// Verifier round C: usage kinds from ONE reader, device-name provider names, per-user run state, unknown --mode, live daemon env names, orphan shells.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfHostedProviders, selfHostedReport, readLocal, kindId, usesQwenCli, _resetForTest } from '../../plugins/usage-otel/server/selfhosted-usage.mjs';
import { add } from '../provider.mjs';
import { runDir, writeState, readState, readStateJson, listState, trusted } from '../../plugins/routing/runstate.mjs';
import { stopVerified, reapOrphans, writeOwn, readOwn, ownRecord, identityOk } from '../../deploy/laptop/gpu-guard.mjs';
import { modeError, runRoute } from '../../plugins/routing/route.mjs';
import { orphanSnapshotPids, reapAgentOrphans } from '../../plugins/routing/orphans.mjs';
import { liveEnvNames, credentialNames } from '../daemon-env.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// ---- C1: one kind per provider, at load AND at report time
test('C1: the laptop launcher is kind "Local model" even when hub.local.json cannot be found; usage kind never splits', async () => {
  const cfg = { agents: { providers: { 'lap': { label: 'Laptop model', command: ['node', 'laptop-agent.mjs'], env: { LAPTOP_PORT: '8089' } }, 'q1': { label: 'Qwen Code h', command: ['node', 'office-agent.mjs', 'qwen', 'http://h:1/v1', 'm'] } } } };
  const bare = selfHostedProviders(cfg, {});
  assert.equal(bare[0].kind, 'Local model', 'laptop = Local model from its own record, no hub.local.json needed');
  assert.equal(bare[1].kind, 'Qwen Code');
  const withLocal = selfHostedProviders(cfg, { extraProviders: { lap: { type: 'local-llama' }, q1: { type: 'qwen-code' } } });
  assert.deepEqual(withLocal.map((x) => x.kind), ['Local model', 'Qwen Code'], 'explicit record kind wins and agrees');
});
test('C1: readLocal finds hub.local.json beside a plugin listed in the Paseo config (no AGENT_HUB_REPO, bundled plugin)', () => {
  const home = tmp('fixc-home-'), repo = tmp('fixc-repo-');
  mkdirSync(join(repo, 'config')); mkdirSync(join(repo, 'plugins', 'usage-otel'), { recursive: true });
  writeFileSync(join(repo, 'config', 'hub.local.json'), JSON.stringify({ extraProviders: { lap: { type: 'local-llama' } } }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ plugins: { u: { path: join(repo, 'plugins', 'usage-otel') } } }));
  const env = { PASEO_HOME: home };
  assert.equal(readLocal(env).extraProviders.lap.type, 'local-llama');
});
test('C1: the report for a kind uses the same providers the cards were built from (no "not configured" for a configured kind)', async () => {
  _resetForTest();
  const home = tmp('fixc-rep-');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: { providers: { lap: { label: 'Laptop model', command: ['node', 'laptop-agent.mjs'], env: { LAPTOP_PORT: '1' } } } } }));
  const f = async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }); };
  const r = await selfHostedReport(kindId('Local model'), { env: { PASEO_HOME: home, AGENT_HUB_NO_LOCAL_X: '1' }, readFeed: () => '', f });
  assert.equal(r.status, 'available'); assert.match(r.planLabel, /1 endpoint/);
  const none = await selfHostedReport('qwen-code', { env: { PASEO_HOME: home }, readFeed: () => '', f });
  assert.equal(none.status, 'error', 'a kind with no providers has no data (and the plugin registers no card for it)');
});
test('C5: token side channel is chosen by provider KIND, not by a name prefix', () => {
  const cfg = { agents: { providers: { 'lab-box': { command: ['node', '/x/deploy/office/office-agent.mjs', 'qwen', 'http://h/v1', 'm'] }, codex: {}, 'oc-lab': { command: ['opencode'] } } } };
  assert.equal(usesQwenCli('qwen-laptop'), true);
  assert.equal(usesQwenCli('lab-box', cfg, {}), true, 'user-named provider launched by the office launcher');
  assert.equal(usesQwenCli('lab-box-ro', cfg, {}), true, 'read-only twin');
  assert.equal(usesQwenCli('v24ctest', {}, { extraProviders: { v24ctest: { type: 'qwen-code' } } }), true);
  assert.equal(usesQwenCli('x', {}, { extraProviders: { x: { type: 'opencode' } } }), false);
  assert.equal(usesQwenCli('codex', cfg, {}), false); assert.equal(usesQwenCli('oc-lab', cfg, {}), false);
});

