import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { add, edit, remove, list } from '../provider.mjs';
import { safeUrl, scrubKeyEnv } from '../../plugins/routing/office.mjs';
import { resolveCommand, spawnSafe, spawnSyncSafe } from '../../plugins/routing/spawn-safe.mjs';
import { own } from '../../plugins/routing/jsonfile.mjs';
import { discover } from '../provider-kinds.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BS = String.fromCharCode(92);
const served = (ids) => async () => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) });
const opts = { f: served(['m1']), which: () => 'qwen' };

// ---- 1. URL validation
const BAD_URLS = ['http://127.0.0.1:8000/v1&whoami>PWNED.txt&', 'http://h/v1|calc', 'http://h/v1;ls', 'http://h/v1$(id)', 'http://h/v1`id`', 'http://h/v1"x', "http://h/v1'x", 'http://h/v1^x', 'http://h/v1%26x', 'http://h/v1' + BS + 'x',
  'http://h /v1', 'http://h/v1\n', 'http://h/v1\u0000', 'http://u:p@h/v1', 'http://h/v1?a=b', 'http://h/v1#f', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://h/v1', 'http://', 'http://h/v1<x', 'http://h/v1>x', '', undefined, null, 5];
test('safeUrl refuses every shell/control character, credentials, query, fragment and non-http schemes', () => {
  for (const u of BAD_URLS) assert.equal(safeUrl(u), '', JSON.stringify(u));
});
test('safeUrl returns the canonical form of a good URL', () => {
  assert.equal(safeUrl('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1');
  assert.equal(safeUrl('https://Host.Example.test/v1/'), 'https://host.example.test/v1');
  assert.equal(safeUrl('http://host:80'), 'http://host');
  assert.equal(safeUrl('http://[::1]:8000/v1'), 'http://[::1]:8000/v1');
});

function box(routes = { slots: { codex: 2 }, routes: { summarise: ['qwen-laptop'], 'code-edit': ['codex/latest-terra'] } }, eol = '\n') {
  const t = mkdtempSync(join(tmpdir(), 'ahub-hard-'));
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), routes: join(t, 'routes.json') };
  writeFileSync(p.routes, JSON.stringify(routes, null, 2).split('\n').join(eol) + eol);
  writeFileSync(p.paseo, JSON.stringify({ version: 1, agents: { providers: { codex: {} } } }, null, 2).split('\n').join(eol) + eol);
  return { t, p };
}
const snap = (p) => ['local', 'paseo', 'routes'].map((f) => (existsSync(p[f]) ? readFileSync(p[f]).toString('base64') : null));

test('add refuses the command-injection URL (CLI and UI path) and writes nothing', async () => {
  const { t, p } = box(); const before = snap(p);
  const payload = 'http://127.0.0.1:1/v1&whoami>PWNED.txt&';
  await assert.rejects(add({ name: 'qwen-x', url: payload, model: 'm1' }, p, opts), /plain http\(s\) base URL/);
  await assert.rejects(discover('qwen-code', { url: payload }, { f: served(['m1']) }), /plain http\(s\) base URL/);
  assert.deepEqual(snap(p), before); assert.ok(!existsSync(join(t, 'PWNED.txt')) && !existsSync('PWNED.txt'));
  for (const u of BAD_URLS.filter((x) => typeof x === 'string' && x)) await assert.rejects(add({ name: 'qwen-x', url: u, model: 'm1' }, p, opts), /URL/, u);
  assert.deepEqual(snap(p), before);
});
test('edit refuses a bad URL too, and keeps the provider', async () => {
  const { p } = box(); await add({ name: 'qwen-x', url: 'http://h.example.test:1/v1', model: 'm1' }, p, opts);
  const before = snap(p);
  await assert.rejects(edit('qwen-x', { url: 'http://h/v1&calc&' }, p, opts), /URL/);
  assert.deepEqual(snap(p), before);
});

