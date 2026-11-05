import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge } from '../../deploy/laptop/gpu-guard.mjs';

const ok = { pnp: 'OK', smiOk: true, usedMiB: 6000, apps: [42], serverPid: 42, cpuPct: 3, idle: true };

test('healthy GPU run passes', () => assert.equal(judge(ok), ''));
test('no model loaded and GPU fine passes', () => assert.equal(judge({ ...ok, serverPid: null, apps: [], usedMiB: 0 }), ''));
test('PnP Unknown is a failure', () => assert.match(judge({ ...ok, pnp: 'Unknown' }), /PnP status is Unknown/));
test('nvidia-smi failing is a failure', () => assert.match(judge({ ...ok, smiOk: false }), /nvidia-smi/));
test('loaded but no GPU compute app and no GPU memory = CPU run', () => assert.match(judge({ ...ok, apps: [], usedMiB: 300 }), /no GPU memory/));
test('WDDM not listing the pid is fine while GPU memory is in use', () => assert.equal(judge({ ...ok, apps: [] }), ''));
test('high idle CPU fails, high CPU while busy does not', () => {
  assert.match(judge({ ...ok, cpuPct: 400 }), /CPU while idle/);
  assert.equal(judge({ ...ok, cpuPct: 400, idle: false }), '');
});

test('--check refuses (exit 3) when the GPU is missing', { skip: process.platform !== 'win32' }, () => {
  const agent = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'laptop', 'laptop-agent.mjs');
  // PnP says Unknown on this laptop right now; skip when the card is actually healthy
  const pnp = spawnSync('powershell', ['-NoProfile', '-Command', "(Get-PnpDevice -Class Display | Where-Object FriendlyName -like '*NVIDIA*').Status"], { encoding: 'utf8' }).stdout.trim();
  if (pnp === 'OK') return;
  const r = spawnSync(process.execPath, [agent, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /GPU missing -> provider disabled/);
});
