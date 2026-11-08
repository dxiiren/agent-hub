// Reliable `just down` / `just up`: verifies what Paseo's own stop/start only claim.
//   node scripts/daemon-ctl.mjs stop      daemon stop, then prove it is gone; if not, stop the pid recorded in <home>/paseo.pid (exact pid, only while it is the one holding the port)
//   node scripts/daemon-ctl.mjs heal      before a start: a daemon that holds the port but does not answer is stopped the same way
//   node scripts/daemon-ctl.mjs ready     wait until HTTP /api/health AND `paseo ls` answer; HTTP up but `paseo ls` slow = STARTING (exit 0, says so); exit 1 only when HTTP never answers
//   node scripts/daemon-ctl.mjs plugins   install every missing hub plugin, reload any that is not running, then check all of them
// Env: AGENT_HUB_HOME (Paseo home), AGENT_HUB_PORT (default: the port in paseo.pid, else 6767), AGENT_HUB_PASEO (a fake paseo, tests),
//      AGENT_HUB_READY_S (ready deadline, default 600: measured cold boots took 8-13 min).
//   node scripts/daemon-ctl.mjs guard     exit 3 + the pids when ANY `paseo daemon run --home <home>` tree is alive (matched by command line); service start refuses to spawn a second one
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncSafe } from '../plugins/routing/spawn-safe.mjs';
import { findDaemonTrees, killPids, orphanPatchHelpers, snapshotProcs } from './daemon-trees.mjs';

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

