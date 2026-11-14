import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modeProxy, RO_MODE, cleanModelId, cleanConfigOptions, cleanUpdate } from '../acp-proxy.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));
const spawned = [];
const launch = (ro) => { spawned.push(ro); return spawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, FAKE_RO: ro ? '1' : '0' } }); };
function session() {
  const input = new PassThrough(), output = new PassThrough(); const got = []; let n = 0;
  output.setEncoding('utf8'); let buf = '';
  const waiters = new Map();
  output.on('data', (d) => { buf += d; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls) { const m = JSON.parse(l); got.push(m); if (m.id !== undefined) waiters.get(m.id)?.(m); } });
  const p = modeProxy({ input, output, timeoutMs: 8000, spawnAgent: launch });
  const call = (method, params) => new Promise((res) => { const id = ++n; waiters.set(id, res); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const prompt = async (sessionId, text) => { const before = got.length; const r = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }); return { r, text: got.slice(before).map((m) => m.params?.update?.content?.text).filter(Boolean).join('') }; };
  return { p, call, prompt, got, close: () => { input.end(); p.kill(); } };
}
const open = async (s) => { await s.call('initialize', { protocolVersion: 1 }); return (await s.call('session/new', { cwd: '.', mcpServers: [] })).result; };

test('session/new offers the read-only mode next to the agent own modes', async () => {
  const s = session(); const r = await open(s);
  assert.deepEqual(r.modes.availableModes.map((m) => m.id), ['default', 'plan', RO_MODE.id]);
  assert.equal(r.modes.currentModeId, 'default'); s.close();
});

test('normal session (default mode): the agent starts normal, an edit works', async () => {
  spawned.length = 0; const s = session(); const r = await open(s);
  const f = join(mkdtempSync(join(tmpdir(), 'acpp-')), 'w.txt');
  const a = await s.prompt(r.sessionId, `WRITE ${f}`);
  assert.equal(a.text, 'WROTE'); assert.ok(existsSync(f)); assert.deepEqual(spawned, [false]); s.close();
});

test('read-only mode chosen before the first prompt: qwen is restarted read-only, the SAME session id keeps working, a write and a sensitive read are refused', async () => {
  spawned.length = 0; const s = session(); const r = await open(s);
  const d = mkdtempSync(join(tmpdir(), 'acpp-')); const f = join(d, 'w.txt'); writeFileSync(join(d, '.env'), 'SECRET=1'); writeFileSync(join(d, 'a.txt'), 'plain');
  const m = await s.call('session/set_mode', { sessionId: r.sessionId, modeId: RO_MODE.id });
  assert.deepEqual(m.result, {}); assert.deepEqual(spawned, [false, true], 'one restart, read-only');
  assert.equal((await s.prompt(r.sessionId, `WRITE ${f}`)).text, 'REFUSED write'); assert.ok(!existsSync(f));
  assert.equal((await s.prompt(r.sessionId, `READ ${join(d, '.env')}`)).text, 'REFUSED sensitive read');
  assert.equal((await s.prompt(r.sessionId, `READ ${join(d, 'a.txt')}`)).text, 'READ plain');
  assert.match((await s.prompt(r.sessionId, 'MODE')).text, /MODE plan RO true/, 'the restarted agent runs in its own plan mode too');
  s.close();
});

test('read-only is refused after a prompt, and a read-only session refuses another mode; other modes pass through untouched', async () => {
  const s = session(); const r = await open(s);
  assert.deepEqual((await s.call('session/set_mode', { sessionId: r.sessionId, modeId: 'plan' })).result, {});
  assert.match((await s.prompt(r.sessionId, 'MODE')).text, /MODE plan RO false/);
  assert.match((await s.call('session/set_mode', { sessionId: r.sessionId, modeId: RO_MODE.id })).error.message, /before the first prompt/); s.close();
  const t = session(); const q = await open(t); await t.call('session/set_mode', { sessionId: q.sessionId, modeId: RO_MODE.id });
  assert.match((await t.call('session/set_mode', { sessionId: q.sessionId, modeId: 'default' })).error.message, /read-only/);
  assert.deepEqual((await t.call('session/set_mode', { sessionId: q.sessionId, modeId: RO_MODE.id })).result, {}); t.close();
});

test('a legacy read-only launch (initialReadOnly) is read-only from the first message', () => {
  const input = new PassThrough(), output = new PassThrough(); spawned.length = 0;
  const p = modeProxy({ input, output, initialReadOnly: true, spawnAgent: launch });
  assert.deepEqual(spawned, [true]); input.end(); p.kill();
});

test('deny by default: an unknown or missing mode id restarts the agent read-only, never normal', async () => {
  for (const params of [{ modeId: 'bogus-mode' }, {}]) {
    spawned.length = 0; const s = session(); const r = await open(s);
    const d = mkdtempSync(join(tmpdir(), 'acpp-')); const f = join(d, 'w.txt');
    assert.deepEqual((await s.call('session/set_mode', { sessionId: r.sessionId, ...params })).result, {});
    assert.deepEqual(spawned, [false, true]);
    assert.equal((await s.prompt(r.sessionId, `WRITE ${f}`)).text, 'REFUSED write'); assert.ok(!existsSync(f)); s.close();
  }
});

