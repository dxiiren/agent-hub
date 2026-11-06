import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add, remove, edit, list, describe, accountDirOf, api, slug } from '../provider.mjs';
import { KINDS, loginCommand, hasAccounts, kindOf } from '../provider-kinds.mjs';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function box(extra = {}) {
  const t = mkdtempSync(join(tmpdir(), 'ahub-acct-'));
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), routes: join(t, 'routes.json') };
  writeFileSync(p.routes, JSON.stringify({ slots: { codex: 2 }, modes: {}, routes: { 'code-edit': ['codex/latest-terra'], summarise: ['qwen-laptop'] } }, null, 2) + '\n');
  writeFileSync(p.paseo, JSON.stringify({ version: 1, agents: { providers: { codex: {}, qoder: { extends: 'acp', command: ['/bin/qodercli', '--acp', '--config-dir', '/hub/qoder-home'] }, ...extra } } }, null, 2) + '\n');
  return { t, p, read: (f) => JSON.parse(readFileSync(p[f], 'utf8')) };
}
const cli = (ids) => ({ run: () => ({ stdout: JSON.stringify(ids.map((id) => ({ id, model: id }))) }) });

test('schema: EVERY kind declares how it separates accounts (config-dir, endpoint or a reason it cannot)', () => {
  for (const [type, k] of Object.entries(KINDS)) {
    assert.ok(k.account && ['config-dir', 'endpoint'].includes(k.account.by) || k.account?.none, `${type} has no account declaration`);
    if (k.account.by === 'config-dir') assert.ok(k.account.env || k.account.arg, `${type}: env or arg`);
  }
  assert.deepEqual(Object.entries(KINDS).filter(([, k]) => hasAccounts(k)).map(([t]) => t).sort(), ['claude', 'codex', 'qoder']);
  assert.equal(KINDS.claude.account.env, 'CLAUDE_CONFIG_DIR'); assert.equal(KINDS.codex.account.env, 'CODEX_HOME'); assert.equal(KINDS.qoder.account.arg, '--config-dir');
  assert.equal(describe(box().p).kinds.find((k) => k.type === 'qwen-code').account.by, 'endpoint');
});

test('login command per kind (posix and windows spelling), never carries a secret', () => {
  assert.equal(loginCommand(kindOf('claude'), '/h/a', false), "CLAUDE_CONFIG_DIR='/h/a' claude auth login");
  assert.equal(loginCommand(kindOf('codex'), 'C:\\a', true), "$env:CODEX_HOME='C:\\a'; codex login");
  assert.equal(loginCommand(kindOf('qoder'), '/h/a'), 'qodercli --config-dir /h/a login');
  assert.equal(loginCommand(kindOf('qwen-code'), '/x'), '');
});

for (const kind of ['claude', 'codex']) {
  test(`${kind}: --account makes its own provider whose env names the account dir; undo is byte-exact; dir kept unless --purge`, async () => {
    const { t, p, read } = box(); const before = ['local', 'paseo', 'routes'].map((f) => (existsSync(p[f]) ? sha(p[f]) : null));
    const dir = join(t, 'accts', 'work'); const prevRoot = process.env.AGENT_HUB_ACCOUNTS_DIR; process.env.AGENT_HUB_ACCOUNTS_DIR = join(t, 'accts'); // --purge only deletes inside the accounts root
    try {
    const r = await add({ name: `${kind}-work`, kind, account: 'work', accountDir: dir, model: 'm1', routes: 'code-edit', slots: '1' }, p, cli(['m1']));
    assert.equal(r.accountDir, dir); assert.match(r.login, kind === 'claude' ? /CLAUDE_CONFIG_DIR.*claude auth login/ : /CODEX_HOME.*codex login/); assert.ok(existsSync(dir));
    const e = read('paseo').agents.providers[`${kind}-work`];
    assert.equal(e.extends, kind); assert.deepEqual(e.env, { [KINDS[kind].account.env]: dir });
    assert.equal(read('routes').slots[`${kind}-work`], 1); assert.ok(read('routes').routes['code-edit'].includes(`${kind}-work/m1`));
    assert.equal(list(p)[0].account, 'work');
    remove(`${kind}-work`, p);
    assert.deepEqual(['local', 'paseo', 'routes'].map((f) => (existsSync(p[f]) ? sha(p[f]) : null)), before, 'byte-identical after remove');
    assert.ok(existsSync(dir), 'account dir (its login) survives remove');
    await add({ name: `${kind}-work`, kind, account: 'work', accountDir: dir, model: 'm1' }, p, cli(['m1']));
    remove(`${kind}-work`, p, { purge: true }); assert.ok(!existsSync(dir), '--purge deletes it');
    } finally { if (prevRoot === undefined) delete process.env.AGENT_HUB_ACCOUNTS_DIR; else process.env.AGENT_HUB_ACCOUNTS_DIR = prevRoot; }
  });
}

