// Both CLI wrappers (bin/agent-hub for sh, bin/agent-hub.cmd for Windows) must reach every script they dispatch to.
// A `\r` escape once ate the "\routing" of one .cmd path, so `agent-hub cleanup` died on Windows while every test passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'usage-otel', 'bin');
const CMD = join(BIN, 'agent-hub.cmd'), SH = join(BIN, 'agent-hub');

test('every script path in agent-hub.cmd exists (and no stray carriage return hides inside a path)', () => {
  const t = readFileSync(CMD, 'utf8');
  assert.equal(/\r(?!\n)/.test(t), false, 'a lone CR inside the .cmd (a "\\r" escape that was typed as a character)');
  const paths = [...t.matchAll(/%~dp0([^"\s]+)/g)].map((m) => m[1].replaceAll('\\', '/'));
  assert.ok(paths.length >= 6, `found ${paths.length} paths`);
  for (const p of paths) assert.ok(existsSync(resolve(BIN, p)), `agent-hub.cmd points at ${p}, which does not exist`);
});

test('every script path in the sh wrapper exists', () => {
  const t = readFileSync(SH, 'utf8');
  const paths = [...t.matchAll(/\$d\/([^"\s]+)/g)].map((m) => m[1]);
  assert.ok(paths.length >= 6, `found ${paths.length} paths`);
  for (const p of paths) assert.ok(existsSync(resolve(BIN, p)), `agent-hub points at ${p}, which does not exist`);
});

// Each subcommand with arguments that make its script answer at once (usage or a refusal), through the real wrapper. doctor is covered by the path checks (it would talk to a daemon).
const CASES = [
  [['cleanup', '--older-than', 'bad'], /--older-than takes a number/],
  [['route'], /usage: route[.]mjs/],
  [['reply'], /usage: route[.]mjs reply/],
  [['provider'], /provider kinds/],
];
const out = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;
for (const [args, re] of CASES) {
  test(`agent-hub.cmd ${args[0]} reaches its script`, { skip: process.platform !== 'win32' }, () => {
    const r = spawnSync('cmd', ['/d', '/c', CMD, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(r.status, 2, out(r));
    assert.match(out(r), re);
  });
  test(`sh agent-hub ${args[0]} reaches its script`, () => {
    const r = spawnSync('sh', [SH, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (r.error?.code === 'ENOENT') return; // no sh on this machine
    assert.equal(r.status, 2, out(r));
    assert.match(out(r), re);
  });
}
test('an unknown subcommand prints the usage and exits 2 through both wrappers', () => {
  const sh = spawnSync('sh', [SH, 'nope'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (!sh.error) { assert.equal(sh.status, 2); assert.match(out(sh), /usage: agent-hub/); }
  if (process.platform === 'win32') {
    const c = spawnSync('cmd', ['/d', '/c', CMD, 'nope'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(c.status, 2); assert.match(out(c), /usage: agent-hub/);
  }
});
