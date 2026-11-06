import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { add, edit, remove, migrate, describe } from '../provider.mjs';
import { kindOf, discover, LOCAL_FIELD_IDS } from '../provider-kinds.mjs';
import { llamaArgs, startRefusal, reapStep, writeOwn, listenerPid, spawnOrphan } from '../../deploy/laptop/gpu-guard.mjs';

const DEPLOY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'laptop');
const files = (t) => { const bin = join(t, 'llama-server'), gguf = join(t, 'm.gguf'); writeFileSync(bin, ''); writeFileSync(gguf, ''); return { bin, modelFile: gguf }; };
function box() {
  const t = mkdtempSync(join(tmpdir(), 'ahub-ll-'));
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), routes: join(t, 'routes.json') };
  writeFileSync(p.routes, JSON.stringify({ slots: {}, modes: {}, routes: { summarise: ['a'], 'code-edit': ['x'] } }, null, 2) + '\n');
  writeFileSync(p.paseo, JSON.stringify({ version: 1, agents: { providers: { codex: {} } } }, null, 2) + '\n');
  return { t, p, read: (f) => JSON.parse(readFileSync(p[f], 'utf8')), ...files(t) };
}
const which = () => '/opt/qwen';

test('kind schema: own provider with slots and read-only mode, path/number fields, no endpoint to list models from', async () => {
  const k = kindOf('local-llama');
  assert.ok(k.own && k.slots && k.twin && k.local);
  assert.deepEqual(LOCAL_FIELD_IDS, ['bin', 'modelFile', 'port', 'ctx', 'device', 'idleMin', 'heavyLock']);
  assert.deepEqual(k.fields.filter((f) => f.required).map((f) => f.id), ['bin', 'modelFile', 'model']);
  assert.deepEqual(await discover('local-llama', {}), []);
  assert.ok(describe(box().p).kinds.some((x) => x.type === 'local-llama'), 'the Settings form and catalog draw it from the schema');
});

test('the launcher builds exactly the GPU-only, no-mmap llama-server arguments', () => {
  const a = llamaArgs({ model: '/m.gguf', ctx: '4096', port: '8089', alias: 'x', device: 'CUDA0' });
  assert.deepEqual(a, ['-m', '/m.gguf', '--jinja', '-ngl', '99', '-c', '4096', '-np', '1', '-fa', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--reasoning', 'off',
    '--temp', '0.7', '--top-p', '0.8', '--top-k', '20', '--device', 'CUDA0', '--load-mode', 'none', '--host', '127.0.0.1', '--port', '8089', '--alias', 'x', '--metrics', '--cache-ram', '0', '-ot', 'token_embd\.weight=CUDA0']);
  assert.ok(a[a.indexOf('--load-mode') + 1] === 'none' && a[a.indexOf('-ngl') + 1] === '99');
  assert.equal(llamaArgs({ model: 'm', port: 1, alias: 'a' }).includes('65536'), true, 'default context');
});