test('qoder: the account copies the base provider command and swaps --config-dir', async () => {
  const { t, p, read } = box(); const dir = join(t, 'q1');
  await add({ name: 'qoder-two', kind: 'qoder', account: 'two', accountDir: dir, model: 'efficient', routes: 'code-edit' }, p, cli(['efficient']));
  assert.deepEqual(read('paseo').agents.providers['qoder-two'].command, ['/bin/qodercli', '--acp', '--config-dir', dir]);
  assert.deepEqual(read('paseo').agents.providers.qoder.command.slice(-1), ['/hub/qoder-home'], 'default qoder untouched');
  remove('qoder-two', p);
});

test('two accounts of one kind, edit keeps the account, env is per provider (never global)', async () => {
  const { t, p, read } = box();
  await add({ name: 'claude-a', kind: 'claude', account: 'a', accountDir: join(t, 'a'), model: 'm1', routes: 'code-edit' }, p, cli(['m1']));
  await add({ name: 'claude-b', kind: 'claude', account: 'b', accountDir: join(t, 'b'), model: 'm1', routes: 'code-edit' }, p, cli(['m1']));
  const pr = read('paseo').agents.providers; assert.notEqual(pr['claude-a'].env.CLAUDE_CONFIG_DIR, pr['claude-b'].env.CLAUDE_CONFIG_DIR);
  await edit('claude-b', { slots: '4' }, p, cli(['m1']));
  assert.equal(read('routes').slots['claude-b'], 4); assert.equal(read('paseo').agents.providers['claude-b'].env.CLAUDE_CONFIG_DIR, join(t, 'b'));
  remove('claude-a', p); remove('claude-b', p);
});

test('kinds that cannot use a login dir refuse --account with the reason; bad names refuse', async () => {
  const { p } = box();
  await assert.rejects(add({ name: 'qwen-x', kind: 'qwen-code', account: 'w', url: 'http://h.example/v1', model: 'm' }, p, { f: async () => ({ ok: true, json: async () => ({ data: [{ id: 'm' }] }) }), which: () => 'qwen' }), /another entry with its own --url/);
  await assert.rejects(add({ name: 'work', kind: 'claude', account: 'w', model: 'm1' }, p, cli(['m1'])), /must be named "claude-/);
  await assert.rejects(add({ name: 'claude-w', kind: 'claude', account: 'W X', model: 'm1' }, p, cli(['m1'])), /--account must be/);
  assert.ok(!existsSync(p.local));
});

test('default account dir lives under the user home and is configurable', () => {
  assert.match(accountDirOf('claude', 'work', {}).replace(/\\/g, '/'), /\.agent-hub\/accounts\/claude\/work$/);
  assert.equal(accountDirOf('codex', 'x', { AGENT_HUB_ACCOUNTS_DIR: '/data/acc' }).replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''), '/data/acc/codex/x');
});

test('model list: CLI kinds carry the CLI tier/cost text, an account lists its own provider first, failure says what to fix; add without --model lists', async () => {
  const { discover } = await import('../provider-kinds.mjs');
  const calls = [];
  const run = (c, a) => { calls.push(a[2]); return a[2] === 'claude-work' ? { stdout: '[]' } : { stdout: JSON.stringify([{ id: 'efficient', model: 'Efficient', description: 'Vision · 0.00x Credit' }]) }; };
  const m = await discover('qoder', { provider: 'claude-work' }, { run });
  assert.deepEqual(m, [{ id: 'efficient', label: 'Efficient', hint: 'Vision · 0.00x Credit' }]); assert.deepEqual(calls, ['claude-work', 'qoder']);
  await assert.rejects(discover('claude', {}, { run: () => ({ stdout: '' }) }), /Fix: install Claude, sign in/);
  const ep = await discover('qwen-code', { url: 'http://h.example:8000/v1' }, { f: async () => ({ ok: true, json: async () => ({ data: [{ id: 'q1' }, { id: 'q2' }] }) }) });
  assert.deepEqual(ep.map((x) => x.id), ['q1', 'q2']);
  await assert.rejects(discover('qwen-code', { url: 'http://h.example:8000/v1' }, { f: async () => { throw new Error('ECONNREFUSED'); } }), /endpoint check failed/);
});

