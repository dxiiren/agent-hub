import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { show, set, undo, validate, api, main, modelsOf, TASK_TYPES } from '../routes.mjs';
import { effectiveBudget } from '../../plugins/routing/budget.mjs';
import { modelNotAllowed } from '../../plugins/routing/allow.mjs';
import { runRoute } from '../../plugins/routing/route.mjs';

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const ROUTES = { slots: { codex: 3, qoder: 2 }, modes: { codex: 'full-access' }, routes: { 'code-edit': ['codex/gpt-a', 'codex/gpt-b', 'qoder/q1'], summarise: [], review: ['claude/latest-haiku'] } };
function box(routes = ROUTES) {
  const t = mkdtempSync(join(tmpdir(), 'ahub-routes-'));
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), routes: join(t, 'routes.local.json') };
  if (routes) writeFileSync(p.routes, JSON.stringify(routes, null, 2) + '\n');
  writeFileSync(p.paseo, JSON.stringify({ agents: { providers: { codex: {}, qoder: {} } } }));
  const LS = [{ provider: 'codex', label: 'Codex', status: 'available', enabled: 'Enabled' }, { provider: 'qoder', label: 'Qoder', status: 'available', enabled: 'Enabled' }, { provider: 'claude', label: 'Claude', status: 'available', enabled: 'Disabled' }];
  const models = { codex: ['gpt-a', 'gpt-b', 'gpt-c'], qoder: ['q1', 'q2'], claude: ['claude-haiku-1'] };
  const o = { paseoLs: () => LS, paseoModels: (id) => (models[id] ?? []).map((x) => ({ id: x, label: x })) };
  return { p, o, read: () => JSON.parse(readFileSync(p.routes, 'utf8')) };
}

