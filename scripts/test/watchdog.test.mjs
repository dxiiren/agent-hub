// Hang watchdog: decision logic, the tick with a really hung port, parent-pid recognition of the daemon worker, stop of supervisor + worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepProbe, providerErrors, syncAlert, decide, tick, START_GRACE_MS, FAILS_TO_RESTART, MAX_RESTARTS, WINDOW_MS, runStart, killPlan, recover } from '../daemon-watchdog.mjs';
import { probeDaemon } from '../daemon-health.mjs';
import { isDaemonProcess, stopDaemon } from '../daemon-ctl.mjs';

const T0 = 1_000_000_000_000;
const SCRATCH = mkdtempSync(join(tmpdir(), 'wd-alert-'));
process.env.AGENT_HUB_ALERT_FILE = join(SCRATCH, 'HUB-ALERT.txt'); process.env.AGENT_HUB_INCIDENT_LOG = join(SCRATCH, 'pool-feedback.md');

test('decide: healthy resets the counter, one failure does nothing', () => {
  let r = decide({ state: { fails: 2 }, ok: true, now: T0 });
  assert.equal(r.action, 'none'); assert.equal(r.state.fails, 0);
  r = decide({ state: {}, ok: false, now: T0 });
  assert.equal(r.action, 'none'); assert.equal(r.state.fails, 1);
});

test('decide: restart exactly at the 3rd failure in a row, then the counter starts over', () => {
  let s = {};
  for (let i = 1; i < FAILS_TO_RESTART; i++) { const r = decide({ state: s, ok: false, now: T0 + i }); assert.equal(r.action, 'none'); s = r.state; }
  const r = decide({ state: s, ok: false, now: T0 + 9 });
  assert.equal(r.action, 'restart'); assert.equal(r.state.fails, 0); assert.deepEqual(r.state.restarts, [T0 + 9]);
});

test('decide: no failed-check counting and no second restart while the last restart is younger than the start grace', () => {
  let r = decide({ state: { fails: 2, restarts: [T0 - 60_000] }, ok: false, now: T0 });
  assert.equal(r.action, 'none'); assert.equal(r.state.fails, 0); assert.match(r.reason, /still booting/);
  r = decide({ state: { fails: 2, restarts: [T0 - START_GRACE_MS - 1000] }, ok: false, now: T0 });
  assert.equal(r.action, 'restart', 'after the grace a still-dead daemon (fails already at 2) is restarted again');
});

test('decide: a success between failures breaks the streak', () => {
  let s = decide({ state: {}, ok: false, now: T0 }).state;
  s = decide({ state: s, ok: false, now: T0 + 1 }).state;
  s = decide({ state: s, ok: true, now: T0 + 2 }).state;
  assert.equal(decide({ state: s, ok: false, now: T0 + 3 }).action, 'none');
});

test('decide: deliberate stop never restarts and clears the streak', () => {
  const r = decide({ state: { fails: 9 }, ok: false, now: T0, deliberateStop: true });
  assert.equal(r.action, 'skip'); assert.equal(r.state.fails, 0);
});

test('decide: after MAX_RESTARTS restarts in an hour it backs off, logs once, and resumes when the window passes', () => {
  const restarts = Array.from({ length: MAX_RESTARTS }, (_, i) => T0 - 20 * 60_000 - (MAX_RESTARTS - i) * 1000); // older than the start grace
  assert.equal(restarts.length, MAX_RESTARTS);
  let r = decide({ state: { fails: FAILS_TO_RESTART - 1, restarts }, ok: false, now: T0 });
  assert.equal(r.action, 'backoff'); assert.equal(r.state.restarts.length, MAX_RESTARTS); assert.equal(r.state.backoffAt, T0);
  r = decide({ state: { ...r.state }, ok: false, now: T0 + 1000 });
  assert.equal(r.action, 'none', 'second tick in backoff stays quiet'); assert.match(r.reason, /not restarting/);
  r = decide({ state: { fails: 5, restarts }, ok: false, now: T0 + WINDOW_MS + 5000 });
  assert.equal(r.action, 'restart', 'old restarts left the window');
});

