import test from 'node:test';
import assert from 'node:assert/strict';
import { stopDaemon, waitReady, sweepTrees, ensurePlugins, pluginIds } from '../daemon-ctl.mjs';

const P = [
  { id: 'agent-hub-gate', path: '/repo/plugins/gate' },
  { id: 'agent-hub-usage', path: '/repo/plugins/usage-otel' },
  { id: 'agent-hub-providers', path: '/repo/plugins/providers' },
  { id: 'agent-hub-reaper', path: '/repo/plugins/reaper' },
];
const z = async () => {};
const mk = (init, { stick } = {}) => {
  const s = new Map(init.map((e) => [e.id, { ...e }]));
  const c = [];
  const p = (a) => {
    c.push([...a]);
    if (a[0] === 'plugin' && a[1] === 'ls') return { status: 0, stdout: JSON.stringify([...s.values()]), stderr: '' };
    if (a[1] === 'install') { const x = P.find((y) => y.path === a[2]); if (x) s.set(x.id, { id: x.id, status: 'running', enabled: true }); return { status: 0, stdout: '', stderr: '' }; }
    if (a[1] === 'reload') { const x = s.get(a[2]); if (x && a[2] !== stick) x.status = 'running'; return { status: 0, stdout: '', stderr: '' }; }
    if (a[1] === 'enable') { const x = s.get(a[2]); if (x) x.enabled = true; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: 'x' };
  };
  return { p, c, s };
};

test('stopDaemon: listener null → ok, paseo', async () => {
  let k = 0;
  const r = await stopDaemon({ home: '/x', port: 1, paseoStop: () => {}, listener: () => null, kill: () => { k++; }, pidFile: () => null, sleepFn: z, waitMs: 10, log: () => {} });
  assert.equal(r.ok, true); assert.equal(r.how, 'paseo'); assert.equal(k, 0);
});

test('stopDaemon: throws, recorded pid → kill, pid', async () => {
  let h = 42; const k = [];
  const r = await stopDaemon({ home: '/x', port: 1, paseoStop: () => { throw Error('x'); }, listener: () => h, kill: (p) => { k.push(p); h = null; }, pidFile: () => ({ pid: 42 }), sleepFn: z, waitMs: 10, log: () => {} });
  assert.equal(r.ok, true); assert.equal(r.how, 'pid'); assert.deepEqual(k, [42]);
});

test('stopDaemon: different pid → !ok, no kill', async () => {
  let k = 0;
  const r = await stopDaemon({ home: '/x', port: 1, paseoStop: () => {}, listener: () => 999, kill: () => { k++; }, pidFile: () => ({ pid: 42 }), sleepFn: z, waitMs: 10, log: () => {} });
  assert.equal(r.ok, false); assert.equal(k, 0);
});

test('stopDaemon: kill, port stays → !ok', async () => {
  const r = await stopDaemon({ home: '/x', port: 1, paseoStop: () => {}, listener: () => 42, kill: () => {}, pidFile: () => ({ pid: 42 }), sleepFn: z, waitMs: 10, log: () => {} });
  assert.equal(r.ok, false);
});

test('waitReady: 200 but ls slow → ok + STARTING (not a failure)', async () => {
  let t = 0;
  const r = await waitReady({ port: 1, paseoLs: () => false, fetchFn: async () => ({ status: 200, text: async () => '' }), timeoutMs: 50, intervalMs: 10, sleepFn: z, now: () => (t += 20) });
  assert.equal(r.ok, true); assert.equal(r.starting, true); assert.match(r.detail, /STARTING/);
});

test('waitReady: 200, ls true → ok', async () => {
  let t = 0;
  const r = await waitReady({ port: 1, paseoLs: () => true, fetchFn: async () => ({ status: 200, text: async () => '' }), timeoutMs: 50, intervalMs: 10, sleepFn: z, now: () => (t += 20) });
  assert.equal(r.ok, true);
});

test('waitReady: fetch throws → !ok', async () => {
  let t = 0;
  const r = await waitReady({ port: 1, paseoLs: () => true, fetchFn: async () => { throw Error('x'); }, timeoutMs: 50, intervalMs: 10, sleepFn: z, now: () => (t += 20) });
  assert.equal(r.ok, false);
});

// --- ensurePlugins ---

test('ensurePlugins: missing plugin agent-hub-reaper → install called with its path', async () => {
  const initial = P.filter((p) => p.id !== 'agent-hub-reaper').map((p) => ({ id: p.id, status: 'running', enabled: true }));
  const { p: paseo, c: calls } = mk(initial);
  const log = [];
  const r = await ensurePlugins({ paseo, plugins: P, sleepFn: z, settleMs: 3000, log: (m) => log.push(m) });
  const installs = calls.filter((c) => c[0] === 'plugin' && c[1] === 'install');
  assert.equal(installs.length, 1);
  assert.equal(installs[0][2], '/repo/plugins/reaper');
  assert.equal(r.ok, true);
});