// ---- C2: Windows device names are never a user-chosen name
test('C2: provider add refuses Windows device names as name, account and label-derived name', async () => {
  const t = tmp('fixc-add-');
  const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), routes: join(t, 'routes.json') };
  writeFileSync(p.routes, JSON.stringify({ slots: {}, modes: {}, routes: { summarise: ['a'] } }));
  writeFileSync(p.paseo, JSON.stringify({ version: 1, agents: { providers: { codex: {} } } }));
  const base = { kind: 'qwen-code', url: 'http://127.0.0.1:9/v1', model: 'm', routes: 'summarise' };
  for (const name of ['con', 'nul', 'com1', 'lpt9', 'aux', 'prn', 'CON', 'nul.txt']) await assert.rejects(add({ ...base, name }, p, { which: () => 'qwen', skipVerify: true }), /device name|name must match/i, name);
  await assert.rejects(add({ ...base, label: 'NUL' }, p, { which: () => 'qwen', skipVerify: true }), /device name/i, 'name made from the label');
  assert.equal(existsSync(p.local), false, 'nothing written');
});

// ---- C3: per-user run state
test('C3: run dir is per-user (under PASEO_HOME), private, never the shared temp dir', () => {
  const home = tmp('fixc-run-'); const d = runDir({ PASEO_HOME: home });
  assert.equal(d, join(home, 'run')); assert.ok(statSync(d).isDirectory());
  if (process.platform !== 'win32') assert.equal(statSync(d).mode & 0o777, 0o700);
  assert.equal(runDir({ AGENT_HUB_RUN_DIR: join(home, 'x') }), join(home, 'x'));
});
test('C3: a run dir that is a link (junction) is refused', (t) => {
  const base = tmp('fixc-j-'), real = join(base, 'real'), link = join(base, 'link'); mkdirSync(real);
  try { symlinkSync(real, link, 'junction'); } catch { t.diagnostic('SKIPPED: cannot create a link'); return; }
  assert.throws(() => runDir({ AGENT_HUB_RUN_DIR: link }), /not usable/);
});
test('C3: atomic write leaves no temp file; a symlink target is refused and its victim untouched', (t) => {
  const d = runDir({ PASEO_HOME: tmp('fixc-w-') }); const f = join(d, 'a.json');
  writeState(f, { a: 1 }); assert.deepEqual(readStateJson(f), { a: 1 });
  assert.deepEqual(listState(d, /./), ['a.json'], 'no .tmp left behind');
  const victim = join(d, 'victim.txt'); writeFileSync(victim, 'keep'); const link = join(d, 'link.json');
  try { symlinkSync(victim, link); } catch { t.diagnostic('SKIPPED symlink part: this OS user cannot create symlinks'); return; }
  assert.equal(trusted(link), false); assert.equal(readState(link), null, 'a symlink is never read');
  assert.throws(() => writeState(link, 'pwned'), /refusing/); assert.equal(readFileSync(victim, 'utf8'), 'keep');
  assert.deepEqual(listState(d, /link/), [], 'and never listed');
});
test('C3: a planted ownership record (no binary / start time) never stops a process; the real stop needs binary + start time', async () => {
  const d = runDir({ PASEO_HOME: tmp('fixc-o-') });
  const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);/*llama-server*/'], { stdio: 'ignore', windowsHide: true });
  try {
    writeFileSync(join(d, 'agent-hub-laptop-7777.json'), JSON.stringify({ pid: victim.pid, lastUsed: 0 })); // planted: looks like a llama-server, idle forever
    const r = reapOrphans({ idleMs: 0, dir: d });
    assert.deepEqual(r, [], 'nothing stopped'); assert.equal(victim.exitCode, null); assert.doesNotThrow(() => process.kill(victim.pid, 0));
    // a genuine record (own binary + real start time) is stopped; the same pid with a wrong start time is not
    const rec = ownRecord(victim.pid, process.execPath);
    assert.ok(rec.procStart, 'start time recorded at spawn');
    assert.equal(identityOk({ ...rec, procStart: 'not-the-start-time' }), false);
    assert.equal(stopVerified({ ...rec, procStart: 'not-the-start-time' }), false);
    assert.doesNotThrow(() => process.kill(victim.pid, 0));
    assert.equal(stopVerified({ ...rec, bin: 'C:/other/llama-server.exe' }), false, 'another binary');
    const gone = new Promise((res) => victim.on('exit', res));
    assert.equal(stopVerified(rec), true); await gone;
  } finally { victim.kill(); }
});
test('C3: ownership writes go to the run dir, not the temp dir', () => {
  writeOwn('7778', ownRecord(1, 'x')); assert.ok(readOwn('7778')); assert.ok(existsSync(join(runDir(), 'agent-hub-laptop-7778.json')));
});

