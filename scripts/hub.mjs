// Agent Hub installer core, shared by setup.ps1 and setup.sh.
//   node scripts/hub.mjs configure          write the Paseo config, wrappers and secret (idempotent)
//   node scripts/hub.mjs mcp add|remove     register / remove the agent-hub MCP server in each installed client
//   node scripts/hub.mjs unconfigure       remove the providers, wrappers and secret that configure wrote
//   node scripts/hub.mjs provider add|list|remove   add an OpenAI-compatible endpoint as a provider (scripts/provider.mjs)
//   node scripts/hub.mjs doctor [--deep]    PASS/FAIL per check and per provider; --deep runs one tiny task each
//   node scripts/hub.mjs update [--paseo]   update every CLI that is behind (Paseo only with --paseo; decision 38)
// Env: AGENT_HUB_HOME (Paseo home, default ~/.paseo), AGENT_HUB_PORT (default 6767),
//      AGENT_HUB_CLIENT_ROOT (redirect every client config into a temp dir, for tests),
//      OFFICE_QWEN_URL / OFFICE_QWEN_MODEL / LLAMA_SERVER_BIN / LAPTOP_MODEL_PATH / HEAVY_LOCK_GLOB
//      (or the same keys in config/hub.local.json, git-ignored).
import { writeJsonKeepEol, readJsonStrict } from '../plugins/routing/jsonfile.mjs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './provider.mjs';
import { spawnSyncSafe } from '../plugins/routing/spawn-safe.mjs';
import { DOCTOR_LABEL } from '../plugins/routing/cleanup.mjs';

const WIN = process.platform === 'win32';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = resolve(process.env.AGENT_HUB_HOME || join(homedir(), '.paseo'));
const PORT = process.env.AGENT_HUB_PORT || '6767';
const ROOT = process.env.AGENT_HUB_CLIENT_ROOT ? resolve(process.env.AGENT_HUB_CLIENT_ROOT) : '';
const URL_MCP = `http://127.0.0.1:${PORT}/mcp/agents`;
const SECRET_FILE = join(HOME, 'agent-hub-secret');
const HUB_DIR = join(HOME, 'hub');
const NAME = 'agent-hub';

const local = (() => { if (process.env.AGENT_HUB_NO_LOCAL === '1') return {}; try { return readJsonStrict(join(REPO, 'config', 'hub.local.json'), {}); } catch { return {}; } })(); // read-only here
const opt = (env, key) => process.env[env] || local[key] || '';

// A .cmd shim is resolved to `node <entry>` and run without a shell (plugins/routing/spawn-safe.mjs); a shim that cannot be resolved is refused.
const run = (cmd, args, o = {}) => spawnSyncSafe(cmd, args, { encoding: 'utf8', ...o });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim();
const ok = (m) => console.log(`[OK] ${m}`);
const skip = (m) => console.log(`[SKIP] ${m}`);

function which(name) {
  const r = run(WIN ? 'where' : 'which', [name]);
  const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
  if (r.status !== 0 || !lines.length) return '';
  return WIN ? lines.find((l) => /\.(cmd|exe|bat)$/i.test(l)) || lines[0] : lines[0];
}
const writeJson = writeJsonKeepEol;
const readJson = readJsonStrict; // every caller that later writes the file: unparsable = throw, never default-and-overwrite

// Owner-only file: 0600 on POSIX, current-user-only ACL on Windows. Called after every write of a file that holds the token.
function protect(file) {
  if (!existsSync(file)) return;
  if (WIN) {
    const user = process.env.USERNAME || '';
    const r = user ? run('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`]) : { status: 1 };
    if (r.status !== 0) console.log(`[WARN] could not restrict ACL on ${file}`);
  } else chmodSync(file, 0o600);
}
const writeSecretFile = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text, { mode: 0o600 }); protect(file); };

const BCRYPT_COST = 4;

function secret() {
  if (existsSync(SECRET_FILE)) { protect(SECRET_FILE); return readFileSync(SECRET_FILE, 'utf8').trim(); }
  mkdirSync(HOME, { recursive: true });
  const s = randomBytes(24).toString('hex');
  writeSecretFile(SECRET_FILE, s);
  return s;
}