// ---- 2. no shell anywhere: command shims run as node <entry>
function shimFixture() {
  const d = mkdtempSync(join(tmpdir(), 'ahub-shim-')); mkdirSync(join(d, 'node_modules', 'x'), { recursive: true });
  const entry = join(d, 'node_modules', 'x', 'cli.js');
  writeFileSync(entry, 'require("fs").writeFileSync(process.env.OUT, JSON.stringify(process.argv.slice(2)));');
  const shim = join(d, 'x.cmd');
  writeFileSync(shim, ['@ECHO off', 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" --no-warnings "%dp0%' + BS + 'node_modules' + BS + 'x' + BS + 'cli.js" %*'].join('\r\n'));
  return { d, shim, entry };
}
const NASTY = ['&whoami>PWNED.txt&', '|calc', '^x', '"q"', '%PATH%', 'a b', ';ls', '$(id)', '`id`', '<in', '>out'];
test('resolveCommand turns a .cmd shim into node <entry> with the args untouched; other platforms and binaries pass through', () => {
  const { shim, entry } = shimFixture();
  const r = resolveCommand(shim, NASTY, 'win32');
  assert.equal(r.cmd, process.execPath); assert.deepEqual(r.args, ['--no-warnings', entry, ...NASTY]);
  assert.deepEqual(resolveCommand('/bin/tool', ['a'], 'linux'), { cmd: '/bin/tool', args: ['a'] });
  assert.deepEqual(resolveCommand('C:/x/tool.exe', ['a'], 'win32'), { cmd: 'C:/x/tool.exe', args: ['a'] });
});
test('a .cmd shim that cannot be resolved is refused, never run through a shell', () => {
  const d = mkdtempSync(join(tmpdir(), 'ahub-shim-')); const shim = join(d, 'odd.cmd'); writeFileSync(shim, '@echo off\r\nwhoami\r\n');
  assert.throws(() => resolveCommand(shim, [], 'win32'), /refusing to run it through a shell/);
  assert.throws(() => resolveCommand(join(d, 'missing.cmd'), [], 'win32'), /cannot read command shim/);
  const r = spawnSyncSafe(shim, ['&calc&']); if (process.platform === 'win32') assert.equal(r.status, 127);
});
test('live: metacharacters in arguments reach the program as plain argv and create no file (Windows shim)', { skip: process.platform !== 'win32' }, async () => {
  const { d, shim } = shimFixture(); const out = join(d, 'out.json'); const cwd = mkdtempSync(join(tmpdir(), 'ahub-cwd-'));
  const c = spawnSafe(shim, NASTY, { cwd, env: { ...process.env, OUT: out }, stdio: 'ignore' });
  await new Promise((res, rej) => { c.on('exit', res); c.on('error', rej); });
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), NASTY);
  assert.deepEqual(readdirSync(cwd), [], 'no PWNED.txt, out or in file appeared in the working directory');
});
test('class guard: no spawn/exec in the code runs a shell, except the gate command (a shell command by definition)', () => {
  const roots = ['deploy', 'plugins', 'scripts']; const hits = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === 'test') continue; const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(mjs|js|ts|tsx|py)$/.test(e.name)) {
    const txt = readFileSync(f, 'utf8');
    for (const [i, line] of txt.split('\n').entries()) if (/\bshell\s*[:=]\s*(true|win|process\.platform|\(?\s*os\.name|True)/i.test(line) && !/^\s*(\/\/|#)/.test(line)) hits.push(`${f}:${i + 1}`); } } };
  for (const r of roots) walk(join(REPO, r));
  assert.deepEqual(hits.map((h) => h.replace(REPO, '').split(BS).join('/')).filter((h) => !h.includes('plugins/gate/server/gate.mjs') && !h.includes('opencode_export.py')), []);
});
test('opencode poller: shell stays only for the Windows shim and every argument is allow-listed first', () => {
  const t = readFileSync(join(REPO, 'plugins', 'usage-otel', 'pollers', 'opencode_export.py'), 'utf8');
  assert.match(t, /SAFE_ARG/); assert.match(t, /unsafe opencode argument refused/);
});

// ---- 3. remove is byte-exact in every order
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));
const sequences = () => { // every interleaving of add/remove for 3 providers, each added once and removed once, add before its remove
  const out = [];
  const rec = (seq, added, removed) => { if (removed.size === 3) return out.push(seq); for (const n of [0, 1, 2]) { if (!added.has(n)) rec([...seq, ['add', n]], new Set([...added, n]), removed); else if (!removed.has(n)) rec([...seq, ['rm', n]], added, new Set([...removed, n])); } };
  rec([], new Set(), new Set()); return out;
};
const NAMES = ['qwen-a', 'qwen-b', 'qwen-c'];
for (const [label, routes, eol] of [
  ['routes without slots/modes', { routes: { summarise: ['qwen-laptop'], 'code-edit': ['codex/latest-terra'] } }, '\n'],
  ['routes with slots and an empty modes', { slots: { codex: 2 }, modes: {}, routes: { summarise: ['qwen-laptop'], 'code-edit': [] } }, '\n'],
  ['CRLF file with slots only', { slots: { codex: 2 }, routes: { summarise: ['qwen-laptop'], 'code-edit': [] } }, '\r\n'],
]) {
  test(`property: all ${sequences().length} add/remove orders of 3 providers return every file to its exact bytes (${label})`, async () => {
    for (const seq of sequences()) {
      const { p } = box(routes, eol); const before = snap(p);
      for (const [op, n] of seq) {
        if (op === 'add') await add({ name: NAMES[n], url: `http://h${n}.example.test:8000/v1`, model: 'm1', routes: 'summarise,code-edit' }, p, opts);
        else remove(NAMES[n], p);
      }
      assert.deepEqual(snap(p), before, `order ${seq.map(([o, n]) => o + NAMES[n].slice(-1)).join(' ')}`);
      assert.deepEqual(readdirSync(dirname(p.local)).sort(), ['config.json', 'hub.local.json', 'routes.json'].filter((f) => existsSync(join(dirname(p.local), f))).sort(), 'no undo files left');
    }
  });
}

