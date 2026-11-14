// Smoke tests: every script that runs as a process is spawned for real (stub GPU probes, fake binaries, fake model server).
// a5acf73 shipped a ReferenceError in laptop-agent.mjs that made every laptop route fail while `npm test` stayed green,
// because no test loaded the file.
import test from 'node:test';
import { runDir } from '../../plugins/routing/runstate.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STUB = pathToFileURL(join(ROOT, 'scripts', 'test', 'fixtures', 'gpu-stub.mjs')).href;
const FAKE = join(ROOT, 'scripts', 'test', 'fixtures', 'fake-qwen.mjs');
const WIN = process.platform === 'win32';
const BAD = /ReferenceError|SyntaxError|TypeError|Cannot find module|ERR_MODULE_NOT_FOUND|Unhandled|LAPTOP-REFUSED/;
const f = (p) => join(ROOT, ...p.split('/'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A `qwen` stand-in the launchers can spawn (an npm-style .cmd shim on Windows, which the launchers run as node <entry> without a shell; an executable shell script elsewhere). */
function fakeBin(dir, name = 'qwen') {
  if (WIN) { const p = join(dir, name + '.cmd'); writeFileSync(p, `@ECHO off\r\n"%_prog%" "%dp0%\\${FAKE}" %*\r\n`); return p; }
  const p = join(dir, name); writeFileSync(p, `#!/bin/sh\nexec node "${FAKE}" "$@"\n`, { mode: 0o755 }); return p;
}
/** Fake llama-server: /health and /v1/models on a free port. */
async function fakeModelServer(id = 'qwen35-9b') {
  const srv = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(req.url.startsWith('/v1/models') ? JSON.stringify({ data: [{ id }] }) : '{"status":"ok"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}
const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, cwd: ROOT, ...opts });
const clean = (r, label) => assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, BAD, `${label}: load error in output\n${r.stdout}\n${r.stderr}`);
/** Run a process to its end (killed after ms), collecting output. */
const runAsync = (args, env, ms = 20000) => new Promise((res) => {
  const p = spawn(process.execPath, args, { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  const t = setTimeout(() => p.kill(), ms); p.on('exit', (status) => { clearTimeout(t); res({ status, stdout, stderr }); });
});

function laptopEnv(t, port, extra = {}) {
  return { ...process.env, QWEN_BIN: fakeBin(t), LLAMA_SERVER_BIN: fakeBin(t, 'llama-server'), LAPTOP_MODEL_PATH: join(t, 'qwen35-9b.gguf'), LAPTOP_PORT: String(port), LAPTOP_WATCHDOG_MS: '100', ...extra };
}

test('laptop-agent: a session/prompt runs the whole runtime path (in-flight marker, watchdog ticks, reply passes through)', async () => {
  const t = mkdtempSync(join(tmpdir(), 'smoke-laptop-'));
  const m = await fakeModelServer();
  const p = spawn(process.execPath, ['--import', STUB, f('deploy/laptop/laptop-agent.mjs')], { env: laptopEnv(t, m.port, { FAKE_QWEN_MS: '1200' }), stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => p.on('exit', (c) => r(c)));
  const marker = join(runDir(), `agent-hub-laptop-${m.port}.inflight.${p.pid}`);
  try {
    p.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    p.stdin.write('{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{}}\n');
    let seen = false;
    for (let i = 0; i < 100 && !seen && p.exitCode === null; i++) { seen = existsSync(marker); if (!seen) await sleep(50); }
    assert.ok(seen, `in-flight marker never appeared. stderr: ${err}`);
    for (let i = 0; i < 200 && !/stopReason/.test(out) && p.exitCode === null; i++) await sleep(50);
    assert.match(out, /stopReason/, `prompt reply never came back. stderr: ${err}`);
    await sleep(300);
    assert.equal(existsSync(marker), false, 'in-flight marker must be cleared once the turn ends');
    p.stdin.end();
    assert.equal(await exited, 0, `exit code. stderr: ${err}`);
    assert.doesNotMatch(err, BAD, err);
  } finally { if (p.exitCode === null) p.kill(); await m.close(); }
});

test('laptop-agent --check: pre-flight passes with the stubbed GPU and prints the summary', () => {
  const t = mkdtempSync(join(tmpdir(), 'smoke-check-'));
  const r = node(['--import', STUB, f('deploy/laptop/laptop-agent.mjs'), '--check'], { env: laptopEnv(t, 1, { LAPTOP_MIN_FREE_GB: '0' }) });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /laptop pre-flight ok/); clean(r, 'check');
});

test('laptop-agent --check: a heavy-run lock (even one named by a stale HEAVY_LOCK_GLOB) does not pause the provider', () => {
  const t = mkdtempSync(join(tmpdir(), 'smoke-heavy-'));
  writeFileSync(join(t, 'heavy-run-test.lock'), 'x');
  const r = node(['--import', STUB, f('deploy/laptop/laptop-agent.mjs'), '--check'], { env: laptopEnv(t, 1, { LAPTOP_MIN_FREE_GB: '0', HEAVY_LOCK_GLOB: join(t, 'heavy-run-*.lock') }) });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /laptop pre-flight ok/); clean(r, 'check');
});

test('laptop-agent: the watchdog stops the agent (exit 3, clear reason) when the GPU disappears at run time', async () => {
  const t = mkdtempSync(join(tmpdir(), 'smoke-gone-'));
  const m = await fakeModelServer();
  const gone = join(t, 'gone-stub.mjs');
  writeFileSync(gone, [
    `import ${JSON.stringify(STUB)};`,
    "import { createRequire, syncBuiltinESMExports } from 'node:module';",
    "const cp = createRequire(import.meta.url)('node:child_process'); const prev = cp.spawnSync; let n = 0;",
    "cp.spawnSync = (c, a, o) => (c === 'powershell' && /Get-PnpDevice/.test((a || []).join(' ')) && ++n > 1 ? { status: 0, stdout: 'Unknown\\n', stderr: '' } : prev(c, a, o));",
    'syncBuiltinESMExports();', ''].join('\n'));
  const p = spawn(process.execPath, ['--import', pathToFileURL(gone).href, f('deploy/laptop/laptop-agent.mjs')], { env: laptopEnv(t, m.port), stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill(), 15000);
  const code = await new Promise((r) => p.on('exit', r)); clearTimeout(timer); await m.close();
  assert.equal(code, 3, err); assert.match(err, /GPU missing -> provider disabled/); assert.doesNotMatch(err, /ReferenceError|TypeError/);
});

test('laptop-reaper: runs, finds nothing of ours to reap and exits 0', () => {
  const r = node(['--import', STUB, f('deploy/laptop/laptop-reaper.mjs'), '59998'], { env: { ...process.env, LAPTOP_REAPER_MS: '100' } });
  assert.equal(r.status, 0, r.stdout + r.stderr); clean(r, 'reaper');
});

test('office-agent: resolves the served model and launches the qwen binary with it', async () => {
  const t = mkdtempSync(join(tmpdir(), 'smoke-office-'));
  const m = await fakeModelServer('office-model-1');
  try {
    const r = await runAsync([f('deploy/office/office-agent.mjs'), fakeBin(t), `http://127.0.0.1:${m.port}/v1`, 'fallback-model'], { ...process.env, FAKE_QWEN_ECHO: '1', AGENT_HUB_RESOLVE_CACHE_OFFICE: join(t, 'cache.json') });
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /--model office-model-1/); clean(r, 'office-agent');
    // Qwen Code's global auto-memory is switched off for every hub-launched Qwen (a stale ~/.qwen/memories leaked one task's rules into another)
    const sys = /SYSSETTINGS (.+)/.exec(r.stdout)?.[1]?.trim();
    assert.ok(sys && existsSync(sys), 'QWEN_CODE_SYSTEM_SETTINGS_PATH not set to a real file: ' + r.stdout);
    assert.equal(JSON.parse(readFileSync(sys, 'utf8')).memory.enableManagedAutoMemory, false);
  } finally { await m.close(); }
});

test('CLI entry points load and answer: gen.mjs, hub.mjs, route.mjs, office.mjs, check-config, scan, agent_hub_usage', () => {
  let r = node([f('deploy/shared/gen.mjs')]); assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /usage: node gen\.mjs/);
  r = node([f('scripts/hub.mjs')]); assert.equal(r.status, 2); assert.match(r.stdout, /usage: hub\.mjs/); clean(r, 'hub');
  r = node([f('plugins/routing/route.mjs')]); assert.equal(r.status, 2); assert.match(r.stderr, /usage: route\.mjs/);
  r = node([f('plugins/routing/route.mjs'), '--resolve', 'codex/gpt-test']); assert.equal(r.status, 0, r.stderr); clean(r, 'route --resolve');
  r = node([f('plugins/routing/office.mjs'), '--id', 'http://127.0.0.1:1', 'fb-model'], { env: { ...process.env, AGENT_HUB_RESOLVE_CACHE_OFFICE: join(mkdtempSync(join(tmpdir(), 'smoke-id-')), 'c.json') } });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'fb-model'); clean(r, 'office --id');
  r = node([f('scripts/check-config.mjs')]); assert.equal(r.status, 0, r.stdout + r.stderr); clean(r, 'check-config');
  r = node([f('scripts/scan.mjs')]); assert.equal(r.status, 0, r.stdout + r.stderr); clean(r, 'scan');
  const py = spawnSync(WIN ? 'python' : 'python3', [f('plugins/usage-otel/bin/agent_hub_usage.py'), '--help'], { encoding: 'utf8', timeout: 30000 });
  if (!py.error) { assert.equal(py.status, 2, py.stderr); assert.match(py.stderr + py.stdout, /usage: agent-hub usage/); assert.doesNotMatch(py.stderr, /Traceback/); }
});