function bcrypt() {
  let g = ''; // `npm root -g` can fail once on a loaded machine (4 configure tests failed on it in a full run, pass alone): ask up to 3 times
  for (let i = 0; i < 3 && !g; i++) g = run('npm', ['root', '-g']).stdout?.trim() || '';
  for (const p of [g && join(g, '@getpaseo', 'cli', 'node_modules', 'bcryptjs'), g && join(g, 'bcryptjs'), 'bcryptjs']) {
    try { return createRequire(import.meta.url)(p); } catch { /* try next */ }
  }
  throw new Error('bcryptjs not found; install Paseo first (npm i -g @getpaseo/cli@0.15.2)');
}

function configure() {
  const s = secret();
  const bc = bcrypt();
  const f = join(HOME, 'config.json');
  const c = readJson(f, { version: 1 });
  c.daemon ??= {};
  c.daemon.listen = `127.0.0.1:${PORT}`;
  c.daemon.mcp = { ...c.daemon.mcp, enabled: true, injectIntoAgents: true };
  c.daemon.relay = { ...c.daemon.relay, enabled: false };
  // Local web UI on the daemon port (same origin, so no CORS or browser local-network prompt; the hosted app.paseo.sh is refused: 403 Origin not allowed).
  c.features = { ...c.features, webUi: { ...c.features?.webUi, enabled: true } };
  const h = c.daemon.auth?.password;
  // Paseo bcrypt-checks the bearer on EVERY /mcp/agents request, in the daemon's one event loop. Cost 10 is ~110 ms of CPU per call
  // (cost 12, the `paseo daemon set-password` default, ~470 ms), so 6 clients polling get_agent_status saturate it and the hub looks
  // unreachable. The secret is 192 random bits, so the minimum cost (4, ~5 ms) loses nothing. Re-hash an existing higher-cost hash too.
  if (!h || !bc.compareSync(s, h) || Number(h.slice(4, 6)) > BCRYPT_COST) c.daemon.auth = { ...c.daemon.auth, password: bc.hashSync(s, BCRYPT_COST) };
  writeJson(f, c);
  ok(`config written: ${f} (listen 127.0.0.1:${PORT}, injectIntoAgents=true, password hash set)`);
  // No presets: this installer registers no provider. Paseo detects the CLIs it knows by itself; every other one (Qwen Code, Qoder, accounts...) is added by the user
  // in Settings > Providers or with `agent-hub provider add`. An older install's seeded Qwen entries become ordinary user-added ones (undo: provider migrate --undo).
  const m = migrate(); if (m.changed) ok(`older preset providers are now ordinary user-added ones: ${m.adopted.join(', ') || '-'}; read-only twins removed: ${m.removedTwins.join(', ') || '-'}`);
}

