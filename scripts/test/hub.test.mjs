import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, resolve, dirname } from 'node:path';
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
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, AGENT_HUB_HOME: join(t, 'home'), AGENT_HUB_CLIENT_ROOT: join(t, 'root') };
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
