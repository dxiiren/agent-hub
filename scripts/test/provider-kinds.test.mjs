import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add, edit, remove, list, describe, api, parseRoutes } from '../provider.mjs';
import { discover, modelListed } from '../provider-kinds.mjs';

const URL1 = 'http://127.0.0.1:9/v1';
const served = (ids, seen) => async (u, o) => { seen?.push(o?.headers?.Authorization); return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) }; };
const cli = (ids) => () => ({ stdout: JSON.stringify(ids.map((id) => ({ id, model: id.toUpperCase() }))) });
function box() {
  const t = mkdtempSync(join(tmpdir(), 'ahub-kinds-'));
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), routes: join(t, 'routes.json') };
  writeFileSync(p.routes, JSON.stringify({ slots: { codex: 2 }, modes: {}, routes: { summarise: ['a', 'b'], 'code-edit': ['x/1', 'y/2', 'z/3'] } }, null, 2) + '\n');
  writeFileSync(p.paseo, JSON.stringify({ version: 1, agents: { providers: { codex: {} } } }, null, 2) + '\n');
  const sha = () => ['local', 'paseo', 'routes'].map((f) => (existsSync(p[f]) ? createHash('sha256').update(readFileSync(p[f])).digest('hex') : null));
  return { p, t, sha, read: (f) => JSON.parse(readFileSync(p[f], 'utf8')) };
}

test('a CLI kind adds only a route token at the chosen position, validates the model, and leaves slots alone', async () => {
  const { p, read } = box();
  await add({ name: 'fast-tier', kind: 'qoder', model: 'efficient', routes: 'code-edit:2,summarise' }, p, { run: cli(['efficient', 'fast']) });
  assert.deepEqual(read('routes').routes['code-edit'], ['x/1', 'qoder/efficient', 'y/2', 'z/3']);
  assert.deepEqual(read('routes').routes.summarise, ['a', 'b', 'qoder/efficient']);
  assert.equal(read('routes').slots['fast-tier'], undefined);
  assert.deepEqual(Object.keys(read('paseo').agents.providers), ['codex'], 'no Paseo provider entry for a CLI kind');
  await assert.rejects(add({ name: 'other', kind: 'qoder', model: 'nope', routes: 'summarise' }, p, { run: cli(['efficient']) }), /not offered by the qoder CLI/);
  await assert.rejects(add({ name: 'dup', kind: 'qoder', model: 'efficient', routes: 'summarise' }, p, { run: cli(['efficient']) }), /already lists qoder\/efficient/);
  assert.deepEqual(list(p), [{ name: 'fast-tier', type: 'qoder', model: 'efficient', slots: undefined, routes: ['summarise', 'code-edit'] }]);
});

test('add then edit then remove returns every file to its original bytes; edit keeps positions and the key stays out of list', async () => {
  const { p, sha, read } = box(); const before = sha(); const seen = [];
  await add({ name: 'qwen-lab', kind: 'qwen', url: URL1, model: 'm1', key: 'sk-test-secret', slots: 2, routes: 'summarise:1' }, p, { f: served(['m1', 'm2'], seen), which: () => 'qwen' });
  assert.equal(seen[0], 'Bearer sk-test-secret');
  assert.equal(read('paseo').agents.providers['qwen-lab'].env.HUB_OPENAI_API_KEY, 'sk-test-secret');
  assert.ok(!JSON.stringify(list(p)).includes('sk-test-secret')); assert.equal(list(p)[0].keySet, true);
  assert.ok(!JSON.stringify(command(p)).includes('sk-test-secret'), 'key never in argv');
  await edit('qwen-lab', { slots: '5', model: 'm2' }, p, { f: served(['m1', 'm2']), which: () => 'qwen' });
  assert.equal(read('routes').slots['qwen-lab'], 5); assert.equal(read('local').extraProviders['qwen-lab'].model, 'm2'); assert.equal(read('local').extraProviders['qwen-lab'].key, 'sk-test-secret', 'edit keeps the key');
  assert.equal(read('routes').routes.summarise[0], 'qwen-lab');
  await assert.rejects(edit('qwen-lab', { model: 'gone' }, p, { f: served(['m1']), which: () => 'qwen' }), /not served/);
  assert.equal(read('local').extraProviders['qwen-lab'].model, 'm2', 'a refused edit changes nothing');
  remove('qwen-lab', p);
  assert.deepEqual(sha(), before);
});
const command = (p) => JSON.parse(readFileSync(p.paseo, 'utf8')).agents.providers['qwen-lab'].command;

