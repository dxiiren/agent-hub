import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGateTemp } from '../../plugins/routing/cleanup.mjs';
import { migrateOldRunFiles, reapOrphans } from '../../deploy/laptop/gpu-guard.mjs';
import { backfillUsage, appendUsage, bookedAgents } from '../../plugins/usage-otel/server/usage.mjs';
import { paths } from '../provider.mjs';

test('cleanGateTemp sweeps agent-hub-gate-XXXXXX when the owner pid is dead, keeps a live owner and a young unowned one', () => {
  const t = mkdtempSync(join(tmpdir(), 'ahub-fixh-gate-'));
  const mk = (n, pid) => { const d = join(t, n); mkdirSync(join(d, 'scan'), { recursive: true }); if (pid) writeFileSync(join(d, 'owner.pid'), String(pid)); return d; };
  const dead = mk('agent-hub-gate-aaaaaa', 111), live = mk('agent-hub-gate-bbbbbb', 222), unowned = mk('agent-hub-gate-cccccc'), oldUnowned = mk('agent-hub-gate-dddddd');
  const old = Date.now() / 1000 - 2 * 86400; utimesSync(oldUnowned, old, old);
  const opts = { tmp: t, dead: (p) => p === 111 };
  assert.equal(cleanGateTemp({ ...opts, dry: true }), 2);
  assert.ok(existsSync(dead));
  assert.equal(cleanGateTemp(opts), 2);
  assert.deepEqual([existsSync(dead), existsSync(live), existsSync(unowned), existsSync(oldUnowned)], [false, true, true, false]);
});

test('migrateOldRunFiles removes only our exact old names with dead owners; dry run removes nothing', () => {
  const d = mkdtempSync(join(tmpdir(), 'ahub-fixh-old-'));
  const w = (n, c) => writeFileSync(join(d, n), c);
  w('agent-hub-laptop-8089.json', JSON.stringify({ pid: 111 })); w('agent-hub-laptop-8089.reaper', '111'); w('agent-hub-laptop-8089.inflight.111', '1');
  w('agent-hub-laptop-8090.json', JSON.stringify({ pid: 222 })); w('agent-hub-laptop-8089.inflight.222', '1'); w('other-file.json', '{}'); w('agent-hub-laptop-x.json', '{}');
  const o = { dirs: [d], pAlive: (p) => p === 222 };
  assert.equal(migrateOldRunFiles({ ...o, dry: true }).length, 3);
  assert.ok(existsSync(join(d, 'agent-hub-laptop-8089.json')));
  assert.equal(migrateOldRunFiles(o).length, 3);
  assert.deepEqual(['agent-hub-laptop-8089.json', 'agent-hub-laptop-8089.reaper', 'agent-hub-laptop-8089.inflight.111', 'agent-hub-laptop-8090.json', 'agent-hub-laptop-8089.inflight.222', 'other-file.json', 'agent-hub-laptop-x.json'].map((n) => existsSync(join(d, n))), [false, false, false, true, true, true, true]);
});

test('reapOrphans dry run lists an idle orphan but stops and removes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-fixh-reap-'));
  writeFileSync(join(dir, 'agent-hub-laptop-9001.json'), JSON.stringify({ pid: 5, lastUsed: 1 }));
  const stopped = [];
  const r = reapOrphans({ idleMs: 1000, now: 1e9, dir, dry: true, alive: () => true, inflightOf: () => false, stop: (o) => { stopped.push(o.pid); return true; } });
  assert.deepEqual(r, [{ port: '9001', pid: 5 }]);
  assert.deepEqual(stopped, []);
  assert.ok(existsSync(join(dir, 'agent-hub-laptop-9001.json')));
});

test('provider paths(): PASEO_HOME is honoured when AGENT_HUB_HOME is not set (the run dir already did)', () => {
  const p = paths({ PASEO_HOME: join(tmpdir(), 'ph'), AGENT_HUB_NO_LOCAL: '1' });
  assert.equal(p.paseo, join(tmpdir(), 'ph', 'config.json'));
});

test('usage backfill books recent finished agents with no record, once (idempotent by agent id)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-fixh-usage-'));
  const now = Date.parse('2026-11-07T12:00:00Z'), fresh = '2026-11-07T11:00:00Z';
  appendUsage(dir, { agent: 'has', session: '', provider: 'codex', in: 1, out: 1, cached: 0, cost_usd: 0, credits: 0 });
  const agents = [{ id: 'has', status: 'idle', updatedAt: fresh }, { id: 'lost', status: 'closed', updatedAt: fresh }, { id: 'old', status: 'closed', updatedAt: '2026-11-06T01:00:00Z' }, { id: 'busy', status: 'running', updatedAt: fresh }, { id: 'empty', status: 'idle', updatedAt: fresh }];
  const book = async (a) => { if (a.id === 'empty') return false; appendUsage(dir, { agent: a.id, session: '', provider: 'codex', in: 5, out: 1, cached: 0, cost_usd: 0, credits: 0 }); return true; };
  assert.equal(await backfillUsage({ list: async () => agents, book, dir, now }), 1);
  assert.ok(bookedAgents(dir).has('lost') && !bookedAgents(dir).has('old') && !bookedAgents(dir).has('busy'));
  assert.equal(await backfillUsage({ list: async () => agents, book, dir, now }), 0);
  assert.equal(readFileSync(join(dir, 'usage.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('the Add provider screen shows loading, then data or an error with Retry, and the banner once', () => {
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'plugins', 'providers', 'index.client.tsx'), 'utf8');
  assert.ok(/load\.state !== "ready"/.test(src) && /S\.loadFailed/.test(src) && /actionLabel=\{S\.retry\} onPress=\{reload\}/.test(src));
  assert.equal(src.split('<SettingsRow label={msg.text}').length - 1, 1, 'msg is rendered once');
});
