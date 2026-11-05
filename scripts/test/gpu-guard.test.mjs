import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, ownedStopTarget, idleExpired, modelMatches, markInflight, clearInflight, anyInflight, sharedIdle, cpuJudgeable } from '../../deploy/laptop/gpu-guard.mjs';

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

test('only the recorded pid is a stop target; a foreign listener or none is never stopped', () => {
  assert.equal(ownedStopTarget({ pid: 42 }, 42), 42);
  assert.equal(ownedStopTarget({ pid: 42 }, 99), null); // someone else's server took the port
  assert.equal(ownedStopTarget(null, 99), null);        // hub never started one
});
test('keep-warm: idle timeout is honoured, a fresh prompt resets it', () => {
  const own = { pid: 42, lastUsed: 1_000 };
  assert.equal(idleExpired(own, 1_000 + 14 * 60_000, 15 * 60_000), false);
  assert.equal(idleExpired(own, 1_000 + 16 * 60_000, 15 * 60_000), true);
  assert.equal(idleExpired(null, 1e12, 1), false);
});
test('modelMatches: alias or model file name, else refuse', () => {
  assert.equal(modelMatches('qwen35-9b', 'qwen35-9b', 'D:/m/x.gguf'), true);
  assert.equal(modelMatches('Qwen3.5-9B-Q4.gguf', 'qwen35-9b', 'D:'+String.fromCharCode(92)+'m'+String.fromCharCode(92)+'Qwen3.5-9B-Q4.gguf'), true);
  assert.equal(modelMatches('llama-70b', 'qwen35-9b', 'D:/m/x.gguf'), false);
  assert.equal(modelMatches('', 'qwen35-9b', 'D:/m/x.gguf'), false);
});

const NOW = 10_000_000;
test('fresh second process: shared in-flight or recent lastUsed keeps the server non-idle', () => {
  const own = { pid: 42, startedAt: NOW - 600_000, lastUsed: NOW - 10_000 };
  assert.equal(sharedIdle(own, false, NOW, 300_000), false); // recent use by another process
  assert.equal(sharedIdle({ ...own, lastUsed: 0 }, true, NOW, 300_000), false); // prompt in flight elsewhere
  const port = 't' + process.pid;
  assert.equal(anyInflight(port), false);
  markInflight(port, 1); assert.equal(anyInflight(port), true);
  assert.equal(anyInflight(port, Date.now() + 200_000), false); // stale marker of a dead process is ignored
  clearInflight(port, 1); assert.equal(anyInflight(port), false);
});
test('no CPU judging before first /health or within 60 s of the start', () => {
  assert.equal(cpuJudgeable({ startedAt: NOW - 600_000 }, false, NOW), false);
  assert.equal(cpuJudgeable({ startedAt: NOW - 30_000 }, true, NOW), false);
  assert.equal(cpuJudgeable({ startedAt: NOW - 61_000 }, true, NOW), true);
  const idle = sharedIdle({ startedAt: NOW - 30_000, lastUsed: 0 }, false, NOW, 300_000) && cpuJudgeable({ startedAt: NOW - 30_000 }, true, NOW);
  assert.equal(judge({ ...ok, cpuPct: 400, idle }), '');
});
test('truly idle server burning CPU is still flagged; a lost GPU is caught regardless of idle', () => {
  const own = { startedAt: NOW - 900_000, lastUsed: NOW - 400_000 };
  const idle = sharedIdle(own, false, NOW, 300_000) && cpuJudgeable(own, true, NOW);
  assert.match(judge({ ...ok, cpuPct: 400, idle }), /CPU while idle/);
  assert.match(judge({ ...ok, pnp: 'Unknown', idle: false }), /PnP/);
  assert.match(judge({ ...ok, apps: [], usedMiB: 100, idle: false }), /no GPU memory/);
});
