import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modeProxy, RO_MODE } from '../acp-proxy.mjs';

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
