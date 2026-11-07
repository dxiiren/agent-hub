// One command to add, list and remove an OpenAI-compatible model endpoint as a hub provider (Paseo's UI catalog cannot take a URL, model or env).
//   node scripts/hub.mjs provider add <name> --type qwen-code --url <base-url> --model <id> [--slots N] [--routes code-edit,summarise]
//   node scripts/hub.mjs provider list | remove <name>        (also: agent-hub provider ...)
// Writes config/hub.local.json (extraProviders), the routes file (slots, modes, route chains) and the Paseo config.json entries (<name>).
// Restart the daemon afterwards (`just down && just up`) so Paseo reloads its providers.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { KINDS, LOCAL_DEFAULTS, LOCAL_FIELD_IDS, RESERVED, KEY_ENV, kindOf, chainToken, discover, modelListed, hubDirOf, displayName, hasAccounts, loginCommand } from './provider-kinds.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeId, safeUrl } from '../plugins/routing/office.mjs';
import { READ_ONLY_ENFORCED, RESERVED_NAME_RE } from '../plugins/routing/route.mjs';
import { writeJsonKeepEol, writeAtomic, readJsonStrict, own } from '../plugins/routing/jsonfile.mjs';
import { withLock, withLockSync } from '../plugins/routing/lock.mjs';
import { paseoHome } from '../plugins/routing/runstate.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NAME_RE = KINDS['qwen-code'].nameRe; // any lower-case id
/** An id from a display name ("Lab box #2" -> "lab-box-2"). */
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '');
// A type = how to launch it. Add a type here (one function) to support another OpenAI-compatible launcher.
export const TYPES = {
  'qwen-code': { command: (repo, s, bin) => [process.execPath, join(repo, 'deploy', 'office', 'office-agent.mjs'), bin, s.url, s.model] },
};
const launchCommand = (k, repo, s) => k.launch.map((t) => String(t).replace(/\{(node|repo|url|model)\}/g, (_, x) => ({ node: process.execPath, repo, url: s.url ?? '', model: s.model ?? '' })[x]));

