import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add, remove, list, entries } from '../provider.mjs';

const URL1 = 'http://llm.example.test:8000/v1';
const served = (ids) => async () => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) });
function box() {
  const t = mkdtempSync(join(tmpdir(), 'ahub-prov-'));
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), routes: join(t, 'routes.json') };
  writeFileSync(p.routes, JSON.stringify({ slots: { codex: 2 }, modes: {}, routes: { summarise: ['qwen-laptop'], 'code-edit': ['codex/latest-terra'] } }));
  writeFileSync(p.paseo, JSON.stringify({ version: 1, agents: { providers: { codex: {} } } }));
  const read = (f) => JSON.parse(readFileSync(p[f], 'utf8'));
  return { p, read };
}
const opts = (ids = ['m1']) => ({ f: served(ids), which: () => 'qwen' });

test('add writes ONE provider (no read-only twin), local config, slots, modes and routes; list and remove undo it', async () => {
  const { p, read } = box();
  await add({ name: 'qwen-extra', url: URL1, model: 'm1', slots: '3', routes: 'summarise,code-edit' }, p, opts());
  const prov = read('paseo').agents.providers;
  assert.ok(prov.codex, 'existing providers kept');
  assert.deepEqual(prov['qwen-extra'].command.slice(-3), ['qwen', URL1, 'm1']);
  assert.equal(prov['qwen-extra'].extends, 'acp');
  assert.ok(!Object.keys(prov).some((k) => k.endsWith('-ro')), 'no -ro twin entries');
  assert.deepEqual(read('local').extraProviders['qwen-extra'], { type: 'qwen-code', url: URL1, model: 'm1' });
  const r = read('routes');
  assert.ok(r.readOnlyEnforced.includes('qwen-extra') && r.readOnlyEnforced.includes('qwen-laptop')); assert.equal(r.readOnlyModes['qwen-extra'], 'read-only');
  assert.equal(r.slots['qwen-extra'], 3); assert.equal(r.modes['qwen-extra'], 'yolo');
  assert.deepEqual(r.routes.summarise, ['qwen-laptop', 'qwen-extra']); assert.deepEqual(r.routes['code-edit'], ['codex/latest-terra', 'qwen-extra']);
  assert.deepEqual(list(p), [{ name: 'qwen-extra', type: 'qwen-code', url: URL1, model: 'm1', slots: 3, routes: ['summarise', 'code-edit'] }]);
  remove('qwen-extra', p);
  assert.deepEqual(Object.keys(read('paseo').agents.providers), ['codex']);
  assert.deepEqual(read('routes').routes.summarise, ['qwen-laptop']); assert.equal(read('routes').slots['qwen-extra'], undefined); assert.equal(read('routes').readOnlyEnforced, undefined); assert.equal(read('routes').readOnlyModes, undefined);
  assert.deepEqual(list(p), []);
});

test('remove restores the config files byte for byte', async () => {
  const { p } = box(); const before = ['local', 'paseo', 'routes'].map((f) => existsSync(p[f]) ? readFileSync(p[f], 'utf8') : null);
  await add({ name: 'qwen-extra', url: URL1, model: 'm1', routes: 'summarise' }, p, opts());
  remove('qwen-extra', p);
  const after = ['local', 'paseo', 'routes'].map((f) => existsSync(p[f]) ? readFileSync(p[f], 'utf8') : null);
  assert.deepEqual(JSON.parse(after[1]), JSON.parse(before[1])); assert.deepEqual(JSON.parse(after[2]), JSON.parse(before[2]));
  const r = JSON.parse(after[2]); assert.ok(!('readOnlyEnforced' in r) && !('readOnlyModes' in r)); assert.equal(after[0], null, 'hub.local.json did not exist before add and is gone again');
});

test('refuses a model the endpoint does not serve, writing nothing', async () => {
  const { p } = box();
  await assert.rejects(add({ name: 'qwen-extra', url: URL1, model: 'other' }, p, opts(['m1'])), /not served \(served: m1\)/);
  assert.ok(!existsSync(p.local));
});