test('tick: a really hung port (accepts, never answers) -> restart on the 2nd tick, logged with the reason; healthy port -> none', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wd-'));
  const hung = net.createServer((s) => s.on('error', () => {})); // accepts and stays silent
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const port = hung.address().port;
  const logs = []; let restarts = 0;
  const run = (now) => tick({ home, port, now, probe: (p) => probeDaemon(p, { attempts: 1, timeoutMs: 200 }), restart: () => { restarts++; return 0; }, log: (a, r) => logs.push([a, r]) });
  assert.equal((await run(T0)).action, 'none');

  const r3 = await run(T0 + 120000);
  assert.equal(r3.action, 'restart'); assert.equal(restarts, 1); assert.equal(r3.probe.state, 'hung');
  assert.match(logs[0][1], /watchdog: 2 failed health checks in a row \(hung/);
  hung.closeAllConnections?.(); hung.close();
  const ok = http.createServer((q, s) => { s.end('{}'); }); await new Promise((r) => ok.listen(0, '127.0.0.1', r));
  const r4 = await tick({ home, port: ok.address().port, now: T0 + 300000, probe: (p) => probeDaemon(p, { attempts: 1, timeoutMs: 500 }), restart: () => { throw Error('no'); }, log: () => {} });
  assert.equal(r4.action, 'none'); ok.close();
});

test('tick: deliberate-stop marker blocks the restart even after many failures', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wd-')); writeFileSync(join(home, 'deliberate-stop'), 'x');
  let restarts = 0; const probe = async () => ({ state: 'down' });
  for (let i = 0; i < 6; i++) await tick({ home, port: 1, now: T0 + i * 120000, probe, restart: () => { restarts++; }, log: () => {} });
  assert.equal(restarts, 0);
  assert.ok(existsSync(join(home, 'watchdog-state.json')));
});

test('runStart: calls `service start` (never restart: its stop half talks to the hung daemon), bounded, reason in the environment', () => {
  let seen;
  const code = runStart('why', { repo: '/r', platform: 'linux', run: (cmd, args, o) => { seen = { cmd, args, o }; return { status: 0 }; } });
  assert.equal(code, 0); assert.equal(seen.cmd, 'sh'); assert.match(seen.args[0], /service\.sh$/); assert.equal(seen.args[1], 'start'); assert.equal(seen.o.env.AGENT_HUB_REASON, 'why');
  assert.ok(seen.o.timeout > 0 && seen.o.timeout <= 300000, 'every step has a timeout'); assert.equal(seen.o.killSignal, 'SIGKILL');
});

// a snapshot as snapshot() returns it: 100 supervisor, 200 worker (holds the port), 210/220 its plugin processes, 300 foreign
const snap = { procs: [
  { pid: 100, ppid: 1, name: 'node.exe', ws: 1e7, cmd: 'node x/supervisor-entrypoint.js' }, { pid: 200, ppid: 100, name: 'node.exe', ws: 1e8, cmd: 'node x/daemon-worker.js' },
  { pid: 210, ppid: 200, name: 'node.exe', ws: 1e7, cmd: 'node x/plugins/plugin-process.js' }, { pid: 220, ppid: 200, name: 'node.exe', ws: 1e7, cmd: 'node other-child.js' },
  { pid: 300, ppid: 50, name: 'node.exe', ws: 1e7, cmd: 'node other.js' }] };

