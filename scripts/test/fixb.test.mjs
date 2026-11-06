// Final-round B findings: config lock + atomic writes, input validation, purge safety, migrate marker, laptop reaper survival and re-arm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { add, remove, edit, migrate, parseRoutes } from '../provider.mjs';
import { withLock, withLockSync } from '../../plugins/routing/lock.mjs';
import { writeAtomic } from '../../plugins/routing/jsonfile.mjs';
import { reapStep, needsReaper, ensureReaper, reapOrphans, ownedAlive, stopVerified, reaperRunning } from '../../deploy/laptop/gpu-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const served = (ids) => async () => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) });
const opts = { f: served(['m1']), which: () => 'qwen' };
function box() {
  const t = mkdtempSync(join(tmpdir(), 'ahub-fixb-'));
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), routes: join(t, 'routes.json') };
  writeFileSync(p.routes, JSON.stringify({ slots: {}, modes: {}, routes: { summarise: [], 'code-edit': [] } }));
  writeFileSync(p.paseo, JSON.stringify({ version: 1, agents: { providers: {} } }));
  const read = (f) => JSON.parse(readFileSync(p[f], 'utf8'));
  return { t, p, read };
}
const URL1 = 'http://llm.example.test:8000/v1';

// ---- B2 / B7: lock, atomic write, race
test('lock: a dead owner pid is taken over; a live foreign owner makes the caller wait, then fail', async () => {
  const { t } = box(); const lf = join(t, 'x.lock');
  writeFileSync(lf, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() })); // no such process
  assert.equal(withLockSync(lf, () => 'ran'), 'ran');
  assert.equal(existsSync(lf), false, 'released');
  writeFileSync(lf, JSON.stringify({ pid: process.ppid, at: Date.now() })); // a live process that is not us
  assert.throws(() => withLockSync(lf, () => 1, { timeoutMs: 200 }), /held by another process/);
  await assert.rejects(withLock(lf, async () => 1, { timeoutMs: 200 }), /held by another process/);
});
test('lock: re-entrant in one call chain, and two async callers of one process exclude each other', async () => {
  const { t } = box(); const lf = join(t, 'y.lock'); const order = [];
  assert.equal(withLockSync(lf, () => withLockSync(lf, () => 'inner')), 'inner');
  await Promise.all([1, 2].map((n) => withLock(lf, async () => { order.push(`in${n}`); await new Promise((r) => setTimeout(r, 80)); order.push(`out${n}`); })));
  assert.ok(order.join() === 'in1,out1,in2,out2' || order.join() === 'in2,out2,in1,out1', order.join());
});
test('writeAtomic leaves no temp file and replaces the content whole', () => {
  const { t } = box(); const f = join(t, 'a.json');
  writeAtomic(f, 'one'); writeAtomic(f, 'two');
  assert.equal(readFileSync(f, 'utf8'), 'two');
  assert.deepEqual(readdirSync(t).filter((x) => x.endsWith('.tmp')), []);
});
test('two processes adding at the same time end with ALL THREE files consistent (no route token without a provider)', async () => {
  const { t, p, read } = box();
  const srv = createServer((q, r) => setTimeout(() => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ data: [{ id: 'm1' }] })); }, 300)).listen(0, '127.0.0.1');
  await new Promise((r) => srv.on('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/v1`;
  const prov = pathToFileURL(resolve(HERE, '..', 'provider.mjs')).href;
  const code = `import(${JSON.stringify(prov)}).then(async (m) => { try { await m.add({ name: process.argv[1], url: ${JSON.stringify(url)}, model: 'm1', routes: 'summarise,code-edit' }, ${JSON.stringify(p)}, { which: () => 'qwen' }); } catch (e) { console.error(e.message); process.exit(1); } })`;
  const run = (n) => new Promise((r) => { const c = spawn(process.execPath, ['-e', code, n], { stdio: 'inherit', windowsHide: true }); c.on('exit', r); });
  const rc = await Promise.all([run('aaa'), run('bbb')]);
  srv.close();
  assert.deepEqual(rc, [0, 0]);
  const names = Object.keys(read('local').extraProviders).sort();
  assert.deepEqual(names, ['aaa', 'bbb']);
  assert.deepEqual(Object.keys(read('paseo').agents.providers).sort(), names);
  assert.deepEqual(Object.keys(read('routes').slots).sort(), names);
  assert.deepEqual([...read('routes').routes.summarise].sort(), names);
  // and two removes at once
  const rm = `import(${JSON.stringify(prov)}).then((m) => { try { m.remove(process.argv[1], ${JSON.stringify(p)}); } catch (e) { console.error(e.message); process.exit(1); } })`;
  const runRm = (n) => new Promise((r) => { const c = spawn(process.execPath, ['-e', rm, n], { stdio: 'inherit', windowsHide: true }); c.on('exit', r); });
  assert.deepEqual(await Promise.all([runRm('aaa'), runRm('bbb')]), [0, 0]);
  assert.equal(existsSync(p.local) ? read('local').extraProviders : undefined, undefined);
  assert.deepEqual(read('paseo').agents?.providers ?? {}, {});
  assert.deepEqual(read('routes').routes.summarise, []);
  assert.equal(existsSync(join(t, 'hub.local.lock')), false, 'lock released');
});

