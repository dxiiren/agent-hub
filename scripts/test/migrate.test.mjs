import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, remove, list } from '../provider.mjs';
import { runRoute } from '../../plugins/routing/route.mjs';

const E = (url, extra = {}) => ({ extends: 'acp', label: 'Qwen Code x', command: ['node', '/r/deploy/office/office-agent.mjs', 'qwen', url, 'm1'], ...extra });
function old() {
  const t = mkdtempSync(join(tmpdir(), 'ahub-mig-'));
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), routes: join(t, 'routes.json') };
  const prov = { codex: {}, 'qwen-code': E('http://h1:1/v1'), 'qwen-code-2': E('http://h2:1/v1'),
    'qwen-laptop': { extends: 'acp', label: 'Qwen Code laptop', command: ['node', '/r/deploy/laptop/laptop-agent.mjs'], env: { LAPTOP_PORT: '8080' } } };
  for (const id of ['qwen-code', 'qwen-code-2', 'qwen-laptop']) prov[id + '-ro'] = { ...prov[id], label: prov[id].label + ' (read-only)', command: [...prov[id].command, '--read-only'] };
  writeFileSync(p.paseo, JSON.stringify({ version: 1, agents: { providers: prov } }, null, 2) + '\r\n');
  writeFileSync(p.local, '{\r\n  "officeQwenUrl": "http://h1:1/v1"\r\n}\r\n');
  writeFileSync(p.routes, JSON.stringify({ slots: { codex: 2, 'qwen-code': 1, 'qwen-code-2': 2, 'qwen-laptop': 1 }, modes: {}, twins: ['x'], routes: { summarise: ['qwen-laptop', 'qwen-code-2'], 'code-edit': ['codex/latest-terra', 'qwen-code'] } }));
  const read = (f) => JSON.parse(readFileSync(p[f], 'utf8'));
  return { t, p, read };
}

test('migrate: seeded Qwen entries become user-added providers, every -ro twin is gone, routes use the base ids with the read-only mode', () => {
  const { p, read } = old(); const r = migrate(p);
  assert.deepEqual(r.adopted, ['qwen-code', 'qwen-code-2', 'qwen-laptop']);
  assert.ok(!Object.keys(read('paseo').agents.providers).some((k) => k.endsWith('-ro')), 'no -ro ids');
  assert.deepEqual(Object.keys(read('local').extraProviders), ['qwen-code', 'qwen-code-2', 'qwen-laptop']);
  assert.deepEqual(read('local').extraProviders['qwen-laptop'], { type: 'qwen-code', url: 'http://127.0.0.1:8080/v1', model: 'qwen35-9b', label: 'Qwen Code laptop' });
  assert.equal(read('local').officeQwenUrl, 'http://h1:1/v1', 'other keys kept');
  const rt = read('routes'); assert.equal(rt.twins, undefined);
  for (const id of ['qwen-code', 'qwen-code-2', 'qwen-laptop']) { assert.equal(rt.readOnlyModes[id], 'read-only'); assert.ok(rt.readOnlyEnforced.includes(id)); }
  assert.deepEqual(list(p).map((x) => x.name), ['qwen-code', 'qwen-code-2', 'qwen-laptop']);
});

test('migrate is idempotent, keeps the Paseo entries byte for byte (minus the twins) and undo puts the exact old bytes back', () => {
  const { p, t } = old(); const before = Object.fromEntries(['local', 'paseo', 'routes'].map((f) => [f, readFileSync(p[f])]));
  migrate(p); const after = Object.fromEntries(['local', 'paseo', 'routes'].map((f) => [f, readFileSync(p[f])]));
  assert.deepEqual(migrate(p), { changed: false }); for (const f of ['local', 'paseo', 'routes']) assert.ok(readFileSync(p[f]).equals(after[f]), `${f} untouched by the second run`);
  assert.equal(JSON.parse(after.paseo).agents.providers['qwen-code'].command[3], 'http://h1:1/v1');
  assert.ok(existsSync(join(t, 'hub.local.undo-migrate-qwen.json')));
  assert.deepEqual(migrate(p, { undo: true }), { undone: true });
  for (const f of ['local', 'paseo', 'routes']) assert.ok(readFileSync(p[f]).equals(before[f]), `${f} byte-exact after undo`);
  assert.deepEqual(readdirSync(t).sort(), ['config.json', 'hub.local.json', 'routes.json']);
});

test('after migrate, Remove works on every Qwen provider (the product path) and leaves no Qwen id behind in providers or routes', () => {
  const { p, read } = old(); migrate(p);
  for (const n of ['qwen-code', 'qwen-code-2', 'qwen-laptop']) remove(n, p);
  assert.deepEqual(Object.keys(read('paseo').agents.providers), ['codex']);
  const rt = read('routes'); assert.ok(!JSON.stringify(rt).includes('qwen'), JSON.stringify(rt));
});

test('a route entry for a provider nobody configured is skipped, never sent to the daemon; an empty chain names the fix', () => {
  const ran = []; const paseo = (a) => (a[0] === 'provider' ? [{ provider: 'codex' }] : a[0] === 'ls' ? [] : a[0] === 'run' ? (ran.push(a[a.indexOf('--provider') + 1]), { status: 'completed', agentId: 'A' }) : {});
  const o = { type: 'code-edit', prompt: 'p', cwd: process.cwd() };
  const r = runRoute(o, paseo, { slots: {}, routes: { 'code-edit': ['qwen-code', 'codex/a'] } });
  assert.deepEqual(ran, ['codex/a']); assert.match(JSON.stringify(r.trace), /provider not configured/);
  const none = runRoute(o, paseo, { slots: {}, routes: { 'code-edit': ['qwen-code'] } });
  assert.equal(none.used, null); assert.match(JSON.stringify(none.trace), /no provider configured for code-edit: add one in Settings > Providers/);
  const empty = runRoute(o, paseo, { slots: {}, routes: { 'code-edit': [] } });
  assert.match(empty.trace[0].error, /no provider configured for code-edit: add one in Settings > Providers/);
});

test('the shipped routes template references only ids Paseo detects itself (codex, claude) and the read-only deny settings cover write, shell and sensitive reads', () => {
  const rt = JSON.parse(readFileSync(new URL('../../config/routes/routes.template.json', import.meta.url), 'utf8'));
  for (const e of Object.values(rt.routes).flat()) assert.match(e, /^(codex|claude)\//, e);
  for (const id of [...Object.keys(rt.slots), ...Object.keys(rt.modes)]) assert.equal(id, 'codex');
  const deny = JSON.parse(readFileSync(new URL('../../config/qwen/system-settings-readonly.json', import.meta.url), 'utf8')).permissions.deny;
  for (const d of ['Edit', 'Write', 'Bash', 'Shell', 'run_shell_command', 'Read(.env)', 'Read(**/.env)', 'Read(**/credentials*)', 'Read(**/*.pem)']) assert.ok(deny.includes(d), d);
});