/** The local-llama fields of a spec/args with defaults filled in ('' and undefined fall back), validated. Throws a plain message. */
export function localSpec(a) {
  const v = Object.fromEntries(LOCAL_FIELD_IDS.map((id) => [id, String(a[id] ?? '').trim() || LOCAL_DEFAULTS[id] || undefined]));
  const bad = (m) => { throw new Error(m); };
  for (const id of ['bin', 'modelFile']) if (!v[id]) bad(`--${id} is required for the local-llama kind`);
  for (const id of ['bin', 'modelFile', 'heavyLock']) if (v[id] && /["\u0000-\u001f]/.test(v[id])) bad(`--${id} must be a plain path (no quotes or control characters)`);
  if (!/^\d+$/.test(v.port) || +v.port < 1 || +v.port > 65535) bad('--port must be a number from 1 to 65535');
  if (!/^\d+$/.test(v.ctx) || +v.ctx < 256) bad('--ctx must be a whole number of tokens (at least 256)');
  if (!/^[A-Za-z0-9_.:-]+$/.test(v.device)) bad('--device must be a llama-server device name such as CUDA0');
  if (!/^\d+(\.\d+)?$/.test(v.idleMin) || +v.idleMin <= 0) bad('--idleMin must be a positive number of minutes');
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
}

export function paths(env = process.env) {
  const home = resolve(env.AGENT_HUB_HOME || paseoHome(env)); // AGENT_HUB_HOME (the launcher copies it to PASEO_HOME), else PASEO_HOME, else ~/.paseo
  const routesDir = join(REPO, 'config', 'routes');
  const dflt = join(homedir(), '.paseo').toLowerCase();
  const elsewhere = [env.AGENT_HUB_HOME, env.PASEO_HOME].filter(Boolean).some((h) => resolve(h).toLowerCase() !== dflt);
  if (elsewhere && env.AGENT_HUB_NO_LOCAL !== '1' && !(env.AGENT_HUB_LOCAL && env.AGENT_HUB_ROUTES)) // a temp home must never write the clone's own config/*.local.json (it once replaced a real hub's providers)
    throw new Error(`REFUSED: PASEO_HOME/AGENT_HUB_HOME points at ${[env.AGENT_HUB_HOME, env.PASEO_HOME].filter(Boolean)[0]}, not ~/.paseo, so this command would overwrite this clone's config/*.local.json. Set AGENT_HUB_NO_LOCAL=1 to keep the provider files inside that home instead.`);
  return { local: env.AGENT_HUB_LOCAL || (env.AGENT_HUB_NO_LOCAL === '1' ? join(home, 'hub.local.json') : join(REPO, 'config', 'hub.local.json')), paseo: join(home, 'config.json'),
    routes: env.AGENT_HUB_ROUTES || (env.AGENT_HUB_NO_LOCAL === '1' ? join(home, 'routes.local.json') : join(routesDir, 'routes.local.json')) }; // always a local file: the tracked template is only a read fallback (rdr)
}
const rd = readJsonStrict; // BOM-safe; missing file = default; unparsable = throws, so add/remove never overwrite a config they could not read
/** Routes reader: a missing local file reads the shipped template (never written, see isTemplatePath). */
export const rdr = (p, d) => (existsSync(p.routes) ? rd(p.routes, d) : rd(join(REPO, 'config', 'routes', 'routes.template.json'), d));
const wr = writeJsonKeepEol; // keeps the file's own line endings
export const sha = (b) => (b ? createHash('sha256').update(b).digest('hex') : null);
export const bytes = (p) => { try { return readFileSync(p); } catch { return null; } };
const FILES = ['local', 'paseo', 'routes'];
/** The one lock every read-modify-write of the three files takes (cross-process; re-entrant in a call chain). Next to hub.local.json, so it matches .gitignore *.local.*. */
export const lockOf = (p) => join(dirname(p.local), 'hub.local.lock');
const basePath = (p) => join(dirname(p.local), 'hub.local.undo-base.json'); // the files as they were before the FIRST added provider
const undoPath = (p, name) => join(dirname(p.local), `hub.local.undo-${name}.json`); // matches .gitignore *.local.*

/** Where account config dirs live: AGENT_HUB_ACCOUNTS_DIR, else ~/.agent-hub/accounts/<kind>/<account>. */
export const accountsRoot = (env = process.env) => resolve(env.AGENT_HUB_ACCOUNTS_DIR || join(homedir(), '.agent-hub', 'accounts'));
export const accountDirOf = (kind, account, env = process.env) => join(accountsRoot(env), kind, account);
const ACCOUNT_MARK = '.agent-hub-account'; // written when the hub creates the dir; --purge deletes only a dir that carries it AND sits inside the accounts root
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** Own Paseo provider (slots, modes, route token = its name): endpoint kinds, and CLI kinds added with an account. */
const ownish = (k, spec) => k.own || !!spec.account;

/** Refuse unless the endpoint's /v1/models lists `model`. `f` is injectable for tests. */
export async function checkEndpoint(url, model, f = fetch, key) {
  const ids = (await discover('qwen-code', { url, key }, { f })).map((m) => m.id);
  if (!ids.includes(model)) throw new Error(`endpoint check failed: model "${model}" not served (served: ${ids.join(', ') || 'none'})`);
}

/** Paseo provider entries for one extra provider (empty for CLI kinds: they only add a route token). Own kinds: the entry. */
export function entries(name, spec, qwenBin, repo = REPO, hubDir, baseCommand) {
  const k = kindOf(spec.type);
  if (spec.account) { // a CLI kind with its own login directory: its own Paseo provider, so the account's env/flag is per provider and never global
    const a = k.account; const label = spec.label || `${k.label.split(' (')[0]} ${spec.account}`;
    if (a.env) return { [name]: { extends: k.base, label, env: { [a.env]: spec.accountDir } } };
    if (!Array.isArray(baseCommand) || !baseCommand.length) throw new Error(`the Paseo config has no "${k.base}" provider command to copy for ${name} (kind ${k.type} sets ${a.arg} on it)`);
    const cmd = baseCommand.map(String); const i = cmd.indexOf(a.arg);
    if (i >= 0) cmd[i + 1] = spec.accountDir; else cmd.push(a.arg, spec.accountDir);
    return { [name]: { extends: 'acp', label, command: cmd } };
  }
  if (!k.own) return {};
  if (k.local) { // hub-managed llama-server: the launcher reads these (deploy/laptop/laptop-agent.mjs); nothing is started until the first prompt
    const label = spec.label || displayName(k.label.split(' (')[0], spec.url);
    return { [name]: { extends: 'acp', label, command: [process.execPath, join(repo, 'deploy', 'laptop', 'laptop-agent.mjs')],
      env: { LLAMA_SERVER_BIN: spec.bin, LAPTOP_MODEL_PATH: spec.modelFile, QWEN_BIN: qwenBin, LAPTOP_PORT: spec.port, LAPTOP_ALIAS: spec.model, LAPTOP_CTX: spec.ctx, LAPTOP_DEVICE: spec.device, LAPTOP_IDLE_MIN: spec.idleMin, ...(spec.heavyLock ? { HEAVY_LOCK_GLOB: spec.heavyLock } : {}) } } };
  }
  const env = spec.key ? { [KEY_ENV]: spec.key } : undefined;
  const label = spec.label || displayName(k.label.split(' (')[0], spec.url);
  if (k.type === 'opencode') return { [name]: { extends: 'opencode', label, env: { OPENCODE_CONFIG: join(hubDir, `opencode-${name}.json`), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_TELEMETRY: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', XDG_CONFIG_HOME: join(hubDir, 'xdg') }, models: [{ id: `${name}/${spec.model}`, label: spec.model, isDefault: true }] } };
  const e = { extends: 'acp', label, command: k.launch ? launchCommand(k, repo, spec) : TYPES[k.type].command(repo, spec, qwenBin), ...(env ? { env } : {}) };
  return { [name]: e }; // one entry per endpoint: the launcher offers the session mode "read-only" itself (acp-proxy.mjs)
}
const opencodeFile = (name, spec) => ({ $schema: 'https://opencode.ai/config.json', model: `${name}/${spec.model}`, autoupdate: false, share: 'disabled',
  provider: { [name]: { npm: '@ai-sdk/openai-compatible', name, options: { baseURL: spec.url, apiKey: 'none' }, models: { [spec.model]: { name: spec.model, tool_call: true, limit: { context: 131072, output: 8192 } } } } } });

/** "code-edit:2,summarise" -> [{c:'code-edit',pos:2},{c:'summarise'}] (pos is 1-based; absent = append). */
export function parseRoutes(s) {
  return (Array.isArray(s) ? s : String(s || '').split(',')).map((x) => String(x).trim()).filter(Boolean).map((x) => {
    const [c, p] = x.split(':'); if (p !== undefined && !(Number.isInteger(Number(p)) && Number(p) >= 1)) throw new Error(`route position in "${x}" must be a whole number >= 1`);
    return { c, ...(p !== undefined ? { pos: Number(p) } : {}) };
  });
}

/** Network / CLI checks of an add or edit: the endpoint answers and lists the model, or the CLI offers it. Done BEFORE any file is touched. */
async function verifyKind(k, { url, model, key, bin, modelFile }, { f = fetch, run } = {}) {
  if (k.local) { for (const [what, x] of [['llama-server program', bin], ['model file', modelFile]]) if (!x || !existsSync(x)) throw new Error(`${what} not found: ${x || '(not set)'}`); return; }
  if (k.own) return checkEndpoint(url, model, f, key);
  const models = await discover(k.type, {}, run ? { run } : {});
  if (!modelListed(model, models)) throw new Error(`model "${model}" is not offered by the ${k.base} CLI (offered: ${models.map((m) => m.id).join(', ')})`);
}

export const add = (a, p = paths(), o = {}) => withLock(lockOf(p), () => addLocked(a, p, o));
async function addLocked(a, p, { f = fetch, which = () => 'qwen', run, preOverride, skipVerify } = {}) {
  if (!preOverride) reconcile(p);
  const k = kindOf(a.kind ?? a.type); const type = k.type; const { model } = a;
  const lc = k.local ? localSpec(a) : undefined; let url = k.local ? `http://127.0.0.1:${lc.port}/v1` : a.url;
  if (k.own && !String(url ?? '').trim()) throw new Error('Enter the Base URL of the endpoint, e.g. http://host:8000/v1');
  if (k.own) { url = safeUrl(url); if (!url) throw new Error('Base URL must be a plain http(s) base URL like http://host:8000/v1 (host, optional port and path; no credentials, query or special characters)'); }
  let name = a.name; // empty name: made from the display name (or kind and host), made unique with -2, -3
  if (!name) { const used = new Set([...Object.keys(rd(p.local, {}).extraProviders || {}), ...Object.keys(rd(p.paseo, {}).agents?.providers || {}), ...RESERVED]); const b0 = slug(a.label) || slug(displayName(k.label.split(' (')[0], url)) || type; name = b0; for (let n = 2; used.has(name) || used.has(name + '-ro'); n++) name = `${b0}-${n}`; } const key = a.key || undefined; const label = a.label ? String(a.label).trim() : undefined;
  const readOnly = !(a.readOnly === false || a.readOnly === 'false' || a.readOnly === 'off');
  const slots = /^[0-9]{1,3}$/.test(String(a.slots ?? 2)) ? Number(a.slots ?? 2) : NaN; // plain decimal only: no 0x10, 1e1, -1
  if (!Number.isInteger(slots) || slots < 1 || slots > 64) throw new Error('--slots must be a whole number from 1 to 64');
  const account = a.account ? String(a.account) : undefined;
  if (account) {
    if (!hasAccounts(k)) throw new Error(`kind ${type} cannot separate accounts through a login directory (${k.account?.by === 'endpoint' ? 'add another entry with its own --url/--key instead' : k.account?.none || 'not supported'})`);
    if (!ACCOUNT_RE.test(account)) throw new Error('--account must be lower-case letters, digits, dashes (max 31)');
    if (!String(name).startsWith(`${k.base}-`)) throw new Error(`an account provider must be named "${k.base}-<something>" (e.g. ${k.base}-${account})`);
    if (!Number.isInteger(slots) || slots < 1) throw new Error('--slots must be a positive integer');
  } else if (a.accountDir) throw new Error('--account-dir needs --account');
  for (const [what, v] of [['name', name], ['account', account]]) if (v && RESERVED_NAME_RE.test(v)) throw new Error(`${what} "${v}" is a Windows device name (con, nul, com1, ...): choose another`);
  if (!k.nameRe.test(name || '') || name.endsWith('-ro') || RESERVED.has(name)) throw new Error(`name must match ${k.nameRe} (${k.nameHelp}; not ending -ro, not one of ${[...RESERVED]})`);
  if (k.own) {
    if (!Number.isInteger(slots) || slots < 1) throw new Error('--slots must be a positive integer');
  }
  if (key !== undefined && !/^[!-~]{1,512}$/.test(String(key))) throw new Error('--key must be 1-512 printable characters without spaces');
  if (key && !k.fields.some((x) => x.id === 'key')) throw new Error(`kind ${type} takes no API key (an agent of that kind could read it)`);
  if (label && !/^[^\x00-\x1f"]{1,80}$/.test(label)) throw new Error('--label must be 1-80 printable characters without quotes');
  if (!safeId(model)) throw new Error(model ? 'model must be a plain model id (letters, digits and . _ - : /)' : 'Choose a model first: it is listed once the Base URL works, or pick "Other / custom model id" and type it.');
  const pre = Object.fromEntries(FILES.map((x) => [x, bytes(p[x])]));
  const local = rd(p.local, {}); const first = !Object.keys(local.extraProviders || {}).length;
  if (own(local.extraProviders, name)) throw new Error(`${name} already exists (remove it first, or use edit)`);
  const cfg = rd(p.paseo, { version: 1 });
  if ((k.own || account) && own(cfg.agents?.providers, name)) throw new Error(`${name} is already a provider in the Paseo config (not added by this tool)`);
  if (!skipVerify) await verifyKind(k, { url, model, key, ...lc }, { f, run });
  const bin = type === 'qwen-code' || k.local ? which('qwen') : null; if ((type === 'qwen-code' || k.local) && !bin) throw new Error('qwen CLI not found on PATH');
  const routes = rdr(p, null); if (!routes) throw new Error(`routes file unreadable: ${p.routes}`);
  const chains = parseRoutes(a.routes);
  { const seen = new Set(); for (const { c } of chains) { if (seen.has(c)) throw new Error(`route ${c} is listed twice`); seen.add(c); } }
  const accountDir = account ? resolve(a.accountDir || accountDirOf(type, account)) : undefined;
  const spec = { type, ...(k.own ? { url } : {}), model, ...lc, ...(account ? { account, accountDir } : {}), ...(label && (k.own || account) ? { label } : {}), ...(key ? { key } : {}), ...(k.twin && !readOnly ? { readOnly: false } : {}) };
  const token = chainToken(name, spec);
  for (const { c } of chains) {
    if (!Array.isArray(own(routes.routes, c))) throw new Error(`unknown route type ${c} (known: ${Object.keys(routes.routes || {})})`);
    if (routes.routes[c].includes(token)) throw new Error(`route ${c} already lists ${token}`);
  }
  // A CLI kind (claude, codex, qoder) is one model of one login: a second entry for the same model and account does nothing new. Endpoint kinds may repeat (more slots, another key).
  const dup = k.own || skipVerify ? undefined : Object.entries(local.extraProviders || {}).find(([, x]) => x.type === type && x.model === model && (x.account || '') === (account || ''));
  if (dup) throw new Error(`${dup[0]} already serves ${model}${account ? ` for account ${account}` : ''}. Edit ${dup[0]} instead, or choose another model or account.`);
  const hubDir = hubDirOf(p.paseo);
  if (ownish(k, spec) && type !== 'opencode') { // display names are unique: a taken one is refused, a taken auto-default gets " #2", " #3" ...
    const taken = new Set(Object.values(cfg.agents?.providers ?? {}).map((x) => String(x?.label ?? '').toLowerCase()));
    const natural = account ? `${k.label.split(' (')[0]} ${account}` : displayName(k.label.split(' (')[0], url);
    if (spec.label && taken.has(spec.label.toLowerCase())) throw new Error(`display name "${spec.label}" is already used by another provider; choose a different --label`);
    if (!spec.label && taken.has(natural.toLowerCase())) { let n = 2; while (taken.has(`${natural} #${n}`.toLowerCase())) n++; spec.label = `${natural} #${n}`; }
  }
  cfg.agents ??= {}; cfg.agents.providers = { ...cfg.agents.providers, ...entries(name, spec, bin, REPO, hubDir, cfg.agents.providers?.[k.base]?.command) };
  local.extraProviders = { ...local.extraProviders, [name]: spec };
  if (ownish(k, spec)) {
    routes.slots = { ...routes.slots, [name]: slots }; routes.modes = { ...routes.modes, [name]: 'yolo' };
    // the launcher restarts qwen with the sensitive-read deny settings when the session mode "read-only" is chosen, so summarise/review may run on it (route.mjs refuses read-only types on unlisted providers)
    if (k.own && k.twin && readOnly) { routes.readOnlyEnforced = [...new Set([...(routes.readOnlyEnforced ?? READ_ONLY_ENFORCED), name])]; routes.readOnlyModes = { ...routes.readOnlyModes, [name]: 'read-only' }; }
  }
  for (const { c, pos } of chains) { const l = routes.routes[c]; l.splice(pos ? Math.min(pos - 1, l.length) : l.length, 0, token); }
  if (type === 'opencode') { mkdirSync(join(hubDir, 'xdg'), { recursive: true }); writeJsonKeepEol(join(hubDir, `opencode-${name}.json`), opencodeFile(name, spec)); }
  if (first) writeFileSync(basePath(p), JSON.stringify(Object.fromEntries(FILES.map((x) => [x, (preOverride ?? pre)[x]?.toString('base64') ?? null]))));
  if (accountDir) { const fresh = !existsSync(accountDir); mkdirSync(accountDir, { recursive: true }); if (fresh) writeFileSync(join(accountDir, ACCOUNT_MARK), 'created by agent-hub; provider remove --purge may delete this folder'); } // an empty dir; the user signs in once (login below). remove() never deletes it unless --purge
  wr(p.local, local); wr(p.routes, routes); wr(p.paseo, cfg);
  // remove() puts the exact pre-add bytes back while nothing else touched the files since
  const snap = Object.fromEntries(FILES.map((x) => [x, { pre: (preOverride ?? pre)[x]?.toString('base64') ?? null, post: sha(bytes(p[x])) }]));
  writeFileSync(undoPath(p, name), JSON.stringify(snap));
  return { name, kind: type, slots: ownish(k, spec) ? slots : undefined, routes: chains.map((x) => x.c), needsRestart: ownish(k, spec), ...(account ? { account, accountDir, login: loginCommand(k, accountDir) } : {}) };
}

/** The routes file as it was before the first added provider (from the undo base), or null. */
function baseRoutes(p) {
  try { const b = JSON.parse(readFileSync(basePath(p), 'utf8')).routes; return b ? JSON.parse(Buffer.from(b, 'base64').toString('utf8').replace(/^\uFEFF/, '')) : null; } catch { return null; }
}
function removeManual(name, p, local = rd(p.local, {})) {
  const spec = own(local.extraProviders, name); const k = kindOf(spec.type); const token = chainToken(name, spec);
  delete local.extraProviders[name]; if (!Object.keys(local.extraProviders).length) delete local.extraProviders;
  const routes = rdr(p, {});
  delete routes.slots?.[name]; delete routes.modes?.[name]; delete routes.readOnlyModes?.[name];
  if (routes.readOnlyEnforced) routes.readOnlyEnforced = routes.readOnlyEnforced.filter((x) => x !== name);
  // add() materialised the built-in defaults and an empty readOnlyModes: drop what is back to its default so the file returns to its pre-add form
  if (routes.readOnlyEnforced && routes.readOnlyEnforced.length === READ_ONLY_ENFORCED.length && READ_ONLY_ENFORCED.every((x) => routes.readOnlyEnforced.includes(x))) delete routes.readOnlyEnforced;
  if (routes.readOnlyModes && !Object.keys(routes.readOnlyModes).length) delete routes.readOnlyModes;
  const orig = baseRoutes(p) ?? {}; for (const key of ['slots', 'modes']) if (routes[key] && !Object.keys(routes[key]).length && !(key in orig)) delete routes[key]; // add() created the container
  if (routes.twins) { routes.twins = routes.twins.filter((x) => x !== name); if (!routes.twins.length) delete routes.twins; }
  for (const c of Object.keys(routes.routes || {})) routes.routes[c] = routes.routes[c].filter((x) => (ownish(k, spec) ? x.split('/')[0] !== name : x !== token));
  const cfg = rd(p.paseo, {});
  if (ownish(k, spec) && cfg.agents?.providers) { delete cfg.agents.providers[name]; delete cfg.agents.providers[name + '-ro']; }
  if (cfg.agents?.providers && !Object.keys(cfg.agents.providers).length) delete cfg.agents.providers;
  if (cfg.agents && !Object.keys(cfg.agents).length) delete cfg.agents;
  wr(p.local, local); wr(p.routes, routes); wr(p.paseo, cfg);
  if (spec.type === 'opencode') rmSync(join(hubDirOf(p.paseo), `opencode-${name}.json`), { force: true });
  rmSync(undoPath(p, name), { force: true });
  if (!local.extraProviders) restoreBase(p);
}
/** Only a folder the hub created (marker file) that lies strictly inside the accounts root; never any other path, whatever --account-dir said at add. */
function purgeable(dir, env = process.env) {
  if (!dir) return false;
  const d = resolve(dir), rel = relative(accountsRoot(env), d);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(join(d, ACCOUNT_MARK));
}
/** Last provider gone: put each file's ORIGINAL bytes back when its content is the same JSON (keeps hand formatting that a rewrite would lose). */
function restoreBase(p) {
  let b; try { b = JSON.parse(readFileSync(basePath(p), 'utf8')); } catch { return; }
  const canon = (buf) => { try { return JSON.stringify(JSON.parse(buf.toString('utf8').replace(/^﻿/, ''))); } catch { return null; } };
  for (const x of FILES) {
    const pre = b[x] === null ? null : Buffer.from(b[x], 'base64'); const cur = bytes(p[x]);
    if (pre === null) { if (cur && canon(cur) === '{}') rmSync(p[x], { force: true }); }
    else if (cur && canon(cur) !== null && canon(cur) === canon(pre)) writeAtomic(p[x], pre);
  }
  rmSync(basePath(p), { force: true });
}
export const remove = (name, p = paths(), o = {}) => withLockSync(lockOf(p), () => removeLocked(name, p, o));
function removeLocked(name, p, { purge } = {}) {
  const local = rd(p.local, {});
  if (!own(local.extraProviders, name)) throw new Error(`${name} is not an added provider (list: ${Object.keys(local.extraProviders || {}).join(', ') || 'none'})`);
  const spec = own(local.extraProviders, name);
  if (purge && purgeable(spec.accountDir)) { try { rmSync(spec.accountDir, { recursive: true, force: true }); } catch { /* best effort */ } } // the account's login lives there; only with --purge
  if (restoreSnapshot(name, p)) { if (spec.type === 'opencode') rmSync(join(hubDirOf(p.paseo), `opencode-${name}.json`), { force: true }); if (!Object.keys(rd(p.local, {}).extraProviders || {}).length) rmSync(basePath(p), { force: true }); return; } // untouched since add: byte-identical to before
  removeManual(name, p, local);
}
/** Change slots, model, url, key, routes (with positions) or the read-only twin of an added provider. Kind and name are fixed. Undo still returns to the state before the ORIGINAL add. */
export const edit = (name, ch, p = paths(), o = {}) => withLock(lockOf(p), () => editLocked(name, ch, p, o));
async function editLocked(name, ch, p, o) {
  const local = rd(p.local, {}); const spec = own(local.extraProviders, name);
  if (!spec) throw new Error(`${name} is not an added provider`);
  const cur = list(p).find((x) => x.name === name); const token = chainToken(name, spec);
  const routes = rdr(p, {});
  const curRoutes = Object.entries(routes.routes || {}).filter(([, v]) => v.includes(token)).map(([c, v]) => `${c}:${v.indexOf(token) + 1}`).join(',');
  let u; try { u = JSON.parse(readFileSync(undoPath(p, name), 'utf8')); } catch { u = null; }
  const before = Object.fromEntries(FILES.map((x) => [x, bytes(p[x])]));
  const untouched = u && FILES.every((x) => !u[x] || sha(before[x]) === u[x].post);
  const preOverride = untouched ? Object.fromEntries(FILES.map((x) => [x, u[x].pre === null ? null : Buffer.from(u[x].pre, 'base64')])) : undefined;
  const merged = { name, kind: spec.type, account: spec.account, accountDir: spec.accountDir, url: spec.url, model: spec.model, key: spec.key, ...Object.fromEntries(LOCAL_FIELD_IDS.filter((i) => spec[i] !== undefined).map((i) => [i, spec[i]])), label: spec.label, readOnly: spec.readOnly, slots: cur.slots, routes: curRoutes, ...Object.fromEntries(Object.entries(ch).filter(([k, v]) => v !== undefined && v !== '' && !['name', 'kind', 'type'].includes(k))) };
  const ocf = join(hubDirOf(p.paseo), `opencode-${name}.json`), ocBefore = bytes(ocf), undoBefore = bytes(undoPath(p, name)), baseBefore = bytes(basePath(p));
  // checks first and no network inside the write window: a crash between remove and add can no longer lose the provider
  await verifyKind(kindOf(spec.type), kindOf(spec.type).local ? { ...merged, ...localSpec(merged) } : merged, o);
  try { removeManual(name, p); return await addLocked(merged, p, { ...o, preOverride, skipVerify: true }); }
  catch (e) { for (const x of FILES) { if (before[x] === null) rmSync(p[x], { force: true }); else writeAtomic(p[x], before[x]); } if (ocBefore) writeFileSync(ocf, ocBefore); if (undoBefore) writeFileSync(undoPath(p, name), undoBefore); if (baseBefore) writeFileSync(basePath(p), baseBefore); throw e; }
}
/** Restore each file whose bytes still equal what add() left; true when every file was restored. */
function restoreSnapshot(name, p) {
  let u; try { u = JSON.parse(readFileSync(undoPath(p, name), 'utf8')); } catch { return false; }
  const done = FILES.filter((x) => u[x] && sha(bytes(p[x])) === u[x].post);
  for (const x of done) { if (u[x].pre === null) rmSync(p[x], { force: true }); else writeAtomic(p[x], Buffer.from(u[x].pre, 'base64')); }
  if (done.length === FILES.length) { rmSync(undoPath(p, name), { force: true }); return true; }
  return false;
}

/**
 * Paseo's own "Remove provider" (Settings > Providers) deletes only the Paseo entry. Forget what the hub still records for such a provider
 * (extraProviders, slots, modes, read-only lists, route chain entries), so a removed provider leaves nothing behind and its name can be added again.
 */
export const reconcile = (p = paths()) => withLockSync(lockOf(p), () => reconcileLocked(p));
function reconcileLocked(p) {
  const prov = rd(p.paseo, null)?.agents?.providers; const local = rd(p.local, {});
  if (!prov || !local.extraProviders) return [];
  const gone = Object.entries(local.extraProviders).filter(([n, s]) => { try { return ownish(kindOf(s.type), s) && !prov[n]; } catch { return false; } }).map(([n]) => n);
  for (const n of gone) removeManual(n, p, rd(p.local, {}));
  return gone;
}

/**
 * One-time, idempotent move to "no presets, no twins": the Qwen entries an older hub seeded (qwen-code, qwen-code-2, qwen-laptop) become ordinary
 * user-added providers (recorded in hub.local.json extraProviders, so Remove works), the "-ro" twins are deleted, and read-only routing uses the
 * session mode "read-only" of the base id. Their Paseo entries are kept byte for byte. The three files' exact previous bytes are saved in
 * hub.local.undo-migrate-qwen.json; `migrate({ undo: true })` puts them back while nothing changed since.
 */
const migrateQwen = (p, o = {}) => withLockSync(lockOf(p), () => migrateQwenLocked(p, o));
function migrateQwenLocked(p, { undo } = {}) {
  const mu = join(dirname(p.local), 'hub.local.undo-migrate-qwen.json');
  if (undo) {
    let u; try { u = JSON.parse(readFileSync(mu, 'utf8')); } catch { return { undone: false, reason: 'no migration record' }; }
    const stale = FILES.filter((x) => sha(bytes(p[x])) !== u[x].post);
    if (stale.length) return { undone: false, reason: `changed since the migration: ${stale.join(', ')}` };
    for (const x of FILES) { if (u[x].pre === null) rmSync(p[x], { force: true }); else writeAtomic(p[x], Buffer.from(u[x].pre, 'base64')); }
    rmSync(mu, { force: true }); return { undone: true };
  }
  const cfg = rd(p.paseo, null); const prov = cfg?.agents?.providers; if (!prov) return { changed: false };
  const local = rd(p.local, {}); const routes = rd(p.routes, null); // the shipped template is never rewritten
  const twins = Object.keys(prov).filter((id) => id.endsWith('-ro') && prov[id.slice(0, -3)]);
  const spec = (id, e) => {
    const c = e.command ?? []; const i = c.findIndex((x) => /office-agent[.]mjs$/.test(String(x)));
    if (i >= 0 && safeUrl(c[i + 2]) && safeId(c[i + 3])) return { type: 'qwen-code', url: safeUrl(c[i + 2]), model: c[i + 3], ...(e.label ? { label: e.label } : {}) };
    if (c.some((x) => /laptop-agent[.]mjs$/.test(String(x)))) return { type: 'qwen-code', url: `http://127.0.0.1:${e.env?.LAPTOP_PORT || '8089'}/v1`, model: e.env?.LAPTOP_ALIAS || 'qwen35-9b', ...(e.label ? { label: e.label } : {}) };
    return null;
  };
  const adopt = ['qwen-code', 'qwen-code-2', 'qwen-laptop'].filter((id) => prov[id] && !local.extraProviders?.[id]).map((id) => [id, spec(id, prov[id])]).filter(([, sp]) => sp);
  const fix = routes ? Object.entries(local.extraProviders ?? {}).filter(([n, sp]) => sp.type === 'qwen-code' && sp.readOnly !== false && routes.readOnlyModes?.[n] !== 'read-only').map(([n]) => n) : []; // stale "plan" (or none) on a Qwen provider
  const stale = twins.length || routes?.twins || fix.length;
  if (!adopt.length && !stale) return { changed: false };
  const pre = Object.fromEntries(FILES.map((x) => [x, bytes(p[x])]));
  for (const [id, sp] of adopt) local.extraProviders = { ...local.extraProviders, [id]: sp };
  for (const t of twins) delete prov[t];
  if (routes) {
    const names = new Set([...adopt.map(([id]) => id), ...twins.map((t) => t.slice(0, -3)), ...fix]);
    delete routes.twins;
    if (names.size) {
      routes.readOnlyEnforced = [...new Set([...(routes.readOnlyEnforced ?? READ_ONLY_ENFORCED), ...names])];
      routes.readOnlyModes = { ...routes.readOnlyModes, ...Object.fromEntries([...names].map((n) => [n, 'read-only'])) };
    }
    for (const c of Object.keys(routes.routes ?? {})) routes.routes[c] = routes.routes[c].filter((x) => !String(x).split('/')[0].endsWith('-ro'));
    wr(p.routes, routes);
  }
  wr(p.local, local); wr(p.paseo, cfg);
  const snap = Object.fromEntries(FILES.map((x) => [x, { pre: pre[x]?.toString('base64') ?? null, post: sha(bytes(p[x])) }]));
  if (!existsSync(mu)) writeFileSync(mu, JSON.stringify(snap));
  return { changed: true, adopted: adopt.map(([id]) => id), removedTwins: twins };
}

/**
 * A qwen-code provider that points at this machine's hub-managed laptop model (loopback URL on the legacy `laptopPort`, with `llamaServer` + `laptopModel`
 * in hub.local.json or LLAMA_SERVER_BIN + LAPTOP_MODEL_PATH in the environment) becomes a local-llama provider: same id, label, slots and routes, so the
 * hub starts llama-server on demand (GPU only, no mmap) and stops it when idle again. Idempotent; own exact-undo record hub.local.undo-migrate-locallama.json.
 */
export const migrateLocalLlama = (p = paths(), o = {}) => withLockSync(lockOf(p), () => migrateLocalLlamaLocked(p, o));
function migrateLocalLlamaLocked(p, { undo, env = process.env } = {}) {
  const mu = join(dirname(p.local), 'hub.local.undo-migrate-locallama.json');
  if (undo) {
    let u; try { u = JSON.parse(readFileSync(mu, 'utf8')); } catch { return { undone: false, reason: 'no migration record' }; }
    const stale = FILES.filter((x) => sha(bytes(p[x])) !== u[x].post);
    if (stale.length) return { undone: false, reason: `changed since the local-llama migration: ${stale.join(', ')}` };
    for (const x of FILES) { if (u[x].pre === null) rmSync(p[x], { force: true }); else writeAtomic(p[x], Buffer.from(u[x].pre, 'base64')); }
    rmSync(mu, { force: true }); return { undone: true };
  }
  const local = rd(p.local, {}); const cfg = rd(p.paseo, null); const prov = cfg?.agents?.providers;
  const bin = env.LLAMA_SERVER_BIN || local.llamaServer, modelFile = env.LAPTOP_MODEL_PATH || local.laptopModel, port = String(env.LAPTOP_PORT || local.laptopPort || '');
  if (!prov || !bin || !modelFile || !port) return { changed: false };
  const hit = Object.entries(local.extraProviders ?? {}).filter(([n, sp]) => {
    const c = prov[n]?.command ?? []; let u; try { u = new URL(sp.url); } catch { return false; }
    return sp.type === 'qwen-code' && ['127.0.0.1', 'localhost'].includes(u.hostname) && u.port === port && /office-agent[.]mjs$/.test(String(c[1])) && c[2];
  });
  if (!hit.length) return { changed: false };
  const pre = Object.fromEntries(FILES.map((x) => [x, bytes(p[x])]));
  for (const [n, sp] of hit) {
    const spec = { type: 'local-llama', url: sp.url, model: sp.model, ...localSpec({ bin, modelFile, port, heavyLock: local.heavyLockGlob }), ...(sp.label ? { label: sp.label } : {}) };
    local.extraProviders[n] = spec; prov[n] = entries(n, spec, prov[n].command[2], REPO)[n];
  }
  wr(p.local, local); wr(p.paseo, cfg);
  writeFileSync(mu, JSON.stringify(Object.fromEntries(FILES.map((x) => [x, { pre: pre[x]?.toString('base64') ?? null, post: sha(bytes(p[x])) }]))));
  return { changed: true, converted: hit.map(([n]) => n) };
}
/** Both one-time moves (older Qwen presets -> user-added providers; managed laptop model -> local-llama). `undo` reverses them newest first. */
/** Fingerprint of everything a migration reads (the three files and the laptop-model env): when it equals the stored one, nothing can have changed since the last pass found/did its work. */
const migrateKey = (p, env) => sha(Buffer.from([...FILES.map((x) => sha(bytes(p[x]))), env.LLAMA_SERVER_BIN, env.LAPTOP_MODEL_PATH, env.LAPTOP_PORT].join('|')));
const markPath = (p) => join(dirname(p.local), 'hub.local.migrated');
const markedDone = (p, env) => { try { return readFileSync(markPath(p), 'utf8') === migrateKey(p, env); } catch { return false; } };
export function migrate(p = paths(), { undo, env } = {}) {
  const e = env ?? process.env;
  if (!undo && markedDone(p, e)) return { changed: false }; // the common case on every route call: three hashes, no lock, no write
  return withLockSync(lockOf(p), () => {
    if (undo) {
      rmSync(markPath(p), { force: true });
      const l = migrateLocalLlama(p, { undo, env }); if (l.undone === false && l.reason !== 'no migration record') return l;
      const q = migrateQwen(p, { undo }); return q.undone || !l.undone ? q : { undone: true };
    }
    if (markedDone(p, e)) return { changed: false };
    const q = migrateQwen(p); const l = migrateLocalLlama(p, { env });
    try { const k = migrateKey(p, e); if (!markedDone(p, e)) writeAtomic(markPath(p), k); } catch { /* a missing marker only costs one more pass */ }
    return l.changed ? { ...q, changed: true, localLlama: l.converted } : q;
  });
}

/** Added providers for display. The API key is never returned, only keySet. */
export const list = (p = paths()) => {
  reconcile(p);
  const routes = rdr(p, {});
  return Object.entries(rd(p.local, {}).extraProviders || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, s]) => { const { key, ...rest } = s; const isOwn = ownish(kindOf(s.type), s); const token = chainToken(name, s);
    return { name, ...rest, ...(key ? { keySet: true } : {}), slots: own(routes.slots, name),
      routes: Object.entries(routes.routes || {}).filter(([, v]) => v.some((x) => (isOwn ? x.split('/')[0] === name : x === token))).map(([c]) => c) }; });
};

/** What the Settings screen needs to draw its form: kinds with fields, the route types and the current providers. */
export const describe = (p = paths()) => ({ kinds: Object.entries(KINDS).map(([type, k]) => ({ type, label: k.label, fields: k.fields, slots: k.slots, readOnlyTwin: k.twin, nameHelp: k.nameHelp, ownProvider: k.own, account: k.account })),
  routeTypes: Object.fromEntries(Object.entries(rdr(p, {}).routes || {}).map(([c, v]) => [c, v.length])), providers: list(p) });

function whichBin(name) { // PATH lookup on Windows, macOS and Linux
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  const l = (r.stdout || '').split(/\r?\n/).filter(Boolean);
  return process.platform === 'win32' ? l.find((x) => /\.(cmd|exe|bat)$/i.test(x)) || l[0] || '' : l[0] || '';
}

const USAGE = `usage:
  provider kinds                                   list the kinds and their fields
  provider add <name> --kind <kind> [--url U] --model M [--key K] [--slots N] [--routes code-edit:2,summarise] [--readonly false] [--label "Display name"]
  provider add <name> --kind claude|codex|qoder --account <acct> --model M [--account-dir D] [--slots N] [--routes ...]   (own login dir; prints the one-line login command)
  provider edit <name> [--label "Display name"] [--model M] [--url U] [--key K] [--slots N] [--routes ...] [--readonly true|false]
  provider list | models --kind <kind> [--url U] [--key K] | remove <name> [--purge]
  provider api            (JSON on stdin {verb,args}; used by the Settings screen)`;

const helpFor = (usage, cmd) => { const rows = usage.split('\n').slice(1), own = rows.filter((x) => new RegExp(`^\\s+(routes|provider) ${cmd}\\b`).test(x)), l = own.length ? own : rows.filter((x) => x.includes(` ${cmd} `) || x.includes(`| ${cmd}`)); return `usage:\n${(l.length ? l : rows).join('\n')}`; };

/** Model ids for the picker of Paseo's "Add custom model" sheet. A hub endpoint provider: its endpoint's /v1/models, fetched here with the stored key (the key never leaves the machine).
 *  A provider whose models the user names (local-llama): an empty list, and the daemon is NOT asked (asking would start the model server).
 *  Everything else (Claude, Codex, Qoder, accounts of them, any built-in): { daemon: true } = the page asks the daemon for the model list it already shows as "N models". */
export async function providerModels(name, p = paths(), o = {}) {
  const spec = typeof name === 'string' ? own(rd(p.local, {}).extraProviders, name) : undefined;
  if (!spec) return { daemon: true };
  const k = kindOf(spec.type);
  if (k.modelsFrom === 'endpoint') return { models: await discover(spec.type, { url: spec.url, key: spec.key }, o) };
  return k.modelsFrom === 'none' ? { models: [] } : { daemon: true };
}

/** The one entry the Settings screen calls: {verb,args} -> JSON. Same functions as the CLI. */
export async function api({ verb, args = {} }, p = paths(), o = {}) {
  if (verb === 'describe') return describe(p);
  if (verb === 'models') return { models: await discover(kindOf(args.kind ?? args.type).type, { url: args.url ?? args.link, key: args.key, provider: args.provider }, o) };
  if (verb === 'list') return { providers: list(p) };
  if (verb === 'provider-models') return providerModels(args.provider, p, o);
  if (verb === 'migrate') return migrate(p, { undo: args.undo === true || args.undo === 'true' });
  if (verb === 'add') return await add(args, p, o);
  if (verb === 'edit') return await edit(args.name, args, p, o);
  if (verb === 'remove') { remove(args.name, p, { purge: args.purge === true || args.purge === 'true' }); return { removed: args.name }; }
  throw new Error(`unknown verb ${verb}`);
}

export async function main(argv) {
  const [cmd, ...rest] = argv; const o = {}; const pos = [];
  if (cmd && cmd !== 'api' && (rest.includes('--help') || rest.includes('-h'))) { console.log(helpFor(USAGE, cmd)); return 0; } // --help on any subcommand prints its usage
  for (let i = 0; i < rest.length; i++) rest[i].startsWith('--') ? (o[rest[i].slice(2)] = rest[++i]) : pos.push(rest[i]);
  if (o.type && !o.kind) o.kind = o.type; // older spelling
  if (o.link && !o.url) o.url = o.link; // plain-words spelling of --url
  if (o.readonly !== undefined) { o.readOnly = o.readonly; delete o.readonly; }
  const bins = { which: (n) => (n === 'qwen' ? process.env.QWEN_BIN || whichBin('qwen') : whichBin(n)) };
  try {
    if (cmd === 'api') {
      let t = ''; for await (const c of process.stdin) t += c;
      try { console.log(JSON.stringify(await api(JSON.parse(t), paths(), bins))); return 0; }
      catch (e) { console.log(JSON.stringify({ error: String(e.message || e) })); return 1; }
    }
    if (cmd === 'add' && !pos[0] && !o.label && !o.kind) { console.log(USAGE); return 2; }
    if (cmd === 'add' && !o.model) { // no --model: show what the kind offers instead of making the user guess
      const k = kindOf(o.kind);
      if (k.fields.some((f) => f.id === 'url') && !o.url) throw new Error(`${k.label} needs --url <base URL>, e.g. --url http://host:8000/v1`); const ms = await discover(k.type, { url: o.url, key: o.key, provider: o.account ? pos[0] : undefined }, bins);
      console.log(`Pick a model and run again with --model <id>:\n${ms.map((m) => `  ${m.id}${m.label !== m.id ? `  (${m.label})` : ''}${m.hint ? `  ${m.hint}` : ''}`).join('\n')}`); return 2;
    }
    if (cmd === 'add' || cmd === 'edit') {
      const r = cmd === 'add' ? await add({ name: pos[0], ...o }, paths(), bins) : await edit(pos[0], o, paths(), bins);
      console.log(`[OK] provider ${r.name} (${r.kind}) ${cmd === 'add' ? 'added' : 'updated'}${r.slots ? `, slots ${r.slots}` : ''}, routes: ${r.routes.join(', ') || '(none: pass --routes code-edit,summarise,...)'}`);
      if (r.login) console.log(`Sign in ONCE to this account (you type the credentials; the hub never sees them):
  ${r.login}`);
      console.log(r.needsRestart ? 'Restart the daemon so Paseo reloads its providers: just down && just up' : 'No restart needed: the route entry is read at dispatch.');
    } else if (cmd === 'remove') { remove(pos[0], paths(), { purge: "purge" in o }); console.log(`[OK] provider ${pos[0]} removed. Restart the daemon if it had its own Paseo provider: just down && just up`); }
    else if (cmd === 'list') { const l = list(); console.log(l.length ? l.map((x) => `${x.name}  ${x.type}  ${x.model}  ${x.url ?? '-'}  ${x.keySet ? 'key set  ' : ''}slots ${x.slots ?? '-'}  routes ${x.routes.join(',') || '-'}`).join('\n') : '(no added providers)'); }
    else if (cmd === 'migrate') { const r = migrate(paths(), { undo: 'undo' in o }); console.log(JSON.stringify(r)); }
    else if (cmd === 'kinds') console.log(describe().kinds.map((k) => `${k.type}  ${k.label}  fields: ${k.fields.map((f) => f.id).join(', ')}`).join('\n'));
    else if (cmd === 'models') {
      const sp = !o.kind && pos[0] ? own(rd(paths().local, {}).extraProviders, pos[0]) : undefined; // `provider models <added name>`
      if (!o.kind && pos[0] && !sp) throw new Error(`${pos[0]} is not an added provider (list: agent-hub provider list); or pass --kind K [--url U]`);
      if (sp) { o.kind = sp.type; o.url ??= sp.url; o.key ??= sp.key; o.provider ??= pos[0]; }
      console.log((await discover(kindOf(o.kind).type, { url: o.url, key: o.key, provider: o.provider }, bins)).map((m) => `${m.id}${m.hint ? `  (${m.label} - ${m.hint})` : ''}`).join('\n'));
    }
    else { console.log(USAGE); return 2; }
    return 0;
  } catch (e) { console.error(`[REFUSED] ${e.message}`); return 1; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // Never process.exit() with sockets or timers still closing (fetch discovery): on Windows libuv aborts with 0xC0000409 (exit 3221226505) and the Save in the form got no result.
  process.exitCode = await main(process.argv.slice(2));
  setTimeout(() => process.exit(), 5000).unref(); // a handle that never closes must not keep the tool alive
}
