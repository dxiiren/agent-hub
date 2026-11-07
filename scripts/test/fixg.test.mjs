import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, parse } from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, add, remove } from '../provider.mjs';
import { writeJsonKeepEol, writeAtomic } from '../../plugins/routing/jsonfile.mjs';
import { absPath } from '../../plugins/routing/route.mjs';
import { cleanGateTemp, staleProjects, removeStaleProjects, junkProjects } from '../../plugins/routing/cleanup.mjs';
import { orphanSnapshotPids, reapAgentOrphans } from '../../plugins/routing/orphans.mjs';
import { dropDefaults, readDefaults, normalizeConfigFile } from '../../plugins/routing/paseo-defaults.mjs';
import { laptopPort, runDir, paseoHome } from '../../plugins/routing/runstate.mjs';
import { pinWarning } from '../tools.mjs';

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const TEMPLATE = resolve(import.meta.dirname, '..', '..', 'config', 'routes', 'routes.template.json');

test('no writer can write a *.template.json; a provider add with no local routes file writes routes.local.json and leaves the template bytes alone', async () => {
  assert.throws(() => writeJsonKeepEol(TEMPLATE, {}), /refusing to write the shipped template/);
  assert.throws(() => writeAtomic(join(tmpdir(), 'x.template.json'), 'x'), /refusing to write the shipped template/);
  const before = sha(TEMPLATE);
  const home = mkdtempSync(join(tmpdir(), 'ahub-fixg-'));
  const p = paths({ AGENT_HUB_HOME: home, AGENT_HUB_NO_LOCAL: '1' });
  assert.match(p.routes, /routes[.]local[.]json$/);
  assert.ok(!existsSync(p.routes));
  await add({ name: 'g1', url: 'http://llm.example.test:8000/v1', model: 'm1', routes: 'summarise' }, p, { f: async () => ({ ok: true, json: async () => ({ data: [{ id: 'm1' }] }) }), which: () => 'qwen' });
  assert.ok(existsSync(p.routes), 'a local routes file was created');
  assert.ok(JSON.parse(readFileSync(p.routes, 'utf8')).routes.summarise.some((x) => /g1/.test(x)), 'the chain came from the template content');
  remove('g1', p);
  assert.equal(sha(TEMPLATE), before, 'template bytes never change');
});

test('a relative --cwd or --home is resolved against the caller, not left for the daemon', () => {
  assert.equal(absPath('.'), process.cwd());
  assert.equal(absPath('sub/x'), resolve('sub/x'));
  assert.equal(absPath(resolve('a')), resolve('a'));
  assert.equal(absPath('-evil'), '-evil'); assert.equal(absPath(''), ''); assert.equal(absPath(undefined), undefined);
});

test('importing the gate and scanning leaves no agent-hub temp folder behind, and one folder at most while running', () => {
  const t = mkdtempSync(join(tmpdir(), 'ahub-fixg-tmp-'));
  const gate = resolve(import.meta.dirname, '..', '..', 'plugins', 'gate', 'server', 'gate.mjs').replaceAll('\\', '/');
  const src = [
    'import { readdirSync } from "node:fs";',
    `const g = await import("file:///${gate}");`,
    'const n = () => readdirSync(process.env.TEMP || process.env.TMPDIR).filter((x) => x.startsWith("agent-hub-")).length;',
    'console.log("import:" + n()); try { g.hasSecret("hello world"); } catch {} console.log("scan:" + n());',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { env: { ...process.env, TEMP: t, TMP: t, TMPDIR: t }, encoding: 'utf8' });
  assert.match(r.stdout, /import:0/, r.stdout + r.stderr);
  assert.ok(Number(/scan:(\d+)/.exec(r.stdout)?.[1]) <= 1, r.stdout + r.stderr);
  assert.deepEqual(readdirSync(t).filter((x) => x.startsWith('agent-hub-')), [], 'removed on exit');
});