test('refuses an unreachable endpoint and a non-OK answer', async () => {
  const { p } = box();
  await assert.rejects(add({ name: 'qwen-extra', url: URL1, model: 'm1' }, p, { which: () => 'qwen', f: async () => { throw new Error('ECONNREFUSED'); } }), /endpoint check failed.*ECONNREFUSED/);
  await assert.rejects(add({ name: 'qwen-extra', url: URL1, model: 'm1' }, p, { which: () => 'qwen', f: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  assert.ok(!existsSync(p.local));
});

test('refuses bad names, duplicates, unknown routes and types', async () => {
  const { p } = box();
  for (const name of ['qwen-x-ro', 'Qwen-X', '9bad']) await assert.rejects(add({ name, url: URL1, model: 'm1' }, p, opts()), /name must match/);
  await assert.rejects(add({ name: 'qwen-x', url: URL1, model: 'm1', routes: 'nope' }, p, opts()), /unknown route type nope/);
  await assert.rejects(add({ name: 'qwen-x', url: URL1, model: 'm1', type: 'zzz' }, p, opts()), /unknown type zzz/);
  await assert.rejects(add({ name: 'qwen-x', url: 'ftp://x', model: 'm1' }, p, opts()), /http\(s\)/);
  await add({ name: 'qwen-x', url: URL1, model: 'm1' }, p, opts());
  await assert.rejects(add({ name: 'qwen-x', url: URL1, model: 'm1' }, p, opts()), /already exists/);
  assert.throws(() => remove('qwen-nope', p), /not an added provider/);
});

test('entries is what configure regenerates from hub.local.json', () => {
  const e = entries('qwen-x', { type: 'qwen-code', url: URL1, model: 'm1' }, 'qwen', '/repo');
  assert.equal(e['qwen-x'].command[1].replace(/\\/g, '/'), '/repo/deploy/office/office-agent.mjs');
  assert.deepEqual(Object.keys(e), ['qwen-x']);
});

test('remove restores the exact bytes (CRLF, explicit defaults, empty keys) and undoes by key with the same EOL when the files changed since', async () => {
  const LF = String.fromCharCode(10), CR = String.fromCharCode(13, 10);
  const crlf = (o) => JSON.stringify(o, null, 2).split(LF).join(CR) + CR;
  const mk = () => {
    const { p } = box();
    writeFileSync(p.routes, crlf({ slots: { codex: 2 }, readOnlyEnforced: ['claude-clean', 'qwen-code', 'qwen-code-2', 'qwen-laptop'], readOnlyModes: {}, routes: { summarise: ['qwen-laptop'] } }));
    writeFileSync(p.paseo, crlf({ version: 1 }));
    writeFileSync(p.local, '{}');
    return p;
  };
  const p = mk(); const before = ['local', 'paseo', 'routes'].map((f) => readFileSync(p[f]));
  await add({ name: 'qwen-extra', url: URL1, model: 'm1', routes: 'summarise' }, p, opts());
  assert.ok(readFileSync(p.routes, 'utf8').includes(CR), 'add keeps CRLF');
  remove('qwen-extra', p);
  ['local', 'paseo', 'routes'].forEach((f, i) => assert.ok(readFileSync(p[f]).equals(before[i]), f + ' byte-identical'));
  const q = mk(); await add({ name: 'qwen-extra', url: URL1, model: 'm1' }, q, opts());
  const r = JSON.parse(readFileSync(q.routes, 'utf8')); r.slots.codex = 5; writeFileSync(q.routes, crlf(r));
  remove('qwen-extra', q);
  const after = readFileSync(q.routes, 'utf8'); assert.ok(after.includes(CR) && !after.includes('qwen-extra'), 'CRLF kept, name gone'); assert.equal(JSON.parse(after).slots.codex, 5);
});

test('a config whose top level is not an object is refused and nothing is written (sha256 before/after)', async () => {
  const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  for (const bad of ['[]', 'null', '"x"', '1']) for (const key of ['local', 'paseo', 'routes']) {
    const { p } = box(); writeFileSync(p[key], bad);
    const files = Object.values(p).filter(existsSync); const before = files.map(sha);
    await assert.rejects(add({ name: 'qwen-extra', url: URL1, model: 'm1' }, p, opts()), /not a JSON object/, `${key}=${bad}`);
    assert.deepEqual(files.map(sha), before, `${key}=${bad}`);
    assert.ok(existsSync(p.local) === (key === 'local'), 'no new file');
  }
});
