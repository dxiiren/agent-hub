// Hang watchdog: a daemon whose port is open but whose /api/health never answers is restarted. Paseo's own supervisor only restarts a CRASH (08-11: the
// worker hung at 08:24, the hub was dead for 20 min until someone restarted it by hand). A scheduled task / systemd timer runs this every 2 min.
//   node scripts/daemon-watchdog.mjs [--dry-run]     env: AGENT_HUB_HOME, AGENT_HUB_PORT, AGENT_HUB_WATCHDOG_TIMEOUT_MS (10000)
// Rules: 3 failed checks in a row -> `service restart`; no restart while a deliberate stop (<home>/deliberate-stop, written by `service stop`) is in force;
// at most 3 restarts per hour, then it only logs "backoff" (no loop). Every restart and backoff is a line in <home>/restart-requests.log (restart-log.mjs).
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from './daemon-ctl.mjs';
import { probeDaemon } from './daemon-health.mjs';
import { logRequest } from './restart-log.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FAILS_TO_RESTART = 3, MAX_RESTARTS = 3, WINDOW_MS = 3600_000;

/** Pure decision. state = {fails, restarts:[ms], backoffAt}. -> {action:'none'|'skip'|'restart'|'backoff', state, reason} */
export function decide({ state = {}, ok, now, deliberateStop = false }) {
  const restarts = (state.restarts ?? []).filter((t) => t > now - WINDOW_MS);
  const base = { restarts, backoffAt: state.backoffAt && state.backoffAt > now - WINDOW_MS ? state.backoffAt : 0 };
  if (deliberateStop) return { action: 'skip', reason: 'deliberate stop in force', state: { ...base, fails: 0 } };
  if (ok) return { action: 'none', state: { ...base, fails: 0 } };
  const fails = (state.fails ?? 0) + 1;
  if (fails < FAILS_TO_RESTART) return { action: 'none', reason: `health check failed ${fails}/${FAILS_TO_RESTART}`, state: { ...base, fails } };
  if (restarts.length >= MAX_RESTARTS) {
    const first = !base.backoffAt;
    return { action: first ? 'backoff' : 'none', reason: `${fails} failed checks but ${restarts.length} restarts in the last hour: not restarting again`, state: { ...base, fails, backoffAt: base.backoffAt || now } };
  }
  return { action: 'restart', reason: `${fails} failed health checks in a row`, state: { ...base, fails: 0, restarts: [...restarts, now] } };
}

export const readState = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
export const writeState = (file, s) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(s)); renameSync(file + '.tmp', file); };

/** One tick. All side effects injectable (tests). -> the decision */
export async function tick({ home, port, probe = (p) => probeDaemon(p, { attempts: 1, timeoutMs: Number(process.env.AGENT_HUB_WATCHDOG_TIMEOUT_MS || 10000) }), restart, log = logRequest, now = Date.now(), dryRun = false }) {
  const stateFile = join(home, 'watchdog-state.json');
  const p = await probe(port);
  const d = decide({ state: readState(stateFile), ok: p.state === 'up', now, deliberateStop: existsSync(join(home, 'deliberate-stop')) });
  const detail = `${d.reason ?? ''}${p.state === 'up' ? '' : ` (${p.state}: ${p.detail ?? ''})`}`.trim();
  if (d.action === 'restart' || d.action === 'backoff') log(d.action === 'restart' ? 'restart' : 'restart-backoff', `watchdog: ${detail}`, { home });
  writeState(stateFile, d.state);
  if (d.action === 'restart' && !dryRun) { const r = await restart(); d.restartExit = r; }
  return { ...d, probe: p };
}

/** service.ps1 / service.sh restart, with the reason in the environment so restart-log.mjs records it too. */
export function runRestart(reason, { repo = REPO, platform = process.platform, run = spawnSync } = {}) {
  const env = { ...process.env, AGENT_HUB_REASON: reason };
  const r = platform === 'win32'
    ? run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'deploy', 'service', 'service.ps1'), 'restart'], { env, encoding: 'utf8', timeout: 600000 })
    : run('sh', [join(repo, 'deploy', 'service', 'service.sh'), 'restart'], { env, encoding: 'utf8', timeout: 600000 });
  return r.status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { home, port } = context(); const dryRun = process.argv.includes('--dry-run');
  const r = await tick({ home, port, dryRun, restart: () => runRestart('watchdog: hung daemon') });
  const line = `${new Date().toISOString()} watchdog ${r.action} probe=${r.probe.state}${r.reason ? ` ${r.reason}` : ''}${r.restartExit !== undefined ? ` restart-exit=${r.restartExit}` : ''}`;
  console.log(line);
  if (r.action !== 'none' || r.probe.state !== 'up') appendFileSync(join(home, 'watchdog.log'), `${line}\n`); // quiet while healthy
}