// Registry guard: a new .mjs under deploy/ or plugins/ must either import cleanly (a library) or be added to the process list.
const ENTRY = new Set(['deploy/laptop/laptop-agent.mjs', 'deploy/laptop/laptop-reaper.mjs', 'deploy/office/office-agent.mjs', 'deploy/shared/gen.mjs', 'plugins/routing/route.mjs', 'plugins/usage-otel/bin/paseo_run_split.mjs']);
const mjsFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === 'test' ? [] : e.isDirectory() ? mjsFiles(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : []));
test('every other .mjs under deploy/ and plugins/ imports without error (a new process script must join ENTRY and get its own test)', () => {
  const libs = [...mjsFiles(f('deploy')), ...mjsFiles(f('plugins'))].filter((p) => !ENTRY.has(relative(ROOT, p).replaceAll('\\', '/')));
  assert.ok(libs.length >= 8, `found only ${libs.length} library files`);
  for (const p of libs) {
    const r = node(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(p).href)})`], { timeout: 20000 });
    assert.equal(r.status, 0, `${relative(ROOT, p)} failed to import:\n${r.stderr}`);
  }
});

test('laptop-agent: low free RAM is a paused state, not a probe error: initialize + session/new answer, only the prompt is refused (exit 3)', async () => {
  const t = mkdtempSync(join(tmpdir(), 'smoke-paused-'));
  const p = spawn(process.execPath, ['--import', STUB, f('deploy/laptop/laptop-agent.mjs')], { env: laptopEnv(t, 1, { LAPTOP_MIN_FREE_GB: '100000' }), stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => p.on('exit', (c) => r(c)));
  try {
    p.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    p.stdin.write('{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":".","mcpServers":[]}}\n');
    for (let i = 0; i < 100 && !/"id":2/.test(out) && p.exitCode === null; i++) await sleep(100);
    assert.match(out, /"id":2/, `the probe got no session/new answer; stderr: ${err}`);
    assert.equal(p.exitCode, null, 'the launcher must stay up for the probe');
    p.stdin.write('{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{}}\n');
    assert.equal(await exited, 3); assert.match(err, /LAPTOP-REFUSED: free RAM/);
  } finally { if (p.exitCode === null) p.kill(); }
});

test('paseo_run_split: needs the handshake; creates WITHOUT the prompt, publishes the id, sends the prompt only after the launcher wrote the marker and .go', async () => {
  const bare = node([f('plugins/usage-otel/bin/paseo_run_split.mjs')], { env: { ...process.env, AGENT_HUB_DIRECT_HANDSHAKE: '' } });
  assert.equal(bare.status, 2); assert.match(bare.stderr, /HANDSHAKE is required/);
  const t = mkdtempSync(join(tmpdir(), 'smoke-split-')); const cli = join(t, 'cli'), gate = join(t, 'gate'), hs = join(t, 'hs'), log = join(t, 'calls.log');
  const mk = (p, body) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
  mk(join(cli, 'node_modules', '@getpaseo', 'client', 'dist', 'daemon-client.js'), `import { appendFileSync } from 'node:fs';
export class DaemonClient {
  async createAgent(o) { appendFileSync(${JSON.stringify(log)}, 'create prompt=' + (o.initialPrompt ?? 'NONE') + ' labels=' + JSON.stringify(o.labels) + '\\n'); return { id: 'AGENT-1234-FAKE' }; }
  async sendAgentMessage(id, text) { appendFileSync(${JSON.stringify(log)}, 'send ' + id + ' ' + text + '\\n'); }
}`);
  mk(join(cli, 'dist', 'index.js'), `import { DaemonClient } from '../node_modules/@getpaseo/client/dist/daemon-client.js';
await new DaemonClient().createAgent({ initialPrompt: 'THE-PROMPT', labels: { session: 's' } });`);
  const child = spawn(process.execPath, [f('plugins/usage-otel/bin/paseo_run_split.mjs')], { env: { ...process.env, AGENT_HUB_PASEO_CLI_DIR: cli, AGENT_HUB_GATE_DIR: gate, AGENT_HUB_DIRECT_HANDSHAKE: hs }, stdio: 'pipe' });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(fn(), 'timeout ' + err); };
  await until(() => existsSync(hs + '.id'));
  assert.equal(readFileSync(hs + '.id', 'utf8'), 'AGENT-1234-FAKE');
  writeFileSync(hs + '.go', ''); // an early .go without the marker must NOT release the prompt
  await new Promise((r) => setTimeout(r, 400));
  assert.doesNotMatch(readFileSync(log, 'utf8'), /send /, 'no prompt before the marker exists');
  mkdirSync(join(gate, 'direct'), { recursive: true }); writeFileSync(join(gate, 'direct', 'AGENT-1234-FAKE.json'), '{}');
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0, err);
  const calls = readFileSync(log, 'utf8').trim().split(/\r?\n/);
  assert.equal(calls[0].startsWith('create prompt=NONE'), true, calls[0]); assert.equal(calls[1], 'send AGENT-1234-FAKE THE-PROMPT');
});