// ---- 4. prototype names
test('own() never returns an inherited member', () => {
  for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) assert.equal(own({}, k), undefined, k);
  assert.equal(own({ a: 1 }, 'a'), 1); assert.equal(own(null, 'a'), undefined);
});
test('prototype names: refused on add, "not an added provider" on remove/edit, never a crash or a fake success', async () => {
  const { p } = box(); const before = snap(p);
  for (const n of ['constructor', 'prototype', '__proto__', 'toString', 'hasOwnProperty']) {
    await assert.rejects(add({ name: n, url: 'http://h.example.test:1/v1', model: 'm1' }, p, opts), /name must match/, n);
    assert.throws(() => remove(n, p), /is not an added provider/, n);
    await assert.rejects(edit(n, { slots: '3' }, p, opts), /is not an added provider/, n);
  }
  assert.deepEqual(snap(p), before); assert.deepEqual(list(p), []);
});
test('route type and slot lookups ignore prototype keys', async () => {
  const { p } = box(); const before = snap(p);
  await assert.rejects(add({ name: 'qwen-x', url: 'http://h.example.test:1/v1', model: 'm1', routes: 'constructor' }, p, opts), /unknown route type/);
  await assert.rejects(add({ name: 'qwen-x', url: 'http://h.example.test:1/v1', model: 'm1', routes: '__proto__' }, p, opts), /unknown route type/);
  assert.deepEqual(snap(p), before);
});

// ---- 5. no raw control bytes in tracked text files
test('no tracked text file holds a raw control byte (write it as an escape)', () => {
  let files; try { files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean); } catch { return; }
  const bad = [];
  for (const f of files) {
    if (!/\.(mjs|js|ts|tsx|py|md|json|ya?ml|ps1|sh|cmd|toml|txt)$/.test(f)) continue;
    let b; try { b = readFileSync(join(REPO, f)); } catch { continue; }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(b.toString('latin1'))) bad.push(f);
  }
  assert.deepEqual(bad, []);
});

// ---- 6. the laptop launcher scrubs credentials like the office launcher
test('laptop-agent starts Qwen with the scrubbed environment, and the scrub drops key-like variables', () => {
  const t = readFileSync(join(REPO, 'deploy', 'laptop', 'laptop-agent.mjs'), 'utf8');
  assert.match(t, /env: scrubKeyEnv\(qwenEnv\(E, ro\)\)/);
  const e = scrubKeyEnv({ PATH: 'p', HUB_OPENAI_API_KEY: 'k', GITHUB_TOKEN: 't', MY_SECRET: 's', DB_PASSWORD: 'x', KEEP: '1' });
  assert.deepEqual(Object.keys(e).sort(), ['KEEP', 'PATH']);
});
