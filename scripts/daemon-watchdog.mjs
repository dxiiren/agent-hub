// Hang watchdog: a daemon whose port is open but whose /api/health never answers is restarted. Paseo's own supervisor only restarts a CRASH (08-11: the
// worker hung at 08:24, the hub was dead for 20 min until someone restarted it by hand). A scheduled task / systemd timer runs this every minute (3 failed ticks = about 3 min to detect, about 1 min to recover).
//   node scripts/daemon-watchdog.mjs [--dry-run]     env: AGENT_HUB_HOME, AGENT_HUB_PORT, AGENT_HUB_WATCHDOG_TIMEOUT_MS (10000)
// Rules: 3 failed checks in a row -> recover() (kill the recorded supervisor + the port-holding worker by exact pid, never ask the daemon, then `service start`); no restart while a deliberate stop (<home>/deliberate-stop, written by `service stop`) is in force;
// at most 3 restarts per hour, then it only logs "backoff" (no loop). Every restart and backoff is a line in <home>/restart-requests.log (restart-log.mjs).
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, isAlive, isDaemonProcess, listenerPid, readDaemonPid } from './daemon-ctl.mjs';
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

/** Last pids the worker logged (daemon.log lines carry "pid": the worker's own): a second, powershell-free proof that a port holder is the daemon. */
export function recentLogPids(home, bytes = 65536) {
  try {
    const f = join(home, 'daemon.log'); const size = statSync(f).size; const fd = openSync(f, 'r'); const buf = Buffer.alloc(Math.min(size, bytes));
    readSync(fd, buf, 0, buf.length, size - buf.length); closeSync(fd);
    return new Set([...buf.toString('utf8').matchAll(/"pid":(\d+)/g)].map((m) => Number(m[1])));
  } catch { return new Set(); }
}

const PS_SNAPSHOT = (port) => `$ErrorActionPreference='SilentlyContinue';
Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='git.exe'" | %{ "P|$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.WorkingSetSize)|$($_.CommandLine)" };
Get-NetTCPConnection -LocalPort ${Number(port)} | group State | %{ "T|$($_.Name)|$($_.Count)" };
"M|$((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory)"`;

/** One bounded powershell call -> [{pid, ppid, name, ws, cmd}] for node/git plus tcp state counts. Never throws; {} on a timeout. */
export function snapshot(port, { run = spawnSync, platform = process.platform, timeoutMs = 25000 } = {}) {
  if (platform !== 'win32') return {};
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SNAPSHOT(port)], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true });
  const procs = [], tcp = {}; let freeKb = null;
  for (const l of String(r.stdout || '').split(/\r?\n/)) {
    const [k, ...f] = l.split('|');
    if (k === 'P') procs.push({ pid: +f[0], ppid: +f[1], name: f[2], ws: +f[3], cmd: f.slice(4).join('|') });
    else if (k === 'T') tcp[f[0]] = +f[1];
    else if (k === 'M') freeKb = +f[0];
  }
  return { procs, tcp, freeKb };
}

/** Pure: what to kill. Supervisor (recorded pid, only when its command line is a Paseo supervisor/daemon or it is the port holder's parent), the port holder (only when proven to be the daemon worker), and the worker's plugin processes. */
export function killPlan({ rec, holder, snap, logPids = new Set(), alive = isAlive }) {
  const byPid = new Map((snap.procs ?? []).map((p) => [p.pid, p]));
  const isSupervisor = (pid) => /supervisor-entrypoint|daemon-worker|bin[\/]paseo\s+daemon\s+run/.test(byPid.get(pid)?.cmd ?? '');
  const workerOk = holder != null && (isDaemonProcess(holder, rec?.pid ?? -1, { info: (p) => (byPid.get(p) ? [byPid.get(p).ppid, byPid.get(p).cmd] : null), alive }).ok || logPids.has(holder));
  const kill = [];
  if (rec?.pid && alive(rec.pid) && (isSupervisor(rec.pid) || byPid.get(holder)?.ppid === rec.pid)) kill.push(rec.pid);
  if (workerOk) kill.push(holder);
  const workers = new Set(kill);
  for (const p of snap.procs ?? []) if (workers.has(p.ppid) && /plugin-process\.js/.test(p.cmd) && !kill.includes(p.pid)) kill.push(p.pid);
  return { kill, workerOk, refused: holder != null && !workerOk ? `port ${holder} holder is not provably the daemon` : null };
}

