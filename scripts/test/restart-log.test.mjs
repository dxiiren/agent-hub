import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { logRequest, scrub, ancestry } from '../restart-log.mjs';

test('scrub blanks secret-looking arguments', () => assert.equal(scrub('paseo --password hunter2 --token=abc x'), 'paseo --password *** --token=*** x'));
test('logRequest writes one line: time, action, reason and the requester chain', () => {
  const home = mkdtempSync(join(tmpdir(), 'rl-'));
  const l = logRequest('stop', 'owner asked', { home, chain: [{ pid: 7, name: 'node', cmd: 'node x.mjs --password p1' }, { pid: 3, name: 'just', cmd: 'just down' }], now: new Date(0) });
  assert.equal(readFileSync(join(home, 'restart-requests.log'), 'utf8'), l);
  assert.match(l, /^1970-01-01T00:00:00.000Z stop reason="owner asked" by 7:node \[node x.mjs --password \*\*\*\] <- 3:just \[just down\]\n$/);
});
test('ancestry names this process and its parent', () => { const a = ancestry(); assert.equal(a[0].pid, process.pid); assert.ok(a.length >= 2, JSON.stringify(a)); });
test('the CLI entry appends a line for the action', () => {
  const home = mkdtempSync(join(tmpdir(), 'rl-'));
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'restart-log.mjs'), 'start'], { env: { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_REASON: 'test' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(readFileSync(join(home, 'restart-requests.log'), 'utf8'), / start reason="test" by \d+:node/);
});
