// One command to add, list and remove an OpenAI-compatible model endpoint as a hub provider (Paseo's UI catalog cannot take a URL, model or env).
//   node scripts/hub.mjs provider add <name> --type qwen-code --url <base-url> --model <id> [--slots N] [--routes code-edit,summarise]
//   node scripts/hub.mjs provider list | remove <name>        (also: agent-hub provider ...)
// Writes config/hub.local.json (extraProviders), the routes file (slots, modes, route chains) and the Paseo config.json entries (<name> and the read-only <name>-ro twin).
// Restart the daemon afterwards (`just down && just up`) so Paseo reloads its providers.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { KINDS, RESERVED, KEY_ENV, kindOf, chainToken, discover, modelListed, hubDirOf } from './provider-kinds.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeId } from '../plugins/routing/office.mjs';
import { READ_ONLY_ENFORCED } from '../plugins/routing/route.mjs';
import { writeJsonKeepEol, readJsonStrict } from '../plugins/routing/jsonfile.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NAME_RE = KINDS['qwen-code'].nameRe; // routing derives the read-only twin only for names starting "qwen" (roTwin in route.mjs)
// A type = how to launch it. Add a type here (one function) to support another OpenAI-compatible launcher.
export const TYPES = {
  'qwen-code': { command: (repo, s, bin) => [process.execPath, join(repo, 'deploy', 'office', 'office-agent.mjs'), bin, s.url, s.model] },
};
const launchCommand = (k, repo, s) => k.launch.map((t) => String(t).replace(/\{(node|repo|url|model)\}/g, (_, x) => ({ node: process.execPath, repo, url: s.url ?? '', model: s.model ?? '' })[x]));

export function paths(env = process.env) {
  const home = resolve(env.AGENT_HUB_HOME || join(homedir(), '.paseo'));
  const routesDir = join(REPO, 'config', 'routes');
  return { local: join(REPO, 'config', 'hub.local.json'), paseo: join(home, 'config.json'),
    routes: env.AGENT_HUB_ROUTES || (existsSync(join(routesDir, 'routes.local.json')) ? join(routesDir, 'routes.local.json') : join(routesDir, 'routes.template.json')) };
}
const rd = readJsonStrict; // BOM-safe; missing file = default; unparsable = throws, so add/remove never overwrite a config they could not read
const wr = writeJsonKeepEol; // keeps the file's own line endings
const sha = (b) => (b ? createHash('sha256').update(b).digest('hex') : null);
const bytes = (p) => { try { return readFileSync(p); } catch { return null; } };
const FILES = ['local', 'paseo', 'routes'];
const basePath = (p) => join(dirname(p.local), 'hub.local.undo-base.json'); // the files as they were before the FIRST added provider
const undoPath = (p, name) => join(dirname(p.local), `hub.local.undo-${name}.json`); // matches .gitignore *.local.*

/** Refuse unless the endpoint's /v1/models lists `model`. `f` is injectable for tests. */
export async function checkEndpoint(url, model, f = fetch, key) {
  const ids = (await discover('qwen-code', { url, key }, { f })).map((m) => m.id);
  if (!ids.includes(model)) throw new Error(`endpoint check failed: model "${model}" not served (served: ${ids.join(', ') || 'none'})`);
}

