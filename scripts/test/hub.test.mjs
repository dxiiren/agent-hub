import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'hub.mjs');
const WIN = process.platform === 'win32';

function sandbox() {
  const t = mkdtempSync(join(tmpdir(), 'ahub-'));
  const bin = join(t, 'bin'); mkdirSync(bin);
  const log = join(t, 'calls.log');
  for (const n of ['claude', 'qodercli', 'qwen', 'codex', 'opencode']) {
    if (WIN) writeFileSync(join(bin, n + '.cmd'), `@echo %* >> "${log}"\r\n`);
    else { writeFileSync(join(bin, n), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 }); }
  }
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, AGENT_HUB_HOME: join(t, 'home'), AGENT_HUB_CLIENT_ROOT: join(t, 'root'), AGENT_HUB_LOCAL: join(t, 'hub.local.json'), AGENT_HUB_ROUTES: join(t, 'routes.json') };
  return { t, log, env, hub: (...a) => spawnSync(process.execPath, [HUB, ...a], { env, encoding: 'utf8' }) };
}
const files = (t) => ['root/claude/.claude.json', 'root/qoder/.qoder/settings.json', 'root/qwen/.qwen/settings.json', 'root/codex/config.toml', 'root/opencode/opencode.json', 'home/agent-hub-secret'].map((f) => join(t, f));

test('mcp add: token never reaches a process argument, files are owner-only', () => {
  const s = sandbox();
  const r = s.hub('mcp', 'add'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const tok = readFileSync(join(s.t, 'home/agent-hub-secret'), 'utf8').trim();
  assert.match(tok, /^[0-9a-f]{48}$/);
  assert.equal(existsSync(s.log) ? readFileSync(s.log, 'utf8') : '', '', 'client CLIs must not be called with the token');
  for (const f of files(s.t)) {
    assert.ok(readFileSync(f, 'utf8').includes(tok), f);
    if (WIN) {
      const acl = spawnSync('icacls', [f], { encoding: 'utf8' }).stdout;
      assert.doesNotMatch(acl, /Everyone|BUILTIN\Users|Authenticated Users/i, f + '\n' + acl);
    } else assert.equal(statSync(f).mode & 0o777, 0o600, f);
  }
  assert.equal(s.hub('mcp', 'add').status, 0); // idempotent
  assert.equal(s.hub('mcp', 'remove').status, 0);
  assert.ok(!readFileSync(files(s.t)[0], 'utf8').includes('agent-hub'));
});

test('unconfigure disables MCP when it removes auth', () => {
  const s = sandbox();
  mkdirSync(join(s.t, 'home'));
  writeFileSync(join(s.t, 'home/config.json'), JSON.stringify({ version: 1, daemon: { mcp: { enabled: true, injectIntoAgents: true }, auth: { password: 'x' } }, agents: { providers: { codex: {} } } }));
  const r = s.hub('unconfigure'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = JSON.parse(readFileSync(join(s.t, 'home/config.json'), 'utf8'));
  assert.equal(c.daemon.auth, undefined);
  assert.equal(c.daemon.mcp.enabled, false);
  assert.equal(c.daemon.mcp.injectIntoAgents, false);
});

test('configure: a fresh install has NO providers (no presets, no read-only twins), even with every CLI installed', () => {
  const s = sandbox();
  const r = s.hub('configure'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = JSON.parse(readFileSync(join(s.t, 'home/config.json'), 'utf8'));
  assert.deepEqual(Object.keys(c.agents?.providers ?? {}), [], 'nothing seeded');
  assert.ok(!/provider registered/.test(r.stdout));
  assert.equal(s.hub('configure').status, 0); // idempotent
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(s.t, 'home/config.json'), 'utf8')).agents?.providers ?? {}), []);
});

test('configure: an older installs seeded Qwen entries become ordinary user-added providers, the -ro twins go (idempotent)', () => {
  const s = sandbox(); mkdirSync(join(s.t, 'home'), { recursive: true });
  const e = (url) => ({ extends: 'acp', label: 'Qwen Code x', command: ['node', '/r/deploy/office/office-agent.mjs', 'qwen', url, 'm1'] });
  writeFileSync(join(s.t, 'home/config.json'), JSON.stringify({ version: 1, agents: { providers: { 'qwen-code': e('http://h:1/v1'), 'qwen-code-ro': { ...e('http://h:1/v1'), command: [...e('http://h:1/v1').command, '--read-only'] } } } }));
  const r = s.hub('configure'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = JSON.parse(readFileSync(join(s.t, 'home/config.json'), 'utf8')).agents.providers;
  assert.deepEqual(Object.keys(c), ['qwen-code']);
});

test('configure: daemon password hash uses the cheap bcrypt cost, and re-hashes a costly one (every MCP call pays this cost)', () => {
  const s = sandbox();
  assert.equal(s.hub('configure').status, 0);
  const f = join(s.t, 'home/config.json');
  const h1 = JSON.parse(readFileSync(f, 'utf8')).daemon.auth.password;
  assert.match(h1, /^\$2[aby]\$04\$/);
  const secret = readFileSync(join(s.t, 'home/agent-hub-secret'), 'utf8').trim();
  const bc = createRequire(import.meta.url)(execFileSync('npm', ['root', '-g'], { shell: process.platform === 'win32' }).toString().trim() + '/@getpaseo/cli/node_modules/bcryptjs');
  assert.ok(bc.compareSync(secret, h1));
  const c = JSON.parse(readFileSync(f, 'utf8')); c.daemon.auth.password = bc.hashSync(secret, 10); writeFileSync(f, JSON.stringify(c));
  assert.equal(s.hub('configure').status, 0);
  assert.match(JSON.parse(readFileSync(f, 'utf8')).daemon.auth.password, /^\$2[aby]\$04\$/);
});

test('configure: enables the daemon web UI (same-origin local page at the daemon port)', () => {
  const s = sandbox();
  assert.equal(s.hub('configure').status, 0);
  assert.equal(JSON.parse(readFileSync(join(s.t, 'home/config.json'), 'utf8')).features.webUi.enabled, true);
});