test('cleanGateTemp removes only our exact, old, empty gate folders', () => {
  const t = mkdtempSync(join(tmpdir(), 'ahub-fixg-clean-'));
  const mk = (n, files = {}) => { const d = join(t, n); mkdirSync(d); for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c); return d; };
  const old = Date.now() / 1000 - 3600;
  const dirs = { empty: mk('agent-hub-gitleaks-aB3dE9'), cfg: mk('agent-hub-nohooks-aB3dE9', { 'empty.gitconfig': '' }), full: mk('agent-hub-gitleaks-zzzzzz', { 'keep.txt': 'x' }), other: mk('agent-hub-test-home-aB3dE9'), young: mk('agent-hub-gitleaks-yyyyyy') };
  mkdirSync(join(dirs.empty, 'r-abc123'));
  for (const k of ['empty', 'cfg', 'full', 'other']) utimesSync(dirs[k], old, old);
  assert.equal(cleanGateTemp({ tmp: t, dry: true }), 2);
  assert.ok(existsSync(dirs.empty), 'dry run removes nothing');
  assert.equal(cleanGateTemp({ tmp: t }), 2);
  assert.deepEqual([existsSync(dirs.empty), existsSync(dirs.cfg), existsSync(dirs.full), existsSync(dirs.other), existsSync(dirs.young)], [false, false, true, true, true]);
});

test('stale projects: only an absolute path that is gone, only with the delete call', () => {
  const live = mkdtempSync(join(tmpdir(), 'ahub-fixg-live-'));
  const rows = [{ projectId: 'a', path: live }, { projectId: 'b', path: join(live, 'removed-worktree') }, { projectId: 'c', path: 'relative/gone' }, { projectId: 'd' }];
  const calls = []; const paseo = (a) => { calls.push(a); return a[1] === 'ls' ? rows : {}; };
  assert.deepEqual(staleProjects(paseo).map((p) => p.projectId), ['b']);
  assert.deepEqual(removeStaleProjects({ paseo, dry: true }), [join(live, 'removed-worktree')]);
  assert.ok(!calls.some((c) => c[1] === 'delete'));
  removeStaleProjects({ paseo });
  assert.deepEqual(calls.filter((c) => c[1] === 'delete'), [['project', 'delete', 'b']]);
});

test('--stale-projects also lists test leftovers (system folder, temp folder, _junk, hdad-*) and never a real repo', () => {
  const R = mkdtempSync(join(tmpdir(), 'ah-junk-root-')), tmp = join(R, 'T'), sys = join(R, 'S');
  const ex = (name, ...parts) => ({ projectId: name, path: join(...parts) });
  const rows = [
    ex('sys', sys), ex('tmp', tmp), ex('under-tmp', tmp, 'x'), ex('junk', R, 'code', 'worktree', '_junk'), ex('junk-deep', R, 'code', 'worktree', '_junk', 'final-round', 'v1', 'repo'),
    ex('hdad', R, 'code', 'worktree', 'Proj-hdad-w2a-c01-main'), ex('hdad2', R, 'code', 'worktree', 'hdad-x'),
    ex('hub', R, 'code', 'agent-hub'), ex('mon', R, 'code', 'Claude-Code-Usage-Monitor'), ex('ng', R, 'code', 'my-app-staging'), ex('other', R, 'code', 'worktree', 'real-repo-fix'), ex('tmpish', R, 'T-keep'),
  ];
  for (const r of rows) mkdirSync(r.path, { recursive: true }); // the folders exist: only the name patterns can select them
  const calls = []; const paseo = (a) => { calls.push(a); return a[0] === 'ls' ? [] : a[1] === 'ls' ? rows : {}; };
  assert.deepEqual(junkProjects(paseo, { tmp, sys }).map((p) => p.projectId), ['sys', 'tmp', 'under-tmp', 'junk', 'junk-deep', 'hdad', 'hdad2']);
  assert.equal(removeStaleProjects({ paseo, dry: true, junk: true, tmp, sys }).length, 7);
  assert.ok(!calls.some((c) => c[1] === 'delete'));
  removeStaleProjects({ paseo, junk: true, tmp, sys });
  assert.deepEqual(calls.filter((c) => c[1] === 'delete').map((c) => c[2]), ['sys', 'tmp', 'under-tmp', 'junk', 'junk-deep', 'hdad', 'hdad2']);
  assert.deepEqual(removeStaleProjects({ paseo, dry: true, tmp, sys }), []); // without junk: only gone folders
  const live = (cwd) => (a) => (a[0] === 'ls' ? [{ status: 'running', cwd }, { status: 'idle', cwd: join(R, 'code', 'worktree', 'hdad-x') }] : a[1] === 'ls' ? rows : {});
  assert.deepEqual(junkProjects(live(join(R, 'code', 'worktree', 'Proj-hdad-w2a-c01-main')), { tmp, sys }).map((p) => p.projectId).includes('hdad'), false); // a running agent keeps its project
  assert.ok(junkProjects(live(join(R, 'code', 'worktree', 'Proj-hdad-w2a-c01-main')), { tmp, sys }).some((p) => p.projectId === 'hdad2')); // an idle one does not
  assert.deepEqual(junkProjects((a) => (a[0] === 'ls' ? { error: 'x' } : rows), { tmp, sys }), []); // agent list unreadable: remove nothing
});

