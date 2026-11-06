// One command to add, list and remove an OpenAI-compatible model endpoint as a hub provider (Paseo's UI catalog cannot take a URL, model or env).
//   node scripts/hub.mjs provider add <name> --type qwen-code --url <base-url> --model <id> [--slots N] [--routes code-edit,summarise]
//   node scripts/hub.mjs provider list | remove <name>        (also: agent-hub provider ...)
// Writes config/hub.local.json (extraProviders), the routes file (slots, modes, route chains) and the Paseo config.json entries (<name>).
// Restart the daemon afterwards (`just down && just up`) so Paseo reloads its providers.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { KINDS, RESERVED, KEY_ENV, kindOf, chainToken, discover, modelListed, hubDirOf, displayName, hasAccounts, loginCommand } from './provider-kinds.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeId } from '../plugins/routing/office.mjs';
import { READ_ONLY_ENFORCED } from '../plugins/routing/route.mjs';
import { writeJsonKeepEol, readJsonStrict } from '../plugins/routing/jsonfile.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NAME_RE = KINDS['qwen-code'].nameRe; // any lower-case id
/** An id from a display name ("Lab box #2" -> "lab-box-2"). */
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '');
// A type = how to launch it. Add a type here (one function) to support another OpenAI-compatible launcher.
export const TYPES = {
  'qwen-code': { command: (repo, s, bin) => [process.execPath, join(repo, 'deploy', 'office', 'office-agent.mjs'), bin, s.url, s.model] },
};
const launchCommand = (k, repo, s) => k.launch.map((t) => String(t).replace(/\{(node|repo|url|model)\}/g, (_, x) => ({ node: process.execPath, repo, url: s.url ?? '', model: s.model ?? '' })[x]));

export function paths(env = process.env) {
  const home = resolve(env.AGENT_HUB_HOME || join(homedir(), '.paseo'));
  const routesDir = join(REPO, 'config', 'routes');
  return { local: env.AGENT_HUB_LOCAL || join(REPO, 'config', 'hub.local.json'), paseo: join(home, 'config.json'),
    routes: env.AGENT_HUB_ROUTES || (existsSync(join(routesDir, 'routes.local.json')) ? join(routesDir, 'routes.local.json') : join(routesDir, 'routes.template.json')) };
}
const rd = readJsonStrict; // BOM-safe; missing file = default; unparsable = throws, so add/remove never overwrite a config they could not read
const wr = writeJsonKeepEol; // keeps the file's own line endings
const sha = (b) => (b ? createHash('sha256').update(b).digest('hex') : null);
const bytes = (p) => { try { return readFileSync(p); } catch { return null; } };
const FILES = ['local', 'paseo', 'routes'];
const basePath = (p) => join(dirname(p.local), 'hub.local.undo-base.json'); // the files as they were before the FIRST added provider
const undoPath = (p, name) => join(dirname(p.local), `hub.local.undo-${name}.json`); // matches .gitignore *.local.*

/** Where account config dirs live: AGENT_HUB_ACCOUNTS_DIR, else ~/.agent-hub/accounts/<kind>/<account>. */
export const accountDirOf = (kind, account, env = process.env) => join(resolve(env.AGENT_HUB_ACCOUNTS_DIR || join(homedir(), '.agent-hub', 'accounts')), kind, account);
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
async function verifyKind(k, { url, model, key }, { f = fetch, run } = {}) {
  if (k.own) return checkEndpoint(url, model, f, key);
  const models = await discover(k.type, {}, run ? { run } : {});
  if (!modelListed(model, models)) throw new Error(`model "${model}" is not offered by the ${k.base} CLI (offered: ${models.map((m) => m.id).join(', ')})`);
}

