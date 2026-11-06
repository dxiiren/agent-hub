import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, findServerDir, loadSpec } from '../paseo-web-patch.mjs';
import { catalogEntries } from '../catalog-entries.mjs';
import { KINDS } from '../provider-kinds.mjs';

const BUNDLE = '_expo/static/js/web/index-0123456789abcdef0123456789abcdef.js';
const SRC = 'A;ANCHOR1;B;ANCHOR2;C';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const spec = (over = {}) => ({ paseo: '9.9.9', bundle: BUNDLE, sha256: sha(SRC), edits: [{ name: 'one', find: 'ANCHOR1', replace: '/*agent-hub-catalog*/X1' }, { name: 'two', find: 'ANCHOR2', replace: 'X2' }], ...over });
function install({ version = '9.9.9', src = SRC } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-webpatch-'));
  const ui = join(dir, 'dist', 'server', 'web-ui');
  mkdirSync(join(ui, '_expo/static/js/web'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(ui, BUNDLE), src);
  writeFileSync(join(ui, 'index.html'), `<html><script src="/${BUNDLE}"></script></html>`);
  const snap = () => [BUNDLE, 'index.html'].map((f) => sha(readFileSync(join(ui, f))));
  return { dir, ui, snap };
}

test('catalog entries are generated from the kinds schema and are searchable by endpoint-server names', () => {
  const e = catalogEntries();
  assert.deepEqual(e.map((x) => x.agentHub.kind), Object.keys(KINDS));
  const qwen = e.find((x) => x.agentHub.kind === 'qwen-code');
  for (const w of ['qwen', 'openai', 'ollama', 'vllm', 'sglang', 'lm studio']) assert.ok(qwen.keywords.includes(w), w);
  for (const k of ['codex', 'claude', 'qoder', 'opencode']) assert.ok(e.find((x) => x.agentHub.kind === k)?.keywords.includes(k), k);
  assert.ok(e.every((x) => x.id.startsWith('agent-hub-') && x.title && x.agentHub.plugin && x.agentHub.screen));
});

test('apply patches once: new hashed bundle, index.html (+gz) repointed, original untouched, catalog written; second apply changes nothing', () => {
  const { ui, dir, snap } = install();
  const before = snap();
  assert.equal(run('apply', { serverDir: dir, spec: spec() }).state, 'applied');
  const html = readFileSync(join(ui, 'index.html'), 'utf8');
  const ref = html.match(/_expo\/static\/js\/web\/index-[0-9a-f]+\.js/)[0];
  assert.notEqual(ref, BUNDLE);
  assert.equal(readFileSync(join(ui, ref), 'utf8'), 'A;/*agent-hub-catalog*/X1;B;X2;C');
  assert.equal(gunzipSync(readFileSync(join(ui, `${ref}.gz`))).toString(), readFileSync(join(ui, ref), 'utf8'));
  assert.equal(gunzipSync(readFileSync(join(ui, 'index.html.gz'))).toString(), html);
  assert.equal(sha(readFileSync(join(ui, BUNDLE))), before[0], 'the original bundle file is never modified');
  assert.equal(JSON.parse(readFileSync(join(ui, 'agent-hub-catalog.json'), 'utf8')).length, Object.keys(KINDS).length);
  const after = [html, readFileSync(join(ui, ref), 'utf8')];
  assert.equal(run('apply', { serverDir: dir, spec: spec() }).state, 'patched');
  assert.deepEqual([readFileSync(join(ui, 'index.html'), 'utf8'), readFileSync(join(ui, ref), 'utf8')], after);
  assert.equal(run('status', { serverDir: dir, spec: spec() }).state, 'patched');
});

test('restore points index.html back at the original bundle and removes the catalog', () => {
  const { ui, dir, snap } = install();
  const before = snap();
  run('apply', { serverDir: dir, spec: spec() });
  assert.equal(run('restore', { serverDir: dir, spec: spec() }).state, 'restored');
  assert.deepEqual(snap(), before);
  assert.equal(existsSync(join(ui, 'agent-hub-catalog.json')), false);
  assert.equal(run('status', { serverDir: dir, spec: spec() }).state, 'unpatched');
});

test('a different Paseo version, a different bundle hash or an anchor that is not unique: skipped with a reason, nothing changes', () => {
  for (const [inst, sp, re] of [
    [{ version: '9.9.8' }, spec(), /no patch for Paseo 9\.9\.8/],
    [{ src: SRC + ' changed' }, spec(), /differs from the one the patch was written for/],
    [{}, spec({ edits: [{ name: 'dup', find: ';', replace: ',' }] }), /matches 4 times/],
    [{}, spec({ edits: [{ name: 'gone', find: 'NOPE', replace: 'x' }] }), /matches 0 times/],
  ]) {
    const { dir, snap } = install(inst);
    const before = snap();
    const r = run('apply', { serverDir: dir, spec: sp });
    assert.equal(r.state, 'skipped');
    assert.match(r.reason, re);
    assert.deepEqual(snap(), before);
  }
  assert.equal(run('apply', { serverDir: join(tmpdir(), 'ahub-no-such-dir-x'), spec: spec() }).state, 'skipped');
});

test('the shipped patch matches the installed Paseo web bundle (skipped when that Paseo version is not installed)', (t) => {
  const dir = findServerDir();
  if (!dir) return t.skip('no Paseo install');
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  const s = loadSpec(version);
  if (!s) return t.skip(`no patch for Paseo ${version}`);
  const f = join(dir, 'dist', 'server', 'web-ui', s.bundle);
  if (!existsSync(f)) return t.skip('bundle already patched or replaced');
  const buf = readFileSync(f);
  assert.equal(sha(buf), s.sha256);
  const text = buf.toString('utf8');
  for (const e of s.edits) assert.equal(text.split(e.find).length - 1, 1, e.name);
});

test('a newer patch revision re-patches from the untouched original and drops the stale bundle; replaceFile edits load from their file', () => {
  const { ui, dir, snap } = install();
  const before = snap();
  run('apply', { serverDir: dir, spec: spec() });
  const old = readFileSync(join(ui, 'index.html'), 'utf8').match(/_expo\/static\/js\/web\/index-[0-9a-f]+\.js/)[0];
  const v2 = spec({ rev: 2, edits: [{ name: 'one', find: 'ANCHOR1', replace: '/*agent-hub-catalog*//*agent-hub-rev:2*/Y1' }, { name: 'two', find: 'ANCHOR2', replace: 'Y2' }] });
  assert.equal(run('apply', { serverDir: dir, spec: v2 }).state, 'applied');
  const ref = readFileSync(join(ui, 'index.html'), 'utf8').match(/_expo\/static\/js\/web\/index-[0-9a-f]+\.js/)[0];
  assert.notEqual(ref, old);
  assert.equal(readFileSync(join(ui, ref), 'utf8'), 'A;/*agent-hub-catalog*//*agent-hub-rev:2*/Y1;B;Y2;C');
  assert.equal(existsSync(join(ui, old)), false, 'stale patched bundle removed');
  assert.equal(run('apply', { serverDir: dir, spec: v2 }).state, 'patched', 'same revision again: idempotent');
  run('restore', { serverDir: dir, spec: v2 });
  assert.deepEqual(snap(), before);
  const s = loadSpec('0.15.2');
  const pick = s.edits.find((e) => e.name === 'model-picker-component');
  assert.ok(pick.replace.includes('/*agent-hub-rev:' + s.rev + '*/') && pick.replace.endsWith(pick.find), 'component source loaded and ends with the anchor it precedes');
});

// ---- the logic the patch injects, run for real with stubbed browser globals (verifier D: plugin-page reload and schedule hint were UNTESTED)
import vm from 'node:vm';
const shipped = () => loadSpec('0.15.2');
const edit = (name) => shipped().edits.find((e) => e.name === name);
const grab = (src, fn) => { const i = src.indexOf(`function ${fn}(`); assert.ok(i >= 0, fn); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } throw new Error('unbalanced'); };