/** [parentPid, commandLine] of a process, or null. Windows: CIM; elsewhere /proc. */
export function procInfo(pid, platform = process.platform) {
  try {
    if (platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$x=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -EA 0;if($x){"$($x.ParentProcessId)|$($x.CommandLine)"}`], { encoding: 'utf8', timeout: 15000 });
      const l = (r.stdout || '').trim(); if (!l) return null; const i = l.indexOf('|'); return [Number(l.slice(0, i)), l.slice(i + 1)];
    }
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return [Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')];
  } catch { return null; }
}

/**
 * Is `holder` (the pid on the port) the recorded daemon or part of it? Paseo's supervisor (the pid in paseo.pid) runs the real server as a child
 * `daemon-worker.js`, and that child holds the port. True when the recorded pid is an ancestor of holder (max 6 levels), or when holder is a
 * daemon-worker whose supervisor is gone. Anything else (a foreign process) is false. -> {ok, chain}
 */
export function isDaemonProcess(holder, recPid, { info = procInfo, alive = isAlive } = {}) {
  const chain = []; let p = holder;
  for (let i = 0; i < 6 && p > 0; i++) {
    const row = info(p); if (!row) break;
    chain.push(p);
    if (row[0] === recPid) return { ok: true, chain: [...chain, recPid] };
    if (i === 0 && /daemon-worker\.js/.test(row[1]) && !alive(recPid)) return { ok: true, chain };
    p = row[0];
  }
  return { ok: false, chain };
}

async function until(cond, ms, sleepFn, stepMs = 500) { for (let t = 0; t <= ms; t += stepMs) { if (cond()) return true; await sleepFn(stepMs); } return cond(); }

/**
 * Stop the daemon and prove it. Order: `paseo daemon stop`; wait for the port to be free; if it is not, kill the recorded pid
 * (never by name, and only while that pid is what holds the port); wait again. -> {ok, how, detail}
 */
export async function stopDaemon({ home, port, paseoStop, listener = listenerPid, alive = isAlive, related = (holder, recPid) => isDaemonProcess(holder, recPid, { alive }), kill = (pid) => process.kill(pid, 'SIGKILL'), pidFile = readDaemonPid, sleepFn = sleep, waitMs = 20000, log = console.log }) {
  try { paseoStop(); } catch { /* verified below, not trusted */ }
  const gone = () => listener(port) === null;
  if (await until(gone, waitMs, sleepFn)) return { ok: true, how: 'paseo' };
  const rec = pidFile(home);
  const holder = listener(port);
  if (!rec || holder === null) return { ok: await until(gone, waitMs, sleepFn), how: 'paseo', detail: 'late' };
  // The port holder is normally the supervisor's child (daemon-worker.js); kill the supervisor first so it cannot respawn the worker, then the holder. Exact pids only.
  const child = holder !== rec.pid;
  if (child && !related(holder, rec.pid).ok) return { ok: false, how: 'none', detail: `port ${port} is held by pid ${holder}, not the daemon pid ${rec.pid} recorded in ${join(home, 'paseo.pid')} or a child of it; not killed` };
  const targets = child ? [...(alive(rec.pid) ? [rec.pid] : []), holder] : [rec.pid];
  log(`[WARN] paseo daemon stop left the daemon on port ${port}; stopping exact pid${targets.length > 1 ? 's' : ''} ${targets.join(', ')}`);
  for (const t of targets) { try { kill(t); } catch (e) { if (alive(t)) return { ok: false, how: 'kill', detail: `could not stop pid ${t}: ${e.message}` }; } }
  const ok = await until(gone, waitMs, sleepFn);
  return ok ? { ok, how: 'pid', detail: `pid ${targets.join('+')}` } : { ok, how: 'kill', detail: `pid ${targets.join('+')} stopped but port ${port} is still held by ${listener(port)}` };
}

async function health(port, fetchFn, ms = 3000) {
  try { const r = await fetchFn(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(ms) }); await r.text(); return r.status === 200; } catch { return false; }
}

/** Ready = HTTP /api/health 200 AND `paseo ls` exit 0. HTTP up but `paseo ls` still slow at the deadline = ok + starting (the daemon is booting, not dead). -> {ok, starting?, seconds, detail} */
export async function waitReady({ port, paseoLs, fetchFn = fetch, timeoutMs = 600000, intervalMs = 2000, sleepFn = sleep, now = Date.now }) {
  const t0 = now(); let http = false, ls = false;
  do {
    http = await health(port, fetchFn);
    if (http) ls = paseoLs();
    if (http && ls) return { ok: true, seconds: Math.round((now() - t0) / 100) / 10 };
    await sleepFn(intervalMs);
  } while (now() - t0 < timeoutMs);
  const seconds = Math.round((now() - t0) / 100) / 10;
  if (http) return { ok: true, starting: true, seconds, detail: `HTTP answers but \`paseo ls\` does not yet after ${Math.round(timeoutMs / 1000)} s: the hub is STARTING (still loading), not failed` };
  return { ok: false, seconds, detail: `HTTP does not answer after ${Math.round(timeoutMs / 1000)} s` };
}

/**
 * Stop EVERY daemon tree of this home, found by command line (a tree paseo.pid does not know, e.g. a second one started while the first was wedged), plus orphaned
 * paseo-server-patch helpers, by exact pid; then prove none is left. -> {ok, killed, left}
 */
export async function sweepTrees({ home, snap = snapshotProcs, kill = killPids, sleepFn = sleep, waitMs = 10000, log = console.log }) {
  const look = () => { const p = snap(); return [...findDaemonTrees(p, home).pids, ...orphanPatchHelpers(p)]; };
  const first = look(); if (!first.length) return { ok: true, killed: [], left: [] };
  log(`[WARN] stopping daemon process tree pids ${first.join(', ')} (matched by command line, home ${home})`);
  const r = kill(first); let left = look();
  for (let t = 0; left.length && t < waitMs; t += 500) { await sleepFn(500); left = look(); }
  return { ok: left.length === 0, killed: r.killed, left };
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

export function context() {
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
    if (cmd === 'stop') { const sw = await sweepTrees({ home }); if (!sw.ok) { console.log(`[FAIL] daemon process tree still alive: pids ${sw.left.join(', ')}`); process.exit(1); } if (!r.ok && listenerPid(port) === null) { r.ok = true; r.how = 'sweep'; } }
    console.log(r.ok ? `[OK] daemon stopped, port ${port} is free${r.how === 'pid' ? ` (by recorded ${r.detail})` : ''}` : `[FAIL] daemon is still running: ${r.detail}`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'guard') {
    const p = snapshotProcs(); const t = findDaemonTrees(p, home);
    if (t.pids.length) { console.log(`[..] a daemon tree for ${home} is already alive (pids ${t.pids.join(', ')}); not starting a second one. Wait for it, or run service.ps1 stop.`); process.exit(3); }
    process.exit(0);
  } else if (cmd === 'ready') {
    const r = await waitReady({ port, timeoutMs: Number(process.env.AGENT_HUB_READY_S || 600) * 1000, paseoLs: () => paseo(['ls', '--json'], { timeout: 20000 }).status === 0 });
    console.log(r.starting ? `[..] hub is STARTING: ${r.detail}; ${logHint}` : r.ok ? `[OK] daemon ready on port ${port} in ${r.seconds} s (HTTP and paseo ls answer)` : `[FAIL] daemon did not become ready: ${r.detail}; ${logHint}`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'plugins') {
    const r = await ensurePlugins({ paseo });
    if (!r.ok) console.log(`[FAIL] not every plugin is running; ${logHint}`);
    process.exit(r.ok ? 0 : 1);
  } else { console.log('usage: daemon-ctl.mjs stop | heal | guard | ready | plugins'); process.exit(2); }
}
