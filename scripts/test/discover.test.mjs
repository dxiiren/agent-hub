import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEngines, discoverHost, plan, discoverAll, expandPorts } from '../discover.mjs';

// fake network: "host:port" -> models, "host:9091" -> stats body (absent = monitor down); chat completions answer unless chatFail
const net = ({ stats = {}, models = {}, chatFail = false }) => async (url, init) => {
  const u = new URL(url); const k = `${u.hostname}:${u.port}`;
  if (u.pathname === '/api/stats') { if (!(k in stats)) throw new Error('down'); return { ok: true, json: async () => stats[k] }; }
  if (!(k in models)) throw new Error('refused');
  if (u.pathname.endsWith('/chat/completions')) return { ok: !chatFail, json: async () => ({ choices: [{}] }) };
  return { ok: true, json: async () => ({ data: models[k].map((id) => ({ id })) }) };
};
const ALLOW = [8000, 8001, 8005, 8888];

test('expandPorts: numbers and ranges', () => { assert.deepEqual(expandPorts([8000, '8002-8004', 'x']), [8000, 8002, 8003, 8004]); });

test('parseEngines: present, null, missing, offline', () => {
  assert.deepEqual(parseEngines({ engines: [{ port: 8888, status: 'online' }, { port: 8000, status: 'offline' }] }), [8888]);
  assert.equal(parseEngines({ engines: null }), null);
  assert.equal(parseEngines({}), null);
  assert.equal(parseEngines({ engines: [] }), null);
});

test('discoverHost: monitor engines are confirmed by /v1/models; guardrails and embedding are not chat', async () => {
  const f = net({ stats: { 'h:9091': { engines: [{ port: 8000 }, { port: 8001 }, { port: 8005 }] } }, models: { 'h:8000': ['NeMo-GuardRails'], 'h:8001': ['Qwen-Embedding'], 'h:8005': ['Qwen3.8-27B'] } });
  assert.deepEqual((await discoverHost('h', { f, allow: ALLOW })).map((x) => [x.port, x.chat[0]]), [[8005, 'Qwen3.8-27B']]);
});

test('discoverHost: the served id comes from /v1/models, not the dashboard name', async () => {
  const f = net({ stats: { 'h:9091': { engines: [{ port: 8888, model: 'dashboard-name' }] } }, models: { 'h:8888': ['Qwen3.8-Flash-Next'] } });
  assert.equal((await discoverHost('h', { f, allow: ALLOW }))[0].chat[0], 'Qwen3.8-Flash-Next');
});

test('discoverHost: engines null or monitor down falls back to scanning the allowlist', async () => {
  const models = { 'h:8888': ['Qwen3.8-Flash-Next'] };
  assert.equal((await discoverHost('h', { f: net({ stats: { 'h:9091': { engines: null } }, models }), allow: ALLOW }))[0].port, 8888);
  assert.equal((await discoverHost('h', { f: net({ models }), allow: ALLOW }))[0].port, 8888);
  assert.deepEqual(await discoverHost('h', { f: net({}), allow: ALLOW }), []);
});

test('a port outside the allowlist is refused (monitor claim and scan alike)', async () => {
  const f = net({ stats: { 'h:9091': { engines: [{ port: 9999 }] } }, models: { 'h:9999': ['Qwen-Evil'] } });
  assert.deepEqual(await discoverHost('h', { f, allow: ALLOW }), []);
  assert.deepEqual(await discoverHost('h', { f, allow: [] }), []);
});

test('plan: moved endpoint, new model, and no change; the host never changes', () => {
  const spec = { url: 'http://h:8000/v1', model: 'old' };
  assert.deepEqual(plan(spec, [{ host: 'h', port: 8888, chat: ['Qwen-New'] }]), { url: 'http://h:8888/v1', model: 'Qwen-New' });
  assert.deepEqual(plan(spec, [{ host: 'h', port: 8000, chat: ['new'] }]), { url: 'http://h:8000/v1', model: 'new' });
  assert.equal(plan(spec, [{ host: 'h', port: 8000, chat: ['old', 'x'] }]), null);
  assert.equal(plan(spec, []), null);
  assert.equal(plan(spec, [{ host: 'other', port: 1, chat: ['q'] }]), null);
});

function box({ enabled, key } = {}) {
  const t = mkdtempSync(join(tmpdir(), 'ahub-disc-'));
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), state: join(t, 'state.json') };
  writeFileSync(p.local, JSON.stringify({ discoverPorts: { h: ALLOW }, extraProviders: { 'qwen-a': { type: 'qwen-code', url: 'http://h:8000/v1', model: 'old', ...(key ? { key } : {}) }, 'qwen-b': { type: 'qwen-code', url: 'http://elsewhere:8000/v1', model: 'm' } } }));
  writeFileSync(p.paseo, JSON.stringify({ agents: { providers: { 'qwen-a': enabled === undefined ? {} : { enabled } } } }));
  return p;
}
const f = net({ models: { 'h:8888': ['Qwen3.8-Flash-Next'], 'elsewhere:8888': ['Q'] } }); // h:8000 is dead
const run = (p, o = {}) => discoverAll({ p, hosts: ['h'], f, stateFile: p.state, ...o });

test('fewer than 3 consecutive failures changes nothing; the 3rd repoints; a healthy tick resets the counter', async () => {
  const p = box(); const calls = []; const edit = async (n, to) => calls.push([n, to]);
  assert.deepEqual(await run(p, { edit }), []); assert.deepEqual(await run(p, { edit }), []); assert.equal(calls.length, 0);
  const ch = await run(p, { edit });
  assert.equal(ch.length, 1); assert.deepEqual(calls, [['qwen-a', { url: 'http://h:8888/v1', model: 'Qwen3.8-Flash-Next' }]]);
  const q = box(); await run(q, { edit }); await run(q, { edit });
  await run(q, { edit, f: net({ models: { 'h:8000': ['old'] } }) }); // current endpoint answers: counter back to 0
  assert.deepEqual(await run(q, { edit }), []); assert.equal(calls.length, 1);
});

test('a keyed provider is never edited, only proposed in the log', async () => {
  const p = box({ key: 'k' }); const lines = []; const edit = async () => assert.fail('keyed edit');
  assert.deepEqual(await run(p, { edit, log: (m) => lines.push(m) }), []);
  assert.ok(lines.some((l) => /^PROPOSAL qwen-a/.test(l)));
});

test('a wrong model family or a failing chat completion is refused', async () => {
  const edit = async () => assert.fail('edit');
  for (const fx of [net({ models: { 'h:8888': ['Llama-3-guard'] } }), net({ models: { 'h:8888': ['Qwen3.8-Flash-Next'] }, chatFail: true })]) {
    const p = box(); for (let i = 0; i < 4; i++) assert.deepEqual(await run(p, { edit, f: fx }), []);
  }
});

test('enabled:false stays untouched; dry run edits nothing; other hosts untouched', async () => {
  const edit = async () => assert.fail('edit');
  const off = box({ enabled: false }); for (let i = 0; i < 4; i++) assert.deepEqual(await run(off, { edit }), []);
  const p = box(); for (let i = 0; i < 2; i++) await run(p, { edit });
  assert.equal((await run(p, { edit, dry: true })).length, 1); // dry run reports the 3rd-tick repoint but never calls edit
});