function reconnectHarness({ health, session = {} } = {}) {
  const src = grab(edit('plugin-screen-reconnect').replace, '__AhRe');
  const timers = []; let reloads = 0, cleanup = null; const store = { ...session };
  const ctx = vm.createContext({
    l: { useEffect: (fn) => { cleanup = fn(); } }, T: { jsx: (...a) => a }, n: { Text: 'Text' }, k: { message: 'm' },
    setInterval: (f) => { timers.push(f); return timers.length; }, clearInterval: () => {},
    fetch: async () => { const v = health.shift(); if (v instanceof Error) throw v; return { ok: v }; },
    sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    location: { reload: () => { reloads++; } }, Date: { now: () => ctx.__now }, __now: 100_000, String, Number,
  });
  vm.runInContext(src + ';this.__AhRe=__AhRe;', ctx);
  ctx.__AhRe({ t: 'Plugin offline' });
  return { tick: () => timers.at(-1)(), reloads: () => reloads, ctx, store, stop: () => cleanup?.() };
}
test('plugin page: reloads once the daemon answers again after it was down; never while it is still down', async () => {
  const h = reconnectHarness({ health: [new Error('refused'), new Error('refused'), true] });
  await h.tick(); await h.tick(); assert.equal(h.reloads(), 0, 'down: no reload');
  await h.tick(); assert.equal(h.reloads(), 1, 'back: reload');
  h.stop();
});
test('plugin page: the message shown while the daemon already answers reloads too (no stuck screen), but at most every 10 s and 20 times', async () => {
  const h = reconnectHarness({ health: [true, true, true] });
  await h.tick(); assert.equal(h.reloads(), 1);
  await h.tick(); assert.equal(h.reloads(), 1, 'within 10 s of the last reload: wait');
  h.ctx.__now += 11_000; await h.tick(); assert.equal(h.reloads(), 2);
  const capped = reconnectHarness({ health: [true], session: { 'ah-rl-t': '0', 'ah-rl-c': '20' } });
  await capped.tick(); assert.equal(capped.reloads(), 0, 'cap reached: a plugin that truly failed does not reload forever');
});
test('schedule form hint lists exactly what is missing, nothing for a heartbeat or a complete form', () => {
  const ctx = vm.createContext({}); vm.runInContext(grab(edit('schedule-missing-fn').replace, '__AhMissing') + ';this.f=__AhMissing;', ctx); const F = (a, b) => [...ctx.f(a, b)]; // same realm for deepEqual
  const full = { targetKind: 'new', workingDir: '/p', selectedProvider: 'x', selectedModel: 'm', prompt: 'do', submitCadence: { type: 'cron' } };
  assert.deepEqual(F(full, null), []);
  assert.deepEqual(F({ ...full, workingDir: ' ', selectedModel: '' }, null), ['a project', 'a model']);
  assert.deepEqual(F({ ...full, prompt: '', submitCadence: null }, null), ['a prompt', 'a valid cadence']);
  assert.deepEqual(F(full, 'bad cron'), ['a valid cadence']);
  assert.deepEqual(F({ targetKind: 'agent' }, null), []);
});
test('the switch read-back edit refetches the plugin list again after the daemon has applied the change', () => {
  const r = edit('plugin-switch-readback').replace;
  const calls = []; const ctx = vm.createContext({ ce: () => {}, fe: async () => { calls.push('fetch'); }, setTimeout: (f, ms) => calls.push(`t${ms}`) });
  vm.runInContext(`const o={};let je;o.x=0;${r.replace(/^je=/, 'je=')};je("ok").then(()=>{})`, ctx);
  return new Promise((ok) => setImmediate(() => { assert.deepEqual(calls, ['fetch', 't1200', 't3500']); ok(); }));
});