test('read-only twin can be switched off; opencode kind writes its own config file and removal deletes it', async () => {
  const { p, t, sha } = box(); const before = sha();
  await add({ name: 'qwen-x', kind: 'qwen', url: URL1, model: 'm1', readOnly: 'false' }, p, { f: served(['m1']), which: () => 'qwen' });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(p.paseo, 'utf8')).agents.providers), ['codex', 'qwen-x']);
  remove('qwen-x', p); assert.deepEqual(sha(), before);
  await add({ name: 'opencode-x', kind: 'opencode', url: URL1, model: 'm1', routes: 'summarise' }, p, { f: served(['m1']) });
  const f = join(t, 'hub', 'opencode-opencode-x.json'); assert.ok(existsSync(f));
  assert.equal(JSON.parse(readFileSync(p.paseo, 'utf8')).agents.providers['opencode-x'].extends, 'opencode');
  remove('opencode-x', p); assert.ok(!existsSync(f)); assert.deepEqual(sha(), before);
});

test('api verbs mirror the CLI; describe lists kinds with fields and route types', async () => {
  const { p } = box();
  const d = await api({ verb: 'describe' }, p); assert.ok(d.kinds.find((k) => k.type === 'qwen-code').fields.some((f) => f.type === 'secret')); assert.deepEqual(d.routeTypes, { summarise: 2, 'code-edit': 3 });
  assert.deepEqual((await api({ verb: 'models', args: { kind: 'qwen', url: URL1 } }, p, { f: served(['m1']) })).models, [{ id: 'm1', label: 'm1' }]);
  await api({ verb: 'add', args: { name: 'qwen-api', kind: 'qwen', url: URL1, model: 'm1' } }, p, { f: served(['m1']), which: () => 'q' });
  assert.equal((await api({ verb: 'list' }, p)).providers.length, 1);
  await api({ verb: 'remove', args: { name: 'qwen-api' } }, p); assert.equal(list(p).length, 0);
  await assert.rejects(api({ verb: 'zap' }, p), /unknown verb/);
});

test('input validation: non-http urls, bad route positions, unreachable endpoint, empty CLI list', async () => {
  const { p } = box();
  await assert.rejects(add({ name: 'qwen-a', kind: 'qwen', url: 'file:///etc/passwd', model: 'm' }, p, { which: () => 'q' }), /http\(s\)/);
  assert.throws(() => parseRoutes('summarise:0'), /position/);
  await assert.rejects(discover('qwen-code', { url: URL1 }, { f: async () => { throw new Error('ECONNREFUSED'); } }), /endpoint check failed/);
  await assert.rejects(discover('codex', {}, { run: () => ({ stdout: '' }) }), /listed nothing/);
  assert.ok(modelListed('latest-sonnet', []) && modelListed('Efficient', [{ id: 'efficient', label: 'Efficient' }]) && !modelListed('x', []));
});

test('a custom kind from AGENT_HUB_KINDS is offered and builds its launch command', async () => {
  const t = mkdtempSync(join(tmpdir(), 'ahub-custom-')); const f = join(t, 'kinds.json');
  writeFileSync(f, JSON.stringify({ myagent: { label: 'My agent', launch: ['{node}', 'run.mjs', '{url}', '{model}'] } }));
  const code = `import { KINDS } from './scripts/provider-kinds.mjs'; import { entries } from './scripts/provider.mjs';
    const e = entries('myagent-1', { type: 'myagent', url: 'http://127.0.0.1:9/v1', model: 'm1' }, null, '/repo', '/hub');
    console.log(JSON.stringify({ has: !!KINDS.myagent, cmd: e['myagent-1'].command, ro: !!e['myagent-1-ro'] }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: join(import.meta.dirname, '..', '..'), encoding: 'utf8', env: { ...process.env, AGENT_HUB_KINDS: f } });
  const o = JSON.parse(r.stdout); assert.equal(o.has, true); assert.deepEqual(o.cmd, [o.cmd[0], 'run.mjs', URL1, 'm1']); assert.equal(o.ro, false);
});
