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
