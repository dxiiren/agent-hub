import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

test('add writes provider + ro twin, local config, slots, modes and routes; list and remove undo it', async () => {
  const { p, read } = box();
  await add({ name: 'qwen-extra', url: URL1, model: 'm1', slots: '3', routes: 'summarise,code-edit' }, p, opts());
  const prov = read('paseo').agents.providers;
  assert.ok(prov.codex, 'existing providers kept');
  assert.deepEqual(prov['qwen-extra'].command.slice(-3), ['qwen', URL1, 'm1']);
  assert.equal(prov['qwen-extra'].extends, 'acp');
  assert.deepEqual(prov['qwen-extra-ro'].command, [...prov['qwen-extra'].command, '--read-only']);
  assert.deepEqual(read('local').extraProviders['qwen-extra'], { type: 'qwen-code', url: URL1, model: 'm1' });
  const r = read('routes');
  assert.equal(r.slots['qwen-extra'], 3); assert.equal(r.modes['qwen-extra'], 'yolo');
  assert.deepEqual(r.routes.summarise, ['qwen-laptop', 'qwen-extra']); assert.deepEqual(r.routes['code-edit'], ['codex/latest-terra', 'qwen-extra']);
  assert.deepEqual(list(p), [{ name: 'qwen-extra', type: 'qwen-code', url: URL1, model: 'm1', slots: 3, routes: ['summarise', 'code-edit'] }]);
  remove('qwen-extra', p);
  assert.deepEqual(Object.keys(read('paseo').agents.providers), ['codex']);
  assert.deepEqual(read('routes').routes.summarise, ['qwen-laptop']); assert.equal(read('routes').slots['qwen-extra'], undefined);
  assert.deepEqual(list(p), []);
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
  for (const name of ['bad', 'qwen-code', 'qwen-x-ro', 'Qwen-X', undefined]) await assert.rejects(add({ name, url: URL1, model: 'm1' }, p, opts()), /name must match/);
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
  assert.ok(e['qwen-x-ro'].label.endsWith('(read-only)'));
});
