import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add, edit, remove, list, describe, api, parseRoutes } from '../provider.mjs';
import { discover, modelListed } from '../provider-kinds.mjs';

const URL1 = 'http://127.0.0.1:9/v1';
const served = (ids, seen) => async (u, o) => { seen?.push(o?.headers?.Authorization); return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) }; };
const cli = (ids) => () => ({ stdout: JSON.stringify(ids.map((id) => ({ id, model: id.toUpperCase() }))) });
function box() {
  const t = mkdtempSync(join(tmpdir(), 'ahub-kinds-'));
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), routes: join(t, 'routes.json') };
  writeFileSync(p.routes, JSON.stringify({ slots: { codex: 2 }, modes: {}, routes: { summarise: ['a', 'b'], 'code-edit': ['x/1', 'y/2', 'z/3'] } }, null, 2) + '\n');
  writeFileSync(p.paseo, JSON.stringify({ version: 1, agents: { providers: { codex: {} } } }, null, 2) + '\n');
  const sha = () => ['local', 'paseo', 'routes'].map((f) => (existsSync(p[f]) ? createHash('sha256').update(readFileSync(p[f])).digest('hex') : null));
  return { p, t, sha, read: (f) => JSON.parse(readFileSync(p[f], 'utf8')) };
}

test('a CLI kind adds only a route token at the chosen position, validates the model, and leaves slots alone', async () => {
  const { p, read } = box();
  await add({ name: 'fast-tier', kind: 'qoder', model: 'efficient', routes: 'code-edit:2,summarise' }, p, { run: cli(['efficient', 'fast']) });
  assert.deepEqual(read('routes').routes['code-edit'], ['x/1', 'qoder/efficient', 'y/2', 'z/3']);
  assert.deepEqual(read('routes').routes.summarise, ['a', 'b', 'qoder/efficient']);
  assert.equal(read('routes').slots['fast-tier'], undefined);
  assert.deepEqual(Object.keys(read('paseo').agents.providers), ['codex'], 'no Paseo provider entry for a CLI kind');
  await assert.rejects(add({ name: 'other', kind: 'qoder', model: 'nope', routes: 'summarise' }, p, { run: cli(['efficient']) }), /not offered by the qoder CLI/);
  await assert.rejects(add({ name: 'dup', kind: 'qoder', model: 'efficient', routes: 'summarise' }, p, { run: cli(['efficient']) }), /already lists qoder\/efficient/);
  assert.deepEqual(list(p), [{ name: 'fast-tier', type: 'qoder', model: 'efficient', slots: undefined, routes: ['summarise', 'code-edit'] }]);
});

test('add then edit then remove returns every file to its original bytes; edit keeps positions and the key stays out of list', async () => {
  const { p, sha, read } = box(); const before = sha(); const seen = [];
  await add({ name: 'qwen-lab', kind: 'qwen', url: URL1, model: 'm1', key: 'sk-test-secret', slots: 2, routes: 'summarise:1' }, p, { f: served(['m1', 'm2'], seen), which: () => 'qwen' });
  assert.equal(seen[0], 'Bearer sk-test-secret');
  assert.equal(read('paseo').agents.providers['qwen-lab'].env.HUB_OPENAI_API_KEY, 'sk-test-secret');
  assert.ok(!JSON.stringify(list(p)).includes('sk-test-secret')); assert.equal(list(p)[0].keySet, true);
  assert.ok(!JSON.stringify(command(p)).includes('sk-test-secret'), 'key never in argv');
  await edit('qwen-lab', { slots: '5', model: 'm2' }, p, { f: served(['m1', 'm2']), which: () => 'qwen' });
  assert.equal(read('routes').slots['qwen-lab'], 5); assert.equal(read('local').extraProviders['qwen-lab'].model, 'm2'); assert.equal(read('local').extraProviders['qwen-lab'].key, 'sk-test-secret', 'edit keeps the key');
  assert.equal(read('routes').routes.summarise[0], 'qwen-lab');
  await assert.rejects(edit('qwen-lab', { model: 'gone' }, p, { f: served(['m1']), which: () => 'qwen' }), /not served/);
  assert.equal(read('local').extraProviders['qwen-lab'].model, 'm2', 'a refused edit changes nothing');
  remove('qwen-lab', p);
  assert.deepEqual(sha(), before);
});
const command = (p) => JSON.parse(readFileSync(p.paseo, 'utf8')).agents.providers['qwen-lab'].command;

