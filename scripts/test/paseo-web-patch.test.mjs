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
  assert.ok(s.edits.some((e) => e.replace.includes('/*agent-hub-rev:' + s.rev + '*/')) && pick.replace.endsWith(pick.find), 'component source loaded and ends with the anchor it precedes');
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
  assert.deepEqual(F({ ...full, workingDir: ' ', selectedModel: '' }, null), ['Choose a project', 'Choose a model']);
  assert.deepEqual(F({ ...full, prompt: '', submitCadence: null }, null), ['Write a prompt', 'Fix the cadence (for example 0 9 * * * runs every day at 09:00)']);
  assert.deepEqual(F(full, 'bad cron'), ['Fix the cadence (for example 0 9 * * * runs every day at 09:00)']);
  assert.deepEqual(F({ targetKind: 'agent' }, null), []);
});
test('the switch read-back edit refetches the plugin list again after the daemon has applied the change', () => {
  const r = edit('plugin-switch-readback').replace;
  const calls = []; const ctx = vm.createContext({ ce: () => {}, fe: async () => { calls.push('fetch'); }, setTimeout: (f, ms) => calls.push(`t${ms}`) });
  vm.runInContext(`const o={};let je;o.x=0;${r.replace(/^je=/, 'je=')};je("ok").then(()=>{})`, ctx);
  return new Promise((ok) => setImmediate(() => { assert.deepEqual(calls, ['fetch', 't1200', 't3500']); ok(); }));
});

test('the schedule hint uses a plain DOM element: that module exports no Text (React error #130 took the whole Schedules page down live)', () => {
  const r = edit('schedule-missing-use').replace;
  assert.ok(r.includes('jsx)("div"') && !/t\.Text/.test(r));
});

test('config patch: the new value is cached at once (nested objects merged), then the daemon answer, then a read-back; a failed save re-reads and rethrows', async () => {
  const body = edit("config-read-back").replace.replace(/}$/, ""); // the injected text ends with the closing brace of patchConfig
  const make = (patchImpl) => {
    const cache = [{ idleRuntimeCleanup: true, features: { dictation: { enabled: true }, webUi: { enabled: true }, voiceMode: { enabled: false, stt: { provider: 'local' } } } }]; const seen = [];
    const C = { setQueryData: (_k, v) => { const nv = typeof v === 'function' ? v(cache.at(-1)) : v; cache.push(nv); seen.push(nv); } };
    const h = { patchDaemonConfig: patchImpl, getDaemonConfig: async () => ({ config: { fresh: true } }) };
    const fn = vm.runInContext(`(async (n,h,C,w)=>{${body}})`, vm.createContext({}));
    return { run: (n) => fn(n, h, C, 'k'), seen };
  };
  const ok = make(async (n) => ({ config: { fromDaemon: n } }));
  assert.deepEqual(JSON.parse(JSON.stringify(await ok.run({ idleRuntimeCleanup: false, features: { dictation: { enabled: false } } }))), { fromDaemon: { idleRuntimeCleanup: false, features: { dictation: { enabled: false } } } });
  assert.deepEqual(JSON.parse(JSON.stringify(ok.seen[0])), { idleRuntimeCleanup: false, features: { dictation: { enabled: false }, webUi: { enabled: true }, voiceMode: { enabled: false, stt: { provider: 'local' } } } }, 'optimistic value first, siblings kept');
  const deep = make(async (n) => ({ config: n })); await deep.run({ features: { voiceMode: { enabled: true } } });
  assert.deepEqual(JSON.parse(JSON.stringify(deep.seen[0])).features.voiceMode, { enabled: true, stt: { provider: 'local' } }, 'a deep patch keeps the sibling keys (voice page reads stt.provider)');
  assert.ok(ok.seen[1].fromDaemon, 'then the daemon answer');
  await new Promise((r) => setImmediate(r)); assert.deepEqual(JSON.parse(JSON.stringify(ok.seen.at(-1))), { fresh: true }, 'then the read-back');
  const bad = make(async () => { throw new Error('nope'); });
  await assert.rejects(bad.run({ idleRuntimeCleanup: false }), /nope/);
  await new Promise((r) => setImmediate(r)); assert.deepEqual(JSON.parse(JSON.stringify(bad.seen.at(-1))), { fresh: true }, 'a failed save is rolled back by a read');
});
test('the plugin Reload menu item says why it is disabled', () => {
  const e = edit('plugin-reload-hint'); assert.match(e.replace, /l\.enabled\?B:B\+"[^"]*enable the plugin/);
});

