import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDaemonEnv, parseExtras } from '../daemon-env.mjs';

const secrets = { GITEA_TOKEN: 't', GITHUB_MCP_PAT: 't', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', DB_PASSWORD: 'p', AWS_SECRET_ACCESS_KEY: 's', GOOGLE_APPLICATION_CREDENTIALS: 'c', NPM_AUTH: 'a', PASEO_PASSWORD: 'p', AGENT_HUB_SECRET_FILE: 'f', SSH_AUTH_SOCK: 's', MY_PRIVATE_THING: 'x' };
const basics = { PATH: 'p', Path: 'p2', SystemRoot: 'C:/Windows', TEMP: 't', HOME: '/h', USERPROFILE: 'u', APPDATA: 'a', LOCALAPPDATA: 'l', ProgramFiles: 'pf', 'ProgramFiles(x86)': 'pf86', COMPUTERNAME: 'c', PROCESSOR_ARCHITECTURE: 'x', LC_ALL: 'C', LANG: 'en', XDG_CONFIG_HOME: '/x', TZ: 'z', SHELL: '/bin/sh', TERM: 'xterm', PASEO_HOME: '/p', AGENT_HUB_MCP: 'http://127.0.0.1:6767/mcp/agents', AGENT_HUB_PORT: '6767', CODEX_HOME: '/c' };

test('credential-looking variables are dropped, OS and hub variables kept (win/mac/linux names)', () => {
  const out = buildDaemonEnv({ ...basics, ...secrets, RANDOM_TOOL_SETTING: 'v' });
  assert.deepEqual(Object.keys(out).sort(), Object.keys(basics).sort());
  for (const k of Object.keys(secrets)) assert.ok(!(k in out), k);
  assert.ok(!('RANDOM_TOOL_SETTING' in out));
});

test('extras are honoured: exact names, prefix with *, case-insensitive, comma string or array', () => {
  const env = { HTTPS_PROXY: 'p', https_proxy: 'p', NO_PROXY: 'n', NODE_EXTRA_CA_CERTS: 'c', GITEA_TOKEN: 't', OTHER: 'o' };
  assert.deepEqual(Object.keys(buildDaemonEnv(env, 'https_proxy, NO_PROXY,NODE_*')).sort(), ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'NO_PROXY', 'https_proxy']);
  assert.deepEqual(Object.keys(buildDaemonEnv(env, ['GITEA_TOKEN'])), ['GITEA_TOKEN']); // an explicit extra is the owner's choice
  assert.deepEqual(parseExtras(undefined), []);
});

test('the launcher runs the command with the scrubbed environment', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../daemon-env.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, process.execPath, '-e', 'console.log(JSON.stringify(Object.keys(process.env)))'],
    { encoding: 'utf8', env: { ...process.env, GITEA_TOKEN: 't', MY_API_KEY: 'k', AGENT_HUB_ENV_ALLOW: 'KEPT_VAR', KEPT_VAR: '1' } });
  const keys = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.ok(keys.includes('KEPT_VAR') && !keys.includes('GITEA_TOKEN') && !keys.includes('MY_API_KEY'), r.stdout + r.stderr);
});