test('display names are unique: a taken label is refused, a taken auto-default gets #2/#3, accounts get their own default', async () => {
  const { t, p, read } = box();
  const o = { f: async () => ({ ok: true, json: async () => ({ data: [{ id: 'm' }] }) }), which: () => 'qwen' };
  const U = 'http://10.1.2.3:8000/v1';
  await add({ name: 'qwen-a', url: U, model: 'm' }, p, o);
  await add({ name: 'qwen-b', url: U, model: 'm' }, p, o);
  await add({ name: 'qwen-c', url: U, model: 'm' }, p, o);
  const L = () => Object.fromEntries(Object.entries(read('paseo').agents.providers).map(([k, v]) => [k, v.label]));
  assert.equal(L()['qwen-a'], 'Qwen Code 10.1.2.3'); assert.equal(L()['qwen-b'], 'Qwen Code 10.1.2.3 #2'); assert.equal(L()['qwen-c'], 'Qwen Code 10.1.2.3 #3');
  await assert.rejects(add({ name: 'qwen-d', url: U, model: 'm', label: 'qwen code 10.1.2.3' }, p, o), /already used by another provider/);
  await add({ name: 'claude-w', kind: 'claude', account: 'w', accountDir: join(t, 'w'), model: 'm1' }, p, cli(['m1']));
  await assert.rejects(add({ name: 'claude-w2', kind: 'claude', account: 'w2', accountDir: join(t, 'w2'), model: 'm1', label: 'Claude w' }, p, cli(['m1'])), /already used/);
  await edit('qwen-b', { slots: '5' }, p, o); assert.equal(L()['qwen-b'], 'Qwen Code 10.1.2.3 #2', 'edit keeps its own name without colliding with itself');
});

test('names: any lower-case id is accepted; empty name is made from the display name (unique); a non-"qwen" name is read-only capable through its own id', async () => {
  const { p, read } = box();
  const o = { f: async () => ({ ok: true, json: async () => ({ data: [{ id: 'm' }] }) }), which: () => 'qwen' };
  assert.equal(slug('Lab box #2'), 'lab-box-2');
  const r1 = await add({ name: '', label: 'Lab box', url: 'http://10.1.2.3:8000/v1', model: 'm', routes: 'summarise' }, p, o);
  assert.equal(r1.name, 'lab-box');
  const r2 = await add({ label: 'Lab box 2', url: 'http://10.1.2.3:8001/v1', model: 'm' }, p, o);
  assert.equal(r2.name, 'lab-box-2');
  const r3 = await add({ url: 'http://10.1.2.3:8002/v1', model: 'm', label: 'Lab box' + ' x' }, p, o);
  assert.equal(r3.name, 'lab-box-x');
  assert.ok(!Object.keys(read('paseo').agents.providers).some((k) => k.endsWith('-ro')), 'no twin entries'); assert.equal(read('routes').twins, undefined);
  assert.equal(read('routes').readOnlyModes['lab-box'], 'read-only'); assert.ok(read('routes').readOnlyEnforced.includes('lab-box'));
  remove('lab-box', p); remove('lab-box-2', p); remove('lab-box-x', p); assert.equal(read('routes').readOnlyModes, undefined);
});

test('load-models path: UI verb -> backend -> GET <base>/v1/models fills the list; failure returns the reason and what to fix', async () => {
  const seen = [];
  const f = async (u, init) => { seen.push({ u, timeout: !!init?.signal }); return { ok: true, json: async () => ({ data: [{ id: 'Qwen3.8-27B' }] }) }; };
  const r = await api({ verb: 'models', args: { kind: 'qwen-code', url: 'http://h.example:8005/v1' } }, box().p, { f });
  assert.deepEqual(r.models, [{ id: 'Qwen3.8-27B', label: 'Qwen3.8-27B' }]); assert.equal(seen[0].u, 'http://h.example:8005/v1/models'); assert.ok(seen[0].timeout, 'has a timeout signal');
  await assert.rejects(api({ verb: 'models', args: { kind: 'qwen-code', url: 'http://h.example:8005/v1' } }, box().p, { f: async () => { throw new Error('ECONNREFUSED'); } }), /GET http:\/\/h.example:8005\/v1\/models -> ECONNREFUSED/);
  await assert.rejects(api({ verb: 'models', args: { kind: 'qwen-code', url: 'not a link' } }, box().p, { f }), /http\(s\) base URL/);
});
