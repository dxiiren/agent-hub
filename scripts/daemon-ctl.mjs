// Reliable `just down` / `just up`: verifies what Paseo's own stop/start only claim.
//   node scripts/daemon-ctl.mjs stop      daemon stop, then prove it is gone; if not, stop the pid recorded in <home>/paseo.pid (exact pid, only while it is the one holding the port)
//   node scripts/daemon-ctl.mjs heal      before a start: a daemon that holds the port but does not answer is stopped the same way
//   node scripts/daemon-ctl.mjs ready     wait until HTTP /api/health AND `paseo ls` answer (exit 1 with the log path otherwise)
//   node scripts/daemon-ctl.mjs plugins   install every missing hub plugin, reload any that is not running, then check all of them
// Env: AGENT_HUB_HOME (Paseo home), AGENT_HUB_PORT (default: the port in paseo.pid, else 6767), AGENT_HUB_PASEO (a fake paseo, tests),
//      AGENT_HUB_READY_S (ready deadline, default 180).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncSafe } from '../plugins/routing/spawn-safe.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIRS = ['gate', 'usage-otel', 'providers', 'reaper'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The daemon's own pid file: {pid, listen} or null. */
export function readDaemonPid(home) {
  try { const j = JSON.parse(readFileSync(join(home, 'paseo.pid'), 'utf8')); return Number.isInteger(j.pid) ? j : null; } catch { return null; }
}

export function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** Pid listening on a local TCP port, or null. */
export function listenerPid(port, platform = process.platform) {
  if (platform === 'win32') {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    for (const l of (r.stdout || '').split(/\r?\n/)) { const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(l); if (m && Number(m[1]) === Number(port)) return Number(m[2]); }
    return null;
  }
  const r = spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const n = Number((r.stdout || '').split(/\s+/)[0]);
  return n > 0 ? n : null;
}

async function until(cond, ms, sleepFn, stepMs = 500) { for (let t = 0; t <= ms; t += stepMs) { if (cond()) return true; await sleepFn(stepMs); } return cond(); }

/**
 * Stop the daemon and prove it. Order: `paseo daemon stop`; wait for the port to be free; if it is not, kill the recorded pid
 * (never by name, and only while that pid is what holds the port); wait again. -> {ok, how, detail}
 */
export async function stopDaemon({ home, port, paseoStop, listener = listenerPid, alive = isAlive, kill = (pid) => process.kill(pid, 'SIGKILL'), pidFile = readDaemonPid, sleepFn = sleep, waitMs = 20000, log = console.log }) {
  try { paseoStop(); } catch { /* verified below, not trusted */ }
  const gone = () => listener(port) === null;
  if (await until(gone, waitMs, sleepFn)) return { ok: true, how: 'paseo' };
  const rec = pidFile(home);
  const holder = listener(port);
  if (!rec || holder === null) return { ok: await until(gone, waitMs, sleepFn), how: 'paseo', detail: 'late' };
  if (holder !== rec.pid) return { ok: false, how: 'none', detail: `port ${port} is held by pid ${holder}, not the daemon pid ${rec.pid} recorded in ${join(home, 'paseo.pid')}; not killed` };
  log(`[WARN] paseo daemon stop left the daemon (pid ${rec.pid}) on port ${port}; stopping that exact pid`);
  try { kill(rec.pid); } catch (e) { if (alive(rec.pid)) return { ok: false, how: 'kill', detail: `could not stop pid ${rec.pid}: ${e.message}` }; }
  const ok = await until(gone, waitMs, sleepFn);
  return ok ? { ok, how: 'pid', detail: `pid ${rec.pid}` } : { ok, how: 'kill', detail: `pid ${rec.pid} stopped but port ${port} is still held by ${listener(port)}` };
}

async function health(port, fetchFn, ms = 3000) {
  try { const r = await fetchFn(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(ms) }); await r.text(); return r.status === 200; } catch { return false; }
}

/** Ready = HTTP /api/health 200 AND `paseo ls` exit 0. -> {ok, seconds, detail} */
export async function waitReady({ port, paseoLs, fetchFn = fetch, timeoutMs = 180000, intervalMs = 2000, sleepFn = sleep, now = Date.now }) {
  const t0 = now(); let http = false, ls = false;
  do {
    http = await health(port, fetchFn);
    if (http) ls = paseoLs();
    if (http && ls) return { ok: true, seconds: Math.round((now() - t0) / 100) / 10 };
    await sleepFn(intervalMs);
  } while (now() - t0 < timeoutMs);
  return { ok: false, seconds: Math.round((now() - t0) / 100) / 10, detail: `HTTP ${http ? 'answers' : 'does not answer'}, \`paseo ls\` ${ls ? 'answers' : 'does not answer'} after ${Math.round(timeoutMs / 1000)} s` };
}

