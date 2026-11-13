import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEngines, discoverHost, plan, discoverAll } from '../discover.mjs';

// fake network: "host:port" -> models, "host:9091" -> stats body (absent = monitor down)
const net = ({ stats = {}, models = {} }) => async (url) => {
  const u = new URL(url); const k = `${u.hostname}:${u.port}`;
  if (u.pathname === '/api/stats') { if (!(k in stats)) throw new Error('down'); return { ok: true, json: async () => stats[k] }; }
  if (!(k in models)) throw new Error('refused');
  return { ok: true, json: async () => ({ data: models[k].map((id) => ({ id })) }) };
};

test('parseEngines: present, null, missing, offline', () => {
  assert.deepEqual(parseEngines({ engines: [{ port: 8888, status: 'online' }, { port: 8000, status: 'offline' }] }), [8888]);
  assert.equal(parseEngines({ engines: null }), null);
  assert.equal(parseEngines({}), null);
  assert.equal(parseEngines({ engines: [] }), null);
});

test('discoverHost: monitor engines are confirmed by /v1/models; guardrails and embedding are not chat', async () => {
  const f = net({ stats: { '10.0.0.1:9091': { engines: [{ port: 8000 }, { port: 8001 }, { port: 8005 }] } }, models: { '10.0.0.1:8000': ['NeMo-GuardRails'], '10.0.0.1:8001': ['Qwen-Embedding'], '10.0.0.1:8005': ['Qwen3.8-27B'] } });
  const r = await discoverHost('10.0.0.1', { f });
  assert.deepEqual(r.map((x) => [x.port, x.chat[0]]), [[8005, 'Qwen3.8-27B']]);
});

test('discoverHost: the served id comes from /v1/models, not the dashboard name', async () => {
  const f = net({ stats: { 'h:9091': { engines: [{ port: 8888, model: 'dashboard-name' }] } }, models: { 'h:8888': ['Qwen3.8-Flash-Next'] } });
  assert.equal((await discoverHost('h', { f }))[0].chat[0], 'Qwen3.8-Flash-Next');
});

test('discoverHost: engines null or monitor down falls back to a port scan', async () => {
  const models = { 'h:8888': ['Qwen3.8-Flash-Next'] };
  assert.equal((await discoverHost('h', { f: net({ stats: { 'h:9091': { engines: null } }, models }) }))[0].port, 8888);
  assert.equal((await discoverHost('h', { f: net({ models }) }))[0].port, 8888);
  assert.deepEqual(await discoverHost('h', { f: net({}) }), []);
});

test('plan: moved endpoint, new model, and no change', () => {
  const spec = { url: 'http://h:8000/v1', model: 'old' };
  assert.deepEqual(plan(spec, [{ host: 'h', port: 8888, chat: ['Qwen-New'] }]), { url: 'http://h:8888/v1', model: 'Qwen-New' });
  assert.deepEqual(plan(spec, [{ host: 'h', port: 8000, chat: ['new'] }]), { url: 'http://h:8000/v1', model: 'new' });
  assert.equal(plan(spec, [{ host: 'h', port: 8000, chat: ['old', 'x'] }]), null);
  assert.equal(plan(spec, []), null);
  assert.equal(plan(spec, [{ host: 'other', port: 1, chat: ['q'] }]), null);
});

function box(enabled) {
  const t = mkdtempSync(join(tmpdir(), 'ahub-disc-'));
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json') };
  writeFileSync(p.local, JSON.stringify({ extraProviders: { 'qwen-a': { type: 'qwen-code', url: 'http://h:8000/v1', model: 'old' }, 'qwen-b': { type: 'qwen-code', url: 'http://elsewhere:8000/v1', model: 'm' } } }));
  writeFileSync(p.paseo, JSON.stringify({ agents: { providers: { 'qwen-a': enabled === undefined ? {} : { enabled } } } }));
  return p;
}
const f = net({ models: { 'h:8888': ['Qwen3.8-Flash-Next'], 'elsewhere:8888': ['Q'] } });

test('discoverAll repoints only discovery-host providers and calls edit once', async () => {
  const calls = []; const ch = await discoverAll({ p: box(), hosts: ['h'], f, edit: async (n, to) => calls.push([n, to]) });
  assert.deepEqual(calls, [['qwen-a', { url: 'http://h:8888/v1', model: 'Qwen3.8-Flash-Next' }]]);
  assert.equal(ch.length, 1);
});

test('discoverAll: enabled:false stays untouched; dry run edits nothing; no change = no call', async () => {
  const calls = []; const edit = async (...a) => calls.push(a);
  assert.deepEqual(await discoverAll({ p: box(false), hosts: ['h'], f, edit }), []);
  assert.equal((await discoverAll({ p: box(), hosts: ['h'], f, edit, dry: true })).length, 1);
  assert.equal(calls.length, 0);
  assert.equal((await discoverAll({ p: box(), hosts: ['h'], f: net({ models: { 'h:8000': ['Qwen-old'] } }), edit })).length, 1); // same port, new model id
  assert.equal(calls.length, 1);
});

test('discoverAll: unchanged endpoint and model makes no change', async () => {
  const p = box(); writeFileSync(p.local, JSON.stringify({ extraProviders: { 'qwen-a': { type: 'qwen-code', url: 'http://h:8000/v1', model: 'Qwen-same' } } }));
  assert.deepEqual(await discoverAll({ p, hosts: ['h'], f: net({ models: { 'h:8000': ['Qwen-same'] } }), edit: async () => assert.fail('no edit') }), []);
});