test('read-only twin can be switched off; opencode kind writes its own config file and removal deletes it', async () => {
  const { p, t, sha } = box(); const before = sha();
  await add({ name: 'qwen-x', kind: 'qwen', url: URL1, model: 'm1', readOnly: 'false' }, p, { f: served(['m1']), which: () => 'qwen' });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(p.paseo, 'utf8')).agents.providers), ['codex', 'qwen-x']);
  remove('qwen-x', p); assert.deepEqual(sha(), before);
  await add({ name: 'opencode-x', kind: 'opencode', url: URL1, model: 'm1', routes: 'summarise' }, p, { f: served(['m1']) });
  const f = join(t, 'hub', 'opencode-opencode-x.json'); assert.ok(existsSync(f));
  assert.equal(JSON.parse(readFileSync(p.paseo, 'utf8')).agents.providers['opencode-x'].extends, 'opencode');
  remove('opencode-x', p); assert.ok(!existsSync(f)); assert.deepEqual(sha(), before);
});

test('api verbs mirror the CLI; describe lists kinds with fields and route types', async () => {
  const { p } = box();
  const d = await api({ verb: 'describe' }, p); assert.ok(d.kinds.find((k) => k.type === 'qwen-code').fields.some((f) => f.type === 'secret')); assert.deepEqual(d.routeTypes, { summarise: 2, 'code-edit': 3 });
  assert.deepEqual((await api({ verb: 'models', args: { kind: 'qwen', url: URL1 } }, p, { f: served(['m1']) })).models, [{ id: 'm1', label: 'm1' }]);
  await api({ verb: 'add', args: { name: 'qwen-api', kind: 'qwen', url: URL1, model: 'm1' } }, p, { f: served(['m1']), which: () => 'q' });
  assert.equal((await api({ verb: 'list' }, p)).providers.length, 1);
  await api({ verb: 'remove', args: { name: 'qwen-api' } }, p); assert.equal(list(p).length, 0);
  await assert.rejects(api({ verb: 'zap' }, p), /unknown verb/);
});

test('input validation: non-http urls, bad route positions, unreachable endpoint, empty CLI list', async () => {
  const { p } = box();
  await assert.rejects(add({ name: 'qwen-a', kind: 'qwen', url: 'file:///etc/passwd', model: 'm' }, p, { which: () => 'q' }), /http\(s\)/);
  assert.throws(() => parseRoutes('summarise:0'), /position/);
  await assert.rejects(discover('qwen-code', { url: URL1 }, { f: async () => { throw new Error('ECONNREFUSED'); } }), /endpoint check failed/);
  await assert.rejects(discover('codex', {}, { run: () => ({ stdout: '' }) }), /listed nothing/);
  assert.ok(modelListed('latest-sonnet', []) && modelListed('Efficient', [{ id: 'efficient', label: 'Efficient' }]) && !modelListed('x', []));
});

test('a custom kind from AGENT_HUB_KINDS is offered and builds its launch command', async () => {
  const t = mkdtempSync(join(tmpdir(), 'ahub-custom-')); const f = join(t, 'kinds.json');
  writeFileSync(f, JSON.stringify({ myagent: { label: 'My agent', launch: ['{node}', 'run.mjs', '{url}', '{model}'] } }));
  const code = `import { KINDS } from './scripts/provider-kinds.mjs'; import { entries } from './scripts/provider.mjs';
    const e = entries('myagent-1', { type: 'myagent', url: 'http://127.0.0.1:9/v1', model: 'm1' }, null, '/repo', '/hub');
    console.log(JSON.stringify({ has: !!KINDS.myagent, cmd: e['myagent-1'].command, ro: !!e['myagent-1-ro'] }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: join(import.meta.dirname, '..', '..'), encoding: 'utf8', env: { ...process.env, AGENT_HUB_KINDS: f } });
  const o = JSON.parse(r.stdout); assert.equal(o.has, true); assert.deepEqual(o.cmd, [o.cmd[0], 'run.mjs', URL1, 'm1']); assert.equal(o.ro, false);
});

test('the key proxy: secret and Host required, path pinned to the upstream base, redirects never followed, real key never leaves', async () => {
  const { createServer, request } = await import('node:http');
  const { startAuthProxy, scrubKeyEnv } = await import('../../plugins/routing/office.mjs');
  let redirectNext = false; const seen = []; const other = []; const evil = createServer((req, res) => { other.push(req.headers.authorization); res.end('evil'); });
  await new Promise((ok) => evil.listen(0, '127.0.0.1', ok));
  const up = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (redirectNext && req.url === '/v1/models') { res.writeHead(302, { location: `http://127.0.0.1:${evil.address().port}/steal` }); return res.end(); }
    res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"m1"}]}');
  });
  await new Promise((ok) => up.listen(0, '127.0.0.1', ok));
  const proxy = await startAuthProxy(`http://127.0.0.1:${up.address().port}/v1`, 'sk-proxy-secret');
  const port = new URL(proxy.base).port;
  const raw = (path, headers = {}) => new Promise((ok, no) => { const r = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => ok({ status: res.statusCode, body: b })); }); r.on('error', no); r.end(); });
  const good = { authorization: `Bearer ${proxy.secret}` };
  try {
    assert.ok(!proxy.base.includes('sk-proxy-secret') && proxy.secret !== 'sk-proxy-secret');
    const ok = await raw('/v1/models', good); assert.equal(ok.status, 200); assert.deepEqual(JSON.parse(ok.body), { data: [{ id: 'm1' }] });
    assert.deepEqual(seen, [{ url: '/v1/models', auth: 'Bearer sk-proxy-secret' }]);
    assert.equal((await raw('/v1/models')).status, 401); assert.equal((await raw('/v1/models', { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await raw('/v1/models', { ...good, host: 'evil.example' })).status, 403);
    for (const p of ['//127.0.0.1/v1/models', '//evil.example/x', 'http://evil.example/', '/../etc/passwd', '/v1/../models', '/v1/./models', '/v1//models', '/v1/%2e%2e/models', '/v1/%2E%2E%2fmodels', '/v1/models%2f..%2f', '/v1\\models', '/v1/models/%5c..', '/v1/models%00'])
      assert.equal((await raw(p, good)).status, 400, p);
    for (const p of ['/v2/models', '/v1/models/extra', '/v1/files', '/v1/chat/completions', '/models']) assert.equal((await raw(p, good)).status, 404, p);
    assert.equal(seen.length, 1, 'nothing forbidden reached the upstream');
    redirectNext = true; const red = await raw('/v1/models', good); assert.equal(red.status, 302); assert.deepEqual(other, [], 'the redirect target never received the key');
  } finally { proxy.close(); up.close(); evil.close(); }
  assert.deepEqual(scrubKeyEnv({ HUB_OPENAI_API_KEY: 'k', OPENAI_API_KEY: 'k', GITEA_TOKEN: 't', GITHUB_MCP_PAT: 't', DB_PASSWORD: 'x', AWS_SECRET: 'x', PATH: 'p', HOME: 'h', TOKENS_PER_MIN: '5', KEYBOARD: 'k' }), { PATH: 'p', HOME: 'h', TOKENS_PER_MIN: '5', KEYBOARD: 'k' });
});

