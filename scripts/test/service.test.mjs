// Regression: `just down` exited 1 because PS 5.1 + ErrorActionPreference=Stop turned paseo's stderr into NativeCommandError.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('service.ps1 stop tolerates paseo writing to stderr', { skip: process.platform !== 'win32' }, () => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(root, 'deploy', 'service', 'service.ps1'), 'stop'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_HUB_PASEO: join(root, 'deploy', 'service', 'test', 'fake-paseo.cmd'),
      AGENT_HUB_TASK: 'AgentHubNoSuchTaskForTest', AGENT_HUB_HOME: join(root, '.no-such-home') },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /stopped/);
});