test('reapAgentOrphans dry run lists the orphans and kills none', () => {
  const procs = [{ pid: 5, ppid: 999, cmd: 'bash C:\\Users\\u\\.qoder\\shell-snapshots\\snapshot-bash-1.sh' }, { pid: 6, ppid: 5, cmd: 'x' }];
  assert.deepEqual(orphanSnapshotPids(procs), [5]);
  const killed = []; assert.deepEqual(reapAgentOrphans({ procs, dry: true, kill: (p) => killed.push(p) }), [5]); assert.deepEqual(killed, []);
  assert.deepEqual(reapAgentOrphans({ procs, kill: (p) => killed.push(p) }), [5]); assert.deepEqual(killed, [5]);
});

test('Paseo default-valued keys are dropped (defaults read from the server files), real settings kept', () => {
  const d = { 'features.dictation.enabled': true, 'features.voiceMode.enabled': false, 'agents.resumeOnStartup': false, 'agents.idleRuntimeCleanup': true };
  const cfg = { version: 1, features: { dictation: { enabled: true }, voiceMode: { enabled: true }, webUi: { enabled: true } }, agents: { resumeOnStartup: false, idleRuntimeCleanup: true, providers: { x: {} } } };
  const { cfg: out, removed } = dropDefaults(cfg, d);
  assert.deepEqual(removed.sort(), ['agents.idleRuntimeCleanup', 'agents.resumeOnStartup', 'features.dictation.enabled']);
  assert.deepEqual(out, { version: 1, features: { voiceMode: { enabled: true }, webUi: { enabled: true } }, agents: { providers: { x: {} } } });
  assert.equal(cfg.agents.resumeOnStartup, false, 'input not mutated');
  const t = mkdtempSync(join(tmpdir(), 'ahub-fixg-pd-'));
  mkdirSync(join(t, 'speech'));
  writeFileSync(join(t, 'speech', 'speech-config-resolver.js'), 'export const DICTATION_ENABLED_BY_DEFAULT = true;\nexport const VOICE_MODE_ENABLED_BY_DEFAULT = false;\n');
  assert.deepEqual(readDefaults(t), { 'features.dictation.enabled': true, 'features.voiceMode.enabled': false }, 'a default whose source is missing is skipped');
  const f = join(t, 'config.json'); writeFileSync(f, JSON.stringify({ features: { dictation: { enabled: true } } }));
  assert.deepEqual(normalizeConfigFile(f, t, { dry: true }).removed, ['features.dictation.enabled']); assert.match(readFileSync(f, 'utf8'), /dictation/);
  normalizeConfigFile(f, t); assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), {});
});

test('run dir and laptop port come from one place (Paseo home / the provider record)', () => {
  const home = mkdtempSync(join(tmpdir(), 'ahub-fixg-home-'));
  assert.equal(paseoHome({ PASEO_HOME: home }), home);
  assert.equal(runDir({ PASEO_HOME: home }), join(home, 'run'));
  assert.equal(laptopPort({ PASEO_HOME: home }), '8089', 'no record: default');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: { providers: { 'qwen-code-laptop': { env: { LAPTOP_PORT: '8080' } } } } }));
  assert.equal(laptopPort({ PASEO_HOME: home }), '8080');
  assert.equal(laptopPort({ PASEO_HOME: home, LAPTOP_PORT: '9000' }), '9000');
});

test('doctor warns when the installed qodercli is not the pin, and says how to fix it', () => {
  const t = { name: 'qodercli', pkg: '@qoder-ai/qodercli', pin: '1.1.81' };
  assert.match(pinWarning({ ...t, installed: '1.1.83' }), /pins 1[.]1[.]81.*npm i -g @qoder-ai\/qodercli@1[.]1[.]81/);
  assert.equal(pinWarning({ ...t, installed: '1.1.81' }), ''); assert.equal(pinWarning({ name: 'x', installed: '2' }), '');
});