test('ensurePlugins: plugin with status failed → plugin reload <id> called', async () => {
  const initial = P.map((p) => ({ id: p.id, status: p.id === 'agent-hub-reaper' ? 'failed' : 'running', enabled: true }));
  const { p: paseo, c: calls } = mk(initial);
  const log = [];
  const r = await ensurePlugins({ paseo, plugins: P, sleepFn: z, settleMs: 3000, log: (m) => log.push(m) });
  const reloads = calls.filter((c) => c[0] === 'plugin' && c[1] === 'reload');
  assert.equal(reloads.length, 1);
  assert.equal(reloads[0][2], 'agent-hub-reaper');
  assert.equal(r.ok, true);
});

test('ensurePlugins: all four end running → ok true and log has one line per plugin', async () => {
  const { p: paseo } = mk([]);
  const log = [];
  const r = await ensurePlugins({ paseo, plugins: P, sleepFn: z, settleMs: 3000, log: (m) => log.push(m) });
  assert.equal(r.ok, true);
  assert.equal(log.length, 4);
  for (const p of P) assert.ok(log.some((l) => l.includes(p.id)), `log missing line for ${p.id}`);
});

test('ensurePlugins: plugin that stays failed → ok false', async () => {
  const initial = P.map((p) => ({ id: p.id, status: p.id === 'agent-hub-reaper' ? 'failed' : 'running', enabled: true }));
  const { p: paseo } = mk(initial, { stick: 'agent-hub-reaper' });
  const log = [];
  const r = await ensurePlugins({ paseo, plugins: P, sleepFn: z, settleMs: 3000, log: (m) => log.push(m) });
  assert.equal(r.ok, false);
});

// --- pluginIds ---

test('pluginIds: returns four entries whose ids are the expected plugin ids', () => {
  const entries = pluginIds();
  assert.equal(entries.length, 4);
  const idSet = new Set(entries.map((x) => x.id));
  for (const id of ['agent-hub-gate', 'agent-hub-usage', 'agent-hub-providers', 'agent-hub-reaper']) {
    assert.ok(idSet.has(id), `missing ${id}`);
  }
});

import { staleWorkspaces, removeStaleWorkspaces } from '../../plugins/routing/cleanup.mjs';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

test('removeStaleWorkspaces: archives a gone folder and a _junk one, keeps a live repo folder and one a running agent uses', () => {
  const live = mkdtempSync(pjoin(tmpdir(), 'ahub-ws-')); // inside the temp dir, so give it a different "tmp" root below
  const keep = pjoin(live, 'repo'); const junk = pjoin(live, '_junk', 'x'); const busy = pjoin(live, '_junk', 'busy');
  for (const d of [keep, junk, busy]) mkdirSync(d, { recursive: true });
  const rows = [{ workspaceId: 'keep', cwd: keep }, { workspaceId: 'gone', cwd: pjoin(live, 'removed') }, { workspaceId: 'junk', cwd: junk }, { workspaceId: 'busy', cwd: busy }];
  const calls = []; const paseo = (a) => { calls.push(a); return a[0] === 'workspace' && a[1] === 'ls' ? rows : a[0] === 'ls' ? [{ status: 'running', cwd: busy }] : {}; };
  const opts = { tmp: pjoin(live, 'no-such-tmp'), sys: pjoin(live, 'no-such-sys') };
  assert.deepEqual(staleWorkspaces(paseo, opts).map((w) => w.workspaceId), ['gone', 'junk']);
  assert.deepEqual(removeStaleWorkspaces({ paseo, dry: true, ...opts }), [pjoin(live, 'removed'), junk]);
  assert.ok(!calls.some((c) => c[1] === 'archive'));
  removeStaleWorkspaces({ paseo, ...opts });
  assert.deepEqual(calls.filter((c) => c[1] === 'archive'), [['workspace', 'archive', 'gone'], ['workspace', 'archive', 'junk']]);
});

test('sweepTrees: kills every tree pid found by command line, then proves none is left; reports the survivors', async () => {
  let alive = [10, 11, 50]; const killedArgs = [];
  const snap = () => alive.map((pid) => ({ pid, ppid: 1, name: 'node.exe', cmd: 'x', born: '' }));
  // trees finder is real: feed a process table where pid 10 is a root and 50 an orphan patch helper
  const table = () => alive.map((pid) => pid === 50 ? { pid, ppid: 999, name: 'node.exe', cmd: 'node paseo-server-patch.mjs apply' } : { pid, ppid: 1, name: 'node.exe', cmd: 'node paseo daemon run --home /h' });
  void snap;
  const r = await sweepTrees({ home: '/h', snap: table, kill: (p) => { killedArgs.push(...p); alive = []; return { killed: p, failed: [] }; }, sleepFn: z, waitMs: 10, log: () => {} });
  assert.equal(r.ok, true); assert.deepEqual(killedArgs.sort((a, b) => a - b), [10, 11, 50]);
  alive = [10];
  const r2 = await sweepTrees({ home: '/h', snap: table, kill: () => ({ killed: [], failed: [10] }), sleepFn: z, waitMs: 10, log: () => {} });
  assert.equal(r2.ok, false); assert.deepEqual(r2.left, [10]);
});