test('Add model picker: only models the provider does not already offer (case-insensitive, "(label)" suffix and provider prefix ignored); none left -> empty-state text', () => {
  const src = edit('model-picker-component').replace;
  const ctx = vm.createContext({ String, Set });
  vm.runInContext(grab(src, '__AhFresh') + ';this.f=__AhFresh;', ctx);
  const m = (...ids) => ids.map((id) => ({ id }));
  assert.deepEqual(ctx.f(m('A', 'b', 'c'), ['a', 'B ']).map((x) => x.id), ['c'], 'case-insensitive, trimmed');
  assert.deepEqual(ctx.f(m('gpt-6 (openai)', 'x'), ['GPT-6']).map((x) => x.id), ['x'], '(label) suffix ignored');
  assert.deepEqual(ctx.f(m('office/Qwen3', 'Other'), ['Qwen3']).map((x) => x.id), ['Other'], 'provider prefix ignored');
  assert.deepEqual(ctx.f(m('a'), ['a']), [], 'everything already offered -> empty');
  assert.deepEqual(ctx.f([{ id: '' }, null, { id: 'z' }], undefined).map((x) => x.id), ['z'], 'junk rows dropped');
  assert.ok(src.includes('All models from this provider are already added') && src.includes('Other model (type its id)'), 'empty state text + custom entry kept');
});

test('schedule Max runs: whole numbers 1-999999 or empty; anything else is named in the hint and blocks Create', () => {
  const ctx = vm.createContext({}); vm.runInContext(grab(edit('schedule-missing-fn').replace, '__AhMissing') + ';this.f=__AhMissing;' + grab(edit('schedule-missing-fn').replace, '__AhBad') + ';this.b=__AhBad;', ctx);
  const full = { targetKind: 'new', workingDir: '/p', selectedProvider: 'x', selectedModel: 'm', prompt: 'do', submitCadence: { type: 'cron' } };
  for (const ok of ['', '1', '10', '999999']) { assert.equal(ctx.b({ ...full, maxRuns: ok }), false, ok); assert.deepEqual([...ctx.f({ ...full, maxRuns: ok }, null)], [], ok); }
  for (const bad of ['0', 'abc', '-5', '1.5', '99999999999999999999', '1000000']) { assert.equal(ctx.b({ ...full, maxRuns: bad }), true, bad); assert.match(ctx.f({ ...full, maxRuns: bad }, null)[0], /^Max runs must be a whole number from 1 to 999999/, bad); }
});
test('model pickers hide providers that cannot run; the newest model becomes the default', () => {
  const pick = edit('picker-hide-broken').replace; assert.ok(pick.includes('"error"!==o.status') && pick.includes('"unavailable"!==o.status'));
  const ctx = vm.createContext({}); vm.runInContext(grab(edit('default-newest').replace, '__ahNew') + ';this.f=__ahNew;', ctx);
  const rows = [{ id: 'o5', description: 'Opus 5 - Previous release', isDefault: true }, { id: 'o55', description: 'Opus 5.5 - Latest release' }];
  assert.deepEqual(ctx.f(rows).map((r) => [r.id, !!r.isDefault]), [['o5', false], ['o55', true]]);
  assert.deepEqual(ctx.f([{ id: 'a', isDefault: true }]).map((r) => r.id), ['a'], 'no release note: unchanged');
});
test('custom model sheet: ids over 200 characters, custom duplicates and models the provider already offers are refused', () => {
  const v = edit('custom-model-valid').replace; assert.ok(v.includes('P.length<=200') && v.includes('__ahHave'));
  assert.ok(edit('custom-model-msg').replace.includes('__AhMsg(P,R)') && edit('model-picker-component').replace.includes('This provider already offers that model.'));
});
test('Overview starts the restart dialog when opened with ah-restart=1 (the provider form Restart now button)', () => {
  const r = edit('overview-auto-restart').replace; assert.ok(r.includes('ah-restart=1') && r.includes('D(!1)') && r.includes('replaceState'));
});
test('diagnostic text: PATH hidden, user names and long log lines shortened', () => {
  const src = readFileSync(new URL('../../patches/paseo-0.15.2/ux-layer.js', import.meta.url), 'utf8'); const a = src.indexOf('globalThis.__ahDiag='); const g = {}; const B = String.fromCharCode(92);
  vm.runInContext(src.slice(a, src.indexOf(String.fromCharCode(10), a)), vm.createContext({ globalThis: g, String }));
  const out = g.__ahDiag(['  PATH: C:' + B + 'a;C:' + B + 'b', '  Paseo home: C:' + B + 'Users' + B + 'bob' + B + 'x', '  {"level":30,"m":"' + 'z'.repeat(400) + '"}'].join(String.fromCharCode(10)));
  assert.match(out, /PATH: .hidden, 2 folders./); assert.ok(out.includes('C:' + B + 'Users' + B + '<user>' + B + 'x') && !out.includes('bob')); assert.ok(out.split(String.fromCharCode(10))[2].length < 260);
});