test('show lists providers with enabled, slots, allowed models, chains, configured total and the effective-budget seam', () => {
  const { p, o } = box(); const s = show(p, o);
  assert.deepEqual(s.types.slice(0, 5), TASK_TYPES);
  const codex = s.providers.find((x) => x.id === 'codex');
  assert.deepEqual([codex.enabled, codex.slots, codex.models], [true, 3, null]);
  assert.deepEqual(codex.chains['code-edit'], ['codex/gpt-a', 'codex/gpt-b']);
  assert.equal(s.providers.find((x) => x.id === 'claude').enabled, false);
  assert.equal(s.configuredTotal, 5); assert.equal(s.effective.effective, 5);
  assert.equal(s.canUndo, false);
});
test('effectiveBudget stub: disabled providers do not count and say why', () => {
  const b = effectiveBudget({ slots: { a: 3, b: 2 }, enabled: { a: true, b: false } });
  assert.deepEqual([b.configured, b.effective, b.perProvider.b], [5, 3, 0]); assert.match(b.reasons[0], /b: disabled/);
});
test('set/show round-trip: slots, model allow-list, chain; show reflects them; file keeps its other keys', async () => {
  const { p, o, read } = box();
  const r = await set({ providers: { codex: { slots: '5', models: ['gpt-a', 'gpt-c'] } }, chains: { summarise: ['qoder/q2'] } }, p, o);
  assert.equal(r.saved, true);
  const f = read(); assert.equal(f.slots.codex, 5); assert.deepEqual(f.allowedModels, { codex: ['gpt-a', 'gpt-c'] }); assert.deepEqual(f.routes.summarise, ['qoder/q2']); assert.equal(f.modes.codex, 'full-access');
  const s = show(p, o); assert.deepEqual(s.providers.find((x) => x.id === 'codex').models, ['gpt-a', 'gpt-c']); assert.equal(s.configuredTotal, 7); assert.equal(s.canUndo, true);
  await set({ providers: { codex: { models: 'all' } } }, p, o); assert.equal(read().allowedModels, undefined, 'all = key removed');
});
test('validation: every problem is listed, nothing is written', async () => {
  const { p, o } = box(); const before = sha(p.routes);
  for (const [ch, re] of [
    [{ providers: { codex: { slots: 0 } } }, /slots must be a whole number from 1 to 64/],
    [{ providers: { codex: { slots: 65 } } }, /1 to 64/], [{ providers: { codex: { slots: 'x' } } }, /1 to 64/], [{ providers: { codex: { slots: 2.5 } } }, /1 to 64/],
    [{ providers: { nope: { slots: 1 } } }, /unknown provider "nope"/],
    [{ providers: { codex: { models: [] } } }, /non-empty list/],
    [{ providers: { codex: { models: ['not-a-model'] } } }, /not in its live model list/],
    [{ providers: { codex: { models: ['gpt-a', 'gpt-a'] } } }, /twice/],
    [{ providers: { codex: { enabled: 'maybe' } } }, /true or false/],
    [{ chains: { 'code-edit': ['codex/gpt-a', 'codex/gpt-a'] } }, /twice/],
    [{ chains: { 'code-edit': ['ghost/x'] } }, /unknown provider "ghost"/],
    [{ chains: { 'code-edit': ['bad entry'] } }, /not a valid entry/],
    [{ chains: { wrong: [] } }, /unknown task type/],
    [{ chains: { 'code-edit': 'codex' } }, /must be a list/],
  ]) await assert.rejects(set(ch, p, o), re, JSON.stringify(ch));
  await assert.rejects(set({ providers: { codex: { slots: 0 }, nope: { slots: 1 } } }, p, o), (e) => /slots/.test(e.message) && /nope/.test(e.message), 'both errors reported');
  assert.equal(sha(p.routes), before, 'file untouched');
});
test('models with no live list (local model, daemon unreachable) accept any well-formed id', () => {
  assert.deepEqual(validate({ providers: { codex: { models: ['whatever'] } } }, ROUTES, new Map([['codex', {}]]), { codex: { known: false, ids: [] } }), []);
});
test('undo restores the routes file byte for byte, one save at a time; refused (and nothing overwritten) when the file changed since', async () => {
  const { p, o } = box(); const orig = readFileSync(p.routes);
  await set({ providers: { codex: { slots: 9 } } }, p, o); const afterOne = readFileSync(p.routes);
  await set({ chains: { review: ['codex/gpt-b'] } }, p, o);
  await undo(p); assert.deepEqual(readFileSync(p.routes), afterOne); await undo(p); assert.deepEqual(readFileSync(p.routes), orig);
  await assert.rejects(undo(p), /nothing to undo/);
  await set({ providers: { codex: { slots: 4 } } }, p, o);
  writeFileSync(p.routes, readFileSync(p.routes, 'utf8').replace('4', '6')); const edited = readFileSync(p.routes);
  await assert.rejects(undo(p), /changed since the last save/); assert.deepEqual(readFileSync(p.routes), edited);
});
test('enabled: reported as a daemon change (flag flips), undo hands the previous flag back; unchanged flag = no change', async () => {
  const { p, o } = box();
  const r = await set({ providers: { codex: { enabled: false }, qoder: { enabled: true } } }, p, o);
  assert.deepEqual(r.enabledChanges, { codex: false }); assert.equal(r.saved, true);
  assert.deepEqual((await undo(p)).enabledChanges, { codex: true });
  assert.equal((await set({ providers: { qoder: { enabled: true } } }, p, o)).saved, false);
});
test('chain reorder: CLI move up/down/off and chain replace', async () => {
  const { p, o, read } = box(); const quiet = async (a) => { const l = console.log; console.log = () => {}; try { return await main(a, p, o); } finally { console.log = l; } };
  assert.equal(await quiet(['move', 'code-edit', 'qoder/q1', 'up']), 0); assert.deepEqual(read().routes['code-edit'], ['codex/gpt-a', 'qoder/q1', 'codex/gpt-b']);
  assert.equal(await quiet(['move', 'code-edit', 'codex/gpt-a', 'down']), 0); assert.deepEqual(read().routes['code-edit'], ['qoder/q1', 'codex/gpt-a', 'codex/gpt-b']);
  assert.equal(await quiet(['move', 'code-edit', 'codex/gpt-a', 'off']), 0); assert.deepEqual(read().routes['code-edit'], ['qoder/q1', 'codex/gpt-b']);
  assert.equal(await quiet(['move', 'code-edit', 'qoder/q1', 'up']), 0, 'top entry up stays put'); assert.deepEqual(read().routes['code-edit'], ['qoder/q1', 'codex/gpt-b']);
  assert.equal(await quiet(['move', 'code-edit', 'ghost', 'up']), 1);
  assert.equal(await quiet(['chain', 'review', 'codex/gpt-c,qoder/q2']), 0); assert.deepEqual(read().routes.review, ['codex/gpt-c', 'qoder/q2']);
  assert.equal(await quiet(['chain', 'review', '']), 0); assert.deepEqual(read().routes.review, []);
  assert.equal(await quiet(['set', 'codex', '--slots', '99']), 1);
  const wrote = []; assert.equal(await main(['set', 'codex', '--enabled', 'false'], p, { ...o, writeEnabled: (c) => wrote.push(c) }), 0); assert.deepEqual(wrote, [{ codex: false }]);
  assert.equal(await quiet(['undo']), 0);
});
test('routing obeys the model allow-list: a model that is not allowed is never used, the next entry is', async () => {
  const { p, o } = box(); await set({ providers: { codex: { models: ['gpt-b'] } } }, p, o);
  const routes = JSON.parse(readFileSync(p.routes, 'utf8'));
  const runs = [];
  const fake = (a) => { if (a[0] === 'run') { runs.push(a[a.indexOf('--provider') + 1]); return { status: 'completed', agentId: 'A1' }; } return a[0] === 'ls' ? [] : a[0] === 'provider' ? [{ provider: 'codex' }, { provider: 'qoder' }] : {}; };
  const r = runRoute({ type: 'code-edit', prompt: 'p', cwd: '/r', session: 's' }, fake, routes);
  assert.deepEqual(runs, ['codex/gpt-b']); assert.equal(r.used, 'codex/gpt-b');
  assert.match(r.trace[0].skip, /model gpt-a is not allowed for codex/);
  const forced = runRoute({ type: 'code-edit', prompt: 'p', cwd: '/r', session: 's', provider: 'codex/gpt-a' }, fake, routes);
  assert.equal(forced.used, null); assert.match(forced.trace[0].skip, /not allowed/); assert.deepEqual(runs, ['codex/gpt-b'], 'explicit --provider cannot bypass it');
  assert.equal(modelNotAllowed(routes, 'qwen-code'), null, 'entry without a model is not restricted'); assert.equal(modelNotAllowed(routes, 'qoder/anything'), null, 'provider without a list is open');
});
test('writes never touch a template: no local routes file -> a local one is created next to it', async () => {
  const { p, o } = box(null); assert.equal(existsSync(p.routes), false);
  await set({ providers: { codex: { slots: 2 } } }, p, o); assert.equal(JSON.parse(readFileSync(p.routes, 'utf8')).slots.codex, 2);
  await undo(p); assert.equal(existsSync(p.routes), false, 'undo of the creating save removes the file again');
  await assert.rejects(set({ providers: { codex: { slots: 2 } } }, { ...p, routes: join(tmpdir(), 'x.template.json') }, o), /template/);
});
test('api verbs (the Settings page): show, models, set, undo; errors come back as thrown messages', async () => {
  const { p, o } = box();
  assert.ok((await api({ verb: 'show' }, p, o)).providers.length >= 3);
  const m = await api({ verb: 'models', args: { provider: 'qoder' } }, p, o); assert.deepEqual(m.models.map((x) => x.id), ['q1', 'q2']); assert.equal(m.known, true);
  assert.equal((await modelsOf('claude', p, { ...o, paseoModels: () => { throw new Error('daemon down'); } })).known, false);
  await api({ verb: 'set', args: { providers: { qoder: { slots: 7 } } } }, p, o); assert.equal(show(p, o).providers.find((x) => x.id === 'qoder').slots, 7);
  assert.equal((await api({ verb: 'undo' }, p, o)).undone, true);
  await assert.rejects(api({ verb: 'zap' }, p, o), /unknown verb/);
});