/** [{dir, id}] from each plugin folder's paseo-plugin.json. */
export function pluginIds(repo = REPO, dirs = PLUGIN_DIRS) {
  return dirs.map((dir) => ({ dir, path: join(repo, 'plugins', dir), id: JSON.parse(readFileSync(join(repo, 'plugins', dir, 'paseo-plugin.json'), 'utf8')).id }));
}

/** paseo(args) -> {status, stdout, stderr}. Installs what is missing, enables a disabled one, reloads one that is not running, re-checks. -> {ok, rows:[{id,status,action}]} */
export async function ensurePlugins({ paseo, plugins = pluginIds(), sleepFn = sleep, settleMs = 30000, log = console.log }) {
  const list = () => { const r = paseo(['plugin', 'ls', '--json']); try { const j = JSON.parse(r.stdout || '[]'); return Array.isArray(j) ? j : []; } catch { return []; } };
  const actions = new Map();
  let cur = list();
  for (const p of plugins) {
    const f = cur.find((x) => x.id === p.id);
    let r;
    if (!f) { r = paseo(['plugin', 'install', p.path]); actions.set(p.id, r.status === 0 ? 'installed' : `install failed: ${String(r.stderr || r.stdout).trim().split(/\r?\n/).pop()}`); }
    else if (f.enabled === false) { r = paseo(['plugin', 'enable', p.id]); actions.set(p.id, 'enabled'); }
    else if (f.status !== 'running') { r = paseo(['plugin', 'reload', p.id]); actions.set(p.id, `reloaded (was ${f.status})`); }
  }
  const state = () => plugins.map((p) => ({ id: p.id, status: list().find((x) => x.id === p.id)?.status ?? 'missing' }));
  let rows = state();
  for (let t = 0; t < settleMs && rows.some((r) => r.status !== 'running'); t += 1000) { await sleepFn(1000); rows = state(); }
  rows = rows.map((r) => ({ ...r, action: actions.get(r.id) ?? 'already' }));
  for (const r of rows) log(`${r.status === 'running' ? '[OK]' : '[FAIL]'} plugin ${r.id}: ${r.status}${r.action === 'already' ? '' : ` (${r.action})`}`);
  return { ok: rows.every((r) => r.status === 'running'), rows };
}

function context() {
  const home = resolve(process.env.AGENT_HUB_HOME || join(homedir(), '.paseo'));
  const listen = readDaemonPid(home)?.listen ?? '';
  const port = Number(process.env.AGENT_HUB_PORT || /:(\d+)$/.exec(listen)?.[1] || 6767);
  const bin = process.env.AGENT_HUB_PASEO || 'paseo';
  const paseo = (args, o = {}) => spawnSyncSafe(bin, ['--home', home, ...args], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', ...o });
  return { home, port, paseo };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2]; const { home, port, paseo } = context();
  const logHint = `see ${join(home, 'daemon.log')}`;
  if (cmd === 'stop' || cmd === 'heal') {
    if (cmd === 'heal') { if (listenerPid(port) === null || await health(port, fetch, 5000)) process.exit(0); console.log(`[WARN] port ${port} is held by a daemon that does not answer; stopping it first`); }
    const r = await stopDaemon({ home, port, paseoStop: () => paseo(['daemon', 'stop'], { stdio: 'inherit' }) });
    console.log(r.ok ? `[OK] daemon stopped, port ${port} is free${r.how === 'pid' ? ` (by recorded ${r.detail})` : ''}` : `[FAIL] daemon is still running: ${r.detail}`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'ready') {
    const r = await waitReady({ port, timeoutMs: Number(process.env.AGENT_HUB_READY_S || 180) * 1000, paseoLs: () => paseo(['ls', '--json'], { timeout: 20000 }).status === 0 });
    console.log(r.ok ? `[OK] daemon ready on port ${port} in ${r.seconds} s (HTTP and paseo ls answer)` : `[FAIL] daemon did not become ready: ${r.detail}; ${logHint}`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'plugins') {
    const r = await ensurePlugins({ paseo });
    if (!r.ok) console.log(`[FAIL] not every plugin is running; ${logHint}`);
    process.exit(r.ok ? 0 : 1);
  } else { console.log('usage: daemon-ctl.mjs stop | heal | ready | plugins'); process.exit(2); }
}