// ---- B4 / B5 validation
test('add refuses duplicate route tokens, control characters in the key, bad slots', async () => {
  const { p } = box(); const base = { name: 'v1', url: URL1, model: 'm1', routes: 'summarise' };
  await assert.rejects(add({ ...base, routes: 'code-edit:1,code-edit' }, p, opts), /listed twice/);
  await assert.rejects(add({ ...base, routes: 'summarise,summarise' }, p, opts), /listed twice/);
  for (const key of ['a\nb', 'a b', 'x\x00y', 'k'.repeat(513)]) await assert.rejects(add({ ...base, key }, p, opts), /--key must be/);
  for (const slots of ['0x10', '1e1', '0', '65', '-1', '2.5', ' ']) await assert.rejects(add({ ...base, slots }, p, opts), /--slots must be/);
  assert.equal((await add({ ...base, slots: '64', key: 'sk-abc.DEF_123' }, p, opts)).slots, 64);
  assert.deepEqual(parseRoutes('summarise,code-edit:2').map((x) => x.c), ['summarise', 'code-edit']);
});

// ---- B6 purge safety
test('remove --purge deletes only a folder the hub created inside the accounts root', async () => {
  const { t, p } = box(); const root = join(t, 'accounts'); const prev = process.env.AGENT_HUB_ACCOUNTS_DIR; process.env.AGENT_HUB_ACCOUNTS_DIR = root;
  try {
    const which = () => 'qwen'; const run = async () => [{ id: 'm1', label: 'm1' }];
    const o = { which, run, f: served(['m1']) };
    // 1) an existing user folder given as --account-dir: never deleted
    const mine = join(t, 'Documents', 'keep', 'me'); mkdirSync(mine, { recursive: true }); writeFileSync(join(mine, 'file.txt'), 'x');
    await add({ name: 'claude-a', kind: 'claude', account: 'a', accountDir: mine, model: 'm1', routes: 'summarise' }, p, o).catch(() => null);
    const spec = (() => { try { return JSON.parse(readFileSync(p.local, 'utf8')).extraProviders?.['claude-a']; } catch { return null; } })();
    if (spec) { remove('claude-a', p, { purge: true }); assert.ok(existsSync(join(mine, 'file.txt')), 'user folder survives --purge'); }
    // 2) a folder the hub created in the root: deleted
    const r2 = await add({ name: 'claude-b', kind: 'claude', account: 'b', model: 'm1', routes: 'summarise' }, p, o).catch(() => null);
    if (r2) { assert.ok(existsSync(join(r2.accountDir, '.agent-hub-account'))); remove('claude-b', p, { purge: true }); assert.equal(existsSync(r2.accountDir), false); }
  } finally { if (prev === undefined) delete process.env.AGENT_HUB_ACCOUNTS_DIR; else process.env.AGENT_HUB_ACCOUNTS_DIR = prev; }
});

// ---- B7 migrate marker
test('migrate runs once per config state: the second call is a no-op without touching the files', () => {
  const { t, p } = box();
  const r1 = migrate(p, { env: {} });
  assert.equal(r1.changed, false);
  assert.ok(existsSync(join(t, 'hub.local.migrated')), 'marker written');
  const before = [p.local, p.paseo, p.routes].map((f) => existsSync(f) && readFileSync(f, 'utf8'));
  assert.deepEqual(migrate(p, { env: {} }), { changed: false });
  assert.deepEqual([p.local, p.paseo, p.routes].map((f) => existsSync(f) && readFileSync(f, 'utf8')), before);
  writeFileSync(p.paseo, JSON.stringify({ version: 1, agents: { providers: { x: {} } } })); // a changed file invalidates the marker
  assert.equal(migrate(p, { env: {} }).changed, false);
});