// ---- unknown --mode
test('unknown --mode is refused with a clear error, on every task type; known modes pass', () => {
  const routes = { routes: { summarise: ['qwen-code'] }, slots: { 'qwen-code': 1 }, modes: { codex: 'full-access' } };
  assert.match(modeError('banana', routes), /unknown --mode "banana"/);
  assert.equal(modeError('plan', routes), null); assert.equal(modeError(undefined, routes), null); assert.equal(modeError('full-access', routes), null);
  const r = runRoute({ type: 'summarise', prompt: 'x', mode: 'banana', cwd: tmpdir(), session: 's' }, () => { throw new Error('daemon must not be reached'); }, routes);
  assert.equal(r.status, 'error'); assert.match(r.trace[0].error, /unknown --mode/);
});

// ---- doctor: the running process's own environment names
test('liveEnvNames reads the names (never values) of a RUNNING process; credentialNames flags credential-like ones', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ZZ_LIVE_TOKEN: 'sekrit-value', ZZ_PLAIN: '1' } });
  try {
    await new Promise((r) => setTimeout(r, 400));
    const r = liveEnvNames(child.pid);
    assert.ok(r.names, r.error); assert.ok(r.names.includes('ZZ_LIVE_TOKEN') && r.names.includes('ZZ_PLAIN'));
    assert.ok(!JSON.stringify(r).includes('sekrit-value'), 'values never returned');
    assert.deepEqual(credentialNames(r.names).filter((n) => n.startsWith('ZZ_')), ['ZZ_LIVE_TOKEN']);
  } finally { child.kill(); }
  assert.ok(liveEnvNames(0).error);
});

// ---- Qoder shell-snapshot orphans
test('orphan shell snapshots: only a snapshot shell whose parent is gone is stopped', () => {
  const S = 'bash -c source x; /home/u/.paseo/hub/qoder-home/shell-snapshots/snapshot-bash-1-a.sh';
  const procs = [{ pid: 1, ppid: 0, cmd: 'init' }, { pid: 10, ppid: 1, cmd: 'qodercli' }, { pid: 11, ppid: 10, cmd: S }, { pid: 12, ppid: 999, cmd: S }, { pid: 13, ppid: 999, cmd: 'bash -c echo' }, { pid: 14, ppid: 999, cmd: S.replace(/\//g, '\\') }];
  assert.deepEqual(orphanSnapshotPids(procs), [12, 14]);
  const killed = []; assert.deepEqual(reapAgentOrphans({ procs, kill: (p) => killed.push(p) }), [12, 14]); assert.deepEqual(killed, [12, 14]);
});