test('killPlan: supervisor, worker and the worker plugin processes; not a foreign child, not an unproven holder', () => {
  const p = killPlan({ rec: { pid: 100 }, holder: 200, snap, alive: () => true });
  assert.deepEqual(p.kill, [100, 200, 210]); assert.equal(p.workerOk, true);
  const f = killPlan({ rec: { pid: 100 }, holder: 300, snap, alive: () => true });
  assert.deepEqual(f.kill, [100]); assert.equal(f.workerOk, false); assert.match(f.refused, /not provably/);
  assert.deepEqual(killPlan({ rec: { pid: 100 }, holder: 300, snap, logPids: new Set([300]), alive: () => true }).kill, [100, 300], 'the pid the worker logged is proof too');
  assert.deepEqual(killPlan({ rec: { pid: 300 }, holder: null, snap, alive: () => true }).kill, [], 'a recorded pid that is not a Paseo supervisor is never killed (pid reuse)');
});

test('recover: kills exact pids, waits for the port, starts once; a refused holder means no start', async () => {
  const z = async () => {}; let held = 200; const killed = []; let starts = 0;
  const d = { snapshot: () => snap, listener: () => held, pidFile: () => ({ pid: 100 }), alive: () => true, logPids: () => new Set(), sleepFn: z, kill: (p) => { killed.push(p); if (p === 200) held = null; }, start: () => { starts++; return 0; } };
  const home = mkdtempSync(join(tmpdir(), 'wd-'));
  const r = await recover({ home, port: 1, d });
  assert.equal(r.ok, true); assert.deepEqual(killed, [100, 200, 210]); assert.equal(starts, 1);
  assert.ok(existsSync(join(home, 'watchdog-evidence.log')), 'evidence written before the kill');
  held = 300; killed.length = 0; starts = 0;
  const r2 = await recover({ home, port: 1, d: { ...d, kill: (p) => killed.push(p) } });
  assert.equal(r2.ok, false); assert.equal(starts, 0); assert.equal(r2.portStillHeldBy, 300); assert.deepEqual(killed, [100]);
});

// process table: 100 = supervisor (recorded), 200 = worker (holds the port), 250 = its child, 300 = foreign, 400 = orphaned worker
const table = { 100: [1, 'node supervisor-entrypoint.js'], 200: [100, 'node x/daemon-worker.js'], 250: [200, 'node child'], 300: [50, 'node other.js'], 50: [1, 'bash'], 400: [1, 'node x/daemon-worker.js'] };
const info = (p) => table[p] ?? null;

test('isDaemonProcess: the worker is the recorded supervisor child, a grandchild too, a foreign process is not', () => {
  assert.equal(isDaemonProcess(200, 100, { info }).ok, true);
  assert.equal(isDaemonProcess(250, 100, { info }).ok, true);
  assert.equal(isDaemonProcess(300, 100, { info }).ok, false);
  assert.equal(isDaemonProcess(999, 100, { info }).ok, false);
});

test('isDaemonProcess: an orphaned daemon-worker (supervisor gone) counts, unless the supervisor is alive elsewhere', () => {
  assert.equal(isDaemonProcess(400, 100, { info, alive: () => false }).ok, true);
  assert.equal(isDaemonProcess(400, 100, { info, alive: () => true }).ok, false);
});

const z = async () => {};
test('stopDaemon: port held by the worker -> kills supervisor first, then worker, exact pids; ok when port frees', async () => {
  let holder = 200; const killed = [];
  const r = await stopDaemon({ home: '/x', port: 1, paseoStop: () => {}, listener: () => holder, alive: () => true, related: (h, rec) => isDaemonProcess(h, rec, { info }),
    kill: (p) => { killed.push(p); if (p === 200) holder = null; }, pidFile: () => ({ pid: 100 }), sleepFn: z, waitMs: 10, log: () => {} });
  assert.equal(r.ok, true); assert.deepEqual(killed, [100, 200]);
});

test('stopDaemon: port held by a foreign process -> refused, nothing killed (unchanged)', async () => {
  const killed = [];
  const r = await stopDaemon({ home: '/x', port: 1, paseoStop: () => {}, listener: () => 300, alive: () => true, related: (h, rec) => isDaemonProcess(h, rec, { info }),
    kill: (p) => killed.push(p), pidFile: () => ({ pid: 100 }), sleepFn: z, waitMs: 10, log: () => {} });
  assert.equal(r.ok, false); assert.deepEqual(killed, []); assert.match(r.detail, /not killed/);
});

