// Entry-point checks: scripts that only run as processes are launched or parsed for real, so a syntax or wiring break fails `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAP = join(ROOT, 'scripts', 'claude-wrap.mjs');
const WIN = process.platform === 'win32';
const rules = () => { const d = mkdtempSync(join(tmpdir(), 'wrap-')); const f = join(d, 'rules.json'); writeFileSync(f, JSON.stringify({ permissions: { deny: ['Bash'], allow: [] } })); return f; };
const wrap = (rest, env = {}) => spawnSync(process.execPath, [WRAP, 'claude-bin', 'mcp.json', rules(), ...rest], { encoding: 'utf8', env: { ...process.env, ...env } });

test('claude-wrap entry point: plan mode gets read-only settings, hook and user-only sources; bypass is untouched', () => {
  const r = wrap(['--permission-mode', 'plan', '--setting-sources', 'project', '--settings', '{"x":1}', '-p', 'hi'], { AGENT_HUB_WRAP_DRYRUN: '1' });
  assert.equal(r.status, 0, r.stderr);
  const { bin, args } = JSON.parse(r.stdout);
  assert.equal(bin, 'claude-bin');
  const s = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(s.permissions.deny, ['Bash']); assert.equal(s.x, 1);
  assert.ok(JSON.stringify(s.hooks.PreToolUse).includes('claude-readhook.mjs'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
  assert.ok(!args.includes('project'));
  const b = JSON.parse(wrap(['--permission-mode', 'bypassPermissions', '-p', 'hi'], { AGENT_HUB_WRAP_DRYRUN: '1' }).stdout).args;
  assert.ok(!b.includes('--settings') && !b.includes('--setting-sources'));
  assert.deepEqual(b.slice(0, 3), ['--strict-mcp-config', '--mcp-config', 'mcp.json']);
});

test('claude-wrap entry point spawns the real binary and passes its exit code (POSIX fake claude)', { skip: WIN }, () => {
  const d = mkdtempSync(join(tmpdir(), 'fc-')); const fake = join(d, 'claude');
  writeFileSync(fake, '#!/bin/sh\necho "$@"\nexit 3\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [WRAP, fake, 'mcp.json', rules(), '--permission-mode', 'plan'], { encoding: 'utf8' });
  assert.equal(r.status, 3); assert.match(r.stdout, /--setting-sources user/);
});

test('deploy/usage/pollers/pollers.py compiles', () => {
  const r = spawnSync('python', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf8").read())', join(ROOT, 'deploy', 'usage', 'pollers', 'pollers.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('deploy/usage/ensure-usage.ps1 parses (PowerShell parser)', { skip: !WIN }, () => {
  const f = join(ROOT, 'deploy', 'usage', 'ensure-usage.ps1').replaceAll(String.fromCharCode(92), '/');
  const ps = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f}',[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 1}`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('deploy/shared/entrypoint.sh passes bash -n', () => {
  const bash = WIN ? ['C:/Program Files/Git/bin/bash.exe', '/usr/bin/bash'].find(existsSync) : 'bash';
  if (!bash) return;
  const r = spawnSync(bash, ['-n', join(ROOT, 'deploy', 'shared', 'entrypoint.sh').replaceAll(String.fromCharCode(92), '/')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
