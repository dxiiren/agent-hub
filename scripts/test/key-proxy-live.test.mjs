// Live proof of the key proxy through the real path: `provider add --key` (CLI, temp home) -> the launcher command it wrote -> the launcher process -> the proxy it started.
// A stub endpoint that demands a key plays the upstream; a stub "qwen" records what the agent would receive (its argv and env). Nothing outside a temp folder is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { spawnSyncSafe } from '../../plugins/routing/spawn-safe.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const KEY = 'sk-live-stub-key-0123456789';
const hasQwen = spawnSyncSafe(process.platform === 'win32' ? 'where' : 'which', ['qwen'], { encoding: 'utf8' }).status === 0;

test('key-bearing provider: the proxy rejects a wrong secret, host, path and endpoint, forwards the real key only upstream, and the agent never sees it', { skip: hasQwen ? false : 'qwen CLI not on PATH (provider add needs it)' }, async () => {
  const seen = [];
  const up = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end('no key'); }
    res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"m1"}]}');
  });
  await new Promise((ok) => up.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${up.address().port}/v1`;
  const home = mkdtempSync(join(tmpdir(), 'ahub-keyproxy-'));
  const env = { ...process.env, AGENT_HUB_HOME: home, PASEO_HOME: home, AGENT_HUB_NO_LOCAL: '1' };
  let launcher;
  try {
    // async: a sync spawn would block this process, and the stub endpoint lives in it
    const add = await new Promise((ok) => { const c = spawn(process.execPath, [join(REPO, 'scripts', 'hub.mjs'), 'provider', 'add', 'livekey', '--kind', 'qwen', '--url', url, '--model', 'm1', '--key', KEY, '--routes', 'summarise'], { env, cwd: REPO }); let o = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (o += d)); c.on('close', (status) => ok({ status, stdout: o, stderr: '' })); });
    assert.equal(add.status, 0, add.stdout + add.stderr);
    assert.ok(seen.some((s) => s.auth === `Bearer ${KEY}`), 'add verified the endpoint with the key');
    const prov = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).agents.providers.livekey;
    assert.equal(prov.env.HUB_OPENAI_API_KEY, KEY, 'the key lives only in the launcher env');
    assert.ok(!prov.command.join(' ').includes(KEY), 'the key is not on the command line');
    // the launcher exactly as Paseo would run it, with a stay-alive stub in place of qwen that records argv and env
    const rec = join(home, 'agent-seen.json'), stub = join(home, 'fake-agent.mjs');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env })); process.stdin.resume(); setTimeout(() => process.exit(0), 60000);\n`);
    const cmd = [...prov.command]; const qi = cmd.findIndex((x) => /qwen(\.cmd|\.exe)?$/i.test(String(x)));
    assert.ok(qi > 0, 'launcher command names the qwen binary: ' + JSON.stringify(cmd));
    const wrapper = join(home, process.platform === 'win32' ? 'fake-qwen.cmd' : 'fake-qwen');
    const NL = String.fromCharCode(10), BS = String.fromCharCode(92); // npm-shim shape on Windows, which spawn-safe resolves without a shell
    writeFileSync(wrapper, process.platform === 'win32' ? ['@ECHO off', '"%_prog%"  "%dp0%' + BS + 'fake-agent.mjs" %*', ''].join(NL) : ['#!/bin/sh', `exec "${process.execPath}" "${stub}" "$@"`, ''].join(NL)); if (process.platform !== 'win32') chmodSync(wrapper, 0o755);
    cmd[qi] = wrapper;
    launcher = spawn(cmd[0], cmd.slice(1), { env: { ...env, ...prov.env }, stdio: ['pipe', 'pipe', 'pipe'], cwd: REPO }); let lerr = ''; launcher.stderr.on('data', (d) => (lerr += d)); launcher.stdout.resume();
    launcher.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' + String.fromCharCode(10)); // the agent starts on the client's first message
    for (let i = 0; i < 100 && !existsSync(rec); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(rec), 'launcher started the agent: ' + lerr + JSON.stringify(cmd));
    await new Promise((r) => setTimeout(r, 300));
    const { argv, env: agentEnv } = JSON.parse(readFileSync(rec, 'utf8'));
    const base = new URL(argv[argv.indexOf('--openai-base-url') + 1]), secret = argv[argv.indexOf('--openai-api-key') + 1];
    assert.ok(secret && secret !== KEY && !JSON.stringify(argv).includes(KEY), 'the agent got a random secret, not the key');
    assert.ok(!JSON.stringify(agentEnv).includes(KEY), 'the agent env carries no copy of the key');
    assert.ok(!Object.keys(agentEnv).some((k) => /HUB_OPENAI_API_KEY/.test(k)), 'no key variable reaches the agent');
    const port = base.port, root = base.pathname.replace(/\/+$/, '');
    const raw = (path, headers = {}) => new Promise((ok, no) => { const r = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); }); r.on('error', no); r.end(); });
    const good = { authorization: `Bearer ${secret}` };
    seen.length = 0;
    assert.equal(await raw(`${root}/models`, good), 200, 'right secret, right path');
    assert.deepEqual(seen, [{ url: '/v1/models', auth: `Bearer ${KEY}` }], 'upstream saw the real key');
    seen.length = 0;
    assert.equal(await raw(`${root}/models`), 401, 'no secret');
    assert.equal(await raw(`${root}/models`, { authorization: `Bearer ${KEY}` }), 401, 'the real key as the secret');
    assert.equal(await raw(`${root}/models`, { authorization: 'Bearer wrong' }), 401, 'wrong secret');
    assert.equal(await raw(`${root}/models`, { ...good, host: 'evil.example' }), 403, 'wrong host');
    for (const p of [`${root}/../x`, `${root}/%2e%2e/x`, `//evil.example${root}/models`, `${root}//models`]) assert.equal(await raw(p, good), 400, p);
    for (const p of ['/v2/models', `${root}/files`, `${root}/models/extra`, '/models']) assert.equal(await raw(p, good), 404, p);
    assert.deepEqual(seen, [], 'nothing forbidden reached the upstream');
  } finally {
    try { launcher?.kill(); } catch { /* gone */ }
    up.close();
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(home, { recursive: true, force: true }); } catch { /* a stub still holds a file: the temp folder stays */ }
  }
});