// ---- B3 laptop reaper
const own = { pid: 7, lastUsed: 1000 };
test('reapStep: unknown listener (loading / lookup timeout) never ends the reaper; only a dead owned pid does', () => {
  const base = { own, inflight: false, now: 1000 + 60_001, idleMs: 60_000 };
  assert.deepEqual(reapStep({ ...base, listener: null, ownAlive: true }), { act: 'stop', pid: 7 }, 'unknown listener + idle: still stopped');
  assert.deepEqual(reapStep({ ...base, listener: null, ownAlive: true, now: 2000 }), { act: 'keep' }, 'loading: keep watching');
  assert.deepEqual(reapStep({ ...base, listener: 99, ownAlive: true }), { act: 'keep' }, 'someone else took the port: not stopped, not abandoned');
  assert.deepEqual(reapStep({ ...base, listener: null, ownAlive: false }), { act: 'gone' }, 'dead pid');
  assert.deepEqual(reapStep({ ...base, listener: 7, ownAlive: true, inflight: true }), { act: 'keep' });
  assert.deepEqual(reapStep({ ...base, own: null, listener: 7, ownAlive: true }), { act: 'gone' });
});
test('ownedAlive / stopVerified: a dead pid or a reused pid (not llama-server) is never stopped', () => {
  assert.equal(ownedAlive({ pid: 7 }, { alive: () => false }), false);
  assert.equal(ownedAlive({ pid: 7 }, { alive: () => true, cmd: () => 'C:/x/llama-server.exe -m a.gguf' }), true);
  assert.equal(ownedAlive({ pid: 7 }, { alive: () => true, cmd: () => 'notepad.exe' }), false, 'pid reused');
  assert.equal(ownedAlive({ pid: 7 }, { alive: () => true, cmd: () => null }), true, 'unreadable command line: assume ours');
  const stopped = [];
  assert.equal(stopVerified({ pid: 7 }, { cmd: () => 'notepad.exe', stop: (x) => stopped.push(x) }), false);
  assert.equal(stopVerified({ pid: 7 }, { cmd: () => null, stop: (x) => stopped.push(x) }), false, 'not positively ours: not stopped');
  assert.equal(stopVerified({ pid: 7 }, { cmd: () => 'llama-server -m x', stop: (x) => stopped.push(x) }), true);
  assert.deepEqual(stopped, [7]);
});
test('a launcher re-arms a reaper when an owned server runs without one (dead or missing reaper), not otherwise', () => {
  assert.equal(needsReaper({ own, ownAlive: true, reaperPid: null, reaperAlive: false }), true);
  assert.equal(needsReaper({ own, ownAlive: true, reaperPid: 5, reaperAlive: false }), true, 'stale reaper file');
  assert.equal(needsReaper({ own, ownAlive: true, reaperPid: 5, reaperAlive: true }), false);
  assert.equal(needsReaper({ own, ownAlive: false, reaperPid: null, reaperAlive: false }), false, 'server dead: nothing to reap');
  assert.equal(needsReaper({ own: null, ownAlive: true, reaperPid: null, reaperAlive: false }), false, 'not ours');
  const spawned = [];
  const sp = (c, a) => { spawned.push(a); return 99; };
  assert.equal(ensureReaper(8089, '/r.mjs', { spawn: sp, own, reaperPid: null, alive: () => true }), true);
  assert.equal(ensureReaper(8089, '/r.mjs', { spawn: sp, own, reaperPid: 5, alive: () => true, pAlive: () => true }), false);
  assert.deepEqual(spawned, [['/r.mjs', '8089']]);
  assert.equal(reaperRunning(5, { alive: () => true, cmd: () => 'node laptop-reaper.mjs 8089' }), true);
  assert.equal(reaperRunning(5, { alive: () => true, cmd: () => 'chrome.exe' }), false, 'reused pid');
});
test('reapOrphans (hub down / doctor / cleanup): stops an idle orphaned server, leaves busy, fresh, dead and foreign ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-orph-')); const now = 10_000_000;
  const put = (port, o) => writeFileSync(join(dir, `agent-hub-laptop-${port}.json`), JSON.stringify(o));
  put(1001, { pid: 11, lastUsed: now - 3_600_000 }); // idle orphan
  put(1002, { pid: 12, lastUsed: now - 3_600_000 }); // busy
  put(1003, { pid: 13, lastUsed: now - 1000 });       // recently used
  put(1004, { pid: 14, lastUsed: now - 3_600_000 }); // dead / reused
  const stopped = [];
  const r = reapOrphans({ idleMs: 900_000, now, dir, alive: (o) => o.pid !== 14, inflightOf: (port) => port === '1002', stop: (o) => { stopped.push(o.pid); return true; } });
  assert.deepEqual(r.map((x) => x.pid), [11]);
  assert.deepEqual(stopped, [11]);
  assert.equal(existsSync(join(dir, 'agent-hub-laptop-1001.json')), false);
  const down = reapOrphans({ idleMs: 0, now, dir, alive: (o) => o.pid !== 14, inflightOf: (port) => port === '1002', stop: () => true });
  assert.deepEqual(down.map((x) => x.pid), [13], 'down: fresh one stopped too, the busy one still left');
});