test('models: only the launched model is advertised, under its plain id; set_model maps back to the runtime id', async () => {
  process.env.FAKE_MODELS = '1';
  try {
    const s = session(); const r = await open(s);
    assert.deepEqual(r.models.availableModels.map((m) => [m.modelId, m.name]), [['Big-Model', 'Big-Model']]);
    assert.equal(r.models.currentModelId, 'Big-Model');
    await s.call('session/set_model', { sessionId: r.sessionId, modelId: 'Big-Model' });
    assert.equal((await s.prompt(r.sessionId, 'HI')).text, 'MODE model=$runtime|openai|Big-Model(openai) RO false');
    s.close();
  } finally { delete process.env.FAKE_MODELS; }
  assert.equal(cleanModelId('$runtime|openai|A-b_1.2(openai)'), 'A-b_1.2'); assert.equal(cleanModelId('plain'), 'plain');
});

test('qwen >= 0.26 ids ("<id>(openai)") are plain in models AND configOptions; the model selector maps back on set_config_option', async () => {
  process.env.FAKE_MODELS = '1';
  try {
    const s = session(); const r = await open(s);
    const model = r.configOptions.find((o) => o.id === 'model');
    assert.deepEqual([model.currentValue, model.options.map((o) => [o.value, o.name])], ['Big-Model', [['Big-Model', 'Big-Model']]]);
    assert.equal(r.configOptions.find((o) => o.id === 'mode').currentValue, 'auto', 'other options untouched');
    await s.call('session/set_config_option', { sessionId: r.sessionId, configId: 'model', value: 'Big-Model' });
    assert.equal((await s.prompt(r.sessionId, 'HI')).text, 'MODE cfg=model:$runtime|openai|Big-Model(openai) RO false');
    s.close();
  } finally { delete process.env.FAKE_MODELS; }
});
test('the captured qwen 0.26.7 payload and streamed updates lose the "(openai)" suffix', () => {
  const back = new Map();
  const opts = cleanConfigOptions([{ id: 'model', currentValue: 'Qwen3.8-27B(openai)', options: [{ value: 'Qwen3.8-27B(openai)', name: 'office-qwen', description: '' }] }], back);
  assert.deepEqual(opts[0].options, [{ value: 'Qwen3.8-27B', name: 'Qwen3.8-27B', description: '' }]); assert.equal(back.get('Qwen3.8-27B'), 'Qwen3.8-27B(openai)');
  assert.equal(cleanUpdate({ sessionUpdate: 'current_model_update', currentModelId: 'Qwen3.8-27B(openai)' }, back).currentModelId, 'Qwen3.8-27B');
  assert.equal(cleanUpdate({ configOptions: [{ id: 'model', currentValue: 'A(openai)', options: [{ value: 'A(openai)', name: 'x' }] }] }, back).configOptions[0].currentValue, 'A');
  for (const [a, b] of [['Qwen3.8-27B(openai)', 'Qwen3.8-27B'], ['Qwen3.8-27B-NVFP-Cluster', 'Qwen3.8-27B-NVFP-Cluster'], ['qwen35-9b', 'qwen35-9b']]) assert.equal(cleanModelId(a), b);
});

test('mcp grant: granted servers are added to session/new, the hub preamble leads the first prompt, tool calls are logged; a nasty prompt arrives byte-for-byte', async () => {
  const input = new PassThrough(), output = new PassThrough(); const sent = [];
  const fake = { stdin: new PassThrough(), stdout: new PassThrough(), on() {}, kill() {} };
  fake.stdin.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) sent.push(JSON.parse(l)); });
  const log = join(mkdtempSync(join(tmpdir(), 'acpt-')), 'tools.jsonl');
  const mcp = { servers: [{ name: 'swing', command: 'node', args: ['s.js'], env: [] }], preamble: 'PRE\n' };
  modeProxy({ input, output, spawnAgent: () => fake, allowRo: false, mcp, toolLog: log });
  const send = (m) => input.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const wait = () => new Promise((r) => setTimeout(r, 80));
  send({ id: 1, method: 'session/new', params: { cwd: '.', mcpServers: [{ name: 'paseo', type: 'http', url: 'u' }] } }); await wait();
  fake.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sessionId: 'S', modes: { currentModeId: 'd', availableModes: [{ id: 'd', name: 'd' }] } } }) + '\n'); await wait();
  const nasty = 'say "hi" \'x\'\nC:\Users\dev\a b\c.txt\n%PATH% $(x) `y` & | > ^';
  send({ id: 2, method: 'session/prompt', params: { sessionId: 'S', prompt: [{ type: 'text', text: nasty }] } }); await wait();
  send({ id: 3, method: 'session/prompt', params: { sessionId: 'S', prompt: [{ type: 'text', text: 'again' }] } }); await wait();
  fake.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'mcp__swing__click', rawInput: { x: 1 } } } }) + '\n'); await wait();
  const sn = sent.find((m) => m.method === 'session/new');
  assert.deepEqual(sn.params.mcpServers.map((x) => x.name), ['paseo', 'swing']);
  const p = sent.filter((m) => m.method === 'session/prompt');
  assert.equal(p[0].params.prompt[0].text, 'PRE\n'); assert.equal(p[0].params.prompt[1].text, nasty);
  assert.equal(p[1].params.prompt.length, 1); // preamble only once
  assert.match(readFileSync(log, 'utf8'), /mcp__swing__click/);
  input.end();
});