/**
 * Recover a hung or dead daemon WITHOUT asking it anything (no `paseo daemon stop`, `ls` or IPC: a hung daemon answers none of them, and that is what froze the 08-11 10:18 recovery).
 * Every step is bounded: snapshot 25 s, kills instant, port wait 15 s, `service start` 240 s. Evidence (process table, CPU, handles, TCP states) is written before the kill.
 */
export async function recover({ home, port, repo = REPO, platform = process.platform, d = {} }) {
  const t0 = Date.now(); const D = {
    snapshot, listener: listenerPid, pidFile: readDaemonPid, alive: isAlive, kill: (pid) => process.kill(pid, 'SIGKILL'), logPids: recentLogPids, sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)),
    start: (reason) => runStart(reason, { repo, platform }), ...d,
  };
  const rec = D.pidFile(home); const holder = D.listener(port); const snap = D.snapshot(port);
  const plan = killPlan({ rec, holder, snap, logPids: D.logPids(home), alive: D.alive });
  try {
    const lines = [`${new Date().toISOString()} hung-daemon evidence: recorded=${rec?.pid ?? '-'} holder=${holder ?? '-'} freeRamKB=${snap.freeKb ?? '?'} tcp=${JSON.stringify(snap.tcp ?? {})}`];
    for (const p of snap.procs ?? []) lines.push(`  ${p.pid} <- ${p.ppid} ${p.name} ws=${Math.round(p.ws / 1048576)}MB ${p.cmd.replace(/\s+/g, ' ').slice(0, 160)}`);
    appendFileSync(join(home, 'watchdog-evidence.log'), lines.join('\n') + '\n');
  } catch { /* evidence is best effort */ }
  const killed = [];
  for (const pid of plan.kill) { try { D.kill(pid); killed.push(pid); } catch { /* already gone */ } }
  for (let i = 0; i < 30 && D.listener(port) !== null; i++) await D.sleepFn(500);
  const still = D.listener(port);
  const startExit = still === null ? D.start('watchdog: hung daemon') : null; // port still held = a holder we refused to kill: never start a second daemon next to it
  return { ok: still === null && startExit === 0, killed, refused: plan.refused, portStillHeldBy: still, startExit, ms: Date.now() - t0 };
}

/** `service.ps1 start` only (never `restart`: its stop half talks to the daemon). The reason travels in the environment for restart-log.mjs. Bounded at 240 s. */
export function runStart(reason, { repo = REPO, platform = process.platform, run = spawnSync } = {}) {
  const env = { ...process.env, AGENT_HUB_REASON: reason };
  const r = platform === 'win32'
    ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'deploy', 'service', 'service.ps1'), 'start'], { env, encoding: 'utf8', timeout: 240000, killSignal: 'SIGKILL', windowsHide: true })
    : run('sh', [join(repo, 'deploy', 'service', 'service.sh'), 'start'], { env, encoding: 'utf8', timeout: 240000, killSignal: 'SIGKILL' });
  return r.status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { home, port } = context(); const dryRun = process.argv.includes('--dry-run');
  const r = await tick({ home, port, dryRun, restart: () => recover({ home, port }).then((r) => { console.log(`recover ${JSON.stringify(r)}`); return r.ok ? 0 : 1; }) });
  const line = `${new Date().toISOString()} watchdog ${r.action} probe=${r.probe.state}${r.reason ? ` ${r.reason}` : ''}${r.restartExit !== undefined ? ` restart-exit=${r.restartExit}` : ''}`;
  console.log(line);
  if (r.action !== 'none' || r.probe.state !== 'up') appendFileSync(join(home, 'watchdog.log'), `${line}\n`); // quiet while healthy
}