// ---------- MCP registration (MCP first, decision 37). Backup once, add only agent-hub, removable.
const MARK_A = '# >>> agent-hub (managed) >>>'; const MARK_B = '# <<< agent-hub (managed) <<<';
// Every client config is written directly: the bearer token never appears in a process argument list.
function clients() {
  const r = (...a) => join(ROOT, ...a);
  const bearer = (s) => ({ Authorization: `Bearer ${s}` });
  return {
    claude: { bin: 'claude', file: ROOT ? r('claude', '.claude.json') : join(homedir(), '.claude.json'), key: 'mcpServers',
      entry: (s) => ({ type: 'http', url: URL_MCP, headers: bearer(s) }) },
    qoder: { bin: 'qodercli', file: ROOT ? r('qoder', '.qoder', 'settings.json') : join(homedir(), '.qoder', 'settings.json'), key: 'mcpServers',
      entry: (s) => ({ url: URL_MCP, type: 'http', headers: bearer(s) }) },
    qwen: { bin: 'qwen', file: ROOT ? r('qwen', '.qwen', 'settings.json') : join(homedir(), '.qwen', 'settings.json'), key: 'mcpServers',
      entry: (s) => ({ httpUrl: URL_MCP, headers: bearer(s) }) },
    codex: { bin: 'codex', file: ROOT ? r('codex', 'config.toml') : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), toml: true },
    opencode: { bin: 'opencode', file: ROOT ? r('opencode', 'opencode.json') : join(homedir(), '.config', 'opencode', 'opencode.json'), key: 'mcp',
      entry: (s) => ({ type: 'remote', url: URL_MCP, headers: bearer(s), enabled: true }), base: { $schema: 'https://opencode.ai/config.json' } },
  };
}
function backup(file) {
  const b = `${file}.${NAME}.bak`;
  if (existsSync(file) && !existsSync(b) && !readFileSync(file, 'utf8').includes(NAME)) { copyFileSync(file, b); protect(b); console.log(`     backup: ${b}`); }
}
function mcp(action) {
  const s = action === 'add' ? secret() : '';
  for (const [name, c] of Object.entries(clients())) {
    if (!which(c.bin)) { skip(`${name}: CLI not installed`); continue; }
    backup(c.file);
    if (c.toml) {
      const t = existsSync(c.file) ? readFileSync(c.file, 'utf8') : '';
      const a = t.indexOf(MARK_A); const b = t.indexOf(MARK_B);
      const strip = a >= 0 && b > a ? t.slice(0, a) + t.slice(b + MARK_B.length) : t;
      const block = action === 'add' ? `\n${MARK_A}\n[mcp_servers.${NAME}]\nurl = "${URL_MCP}"\nhttp_headers = { Authorization = "Bearer ${s}" }\n${MARK_B}\n` : '';
      writeSecretFile(c.file, strip.trimEnd() + (block ? '\n' + block : '\n'));
    } else {
      const j = readJson(c.file, c.base || {});
      j[c.key] ??= {};
      if (action === 'add') j[c.key][NAME] = c.entry(s); else delete j[c.key][NAME];
      writeSecretFile(c.file, JSON.stringify(j, null, 2) + '\n');
    }
    ok(`${name}: ${NAME} ${action === 'add' ? 'registered' : 'removed'} (${c.file})`);
  }
}