test('spawnOrphan: the child outlives its starter and is not in the caller process tree (Paseo tree-kills the launcher)', () => {
  const pid = spawnOrphan(process.execPath, ['-e', 'setTimeout(()=>{},20000)']);
  try {
    assert.ok(pid > 0 && pid !== process.pid);
    process.kill(pid, 0); // alive after the middle process exited
    const parent = process.platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`], { encoding: 'utf8' }).stdout
      : spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
    const ppid = parseInt(parent, 10);
    assert.notEqual(ppid, process.pid, 'a tree walk from the caller must not reach it');
    assert.throws(() => process.kill(ppid, 0));
  } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  assert.equal(spawnOrphan(join(tmpdir(), 'no-such-binary-xyz'), []), null);
});

test('start is refused when the GPU is missing or busy, allowed when free', () => {
  assert.match(startRefusal({ pnp: 'Unknown', smiOk: true }), /GPU missing/);
  assert.match(startRefusal({ pnp: 'OK', smiOk: false }), /GPU missing/);
  assert.match(startRefusal({ pnp: 'OK', smiOk: true, usedMiB: 5000 }), /GPU busy \(5000 MiB/);
  assert.equal(startRefusal({ pnp: 'OK', smiOk: true, usedMiB: 300 }), '');
  assert.equal(startRefusal({ pnp: 'OK', smiOk: true, usedMiB: 800 }, 1000), '', 'limit is configurable');
});

test('reaper step: stops only an idle server it started, keeps a busy one, leaves a foreign one', () => {
  const own = { pid: 7, lastUsed: 1000 };
  assert.deepEqual(reapStep({ own, listener: 7, inflight: false, now: 1000 + 60_001, idleMs: 60_000 }), { act: 'stop', pid: 7 });
  assert.deepEqual(reapStep({ own, listener: 7, inflight: false, now: 1000 + 59_000, idleMs: 60_000 }), { act: 'keep' });
  assert.deepEqual(reapStep({ own, listener: 7, inflight: true, now: 1e9, idleMs: 60_000 }), { act: 'keep' });
  assert.deepEqual(reapStep({ own, listener: 99, inflight: false, now: 1e9, idleMs: 60_000 }), { act: 'gone' });
  assert.deepEqual(reapStep({ own: null, listener: 7, inflight: false, now: 1e9, idleMs: 1 }), { act: 'gone' });
});

test('the reaper process stops a server it started once it has been idle (real process, short idle)', async () => {
  const free = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
  const srv = spawn(process.execPath, ['-e', `require('net').createServer().listen(${free}, '127.0.0.1');`], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((r) => srv.on('exit', r));
  try {
    for (let i = 0; i < 50 && listenerPid(free) !== srv.pid; i++) await new Promise((r) => setTimeout(r, 200));
    assert.equal(listenerPid(free), srv.pid, 'test server listens');
    writeOwn(String(free), { pid: srv.pid, startedAt: Date.now(), lastUsed: Date.now() - 60_000 });
    const reaper = spawn(process.execPath, [join(DEPLOY, 'laptop-reaper.mjs'), String(free)], { stdio: 'ignore', windowsHide: true, env: { ...process.env, LAPTOP_IDLE_MIN: '0.01', LAPTOP_REAPER_MS: '300' } });
    const r = await Promise.race([exited.then(() => 'stopped'), new Promise((x) => setTimeout(() => x('timeout'), 20_000))]);
    assert.equal(r, 'stopped');
    reaper.kill();
  } finally { srv.kill(); }
});

test('add: derives the URL from the port, fills defaults, writes the launcher entry with the GPU settings and the read-only mode', async () => {
  const { p, read, bin, modelFile } = box();
  const r = await add({ name: 'laptop-qwen', kind: 'local-llama', model: 'my-alias', bin, modelFile, routes: 'summarise', slots: 1 }, p, { which });
  assert.equal(r.needsRestart, true);
  const spec = read('local').extraProviders['laptop-qwen'];
  assert.deepEqual(spec, { type: 'local-llama', url: 'http://127.0.0.1:8089/v1', model: 'my-alias', bin, modelFile, port: '8089', ctx: '65536', device: 'CUDA0', idleMin: '15' });
  const e = read('paseo').agents.providers['laptop-qwen'];
  assert.match(e.command[1], /laptop-agent[.]mjs$/);
  assert.deepEqual(e.env, { LLAMA_SERVER_BIN: bin, LAPTOP_MODEL_PATH: modelFile, QWEN_BIN: '/opt/qwen', LAPTOP_PORT: '8089', LAPTOP_ALIAS: 'my-alias', LAPTOP_CTX: '65536', LAPTOP_DEVICE: 'CUDA0', LAPTOP_IDLE_MIN: '15' });
  const rt = read('routes'); assert.equal(rt.slots['laptop-qwen'], 1); assert.equal(rt.readOnlyModes['laptop-qwen'], 'read-only'); assert.deepEqual(rt.routes.summarise, ['a', 'laptop-qwen']);
  await edit('laptop-qwen', { idleMin: '5', port: '8090' }, p, { which });
  assert.equal(read('local').extraProviders['laptop-qwen'].url, 'http://127.0.0.1:8090/v1');
  assert.equal(read('paseo').agents.providers['laptop-qwen'].env.LAPTOP_IDLE_MIN, '5');
  remove('laptop-qwen', p);
  assert.equal(read('paseo').agents.providers['laptop-qwen'], undefined);
});

test('add refuses a missing program or model file, a bad port, a bad device', async () => {
  const { p, bin, modelFile } = box(); const base = { name: 'l1', kind: 'local-llama', model: 'm', bin, modelFile };
  await assert.rejects(add({ ...base, bin: bin + 'x' }, p, { which }), /llama-server program not found/);
  await assert.rejects(add({ ...base, modelFile: modelFile + 'x' }, p, { which }), /model file not found/);
  await assert.rejects(add({ ...base, port: '70000' }, p, { which }), /--port/);
  await assert.rejects(add({ ...base, device: 'a b' }, p, { which }), /--device/);
  await assert.rejects(add({ ...base, bin: '' }, p, { which }), /--bin is required/);
  assert.equal(existsSync(p.local), false, 'nothing written when it refuses');
});

test('migrate: a qwen-code provider on the legacy laptop port becomes local-llama (same id, label, slots, routes); idempotent; undo restores the exact bytes', () => {
  const { t, p, read, bin, modelFile } = box();
  const entry = { extends: 'acp', label: 'Qwen Code laptop', command: ['node', '/r/deploy/office/office-agent.mjs', '/opt/qwen', 'http://127.0.0.1:8080/v1', 'qwen35-9b'] };
  writeFileSync(p.paseo, JSON.stringify({ version: 1, agents: { providers: { codex: {}, 'qwen-code-laptop': entry, 'qwen-code-office': { ...entry, command: ['node', '/r/deploy/office/office-agent.mjs', '/opt/qwen', 'http://10.0.0.5:8000/v1', 'big'] } } } }, null, 2) + '\n');
  writeFileSync(p.local, JSON.stringify({ llamaServer: bin, laptopModel: modelFile, laptopPort: '8080', extraProviders: {
    'qwen-code-laptop': { type: 'qwen-code', url: 'http://127.0.0.1:8080/v1', model: 'qwen35-9b', label: 'Qwen Code laptop' },
    'qwen-code-office': { type: 'qwen-code', url: 'http://10.0.0.5:8000/v1', model: 'big' } } }, null, 2) + '\n');
  writeFileSync(p.routes, JSON.stringify({ slots: { 'qwen-code-laptop': 1 }, modes: {}, readOnlyEnforced: ['qwen-code-laptop', 'qwen-code-office'], readOnlyModes: { 'qwen-code-laptop': 'read-only', 'qwen-code-office': 'read-only' }, routes: { summarise: ['qwen-code-laptop'] } }, null, 2) + '\n');
  const pre = ['local', 'paseo', 'routes'].map((f) => readFileSync(p[f]));
  const env = {};
  const r = migrate(p, { env }); assert.deepEqual(r.localLlama, ['qwen-code-laptop']);
  const spec = read('local').extraProviders['qwen-code-laptop'];
  assert.deepEqual(spec, { type: 'local-llama', url: 'http://127.0.0.1:8080/v1', model: 'qwen35-9b', bin, modelFile, port: '8080', ctx: '65536', device: 'CUDA0', idleMin: '15', label: 'Qwen Code laptop' });
  assert.equal(read('local').extraProviders['qwen-code-office'].type, 'qwen-code', 'a remote endpoint is left alone');
  const e = read('paseo').agents.providers['qwen-code-laptop'];
  assert.equal(e.label, 'Qwen Code laptop'); assert.match(e.command[1], /laptop-agent[.]mjs$/); assert.equal(e.env.QWEN_BIN, '/opt/qwen'); assert.equal(e.env.LAPTOP_PORT, '8080');
  assert.deepEqual(read('routes').slots, { 'qwen-code-laptop': 1 }); assert.deepEqual(read('routes').routes.summarise, ['qwen-code-laptop']);
  const post = ['local', 'paseo', 'routes'].map((f) => readFileSync(p[f]));
  assert.deepEqual(migrate(p, { env }), { changed: false }, 'idempotent');
  ['local', 'paseo', 'routes'].forEach((f, i) => assert.ok(readFileSync(p[f]).equals(post[i])));
  assert.ok(existsSync(join(t, 'hub.local.undo-migrate-locallama.json')));
  assert.deepEqual(migrate(p, { undo: true }), { undone: true });
  ['local', 'paseo', 'routes'].forEach((f, i) => assert.ok(readFileSync(p[f]).equals(pre[i]), `${f} back to the exact old bytes`));
  assert.deepEqual(migrate(p, { undo: true }), { undone: false, reason: 'no migration record' });
});