test('a kind without a key field refuses a key (opencode)', async () => {
  const { p } = box();
  await assert.rejects(add({ name: 'opencode-k', kind: 'opencode', url: URL1, model: 'm1', key: 'sk-x' }, p, { f: served(['m1']) }), /takes no API key/);
  assert.ok(!existsSync(p.local));
});

test('two providers added then removed in the SAME order restore hand-formatted files byte for byte', async () => {
  const { p, sha } = box();
  writeFileSync(p.routes, '{"slots":{"codex":2},"modes":{},\n  "routes":{"summarise":["a","b"],"code-edit":["x/1"]}}'); // hand formatting, no final newline
  const before = sha();
  await add({ name: 'qwen-a', kind: 'qwen', url: URL1, model: 'm1', routes: 'summarise' }, p, { f: served(['m1']), which: () => 'q' });
  await add({ name: 'fast-tier', kind: 'qoder', model: 'efficient', routes: 'code-edit' }, p, { run: cli(['efficient']) });
  remove('qwen-a', p); remove('fast-tier', p);
  assert.deepEqual(sha(), before);
  assert.ok(!existsSync(join(p.local, '..', 'hub.local.undo-base.json')) && !existsSync(join(p.local, '..', 'hub.local.undo-fast-tier.json')), 'no undo files left behind');
});

test('display names default to "<Kind> <host>" (local for loopback), --label overrides', async () => {
  const { entries } = await import('../provider.mjs'); const { displayName, hostOf } = await import('../provider-kinds.mjs');
  assert.equal(displayName('Qwen Code', 'http://example.test:8000/v1'), 'Qwen Code example.test');
  assert.equal(hostOf('http://127.0.0.1:1/v1'), 'local'); assert.equal(hostOf('http://localhost/v1'), 'local'); assert.equal(hostOf('nonsense'), '');
  const e = entries('qwen-a', { type: 'qwen-code', url: 'http://example.test:8000/v1', model: 'm' }, 'qwen', '/repo');
  assert.equal(e['qwen-a'].label, 'Qwen Code example.test'); assert.deepEqual(Object.keys(e), ['qwen-a']);
  assert.equal(entries('qwen-a', { type: 'qwen-code', url: 'http://example.test/v1', model: 'm', label: 'Lab box' }, 'qwen', '/repo')['qwen-a'].label, 'Lab box');
  const { p } = box();
  await add({ name: 'qwen-l', kind: 'qwen', url: URL1, model: 'm1', label: 'My lab' }, p, { f: served(['m1']), which: () => 'q' });
  assert.equal(list(p)[0].label, 'My lab');
  await assert.rejects(add({ name: 'qwen-m', kind: 'qwen', url: URL1, model: 'm1', label: 'bad"quote' }, p, { f: served(['m1']), which: () => 'q' }), /--label/);
});