/** Paseo provider entries for one extra provider (empty for CLI kinds: they only add a route token). Own kinds: the entry, plus a read-only twin when the kind has one and spec.readOnly is not false. */
export function entries(name, spec, qwenBin, repo = REPO, hubDir) {
  const k = kindOf(spec.type);
  if (!k.own) return {};
  const env = spec.key ? { [KEY_ENV]: spec.key } : undefined;
  const label = `${k.label.split(' (')[0]} (${name})`;
  if (k.type === 'opencode') return { [name]: { extends: 'opencode', label, env: { OPENCODE_CONFIG: join(hubDir, `opencode-${name}.json`), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_TELEMETRY: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', XDG_CONFIG_HOME: join(hubDir, 'xdg') }, models: [{ id: `${name}/${spec.model}`, label: spec.model, isDefault: true }] } };
  const e = { extends: 'acp', label, command: k.launch ? launchCommand(k, repo, spec) : TYPES[k.type].command(repo, spec, qwenBin), ...(env ? { env } : {}) };
  return { [name]: e, ...(k.twin && spec.readOnly !== false ? { [name + '-ro']: { ...e, label: e.label + ' (read-only)', command: [...e.command, '--read-only'] } } : {}) };
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
  const k = kindOf(a.kind ?? a.type); const type = k.type; const { name, model, url } = a; const key = a.key || undefined;
  const readOnly = !(a.readOnly === false || a.readOnly === 'false' || a.readOnly === 'off');
  const slots = Number(a.slots ?? 2);
  if (!k.nameRe.test(name || '') || name.endsWith('-ro') || RESERVED.has(name)) throw new Error(`name must match ${k.nameRe} (${k.nameHelp}; not ending -ro, not one of ${[...RESERVED]})`);
  if (k.own) {
    if (!/^https?:\/\/[^\s"]+$/.test(url || '')) throw new Error('--url must be an http(s) base URL');
    if (!Number.isInteger(slots) || slots < 1) throw new Error('--slots must be a positive integer');
  }
  if (key && !k.fields.some((x) => x.id === 'key')) throw new Error(`kind ${type} takes no API key (an agent of that kind could read it)`);
  if (!safeId(model)) throw new Error('--model must be a plain model id');
  const pre = Object.fromEntries(FILES.map((x) => [x, bytes(p[x])]));
  const local = rd(p.local, {}); const first = !Object.keys(local.extraProviders || {}).length;
  if (local.extraProviders?.[name]) throw new Error(`${name} already exists (remove it first, or use edit)`);
  const cfg = rd(p.paseo, { version: 1 });
  if (k.own && cfg.agents?.providers?.[name]) throw new Error(`${name} is already a provider in the Paseo config (not added by this tool)`);
  if (!skipVerify) await verifyKind(k, { url, model, key }, { f, run });
  const bin = type === 'qwen-code' ? which('qwen') : null; if (type === 'qwen-code' && !bin) throw new Error('qwen CLI not found on PATH');
  const routes = rd(p.routes, null); if (!routes) throw new Error(`routes file unreadable: ${p.routes}`);
  const chains = parseRoutes(a.routes);
  const spec = { type, ...(k.own ? { url } : {}), model, ...(key ? { key } : {}), ...(k.twin && !readOnly ? { readOnly: false } : {}) };
  const token = chainToken(name, spec);
  for (const { c } of chains) {
    if (!Array.isArray(routes.routes?.[c])) throw new Error(`unknown route type ${c} (known: ${Object.keys(routes.routes || {})})`);
    if (routes.routes[c].includes(token)) throw new Error(`route ${c} already lists ${token}`);
  }
  const hubDir = hubDirOf(p.paseo);
  cfg.agents ??= {}; cfg.agents.providers = { ...cfg.agents.providers, ...entries(name, spec, bin, REPO, hubDir) };
  local.extraProviders = { ...local.extraProviders, [name]: spec };
  if (k.own) {
    routes.slots = { ...routes.slots, [name]: slots }; routes.modes = { ...routes.modes, [name]: 'yolo' };
    // the -ro twin runs the same launcher with the sensitive-read deny settings, so summarise/review may run on it (route.mjs refuses read-only types on unlisted providers)
    if (k.twin && readOnly) { routes.readOnlyEnforced = [...new Set([...(routes.readOnlyEnforced ?? READ_ONLY_ENFORCED), name])]; routes.readOnlyModes = { ...routes.readOnlyModes, [name]: 'plan' }; }
  }
  for (const { c, pos } of chains) { const l = routes.routes[c]; l.splice(pos ? Math.min(pos - 1, l.length) : l.length, 0, token); }
  if (type === 'opencode') { mkdirSync(join(hubDir, 'xdg'), { recursive: true }); writeJsonKeepEol(join(hubDir, `opencode-${name}.json`), opencodeFile(name, spec)); }
  if (first) writeFileSync(basePath(p), JSON.stringify(Object.fromEntries(FILES.map((x) => [x, (preOverride ?? pre)[x]?.toString('base64') ?? null]))));
  wr(p.local, local); wr(p.routes, routes); wr(p.paseo, cfg);
  // remove() puts the exact pre-add bytes back while nothing else touched the files since
  const snap = Object.fromEntries(FILES.map((x) => [x, { pre: (preOverride ?? pre)[x]?.toString('base64') ?? null, post: sha(bytes(p[x])) }]));
  writeFileSync(undoPath(p, name), JSON.stringify(snap));
  return { name, kind: type, slots: k.own ? slots : undefined, routes: chains.map((x) => x.c), needsRestart: k.own };
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
  for (const c of Object.keys(routes.routes || {})) routes.routes[c] = routes.routes[c].filter((x) => (k.own ? x.split('/')[0] !== name : x !== token));
  const cfg = rd(p.paseo, {});
  if (k.own && cfg.agents?.providers) { delete cfg.agents.providers[name]; delete cfg.agents.providers[name + '-ro']; }
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
export function remove(name, p = paths()) {
  const local = rd(p.local, {});
  if (!local.extraProviders?.[name]) throw new Error(`${name} is not an added provider (list: ${Object.keys(local.extraProviders || {}).join(', ') || 'none'})`);
  const spec = local.extraProviders[name];
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
  const merged = { name, kind: spec.type, url: spec.url, model: spec.model, key: spec.key, readOnly: spec.readOnly, slots: cur.slots, routes: curRoutes, ...Object.fromEntries(Object.entries(ch).filter(([k, v]) => v !== undefined && v !== '' && !['name', 'kind', 'type'].includes(k))) };
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

/** Added providers for display. The API key is never returned, only keySet. */
export const list = (p = paths()) => {
  const routes = rd(p.routes, {});
  return Object.entries(rd(p.local, {}).extraProviders || {}).map(([name, s]) => { const { key, ...rest } = s; const own = kindOf(s.type).own; const token = chainToken(name, s);
    return { name, ...rest, ...(key ? { keySet: true } : {}), slots: routes.slots?.[name],
      routes: Object.entries(routes.routes || {}).filter(([, v]) => v.some((x) => (own ? x.split('/')[0] === name : x === token))).map(([c]) => c) }; });
};

/** What the Settings screen needs to draw its form: kinds with fields, the route types and the current providers. */
export const describe = (p = paths()) => ({ kinds: Object.entries(KINDS).map(([type, k]) => ({ type, label: k.label, fields: k.fields, slots: k.slots, readOnlyTwin: k.twin, nameHelp: k.nameHelp, ownProvider: k.own })),
  routeTypes: Object.fromEntries(Object.entries(rd(p.routes, {}).routes || {}).map(([c, v]) => [c, v.length])), providers: list(p) });

function whichBin(name) { // PATH lookup on Windows, macOS and Linux
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  const l = (r.stdout || '').split(/\r?\n/).filter(Boolean);
  return process.platform === 'win32' ? l.find((x) => /\.(cmd|exe|bat)$/i.test(x)) || l[0] || '' : l[0] || '';
}

const USAGE = `usage:
  provider kinds                                   list the kinds and their fields
  provider add <name> --kind <kind> [--url U] --model M [--key K] [--slots N] [--routes code-edit:2,summarise] [--readonly false]
  provider edit <name> [--model M] [--url U] [--key K] [--slots N] [--routes ...] [--readonly true|false]
  provider list | models --kind <kind> [--url U] [--key K] | remove <name>
  provider api            (JSON on stdin {verb,args}; used by the Settings screen)`;

/** The one entry the Settings screen calls: {verb,args} -> JSON. Same functions as the CLI. */
export async function api({ verb, args = {} }, p = paths(), o = {}) {
  if (verb === 'describe') return describe(p);
  if (verb === 'models') return { models: await discover(kindOf(args.kind ?? args.type).type, { url: args.url, key: args.key }, o) };
  if (verb === 'list') return { providers: list(p) };
  if (verb === 'add') return await add(args, p, o);
  if (verb === 'edit') return await edit(args.name, args, p, o);
  if (verb === 'remove') { remove(args.name, p); return { removed: args.name }; }
  throw new Error(`unknown verb ${verb}`);
}

export async function main(argv) {
  const [cmd, ...rest] = argv; const o = {}; const pos = [];
  for (let i = 0; i < rest.length; i++) rest[i].startsWith('--') ? (o[rest[i].slice(2)] = rest[++i]) : pos.push(rest[i]);
  if (o.type && !o.kind) o.kind = o.type; // older spelling
  if (o.readonly !== undefined) { o.readOnly = o.readonly; delete o.readonly; }
  const bins = { which: (n) => (n === 'qwen' ? process.env.QWEN_BIN || whichBin('qwen') : whichBin(n)) };
  try {
    if (cmd === 'api') {
      let t = ''; for await (const c of process.stdin) t += c;
      try { console.log(JSON.stringify(await api(JSON.parse(t), paths(), bins))); return 0; }
      catch (e) { console.log(JSON.stringify({ error: String(e.message || e) })); return 1; }
    }
    if (cmd === 'add' || cmd === 'edit') {
      const r = cmd === 'add' ? await add({ name: pos[0], ...o }, paths(), bins) : await edit(pos[0], o, paths(), bins);
      console.log(`[OK] provider ${r.name} (${r.kind}) ${cmd === 'add' ? 'added' : 'updated'}${r.slots ? `, slots ${r.slots}` : ''}, routes: ${r.routes.join(', ') || '(none: pass --routes code-edit,summarise,...)'}`);
      console.log(r.needsRestart ? 'Restart the daemon so Paseo reloads its providers: just down && just up' : 'No restart needed: the route entry is read at dispatch.');
    } else if (cmd === 'remove') { remove(pos[0]); console.log(`[OK] provider ${pos[0]} removed. Restart the daemon if it had its own Paseo provider: just down && just up`); }
    else if (cmd === 'list') { const l = list(); console.log(l.length ? l.map((x) => `${x.name}  ${x.type}  ${x.model}  ${x.url ?? '-'}  ${x.keySet ? 'key set  ' : ''}slots ${x.slots ?? '-'}  routes ${x.routes.join(',') || '-'}`).join('\n') : '(no added providers)'); }
    else if (cmd === 'kinds') console.log(describe().kinds.map((k) => `${k.type}  ${k.label}  fields: ${k.fields.map((f) => f.id).join(', ')}`).join('\n'));
    else if (cmd === 'models') console.log((await discover(kindOf(o.kind).type, { url: o.url, key: o.key }, bins)).map((m) => m.id).join('\n'));
    else { console.log(USAGE); return 2; }
    return 0;
  } catch (e) { console.error(`[REFUSED] ${e.message}`); return 1; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(await main(process.argv.slice(2)));