test('decide (fake clock): a young daemon process is never restarted, however many checks failed; an old one is', () => {
  const young = decide({ state: { fails: 5 }, ok: false, now: T0, daemonStartedAt: T0 - 9 * 60_000 });
  assert.equal(young.action, 'none'); assert.equal(young.state.fails, 0); assert.match(young.reason, /boot window/);
  assert.equal(decide({ state: { fails: 2 }, ok: false, now: T0, daemonStartedAt: T0 - 10 * 60_000 - 1000 }).action, 'restart');
  assert.equal(decide({ state: { fails: 2 }, ok: false, now: T0, daemonStartedAt: null }).action, 'restart', 'no process at all = nothing is booting');
});

test('decide (fake clock): at most one restart per 10 min, even with an old daemon process', () => {
  assert.equal(START_GRACE_MS, 10 * 60_000);
  const r = decide({ state: { fails: 2, restarts: [T0 - 9 * 60_000] }, ok: false, now: T0, daemonStartedAt: T0 - 60 * 60_000 });
  assert.equal(r.action, 'none'); assert.match(r.reason, /still booting/);
  assert.equal(decide({ state: { fails: 2, restarts: [T0 - 10 * 60_000 - 1000] }, ok: false, now: T0, daemonStartedAt: T0 - 60 * 60_000 }).action, 'restart');
});

test('tick: the restart reason is logged and a young process tree defers it (trees injected)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wd-')); const logs = []; let restarts = 0;
  const base = { home, port: 1, probe: async () => ({ state: 'down', detail: 'x' }), restart: () => { restarts++; return 0; }, log: (a, r) => logs.push([a, r]) };
  for (let i = 0; i < 4; i++) await tick({ ...base, now: T0 + i * 60_000, trees: () => T0 - 60_000 });
  assert.equal(restarts, 0);
  let r; for (let i = 0; i < FAILS_TO_RESTART; i++) r = await tick({ ...base, now: T0 + 20 * 60_000 + i * 60_000, trees: () => T0 - 60_000 });
  assert.equal(r.action, 'restart'); assert.equal(restarts, 1); assert.match(logs[0][1], new RegExp('watchdog: ' + FAILS_TO_RESTART + ' failed health checks in a row'));
});

test('deepProbe: HTTP up but `paseo ls` failing is sick; an enabled provider in error is only a warning (still up); all good is up', async () => {
  const up = async () => ({ state: 'up' });
  const mk = (ls, prov) => (args) => (args[0] === 'ls' ? ls : prov);
  assert.equal((await deepProbe(1, 'h', { http: up, run: mk({ status: 1 }, { status: 0, stdout: '[]' }) })).state, 'sick');
  const bad = JSON.stringify([{ provider: 'qoder', status: 'error', enabled: 'Enabled' }, { provider: 'codex', status: 'error', enabled: 'Disabled' }]);
  const r = await deepProbe(1, 'h', { http: up, run: mk({ status: 0 }, { status: 0, stdout: bad }) });
  assert.equal(r.state, 'up'); assert.match(r.warn, /qoder/); assert.doesNotMatch(r.warn, /codex/);
  assert.equal((await deepProbe(1, 'h', { http: up, run: mk({ status: 0 }, { status: 0, stdout: '[]' }) })).state, 'up');
  assert.equal((await deepProbe(1, 'h', { http: async () => ({ state: 'hung' }), run: () => { throw Error('not reached'); } })).state, 'hung');
  assert.deepEqual(providerErrors(JSON.parse(bad)), ['qoder']);
});

