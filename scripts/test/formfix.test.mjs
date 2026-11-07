// The Add-provider form's model picker, end to end below the browser: the plugin handler runs `provider.mjs api` with {verb,args} on stdin
// (exactly what plugins/providers/index.server.ts does) against a real local HTTP server. Filled picker on success, a visible message on every failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rpc = (verb, args) => new Promise((ok, no) => {
  const c = spawn(process.execPath, [join(ROOT, 'scripts', 'provider.mjs'), 'api'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; c.stdout.on('data', (d) => (out += d)); c.on('error', no); c.on('close', () => { try { ok(JSON.parse(out)); } catch (e) { no(e); } });
  c.stdin.end(JSON.stringify({ verb, args }));
});
const serve = (handler) => new Promise((ok) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => ok({ s, port: s.address().port })); });
const models = (req, res) => { if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-model-27b' }] })); } else { res.statusCode = 404; res.end('no'); } };

test('picker fills from a full link, and from the same link without a scheme', async () => {
  const { s, port } = await serve(models);
  try {
    for (const url of [`http://127.0.0.1:${port}/v1`, `127.0.0.1:${port}/v1`, `127.0.0.1:${port}`]) {
      const r = await rpc('models', { kind: 'qwen-code', url });
      assert.deepEqual(r.models, [{ id: 'test-model-27b', label: 'test-model-27b' }], url);
    }
  } finally { s.close(); }
});

test('every failure returns a message that names the exact problem', async () => {
  const { s, port } = await serve(models);
  try {
    const dead = await serve(models); const deadPort = dead.port; await new Promise((ok) => dead.s.close(ok));
    const closed = await rpc('models', { kind: 'qwen-code', url: `http://127.0.0.1:${deadPort}/v1` });
    assert.match(closed.error, new RegExp(`Couldn't reach http://127\.0\.0\.1:${deadPort}/v1/models: connection refused`));
    const noPort = await rpc('models', { kind: 'qwen-code', url: '127.0.0.1/v1' });
    assert.match(noPort.error, /Couldn't reach http:\/\/127\.0\.0\.1\/v1\/models/);
    assert.match(noPort.error, /Did you mean a port, e\.g\. http:\/\/127\.0\.0\.1:8000\/v1\?/);
    const wrongPath = await rpc('models', { kind: 'qwen-code', url: `http://127.0.0.1:${port}/nope` });
    assert.match(wrongPath.error, /answered HTTP 404/);
    assert.doesNotMatch(wrongPath.error, /Couldn't reach/);
    const junk = await rpc('models', { kind: 'qwen-code', url: 'http://h/v1;ls' });
    assert.match(junk.error, /is not a usable Base URL/);
    const empty = await rpc('models', { kind: 'qwen-code', url: '' });
    assert.ok(empty.error, 'an empty link is refused with a message');
  } finally { s.close(); }
});

test('Add with a bad link or a model the endpoint does not serve answers with a message, never silence', async () => {
  const { s, port } = await serve(models);
  try {
    const bad = await rpc('add', { kind: 'qwen-code', url: 'http://h/v1;ls', model: 'm' });
    assert.match(bad.error, /plain http\(s\) base URL/);
    const nomodel = await rpc('add', { kind: 'qwen-code', url: `http://127.0.0.1:${port}/v1`, model: '' });
    assert.match(nomodel.error, /Choose a model first/);
    const nolink = await rpc('add', { kind: 'qwen-code', url: '', model: 'm' });
    assert.match(nolink.error, /Enter the Base URL/);
    const edit = await rpc('edit', { name: 'no-such-provider', model: 'x' });
    assert.ok(edit.error, 'edit of an unknown provider is refused with a message');
    const rm = await rpc('remove', { name: 'no-such-provider' });
    assert.ok(rm.error, 'remove of an unknown provider is refused with a message');
  } finally { s.close(); }
});

test('the form sends every typed link to the server (no silent client-side drop) and shows add/remove messages', () => {
  const src = readFileSync(join(ROOT, 'plugins', 'providers', 'index.client.tsx'), 'utf8');
  assert.ok(!/\^https\?/.test(src), 'index.client.tsx must not gate the model call on a client-side link regex');
  assert.match(src, /setModelErr\(r\.error\)/);
  assert.equal((src.match(/msg \? \(msg\.ok \? <SettingsRow/g) ?? []).length, 1, 'the result message shows once, next to the buttons');
});

test('provider.mjs never calls process.exit() right after the work (Windows libuv abort 0xC0000409 = the Save returned no result); the api verb exits 0 with its output', async () => {
  assert.doesNotMatch(readFileSync(join(ROOT, 'scripts', 'provider.mjs'), 'utf8'), /process\.exit\(await/);
  const { s, port } = await serve((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ data: [{ id: 'm1' }] })); });
  try {
    const r = await new Promise((ok, no) => { const c = spawn(process.execPath, [join(ROOT, 'scripts', 'provider.mjs'), 'api'], { stdio: ['pipe', 'pipe', 'pipe'] }); let out = ''; c.stdout.on('data', (d) => (out += d)); c.on('error', no); c.on('close', (code) => ok({ code, out })); c.stdin.end(JSON.stringify({ verb: 'models', args: { kind: 'qwen-code', url: `http://127.0.0.1:${port}/v1` } })); });
    assert.equal(r.code, 0); assert.ok(JSON.parse(r.out));
  } finally { s.close(); }
});
