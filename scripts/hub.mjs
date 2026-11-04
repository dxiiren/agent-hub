// Agent Hub installer core, shared by setup.ps1 and setup.sh.
//   node scripts/hub.mjs configure          write the Paseo config, wrappers and secret (idempotent)
//   node scripts/hub.mjs mcp add|remove     register / remove the agent-hub MCP server in each installed client
//   node scripts/hub.mjs unconfigure       remove the providers, wrappers and secret that configure wrote
//   node scripts/hub.mjs doctor [--deep]    PASS/FAIL per check and per provider; --deep runs one tiny task each
// Env: AGENT_HUB_HOME (Paseo home, default ~/.paseo), AGENT_HUB_PORT (default 6767),
//      AGENT_HUB_CLIENT_ROOT (redirect every client config into a temp dir, for tests),
//      OFFICE_QWEN_URL / OFFICE_QWEN_MODEL / LLAMA_SERVER_BIN / LAPTOP_MODEL_PATH / HEAVY_LOCK_GLOB
//      (or the same keys in config/hub.local.json, git-ignored).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.noDeprecation = true; // shell:true is needed only to run .cmd shims; our args are fixed
const WIN = process.platform === 'win32';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = resolve(process.env.AGENT_HUB_HOME || join(homedir(), '.paseo'));
const PORT = process.env.AGENT_HUB_PORT || '6767';
const ROOT = process.env.AGENT_HUB_CLIENT_ROOT ? resolve(process.env.AGENT_HUB_CLIENT_ROOT) : '';
const URL_MCP = `http://127.0.0.1:${PORT}/mcp/agents`;
const SECRET_FILE = join(HOME, 'agent-hub-secret');
const HUB_DIR = join(HOME, 'hub');
const NAME = 'agent-hub';

const local = (() => { try { return JSON.parse(readFileSync(join(REPO, 'config', 'hub.local.json'), 'utf8')); } catch { return {}; } })();
const opt = (env, key) => process.env[env] || local[key] || '';
const cfg = {
  officeUrl: opt('OFFICE_QWEN_URL', 'officeQwenUrl'),
  officeModel: opt('OFFICE_QWEN_MODEL', 'officeQwenModel') || 'Qwen3.8-27B',
  llama: opt('LLAMA_SERVER_BIN', 'llamaServer'),
  laptopModel: opt('LAPTOP_MODEL_PATH', 'laptopModel'),
  laptopPort: opt('LAPTOP_PORT', 'laptopPort'),
  officeUrl2: opt('OFFICE_QWEN_URL_2', 'officeQwenUrl2'),
  officeModel2: opt('OFFICE_QWEN_MODEL_2', 'officeQwenModel2'),
};

// A .cmd shim must go through cmd.exe, which re-splits arguments: quote every argument that has a space or a shell character.
const q = (a) => (/[\s"&|<>^%]/.test(a) ? '"' + String(a).split('"').join('""') + '"' : String(a));
const run = (cmd, args, o = {}) => (WIN && /[.](cmd|bat)$/i.test(cmd)
  ? spawnSync([q(cmd), ...args.map(q)].join(' '), { encoding: 'utf8', ...o, shell: true })
  : spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...o }));
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim();
const ok = (m) => console.log(`[OK] ${m}`);
const skip = (m) => console.log(`[SKIP] ${m}`);

function which(name) {
  const r = run(WIN ? 'where' : 'which', [name]);
  const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
  if (r.status !== 0 || !lines.length) return '';
  return WIN ? lines.find((l) => /\.(cmd|exe|bat)$/i.test(l)) || lines[0] : lines[0];
}
const writeJson = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); };
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

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

function secret() {
  if (existsSync(SECRET_FILE)) { protect(SECRET_FILE); return readFileSync(SECRET_FILE, 'utf8').trim(); }
  mkdirSync(HOME, { recursive: true });
  const s = randomBytes(24).toString('hex');
  writeSecretFile(SECRET_FILE, s);
  return s;
}

function bcrypt() {
  const g = run('npm', ['root', '-g'], { shell: WIN }).stdout?.trim();
  for (const p of [g && join(g, '@getpaseo', 'cli', 'node_modules', 'bcryptjs'), g && join(g, 'bcryptjs'), 'bcryptjs']) {
    try { return createRequire(import.meta.url)(p); } catch { /* try next */ }
  }
  throw new Error('bcryptjs not found; install Paseo first (npm i -g @getpaseo/cli@0.15.0)');
}