test('a provider in error never restarts the daemon (14-11: qwen-code-laptop restarted it every 12 min); the warning is logged once, no alert file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wd-prov-')); let restarts = 0;
  const up = async () => ({ state: 'up' });
  const bad = JSON.stringify([{ provider: 'qwen-code-laptop', status: 'error', enabled: 'Enabled' }]);
  const probe = (p) => deepProbe(p, home, { http: up, run: (args) => (args[0] === 'ls' ? { status: 0 } : { status: 0, stdout: bad }) });
  const base = { home, port: 1, probe, restart: () => { restarts++; return 0; }, log: () => {} };
  let r; for (let i = 0; i < 20; i++) r = await tick({ ...base, now: T0 + i * 12 * 60_000, trees: () => T0 - 60 * 60_000 });
  assert.equal(restarts, 0); assert.equal(r.action, 'none');
  const warns = readFileSync(join(home, 'watchdog.log'), 'utf8').trim().split(/\r?\n/);
  assert.equal(warns.length, 1); assert.match(warns[0], /warn provider status error: qwen-code-laptop \(no restart\)/);
});

test('a daemon that does not answer still restarts after the failed checks; a boot younger than the window never restarts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wd-prov-')); let restarts = 0;
  const probe = async () => ({ state: 'hung', detail: 'no answer' });
  const base = { home, port: 1, probe, restart: () => { restarts++; return 0; }, log: () => {} };
  for (let i = 0; i < 3; i++) await tick({ ...base, now: T0 + i * 60_000, trees: () => T0 - 60 * 60_000 });
  assert.equal(restarts, 1);
  const h2 = mkdtempSync(join(tmpdir(), 'wd-boot-')); restarts = 0;
  for (let i = 0; i < 5; i++) await tick({ ...base, home: h2, now: T0 + i * 60_000, trees: () => T0 - 2 * 60_000 }); // daemon is 2-7 min old
  assert.equal(restarts, 0);
});

test('syncAlert: file exists exactly while unhealthy, one incident line per incident, a recovered line at the end', () => {
  const d = mkdtempSync(join(tmpdir(), 'wd-sa-')); const alertFile = join(d, 'a.txt'), incidentLog = join(d, 'log.md');
  syncAlert({ ok: false, detail: 'x', alertFile, incidentLog }); syncAlert({ ok: false, detail: 'x', alertFile, incidentLog });
  assert.ok(existsSync(alertFile));
  syncAlert({ ok: true, alertFile, incidentLog });
  assert.ok(!existsSync(alertFile));
  const lines = readFileSync(incidentLog, 'utf8').trim().split(/\r?\n/); assert.equal(lines.length, 2); assert.match(lines[0], /incident/); assert.match(lines[1], /recovered/);
});

test('deepProbe UN-INJECTED on Windows: the real spawn path resolves `paseo.cmd` from PATH (39a1b60: it was exit 127 for ever)', { skip: process.platform !== 'win32' && 'Windows shim resolution only' }, async () => {
  const d = mkdtempSync(join(tmpdir(), 'wd-paseo-')); mkdirSync(join(d, 'node_modules', 'p'), { recursive: true });
  writeFileSync(join(d, 'node_modules', 'p', 'cli.js'), 'process.stdout.write("[]")'); // `paseo ls --json` and `paseo provider ls --json` both answer []
  const BS = String.fromCharCode(92);
  writeFileSync(join(d, 'paseo.cmd'), ['@ECHO off', 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" --no-warnings "%dp0%' + BS + 'node_modules' + BS + 'p' + BS + 'cli.js" %*'].join(String.fromCharCode(13, 10)));
  const old = { PATH: process.env.PATH, Path: process.env.Path };
  const withPath = d + ';' + (old.Path ?? old.PATH ?? ''); process.env.PATH = withPath; process.env.Path = withPath;
  try {
    const r = await deepProbe(1, 'h', { http: async () => ({ state: 'up' }) }); // no `run`: the default spawnSyncSafe('paseo.cmd', ...) path
    assert.equal(r.state, 'up', r.detail);
  } finally { if (old.PATH === undefined) delete process.env.PATH; else process.env.PATH = old.PATH; if (old.Path === undefined) delete process.env.Path; else process.env.Path = old.Path; }
});