// ---------- doctor
const paseo = (args, o = {}) => run('paseo', ['--home', HOME, ...args], { timeout: args[0] === 'logs' ? 30_000 : 300_000, killSignal: 'SIGKILL', ...o }); // bounded: the deep run's own wait is 240 s
let fails = 0;
const row = (good, label, detail = '') => { console.log(`${good ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!good) fails++; };
async function http(path, headers = {}, body) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body, signal: AbortSignal.timeout(15000) });
    return { status: r.status, text: await r.text() };
  } catch (e) { return { status: 0, text: String(e) }; }
}
// Served model ids (GET only), the laptop GGUF, and the CLI versions: installed vs latest published. Read only.
async function latestChecks(conf) {
  const { modelsUrl, firstId } = await import('../plugins/routing/office.mjs');
  const provs = conf.agents?.providers ?? {};
  for (const id of ['qwen-code', 'qwen-code-2']) {
    const c = provs[id]?.command; if (!c) continue;
    const i = c.findIndex((x) => /office-agent[.]mjs$/.test(x)); const base = i >= 0 ? c[i + 2] : c[c.indexOf('--openai-base-url') + 1];
    try { const served = firstId(await (await fetch(modelsUrl(base), { signal: AbortSignal.timeout(5000) })).json()); console.log(`INFO  ${id} serves ${served || '(none)'} (resolved at dispatch)`); }
    catch (e) { console.log(`WARN  ${id}: ${modelsUrl(base).replace(/\/\/[^/]+/, '//<host>')} unreachable (${e.message})`); }
  }
  const lp = provs['qwen-laptop']?.env;
  if (lp?.LAPTOP_MODEL_PATH) {
    try { const st = statSync(lp.LAPTOP_MODEL_PATH); console.log(`INFO  laptop GGUF ${basename(lp.LAPTOP_MODEL_PATH)}, ${(st.size / 2 ** 30).toFixed(1)} GiB, dated ${st.mtime.toISOString().slice(0, 10)}`); }
    catch { console.log(`WARN  laptop GGUF not found: ${lp.LAPTOP_MODEL_PATH}`); }
    console.log('NOTE  check for a newer Qwen small model that fits 100% GPU (no auto-download; decision 35)');
  }
  const { inventory, table } = await import('./tools.mjs');
  const rows = inventory(); console.log('\nTOOL         INSTALLED  LATEST     STATE\n' + table(rows));
  for (const r of rows) if (r.verdict === 'UPDATE') console.log(`NOTE  ${r.name} is behind: \`just update${r.pinned ? ' --paseo' : ''}\``);
}
const retire = (id) => { paseo(['stop', id]); paseo(['archive', id]); };
/** Stop hub-owned laptop llama-servers nobody uses (orphans of a dead reaper or launcher). `now` = stop at once (hub down); else only after the idle time. */
async function reapLaptop(now) {
  try {
    const { reapOrphans } = await import('../deploy/laptop/gpu-guard.mjs');
    return reapOrphans({ idleMs: now ? 0 : Number(process.env.LAPTOP_IDLE_MIN || 15) * 60_000 });
  } catch { return []; }
}
async function doctor(deep) {
  { const o = (await import('../plugins/routing/orphans.mjs')).reapAgentOrphans(); if (o.length) ok(`stopped ${o.length} orphaned agent shell snapshot process(es)`); }
  for (const x of await reapLaptop(false)) ok(`stopped an idle orphaned laptop llama-server (pid ${x.pid}, port ${x.port})`);
  try { // the secret scanner: the gate and the reply scan fail closed without it
    const g = await import('../plugins/gate/server/gate.mjs');
    row(true, 'secret scanner gitleaks', g.checkScanner() + ' (pinned ' + g.GITLEAKS_VERSION + ')');
  } catch (e) { row(false, 'secret scanner gitleaks', e.message + ' (install: see README, Prerequisites)'); }
  const s = secret();
  const { probeDaemon, daemonAdvice } = await import('./daemon-health.mjs');
  const dp = await probeDaemon(PORT);
  row(dp.state === 'up', 'daemon health', `127.0.0.1:${PORT}`);
  try { // what the launcher gave the daemon: names only, audited against the allow-list (a daemon started without daemon-env.mjs leaves no record)
    const { envNamesFile, auditNames, localExtras } = await import('./daemon-env.mjs');
    const rec = JSON.parse(readFileSync(envNamesFile(), 'utf8')); const off = auditNames(rec.names ?? [], localExtras());
    row(off.length === 0, 'daemon environment is allow-listed', off.length ? `NOT allow-listed: ${off.join(', ')} (restart with just down && just up)` : `${rec.names.length} variable names, none credential-like`);
  } catch { row(false, 'daemon environment is allow-listed', 'no launch record: start the daemon with `just up` (it goes through scripts/daemon-env.mjs)'); }
  if (dp.state === 'up') try { // the RUNNING daemon process itself (names only), not just what the launcher recorded
    const { liveEnvNames, credentialNames } = await import('./daemon-env.mjs'); const { listenerPid } = await import('../deploy/laptop/gpu-guard.mjs');
    const pid = listenerPid(PORT), live = pid ? liveEnvNames(pid) : { error: 'no listener on the daemon port' };
    if (live.names) { const bad = credentialNames(live.names); row(bad.length === 0, 'running daemon process environment has no credential names', bad.length ? `credential-like names in pid ${pid}: ${bad.join(', ')} (restart with just down && just up)` : `pid ${pid}: ${live.names.length} variable names, none credential-like`); }
    else console.log(`WARN  running daemon environment not read (${live.error}); the launcher record above still applies`);
  } catch (e) { console.log(`WARN  running daemon environment check failed: ${String(e.message).slice(0, 120)}`); }
  if (dp.state !== 'up') { console.log(daemonAdvice(dp)); process.exit(1); }
  if (process.env.AGENT_HUB_NO_USAGE_STACK !== '1') { // the one usage UI: collector + Prometheus + Grafana must answer
    const { probeStack, usageModeFromFiles } = await import('./usage-stack.mjs');
    const mode = usageModeFromFiles();
    for (const x of await probeStack()) row(x.ok, `usage stack (${mode}) ${x.name}`, x.ok ? x.url : `${x.url} not answering: run \`just up\` (${mode === 'native' ? 'starts the native stack, no Docker' : 'starts Docker and the stack'})`);
  }
  row((await http('/mcp/agents', {}, '{}')).status === 401, 'MCP refuses a call without the password');
  const t = await http('/mcp/agents', { authorization: `Bearer ${s}` }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  const n = (t.text.match(/"name"\s*:/g) || []).length;
  row(t.status === 200 && n > 10, 'MCP tools/list with the password', `${n} tools`);
  const lsAll = () => { const j = JSON.parse(paseo(['provider', 'ls', '--json']).stdout || '[]'); return Array.isArray(j) ? j : j.providers || []; };
  let list = lsAll();
  for (let i = 0; i < 30 && list.some((x) => /loading/i.test(x.status || '')); i++) { await new Promise((r) => setTimeout(r, 3000)); list = lsAll(); } // statuses probe the CLIs after start
  const want = Object.keys(readJson(join(HOME, 'config.json'), {}).agents?.providers || {});
  let refused = '';
  if (want.includes('qwen-laptop')) {
    const r = run(process.execPath, [join(REPO, 'deploy', 'laptop', 'laptop-agent.mjs'), '--check'], { env: { ...process.env, ...(readJson(join(HOME, 'config.json'), {}).agents.providers['qwen-laptop'].env) } });
    if (r.status === 3) { refused = out(r); console.log(`WARN  laptop: ${refused.replace(/^LAPTOP-REFUSED: /, "")} (correct behaviour, not a failure)`); }
    else row(r.status === 0, 'laptop pre-flight (GPU visible, no heavy-run lock, free RAM >= 3 GB)', out(r).split(String.fromCharCode(10)).pop());
  }
  for (const id of want) {
    if (id.startsWith('qwen-laptop') && refused) continue;
    const e = list.find((x) => (x.provider || x.id || x.name) === id);
    const st = e ? (e.status || e.state || '') : 'missing';
    row(/avail|ready|ok/i.test(st), `provider ${id}: status`, st);
  }
  try { // latest aliases: show what they resolve to now, warn on a pinned older model
    const { resolveCached, stalePins } = await import('../plugins/routing/resolve.mjs');
    const rt = JSON.parse(readFileSync(join(REPO, 'config', 'routes', process.env.AGENT_HUB_NO_LOCAL !== '1' && existsSync(join(REPO, 'config', 'routes', 'routes.local.json')) ? 'routes.local.json' : 'routes.template.json'), 'utf8'));
    const lp = (a) => { const j = JSON.parse(paseo(['--json', ...a]).stdout || '[]'); return j; };
    const aliases = [...new Set(Object.values(rt.routes || {}).flat())].filter((e) => /\/(latest|.*@latest)/.test(e));
    for (const a of aliases) { try { console.log(`INFO  ${a} -> ${resolveCached(a, (x) => lp(x))}`); } catch (e) { console.log(`WARN  ${a} does not resolve: ${e.message}`); } }
    for (const w of stalePins(rt)) console.log(`WARN  ${w}`);
  } catch (e) { console.log(`WARN  alias check failed: ${e.message}`); }
  await latestChecks(readJson(join(HOME, 'config.json'), {}));
  if (deep) {
    const dir = mkdtempSync(join(tmpdir(), 'hub-doctor-'));
    const made = new Set(); // every agent this run created, archived by id in the finally below
    try {
    const model = { codex: 'codex/gpt-6.1-terra', 'claude-clean': 'claude-clean/claude-haiku-5-5' };
    for (const id of want.filter((x) => !(x.startsWith('qwen-laptop') && refused) && !/unavail|disabled/i.test(list.find((e) => (e.provider || e.id || e.name) === x)?.status || '') && // a provider the daemon reports unavailable or disabled (no CLI on this machine) is not a failure
       (!process.env.AGENT_HUB_ONLY || x === process.env.AGENT_HUB_ONLY))) {
      // a model may add a word to a one-word reply: up to 3 tries, the check itself stays strict
      let r, j, aid, good = false;
      for (let attempt = 0; attempt < 3 && !good; attempt++) {
        if (aid) retire(aid);
        r = paseo(['run', '--label', DOCTOR_LABEL, '--provider', model[id] || id, '--cwd', dir, '--wait-timeout', '240s', '--json', '--', 'Reply with exactly the word OK and do nothing else.']);
        j = {}; try { j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { /* keep raw */ }
        aid = j.agentId || j.id; if (aid) made.add(aid);
        const reply = aid ? paseo(['logs', aid]).stdout || '' : '';
        good = j.status === 'completed' && reply.split(String.fromCharCode(10)).some((l) => l.trim() === 'OK'); // the agent's own line, not the prompt echo
      }
      row(good, `provider ${id}: live task`, good ? 'replied OK' : `status ${j.status || 'none'}; ${out(r).slice(0, 120).replace(/\s+/g, ' ')}`);
      if (aid) retire(aid);
    }
    } finally {
      for (const a of made) retire(a);
      try { const { cleanup } = await import('../plugins/routing/cleanup.mjs'); cleanup({ paseo: (a) => { try { return JSON.parse(paseo([...a, '--json']).stdout || '[]'); } catch { return []; } }, routes: {} }); } catch { /* the by-id archive above is the primary path */ } // backstop: a run that timed out before returning its id
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks PASSED');
  process.exit(fails ? 1 : 0);
}

// ---------- plugins: enable plugins in the daemon config, then install the gate and usage plugins (daemon must be running)
function plugins() {
  const f = join(HOME, 'config.json'); const c = readJson(f, {});
  if (!c.pluginsEnabled) { c.pluginsEnabled = true; writeJson(f, c); ok('pluginsEnabled set; restart the daemon (just down ; just up) if the installs below fail'); }
  for (const d of ['gate', 'usage-otel', 'providers']) {
    const r = paseo(['plugin', 'install', join(REPO, 'plugins', d)]);
    (r.status === 0 ? ok : (m) => console.log('[FAIL] ' + m))(`plugin ${d}: ${out(r).split(String.fromCharCode(10)).pop()}`);
  }
}

function unconfigure() {
  const f = join(HOME, 'config.json'); const c = readJson(f, null);
  if (c?.agents?.providers) {
    for (const k of ['codex', 'claude-clean', 'qoder', 'qwen-code', 'qwen-code-2', 'opencode', 'qwen-laptop', 'qwen-code-ro', 'qwen-code-2-ro', 'qwen-laptop-ro']) delete c.agents.providers[k];
    for (const n of Object.keys(local.extraProviders || {})) { delete c.agents.providers[n]; delete c.agents.providers[n + '-ro']; }
    delete c.daemon?.auth;
    if (c.daemon?.mcp) { c.daemon.mcp.enabled = false; c.daemon.mcp.injectIntoAgents = false; } // never leave MCP open without auth
    writeJson(f, c);
  }
  rmSync(HUB_DIR, { recursive: true, force: true }); rmSync(SECRET_FILE, { force: true });
  ok(`providers, password hash, ${HUB_DIR} and the secret removed (${f} otherwise kept)`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'configure') configure();
else if (cmd === 'mcp' && (arg === 'add' || arg === 'remove')) mcp(arg);
else if (cmd === 'unconfigure') unconfigure();
else if (cmd === 'plugins') plugins();
else if (cmd === 'provider') process.exit(await (await import('./provider.mjs')).main(process.argv.slice(3)));
else if (cmd === 'update') (await import('./tools.mjs')).update(process.argv.includes('--paseo'));
else if (cmd === 'doctor') await doctor(process.argv.includes('--deep'));
else if (cmd === 'reap-laptop') { const r = await reapLaptop(process.argv.includes('--now')); console.log(r.length ? `stopped ${r.map((x) => `pid ${x.pid} (port ${x.port})`).join(', ')}` : 'no idle orphaned laptop llama-server'); const o = (await import('../plugins/routing/orphans.mjs')).reapAgentOrphans(); if (o.length) console.log(`stopped ${o.length} orphaned agent shell snapshot process(es): ${o.join(', ')}`); }
else { console.log('usage: hub.mjs configure | unconfigure | provider add|list|remove | plugins | mcp add|remove | doctor [--deep] | update [--paseo]'); process.exit(2); }