export async function add(a, p = paths(), { f = fetch, which = () => 'qwen', run, preOverride, skipVerify } = {}) {
  const k = kindOf(a.kind ?? a.type); const type = k.type; const { model, url } = a;
  let name = a.name; // empty name: made from the display name (or kind and host), made unique with -2, -3
  if (!name) { const used = new Set([...Object.keys(rd(p.local, {}).extraProviders || {}), ...Object.keys(rd(p.paseo, {}).agents?.providers || {}), ...RESERVED]); const b0 = slug(a.label) || slug(displayName(k.label.split(' (')[0], url)) || type; name = b0; for (let n = 2; used.has(name) || used.has(name + '-ro'); n++) name = `${b0}-${n}`; } const key = a.key || undefined; const label = a.label ? String(a.label).trim() : undefined;
  const readOnly = !(a.readOnly === false || a.readOnly === 'false' || a.readOnly === 'off');
  const slots = Number(a.slots ?? 2);
  const account = a.account ? String(a.account) : undefined;
  if (account) {
    if (!hasAccounts(k)) throw new Error(`kind ${type} cannot separate accounts through a login directory (${k.account?.by === 'endpoint' ? 'add another entry with its own --url/--key instead' : k.account?.none || 'not supported'})`);
    if (!ACCOUNT_RE.test(account)) throw new Error('--account must be lower-case letters, digits, dashes (max 31)');
    if (!String(name).startsWith(`${k.base}-`)) throw new Error(`an account provider must be named "${k.base}-<something>" (e.g. ${k.base}-${account})`);
    if (!Number.isInteger(slots) || slots < 1) throw new Error('--slots must be a positive integer');
  } else if (a.accountDir) throw new Error('--account-dir needs --account');
  if (!k.nameRe.test(name || '') || name.endsWith('-ro') || RESERVED.has(name)) throw new Error(`name must match ${k.nameRe} (${k.nameHelp}; not ending -ro, not one of ${[...RESERVED]})`);
  if (k.own) {
    if (!/^https?:\/\/[^\s"]+$/.test(url || '')) throw new Error('--url must be an http(s) base URL');
    if (!Number.isInteger(slots) || slots < 1) throw new Error('--slots must be a positive integer');
  }
  if (key && !k.fields.some((x) => x.id === 'key')) throw new Error(`kind ${type} takes no API key (an agent of that kind could read it)`);
  if (label && !/^[^ -"]{1,80}$/.test(label)) throw new Error('--label must be 1-80 printable characters without quotes');
  if (!safeId(model)) throw new Error('--model must be a plain model id');
  const pre = Object.fromEntries(FILES.map((x) => [x, bytes(p[x])]));
  const local = rd(p.local, {}); const first = !Object.keys(local.extraProviders || {}).length;
  if (local.extraProviders?.[name]) throw new Error(`${name} already exists (remove it first, or use edit)`);
  const cfg = rd(p.paseo, { version: 1 });
  if ((k.own || account) && cfg.agents?.providers?.[name]) throw new Error(`${name} is already a provider in the Paseo config (not added by this tool)`);
  if (!skipVerify) await verifyKind(k, { url, model, key }, { f, run });
  const bin = type === 'qwen-code' ? which('qwen') : null; if (type === 'qwen-code' && !bin) throw new Error('qwen CLI not found on PATH');
  const routes = rd(p.routes, null); if (!routes) throw new Error(`routes file unreadable: ${p.routes}`);
  const chains = parseRoutes(a.routes);
  const accountDir = account ? resolve(a.accountDir || accountDirOf(type, account)) : undefined;
  const spec = { type, ...(k.own ? { url } : {}), model, ...(account ? { account, accountDir } : {}), ...(label && (k.own || account) ? { label } : {}), ...(key ? { key } : {}), ...(k.twin && !readOnly ? { readOnly: false } : {}) };
  const token = chainToken(name, spec);
  for (const { c } of chains) {
    if (!Array.isArray(routes.routes?.[c])) throw new Error(`unknown route type ${c} (known: ${Object.keys(routes.routes || {})})`);
    if (routes.routes[c].includes(token)) throw new Error(`route ${c} already lists ${token}`);
  }
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
  if (accountDir) mkdirSync(accountDir, { recursive: true }); // an empty dir; the user signs in once (login below). remove() never deletes it unless --purge
  wr(p.local, local); wr(p.routes, routes); wr(p.paseo, cfg);
  // remove() puts the exact pre-add bytes back while nothing else touched the files since
  const snap = Object.fromEntries(FILES.map((x) => [x, { pre: (preOverride ?? pre)[x]?.toString('base64') ?? null, post: sha(bytes(p[x])) }]));
  writeFileSync(undoPath(p, name), JSON.stringify(snap));
  return { name, kind: type, slots: ownish(k, spec) ? slots : undefined, routes: chains.map((x) => x.c), needsRestart: ownish(k, spec), ...(account ? { account, accountDir, login: loginCommand(k, accountDir) } : {}) };
}

function removeManual(name, p, local = rd(p.local, {})) {
  const spec = local.extraProviders[name]; const k = kindOf(spec.type); const token = chainToken(name, spec);
  delete local.extraProviders[name]; if (!Object.keys(local.extraProviders).length) delete local.extraProviders;
  const routes = rd(p.routes, {});
  delete routes.slots?.[name]; delete routes.modes?.[name]; delete routes.readOnlyModes?.[name];
  if (routes.readOnlyEnforced) routes.readOnlyEnforced = routes.readOnlyEnforced.filter((x) => x !== name);
  // add() materialised the built-in defaults and an empty readOnlyModes: drop what is back to its default so the file returns to its pre-add form
  if (routes.readOnlyEnforced && routes.readOnlyEnforced.length === READ_ONLY_ENFORCED.length && READ_ONLY_ENFORCED.every((x) => routes.readOnlyEnforced.includes(x))) delete routes.readOnlyEnforced;
  if (routes.readOnlyModes && !Object.keys(routes.readOnlyModes).length) delete routes.readOnlyModes;
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
/** Last provider gone: put each file's ORIGINAL bytes back when its content is the same JSON (keeps hand formatting that a rewrite would lose). */
function restoreBase(p) {
  let b; try { b = JSON.parse(readFileSync(basePath(p), 'utf8')); } catch { return; }
  const canon = (buf) => { try { return JSON.stringify(JSON.parse(buf.toString('utf8').replace(/^﻿/, ''))); } catch { return null; } };
  for (const x of FILES) {
    const pre = b[x] === null ? null : Buffer.from(b[x], 'base64'); const cur = bytes(p[x]);
    if (pre === null) { if (cur && canon(cur) === '{}') rmSync(p[x], { force: true }); }
    else if (cur && canon(cur) !== null && canon(cur) === canon(pre)) writeFileSync(p[x], pre);
  }
  rmSync(basePath(p), { force: true });
}
export function remove(name, p = paths(), { purge } = {}) {
  const local = rd(p.local, {});
  if (!local.extraProviders?.[name]) throw new Error(`${name} is not an added provider (list: ${Object.keys(local.extraProviders || {}).join(', ') || 'none'})`);
  const spec = local.extraProviders[name];
  if (purge && spec.accountDir && spec.accountDir.split(/[\\/]/).filter(Boolean).length >= 3) { try { rmSync(spec.accountDir, { recursive: true, force: true }); } catch { /* best effort */ } } // the account's login lives there; only with --purge
  if (restoreSnapshot(name, p)) { if (spec.type === 'opencode') rmSync(join(hubDirOf(p.paseo), `opencode-${name}.json`), { force: true }); if (!Object.keys(rd(p.local, {}).extraProviders || {}).length) rmSync(basePath(p), { force: true }); return; } // untouched since add: byte-identical to before
  removeManual(name, p, local);
}
/** Change slots, model, url, key, routes (with positions) or the read-only twin of an added provider. Kind and name are fixed. Undo still returns to the state before the ORIGINAL add. */
export async function edit(name, ch, p = paths(), o = {}) {
  const local = rd(p.local, {}); const spec = local.extraProviders?.[name];
  if (!spec) throw new Error(`${name} is not an added provider`);
  const cur = list(p).find((x) => x.name === name); const token = chainToken(name, spec);
  const routes = rd(p.routes, {});
  const curRoutes = Object.entries(routes.routes || {}).filter(([, v]) => v.includes(token)).map(([c, v]) => `${c}:${v.indexOf(token) + 1}`).join(',');
  let u; try { u = JSON.parse(readFileSync(undoPath(p, name), 'utf8')); } catch { u = null; }
  const before = Object.fromEntries(FILES.map((x) => [x, bytes(p[x])]));
  const untouched = u && FILES.every((x) => !u[x] || sha(before[x]) === u[x].post);
  const preOverride = untouched ? Object.fromEntries(FILES.map((x) => [x, u[x].pre === null ? null : Buffer.from(u[x].pre, 'base64')])) : undefined;
  const merged = { name, kind: spec.type, account: spec.account, accountDir: spec.accountDir, url: spec.url, model: spec.model, key: spec.key, label: spec.label, readOnly: spec.readOnly, slots: cur.slots, routes: curRoutes, ...Object.fromEntries(Object.entries(ch).filter(([k, v]) => v !== undefined && v !== '' && !['name', 'kind', 'type'].includes(k))) };
  const ocf = join(hubDirOf(p.paseo), `opencode-${name}.json`), ocBefore = bytes(ocf), undoBefore = bytes(undoPath(p, name)), baseBefore = bytes(basePath(p));
  // checks first and no network inside the write window: a crash between remove and add can no longer lose the provider
  await verifyKind(kindOf(spec.type), merged, o);
  try { removeManual(name, p); return await add(merged, p, { ...o, preOverride, skipVerify: true }); }
  catch (e) { for (const x of FILES) { if (before[x] === null) rmSync(p[x], { force: true }); else writeFileSync(p[x], before[x]); } if (ocBefore) writeFileSync(ocf, ocBefore); if (undoBefore) writeFileSync(undoPath(p, name), undoBefore); if (baseBefore) writeFileSync(basePath(p), baseBefore); throw e; }
}
/** Restore each file whose bytes still equal what add() left; true when every file was restored. */
function restoreSnapshot(name, p) {
  let u; try { u = JSON.parse(readFileSync(undoPath(p, name), 'utf8')); } catch { return false; }
  const done = FILES.filter((x) => u[x] && sha(bytes(p[x])) === u[x].post);
  for (const x of done) { if (u[x].pre === null) rmSync(p[x], { force: true }); else writeFileSync(p[x], Buffer.from(u[x].pre, 'base64')); }
  if (done.length === FILES.length) { rmSync(undoPath(p, name), { force: true }); return true; }
  return false;
}

/**
 * One-time, idempotent move to "no presets, no twins": the Qwen entries an older hub seeded (qwen-code, qwen-code-2, qwen-laptop) become ordinary
 * user-added providers (recorded in hub.local.json extraProviders, so Remove works), the "-ro" twins are deleted, and read-only routing uses the
 * session mode "read-only" of the base id. Their Paseo entries are kept byte for byte. The three files' exact previous bytes are saved in
 * hub.local.undo-migrate-qwen.json; `migrate({ undo: true })` puts them back while nothing changed since.
 */
export function migrate(p = paths(), { undo } = {}) {
  const mu = join(dirname(p.local), 'hub.local.undo-migrate-qwen.json');
  if (undo) {
    let u; try { u = JSON.parse(readFileSync(mu, 'utf8')); } catch { return { undone: false, reason: 'no migration record' }; }
    const stale = FILES.filter((x) => sha(bytes(p[x])) !== u[x].post);
    if (stale.length) return { undone: false, reason: `changed since the migration: ${stale.join(', ')}` };
    for (const x of FILES) { if (u[x].pre === null) rmSync(p[x], { force: true }); else writeFileSync(p[x], Buffer.from(u[x].pre, 'base64')); }
    rmSync(mu, { force: true }); return { undone: true };
  }
  const cfg = rd(p.paseo, null); const prov = cfg?.agents?.providers; if (!prov) return { changed: false };
  const local = rd(p.local, {}); const routes = /routes[.]template[.]json$/.test(p.routes) ? null : rd(p.routes, null); // the shipped template is never rewritten
  const twins = Object.keys(prov).filter((id) => id.endsWith('-ro') && prov[id.slice(0, -3)]);
  const spec = (id, e) => {
    const c = e.command ?? []; const i = c.findIndex((x) => /office-agent[.]mjs$/.test(String(x)));
    if (i >= 0 && c[i + 2] && safeId(c[i + 3])) return { type: 'qwen-code', url: c[i + 2], model: c[i + 3], ...(e.label ? { label: e.label } : {}) };
    if (c.some((x) => /laptop-agent[.]mjs$/.test(String(x)))) return { type: 'qwen-code', url: `http://127.0.0.1:${e.env?.LAPTOP_PORT || '8089'}/v1`, model: e.env?.LAPTOP_ALIAS || 'qwen35-9b', ...(e.label ? { label: e.label } : {}) };
    return null;
  };
  const adopt = ['qwen-code', 'qwen-code-2', 'qwen-laptop'].filter((id) => prov[id] && !local.extraProviders?.[id]).map((id) => [id, spec(id, prov[id])]).filter(([, sp]) => sp);
  const stale = twins.length || routes?.twins;
  if (!adopt.length && !stale) return { changed: false };
  const pre = Object.fromEntries(FILES.map((x) => [x, bytes(p[x])]));
  for (const [id, sp] of adopt) local.extraProviders = { ...local.extraProviders, [id]: sp };
  for (const t of twins) delete prov[t];
  if (routes) {
    const names = new Set([...adopt.map(([id]) => id), ...twins.map((t) => t.slice(0, -3))]);
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

/** Added providers for display. The API key is never returned, only keySet. */
export const list = (p = paths()) => {
  const routes = rd(p.routes, {});
  return Object.entries(rd(p.local, {}).extraProviders || {}).map(([name, s]) => { const { key, ...rest } = s; const own = ownish(kindOf(s.type), s); const token = chainToken(name, s);
    return { name, ...rest, ...(key ? { keySet: true } : {}), slots: routes.slots?.[name],
      routes: Object.entries(routes.routes || {}).filter(([, v]) => v.some((x) => (own ? x.split('/')[0] === name : x === token))).map(([c]) => c) }; });
};

/** What the Settings screen needs to draw its form: kinds with fields, the route types and the current providers. */
export const describe = (p = paths()) => ({ kinds: Object.entries(KINDS).map(([type, k]) => ({ type, label: k.label, fields: k.fields, slots: k.slots, readOnlyTwin: k.twin, nameHelp: k.nameHelp, ownProvider: k.own, account: k.account })),
  routeTypes: Object.fromEntries(Object.entries(rd(p.routes, {}).routes || {}).map(([c, v]) => [c, v.length])), providers: list(p) });

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

/** The one entry the Settings screen calls: {verb,args} -> JSON. Same functions as the CLI. */
export async function api({ verb, args = {} }, p = paths(), o = {}) {
  if (verb === 'describe') return describe(p);
  if (verb === 'models') return { models: await discover(kindOf(args.kind ?? args.type).type, { url: args.url ?? args.link, key: args.key, provider: args.provider }, o) };
  if (verb === 'list') return { providers: list(p) };
  if (verb === 'migrate') return migrate(p, { undo: args.undo === true || args.undo === 'true' });
  if (verb === 'add') return await add(args, p, o);
  if (verb === 'edit') return await edit(args.name, args, p, o);
  if (verb === 'remove') { remove(args.name, p, { purge: args.purge === true || args.purge === 'true' }); return { removed: args.name }; }
  throw new Error(`unknown verb ${verb}`);
}

export async function main(argv) {
  const [cmd, ...rest] = argv; const o = {}; const pos = [];
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
    if (cmd === 'add' && !o.model) { // no --model: show what the kind offers instead of making the user guess
      const k = kindOf(o.kind); const ms = await discover(k.type, { url: o.url, key: o.key, provider: o.account ? pos[0] : undefined }, bins);
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
    else if (cmd === 'models') console.log((await discover(kindOf(o.kind).type, { url: o.url, key: o.key, provider: o.provider }, bins)).map((m) => `${m.id}${m.hint ? `  (${m.label} - ${m.hint})` : ''}`).join('\n'));
    else { console.log(USAGE); return 2; }
    return 0;
  } catch (e) { console.error(`[REFUSED] ${e.message}`); return 1; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(await main(process.argv.slice(2)));
