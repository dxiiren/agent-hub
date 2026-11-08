// Every `paseo daemon run --home <home>` process tree is found by command line (not only paseo.pid), stopped by exact pid, and a start is refused while one lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDaemonTrees, orphanPatchHelpers, snapshotProcs, killPids, oldestStart } from '../daemon-trees.mjs';

const H = 'C:\\Users\\u\\.paseo';
const P = (pid, ppid, cmd, name = 'node.exe', born = '2026-11-08T14:00:00.000Z') => ({ pid, ppid, name, cmd, born });
const procs = [
  P(1, 0, 'init', 'System'),
  P(10, 5, '"C:\\Program Files\\nodejs\\node.exe" C:\\hub\\scripts\\daemon-env.mjs C:\\npm\\paseo.cmd daemon run --home C:\\Users\\u\\.paseo'),
  P(11, 10, 'node C:\\npm\\bin\\paseo daemon run --home c:/users/u/.paseo/', 'node.exe', '2026-11-08T14:01:00.000Z'),
  P(12, 11, 'node supervisor-entrypoint.js'), P(13, 12, 'node daemon-worker.js'), P(14, 13, 'node plugin-process.js'),
  P(20, 5, 'cmd.exe /c paseo.cmd daemon run --home C:\\Users\\u\\.paseo', 'cmd.exe'), P(21, 20, 'node w.js'),
  P(30, 5, 'node C:\\npm\\bin\\paseo daemon run --home C:\\other\\.paseo'), P(31, 30, 'node x.js'),
  P(40, 5, 'powershell -Command "paseo daemon run --home C:\\Users\\u\\.paseo"', 'powershell.exe'),
  P(50, 999, 'node C:\\hub\\scripts\\paseo-server-patch.mjs apply'), P(51, 10, 'node C:\\hub\\scripts\\paseo-server-patch.mjs apply'),
];

test('findDaemonTrees: every tree of this home (wrapper chain, cmd launcher, descendants); other homes and shells are left alone', () => {
  const t = findDaemonTrees(procs, H, { self: 9999 });
  assert.deepEqual(t.pids.sort((a, b) => a - b), [10, 11, 12, 13, 14, 20, 21, 51]);
  assert.deepEqual(t.roots, [10, 20]);
  assert.equal(t.pids.includes(30), false); assert.equal(t.pids.includes(40), false);
});

test('findDaemonTrees: never includes the caller or its ancestors', () => {
  assert.deepEqual(findDaemonTrees(procs, H, { self: 13 }).pids.sort((a, b) => a - b), [20, 21]);
});

test('orphanPatchHelpers: a patch helper whose parent is gone, not one with a live parent', () => {
  assert.deepEqual(orphanPatchHelpers(procs), [50]);
});

test('oldestStart: earliest creation time in the tree, null when none', () => {
  assert.equal(oldestStart(procs, [11, 12]), Date.parse('2026-11-08T14:00:00.000Z'));
  assert.equal(oldestStart(procs, []), null);
});

test('real stub process: found by its command line, stopped by exact pid, gone afterwards', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trees-'));
  const stub = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'daemon', 'run', '--home', home], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const t = findDaemonTrees(snapshotProcs(), home, { self: process.pid });
    assert.ok(t.pids.includes(stub.pid) && t.roots.length === 1 && t.roots[0] === stub.pid);
    assert.deepEqual(findDaemonTrees(snapshotProcs(), join(home, 'nope')).pids, []);
    const r = killPids(t.pids);
    assert.ok(r.killed.includes(stub.pid)); assert.deepEqual(r.failed, []);
    await new Promise((r2) => setTimeout(r2, 500));
    assert.deepEqual(findDaemonTrees(snapshotProcs(), home, { self: process.pid }).pids, []);
  } finally { try { stub.kill('SIGKILL'); } catch { /* gone */ } }
});
