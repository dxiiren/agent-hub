import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runServerPatch, loadServerSpec } from '../paseo-server-patch.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const REL = 'dist/server/server/agent/x.js';
const SRC = 'A;ANCHOR1;B;ANCHOR2;C';
const spec = (over = {}) => ({ paseo: '9.9.9', rev: 3, files: [{ path: REL, sha256: sha(SRC), edits: [{ name: 'one', find: 'ANCHOR1', replace: '/*agent-hub-server-rev:3*/X1' }, { name: 'two', find: 'ANCHOR2', replace: 'X2' }] }], ...over });
function install({ version = '9.9.9', src = SRC } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-serverpatch-'));
  mkdirSync(join(dir, 'dist/server/server/agent'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(dir, REL), src);
  return { dir, file: join(dir, REL) };
}

test('apply patches once, keeps the original beside it, is idempotent, restore puts the original back', () => {
  const { dir, file } = install();
  assert.equal(runServerPatch('status', { serverDir: dir, spec: spec() }).state, 'unpatched');
  assert.equal(runServerPatch('apply', { serverDir: dir, spec: spec() }).state, 'applied');
  assert.equal(readFileSync(file, 'utf8'), 'A;/*agent-hub-server-rev:3*/X1;B;X2;C');
  assert.equal(readFileSync(file + '.agent-hub-orig', 'utf8'), SRC);
  assert.equal(runServerPatch('apply', { serverDir: dir, spec: spec() }).state, 'patched');
  assert.equal(runServerPatch('restore', { serverDir: dir, spec: spec() }).state, 'restored');
  assert.equal(readFileSync(file, 'utf8'), SRC);
});

test('a newer revision is applied from the untouched original, never on top of the old patch', () => {
  const { dir, file } = install();
  runServerPatch('apply', { serverDir: dir, spec: spec() });
  const s4 = spec({ rev: 4 }); s4.files[0].edits[0].replace = '/*agent-hub-server-rev:4*/Y1';
  assert.equal(runServerPatch('apply', { serverDir: dir, spec: s4 }).state, 'applied');
  assert.equal(readFileSync(file, 'utf8'), 'A;/*agent-hub-server-rev:4*/Y1;B;X2;C');
});

test('nothing is touched when the version, a file hash or an anchor does not match', () => {
  for (const [name, inst, sp, re] of [
    ['version', install({ version: '1.0.0' }), spec(), /no server patch for Paseo 1\.0\.0/],
    ['hash', install({ src: SRC + ' ' }), spec(), /differs from the one the patch was written for/],
    ['anchor', install({ src: 'A;ANCHOR1;B;ANCHOR1;C' }), (() => { const s = spec(); s.files[0].sha256 = sha('A;ANCHOR1;B;ANCHOR1;C'); return s; })(), /matches 2 times/],
  ]) {
    const before = readFileSync(inst.file, 'utf8');
    const r = runServerPatch('apply', { serverDir: inst.dir, spec: sp });
    assert.equal(r.state, 'skipped', name); assert.match(r.reason, re, name);
    assert.equal(readFileSync(inst.file, 'utf8'), before, name); assert.ok(!existsSync(inst.file + '.agent-hub-orig'), name);
  }
});

// The shipped 0.15.2 snippet, run against a tiny p-limit stand-in.
const snippet = () => loadServerSpec('0.15.2').files[0].edits.find((e) => e.name === 'probe-budget-helpers').replace;
function pLimit(o) {
  const max = typeof o === 'number' ? o : o.concurrency; let active = 0; const q = [];
  const next = () => { if (active < max && q.length) { active++; const { fn, res, rej } = q.shift(); Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); }); } };
  const lim = (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
  lim.clearQueue = () => { while (q.length) q.shift().rej(new Error('cleared')); };
  return lim;
}
const load = () => { const ctx = vm.createContext({ pLimit, String }); vm.runInContext(snippet().replace('import pLimit from "p-limit";', '') + ';this.d=__ahDiscoveryLimit;this.s=__ahShortError;', ctx); return ctx; };

test('shipped 0.15.2 spec: 100 providers share one budget of 4 concurrent probes, each provider keeps its own 4', async () => {
  const { d } = load(); let active = 0, peak = 0;
  const probe = () => async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; };
  const limits = Array.from({ length: 100 }, () => d());
  await Promise.all(limits.map((l) => l(probe())));
  assert.equal(peak, 4);
  active = 0; peak = 0;
  await Promise.all(Array.from({ length: 20 }, () => limits[0](probe())));
  assert.equal(peak, 4, 'one provider alone is still capped at 4');
  assert.equal(typeof limits[0].clearQueue, 'function');
});

test('shipped 0.15.2 spec: a failed probe becomes one short line; short messages stay as they are', () => {
  const { s } = load();
  const dump = ['npm error code E404', 'npm error 404 Not Found - GET https://registry.npmjs.org/cline-nope - Not found', 'npm error 404', 'npm error A complete log of this run can be found in: C:/Users/x/npm-cache/_logs/a.log', '...'.repeat(500)].join('\n');
  const out = s(dump);
  assert.ok(!out.includes('\n') && out.length < 260, out);
  assert.match(out, /404/);
  assert.equal(s('spawn qwen ENOENT'), 'spawn qwen ENOENT');
  assert.equal(s(''), '');
});

test('shipped spec is well formed: every edit has find and replace, rev is set, files are relative', () => {
  const sp = loadServerSpec('0.15.2');
  assert.equal(sp.paseo, '0.15.2'); assert.ok(sp.rev >= 1);
  for (const f of sp.files) { assert.match(f.sha256, /^[0-9a-f]{64}$/); assert.ok(!f.path.startsWith('/')); for (const e of f.edits) assert.ok(e.find && typeof e.replace === 'string', e.name); }
  assert.ok(sp.files[0].edits.some((e) => /agent-hub-server-rev:\d+/.test(e.replace)));
});