// ---------- GPU fit (decision 35): the 9B model needs about 6.3 GB, so the card must have >= 7.5 GiB total
function gpuFits() {
  const r = run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
  const mib = parseInt((r.stdout || '').split(/\s/)[0], 10);
  return r.status === 0 && mib >= Number(process.env.LAPTOP_MIN_VRAM_MIB || 7500) ? mib : 0;
}

// ---------- providers
function providers() {
  const p = {}; const notes = [];
  if (which('codex')) {
    p.codex = { models: [
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', isDefault: true },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }] }; // never gpt-6-astra: the list replaces runtime discovery
  } else notes.push('codex not installed');

  const claude = which('claude');
  if (claude) {
    mkdirSync(HUB_DIR, { recursive: true });
    const empty = join(HUB_DIR, 'empty-mcp.json'); writeJson(empty, { mcpServers: {} });
    const wrap = join(HUB_DIR, WIN ? 'claude-clean.cmd' : 'claude-clean.sh');
    writeFileSync(wrap, WIN
      ? `@echo off\r\n"${claude}" --strict-mcp-config --mcp-config "${empty}" %*\r\n`
      : `#!/bin/sh\nexec "${claude}" --strict-mcp-config --mcp-config "${empty}" "$@"\n`);
    if (!WIN) chmodSync(wrap, 0o755);
    p['claude-clean'] = { extends: 'claude', label: 'Claude (clean MCP)', command: [wrap] };
  } else notes.push('claude not installed');

  const qoder = which('qodercli');
  if (qoder) p.qoder = { extends: 'acp', label: 'Qoder', command: [qoder, '--acp'] }; else notes.push('qodercli not installed');

  const qwen = which('qwen');
  if (qwen && cfg.officeUrl) {
    p['qwen-code'] = { extends: 'acp', label: 'Qwen Code (office)', command: [qwen, '--acp', '--auth-type', 'openai',
      '--openai-base-url', cfg.officeUrl, '--openai-api-key', 'none', '--model', cfg.officeModel] };
  } else notes.push('qwen-code needs the qwen CLI and OFFICE_QWEN_URL');

  if (qwen && cfg.officeUrl2 && cfg.officeModel2) { // optional second office host (a free tier when the first is loaded)
    p['qwen-code-2'] = { extends: 'acp', label: 'Qwen Code (office 2)', command: [qwen, '--acp', '--auth-type', 'openai',
      '--openai-base-url', cfg.officeUrl2, '--openai-api-key', 'none', '--model', cfg.officeModel2] };
  }

  const oc = which('opencode');
  if (oc && cfg.officeUrl) {
    mkdirSync(join(HUB_DIR, 'xdg'), { recursive: true });
    const f = join(HUB_DIR, 'opencode.json');
    writeJson(f, { $schema: 'https://opencode.ai/config.json', model: `office/${cfg.officeModel}`, autoupdate: false, share: 'disabled',
      provider: { office: { npm: '@ai-sdk/openai-compatible', name: 'office-qwen', options: { baseURL: cfg.officeUrl, apiKey: 'none' },
        models: { [cfg.officeModel]: { name: cfg.officeModel, tool_call: true, limit: { context: 131072, output: 8192 } } } } } });
    p.opencode = { env: { OPENCODE_CONFIG: f, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_TELEMETRY: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', XDG_CONFIG_HOME: join(HUB_DIR, 'xdg') },
      models: [{ id: `office/${cfg.officeModel}`, label: `Office ${cfg.officeModel}`, isDefault: true }] };
  } else notes.push('opencode needs the opencode CLI and OFFICE_QWEN_URL');

  const vram = gpuFits();
  if (vram && qwen && cfg.llama && cfg.laptopModel) {
    p['qwen-laptop'] = { extends: 'acp', label: 'Qwen Code (laptop GPU)',
      command: [process.execPath, join(REPO, 'deploy', 'laptop', 'laptop-agent.mjs')],
      env: { LLAMA_SERVER_BIN: cfg.llama, LAPTOP_MODEL_PATH: cfg.laptopModel, QWEN_BIN: qwen, ...(cfg.laptopPort ? { LAPTOP_PORT: cfg.laptopPort } : {}),
        ...(opt('HEAVY_LOCK_GLOB', 'heavyLockGlob') ? { HEAVY_LOCK_GLOB: opt('HEAVY_LOCK_GLOB', 'heavyLockGlob') } : {}) } };
  } else notes.push(vram ? 'laptop model needs LLAMA_SERVER_BIN, LAPTOP_MODEL_PATH and qwen' : 'laptop model skipped: no GPU with >= 7.5 GiB VRAM (decision 35)');
  return { p, notes };
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
  const h = c.daemon.auth?.password;
  if (!h || !bc.compareSync(s, h)) c.daemon.auth = { ...c.daemon.auth, password: bc.hashSync(s, 10) };
  const { p, notes } = providers();
  c.agents ??= {}; c.agents.providers = { ...c.agents.providers, ...p };
  writeJson(f, c);
  ok(`config written: ${f} (listen 127.0.0.1:${PORT}, injectIntoAgents=true, password hash set)`);
  for (const k of Object.keys(p)) ok(`provider registered: ${k}`);
  for (const n of notes) skip(n);
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
const paseo = (args, o = {}) => run(WIN ? 'paseo.cmd' : 'paseo', ['--home', HOME, ...args], { shell: WIN, ...o });
let fails = 0;
const row = (good, label, detail = '') => { console.log(`${good ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!good) fails++; };
async function http(path, headers = {}, body) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body, signal: AbortSignal.timeout(15000) });
    return { status: r.status, text: await r.text() };
  } catch (e) { return { status: 0, text: String(e) }; }
}
async function doctor(deep) {
  const s = secret();
  const h = await http('/api/health');
  row(h.status === 200, 'daemon health', `127.0.0.1:${PORT}`);
  if (h.status !== 200) { console.log('daemon is down: run `just start`'); process.exit(1); }
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
    if (r.status === 3) { refused = out(r); console.log(`WARN  laptop guard refuses right now (correct behaviour, not a failure): ${refused}`); }
    else row(r.status === 0, 'laptop pre-flight (GPU visible, no heavy-run lock, free RAM >= 3 GB)', out(r).split(String.fromCharCode(10)).pop());
  }
  for (const id of want) {
    if (id === 'qwen-laptop' && refused) continue;
    const e = list.find((x) => (x.provider || x.id || x.name) === id);
    const st = e ? (e.status || e.state || '') : 'missing';
    row(/avail|ready|ok/i.test(st), `provider ${id}: status`, st);
  }
  if (deep) {
    const dir = mkdtempSync(join(tmpdir(), 'hub-doctor-'));
    const model = { codex: 'codex/gpt-6.1-terra', 'claude-clean': 'claude-clean/claude-haiku-5-5' };
    for (const id of want.filter((x) => !(x === 'qwen-laptop' && refused) && (!process.env.AGENT_HUB_ONLY || x === process.env.AGENT_HUB_ONLY))) {
      const r = paseo(['run', '--provider', model[id] || id, '--cwd', dir, '--wait-timeout', '240s', '--json', 'Reply with exactly the word OK and do nothing else.']);
      let j = {}; try { j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { /* keep raw */ }
      const aid = j.agentId || j.id;
      const reply = aid ? paseo(['logs', aid]).stdout || '' : '';
      const good = j.status === 'completed' && reply.split(String.fromCharCode(10)).some((l) => l.trim() === 'OK'); // the agent's own line, not the prompt echo
      row(good, `provider ${id}: live task`, good ? 'replied OK' : `status ${j.status || 'none'}; ${out(r).slice(0, 120).replace(/\s+/g, ' ')}`);
      if (aid) paseo(['delete', aid]);
    }
  }
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks PASSED');
  process.exit(fails ? 1 : 0);
}

function unconfigure() {
  const f = join(HOME, 'config.json'); const c = readJson(f, null);
  if (c?.agents?.providers) {
    for (const k of ['codex', 'claude-clean', 'qoder', 'qwen-code', 'qwen-code-2', 'opencode', 'qwen-laptop']) delete c.agents.providers[k];
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
else if (cmd === 'doctor') await doctor(process.argv.includes('--deep'));
else { console.log('usage: hub.mjs configure | unconfigure | mcp add|remove | doctor [--deep]'); process.exit(2); }
