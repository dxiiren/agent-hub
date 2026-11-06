import test from 'node:test';
import assert from 'node:assert/strict';
import { accountGroups, planUsage, toGroupReport, tallyIds, groupReport, _resetForTest } from '../server/accounts-usage.mjs';

const local = { extraProviders: {
  'claude-work': { type: 'claude', account: 'work', accountDir: '/a/work', model: 'm' },
  'codex-two': { type: 'codex', account: 'two', accountDir: '/a/two', model: 'm' },
  'qoder-b': { type: 'qoder', account: 'b', accountDir: '/a/qb', model: 'm' },
  'qwen-x': { type: 'qwen-code', url: 'http://h/v1', model: 'm' } } };
const NOW = Date.parse('2026-11-06T10:00:00Z');
const feed = [{ provider: 'claude-work', in: 100, out: 50 }, { provider: 'claude-clean', in: 10, out: 5 }, { provider: 'claude', in: 1, out: 1 }, { provider: 'codex-two', in: 7, out: 3 }]
  .map((r) => JSON.stringify({ ts: '2026-11-06T09:00:00Z', ...r })).join('\n');

test('groups: one group per kind with accounts, default login first, endpoint kinds left to their own grouping', () => {
  const g = accountGroups(local, { CLAUDE_CONFIG_DIR: '/def/claude' });
  assert.deepEqual(Object.keys(g).sort(), ['claude', 'codex', 'qoder']);
  assert.deepEqual(g.claude.accounts.map((a) => a.id), ['default', 'claude-work']); assert.equal(g.claude.accounts[0].dir, '/def/claude');
  assert.deepEqual(accountGroups({}), {});
});

test('tally folds the default ids and the -ro suffix per account', () => {
  assert.deepEqual(tallyIds(feed, ['claude', 'claude-clean'], NOW), { in: 11, out: 6, n: 2 });
  assert.deepEqual(tallyIds(feed, ['claude-work'], NOW), { in: 100, out: 50, n: 1 });
});

test('claude plan usage: not logged in, expired, ok; the token is sent but never returned', async () => {
  assert.deepEqual(await planUsage('claude', '/x', { read: () => null }), { error: 'not logged in' });
  assert.match((await planUsage('claude', '/x', { read: () => ({ claudeAiOauth: { accessToken: 't', expiresAt: 1 } }), now: 5 })).error, /expired/);
  let seen; const f = async (u, o) => { seen = { u, o }; return { ok: true, json: async () => ({ five_hour: { utilization: 12.34 }, seven_day: { utilization: 40 } }) }; };
  const r = await planUsage('claude', '/x', { f, read: () => ({ claudeAiOauth: { accessToken: 'SECRET', expiresAt: 9e15 } }) });
  assert.deepEqual(r, { session: 12.3, weekly: 40 }); assert.match(seen.u, /oauth\/usage$/); assert.ok(!JSON.stringify(r).includes('SECRET'));
});

test('codex plan usage: windows classified by length; missing auth = not logged in', async () => {
  assert.deepEqual(await planUsage('codex', '/x', { read: () => ({}) }), { error: 'not logged in' });
  const f = async () => ({ ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 }, secondary_window: { used_percent: 30, limit_window_seconds: 604800 } } }) });
  assert.deepEqual(await planUsage('codex', '/x', { f, read: () => ({ tokens: { access_token: 't', account_id: 'a' } }) }), { session: 5, weekly: 30 });
  assert.deepEqual(await planUsage('qoder', '', {}), { error: 'plan usage not readable for this kind' });
});

test('group report: Total line plus one line per account; a not-logged-in account does not crash the card', async () => {
  _resetForTest();
  const r = await groupReport('claude', { local, feed, now: () => NOW, read: () => null, f: async () => { throw new Error('no net'); } });
  assert.equal(r.status, 'available'); assert.equal(r.planLabel, '2 accounts');
  assert.deepEqual(r.details.map((d) => d.id), ['total', 'default', 'claude-work']);
  assert.match(r.details[0].value, /111 in \/ 56 out, 3 tasks/);
  assert.match(r.details[2].value, /^not logged in/);
  assert.equal((await groupReport('qoder', { local: {}, now: () => NOW })).status, 'error');
  assert.equal(toGroupReport([{ id: 'a', label: 'a', plan: { session: 95 }, tally: { in: 0, out: 0, n: 0 } }]).details[0].tone, 'danger');
});
