// Routing & slots: which providers are on, which of their models the hub may use, how many parallel slots, and the order of each task type's chain.
//   node scripts/hub.mjs routes show [--json]                        (also: agent-hub routes ...)
//   node scripts/hub.mjs routes models <provider>                    live model list of a provider
//   node scripts/hub.mjs routes set <provider> [--slots N] [--models a,b|all] [--enabled true|false]
//   node scripts/hub.mjs routes chain <type> <entry,entry,...>       replace the chain of a task type (an empty value empties it)
//   node scripts/hub.mjs routes move <type> <entry> up|down|off      move one entry, or take it out of the chain
//   node scripts/hub.mjs routes undo                                 exact undo of the last save (refused when the file changed since)
// ONE backend for the CLI and the Settings page (plugins/providers, screen "routing"). The routes file stays the single source of truth route.mjs reads;
// writes take the same lock and atomic write as `provider add`, never touch a template, and are undone byte for byte from a snapshot stack.
// "Enabled" lives in Paseo (agents.providers.<id>.enabled): the page changes it through the daemon's config API (the result's `enabledChanges`); the CLI writes the Paseo config file and says when the daemon must be restarted.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, rdr, lockOf, sha, bytes, providerModels } from './provider.mjs';
import { writeJsonKeepEol as wr, writeAtomic, readJsonStrict as rd, own } from '../plugins/routing/jsonfile.mjs';
import { withLock } from '../plugins/routing/lock.mjs';
import { cliPaseo, READ_ONLY_ENFORCED } from '../plugins/routing/route.mjs';
import { effectiveBudget } from '../plugins/routing/budget.mjs';

export const TASK_TYPES = ['code-edit', 'code-edit-easy', 'summarise', 'test-scaffold', 'review'];
export const MAX_SLOTS = 64;
const UNDO_DEPTH = 20;
const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]*(\/[A-Za-z0-9._@:/-]+)?$/;
const MODEL_RE = /^[^\s\u0000-\u001f]{1,160}$/;
export const baseOf = (e) => String(e).split('/')[0];
const undoFile = (p) => join(dirname(p.local), 'hub.local.undo-routes.json'); // matches .gitignore *.local.*
const homeOf = (p) => dirname(p.paseo);

const readUndo = (p) => { try { const a = JSON.parse(readFileSync(undoFile(p), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } };
const bool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);

/** Providers the daemon reports (id, label, enabled, status); [] when it is down. o.paseoLs overrides (tests). */
function daemonProviders(p, o) {
  try {
    const r = o.paseoLs ? o.paseoLs() : cliPaseo(homeOf(p))(['provider', 'ls']);
    return (Array.isArray(r) ? r : r?.providers ?? []).filter((x) => x?.provider).map((x) => ({ id: x.provider, label: x.label ?? x.provider, status: x.status, enabled: x.enabled === true || String(x.enabled).toLowerCase() === 'enabled' }));
  } catch { return []; }
}
const fileEnabled = (cfg, id) => own(cfg?.agents?.providers, id)?.enabled !== false;

/** Every provider id the hub knows: the daemon's, the Paseo config's, slots and chains. */
function providerIds(p, o, routes) {
  const ids = new Map();
  for (const d of daemonProviders(p, o)) ids.set(d.id, d);
  const cfg = rd(p.paseo, {});
  for (const id of Object.keys(cfg.agents?.providers ?? {})) if (!ids.has(id)) ids.set(id, { id, label: id, enabled: fileEnabled(cfg, id) });
  for (const id of [...Object.keys(routes.slots ?? {}), ...Object.values(routes.routes ?? {}).flat().map(baseOf)]) if (!ids.has(id)) ids.set(id, { id, label: id, enabled: fileEnabled(cfg, id) });
  return ids;
}

/** Live model ids of a provider: { ids, known }. known=false when the provider has no list (local-llama: the user names the model) or it could not be read. */
export async function modelsOf(id, p = paths(), o = {}) {
  try {
    const r = await providerModels(id, p, o);
    if (r.models) return { ids: r.models.map((m) => m.id), models: r.models, known: r.models.length > 0 };
    const q = o.paseoModels ? await o.paseoModels(id) : cliPaseo(homeOf(p))(['provider', 'models', id]);
    const list = Array.isArray(q) ? q : q?.models ?? [];
    return { ids: list.map((m) => m.id).filter(Boolean), models: list.filter((m) => m.id).map((m) => ({ id: m.id, label: m.label ?? m.id })), known: list.length > 0 };
  } catch (e) { return { ids: [], models: [], known: false, error: String(e.message || e) }; }
}

export function show(p = paths(), o = {}) {
  const routes = rdr(p, {}); const cfg = rd(p.paseo, {});
  const types = [...new Set([...TASK_TYPES, ...Object.keys(routes.routes ?? {})])];
  const ro = routes.readOnlyEnforced ?? READ_ONLY_ENFORCED;
  const providers = [...providerIds(p, o, routes).values()].map((d) => ({
    id: d.id, label: d.label, status: d.status ?? null, enabled: d.enabled,
    slots: own(routes.slots, d.id) ?? null, models: own(routes.allowedModels, d.id) ?? null, readOnlyAllowed: ro.includes(d.id) || d.id === 'claude',
    chains: Object.fromEntries(types.map((t) => [t, (own(routes.routes, t) ?? []).filter((e) => baseOf(e) === d.id)])),
  }));
  const enabled = Object.fromEntries(providers.map((x) => [x.id, x.enabled]));
  return { types, chains: Object.fromEntries(types.map((t) => [t, [...(own(routes.routes, t) ?? [])]])), providers, maxSlots: MAX_SLOTS, canUndo: readUndo(p).length > 0,
    configuredTotal: Object.values(routes.slots ?? {}).reduce((a, b) => a + b, 0), effective: effectiveBudget({ slots: routes.slots ?? {}, enabled }),
    paseoConfigEnabled: Object.fromEntries(Object.keys(enabled).map((id) => [id, fileEnabled(cfg, id)])) };
}

/** Structural validation of a change set against the current routes; returns the list of errors (empty = fine). Pure: `ids` = known providers. */
export function validate(ch, routes, ids, live = {}) {
  const err = []; const types = new Set([...TASK_TYPES, ...Object.keys(routes.routes ?? {})]);
  if (ch === null || typeof ch !== 'object' || Array.isArray(ch)) return ['changes must be an object { providers, chains }'];
  for (const [id, c] of Object.entries(ch.providers ?? {})) {
    if (!ids.has(id)) { err.push(`unknown provider "${id}" (known: ${[...ids.keys()].sort().join(', ') || 'none'})`); continue; }
    if (c === null || typeof c !== 'object') { err.push(`${id}: expected an object`); continue; }
    if (c.slots !== undefined) { const n = typeof c.slots === 'string' && /^\d+$/.test(c.slots.trim()) ? Number(c.slots) : c.slots; if (!Number.isInteger(n) || n < 1 || n > MAX_SLOTS) err.push(`${id}: slots must be a whole number from 1 to ${MAX_SLOTS} (got ${JSON.stringify(c.slots)})`); }
    if (c.enabled !== undefined && bool(c.enabled) === undefined) err.push(`${id}: enabled must be true or false`);
    if (c.models !== undefined && c.models !== null && c.models !== 'all') {
      if (!Array.isArray(c.models) || !c.models.length) err.push(`${id}: models must be a non-empty list of model ids, or "all"`);
      else for (const m of c.models) {
        if (typeof m !== 'string' || !MODEL_RE.test(m)) err.push(`${id}: "${m}" is not a valid model id`);
        else if (live[id]?.known && !live[id].ids.includes(m)) err.push(`${id}: model "${m}" is not in its live model list (${live[id].ids.join(', ')})`);
      }
      if (new Set(c.models).size !== c.models?.length) err.push(`${id}: a model is listed twice`);
    }
  }
  for (const [t, chain] of Object.entries(ch.chains ?? {})) {
    if (!types.has(t)) { err.push(`unknown task type "${t}" (known: ${[...types].join(', ')})`); continue; }
    if (!Array.isArray(chain)) { err.push(`${t}: the chain must be a list`); continue; }
    if (new Set(chain).size !== chain.length) err.push(`${t}: an entry appears twice`);
    for (const e of chain) {
      if (typeof e !== 'string' || !ENTRY_RE.test(e)) err.push(`${t}: "${e}" is not a valid entry (provider or provider/model)`);
      else if (!ids.has(baseOf(e))) err.push(`${t}: "${e}" names an unknown provider "${baseOf(e)}"`);
      else if (e.includes('/')) { const id = baseOf(e), m = e.slice(id.length + 1); if (live[id]?.known && !/^latest|@latest$/.test(m) && !live[id].ids.includes(m)) err.push(`${t}: "${e}": ${id} does not serve a model called "${m}" (${live[id].ids.join(', ')})`); }
    }
  }
  return err;
}

/** Apply a change set { providers: {id: {slots, models, enabled}}, chains: {type: [entries]} }. Returns { saved, enabledChanges }. Throws one Error listing every problem; nothing is written then. */
export async function set(ch, p = paths(), o = {}) {
  const pre = rdr(p, {}); const ids = providerIds(p, o, pre);
  const live = {}; // network OUTSIDE the lock: only for providers whose model list changes
  for (const [id, c] of Object.entries(ch?.providers ?? {})) if (Array.isArray(c?.models) && ids.has(id)) live[id] = await modelsOf(id, p, o);
  for (const chain of Object.values(ch?.chains ?? {})) for (const e of Array.isArray(chain) ? chain : []) { const id = typeof e === 'string' ? baseOf(e) : ''; if (id && e.includes('/') && ids.has(id) && !live[id]) live[id] = await modelsOf(id, p, o); }
  return withLock(lockOf(p), () => {
    const routes = rdr(p, {});
    const errs = validate(ch, routes, ids, live); if (errs.length) throw new Error(errs.join('\n'));
    const before = bytes(p.routes); const prevEnabled = {}; const enabledChanges = {};
    const next = structuredClone(routes);
    for (const [id, c] of Object.entries(ch.providers ?? {})) {
      if (c.slots !== undefined) { next.slots ??= {}; next.slots[id] = Number(c.slots); }
      if (c.models !== undefined) {
        if (c.models === null || c.models === 'all') { delete next.allowedModels?.[id]; if (next.allowedModels && !Object.keys(next.allowedModels).length) delete next.allowedModels; }
        else { next.allowedModels ??= {}; next.allowedModels[id] = [...c.models]; }
      }
      if (c.enabled !== undefined) { const b = bool(c.enabled); const cur = ids.get(id).enabled; if (b !== cur) { prevEnabled[id] = cur; enabledChanges[id] = b; } }
    }
    for (const [t, chain] of Object.entries(ch.chains ?? {})) { next.routes ??= {}; next.routes[t] = [...chain]; }
    const changed = JSON.stringify(next) !== JSON.stringify(routes);
    if (changed) wr(p.routes, next);
    if (!changed && !Object.keys(enabledChanges).length) return { saved: false, enabledChanges: {}, note: 'nothing to change' };
    const stack = readUndo(p); stack.push({ at: new Date().toISOString(), pre: before ? before.toString('base64') : null, post: sha(bytes(p.routes)), enabled: prevEnabled });
    wr(undoFile(p), stack.slice(-UNDO_DEPTH));
    return { saved: true, enabledChanges };
  });
}

/** Exact undo of the last save: the routes file goes back byte for byte while it still equals what that save wrote. Returns the enabled flags to put back (the page sends them to the daemon). */
export const undo = (p = paths()) => withLock(lockOf(p), () => {
  const stack = readUndo(p); const last = stack.at(-1);
  if (!last) throw new Error('nothing to undo');
  if (sha(bytes(p.routes)) !== last.post) throw new Error('the routes file changed since the last save (by hand, or by provider add/remove): not undone, so nothing is overwritten');
  if (last.pre === null) rmSync(p.routes, { force: true }); else writeAtomic(p.routes, Buffer.from(last.pre, 'base64'));
  stack.pop(); if (stack.length) wr(undoFile(p), stack); else rmSync(undoFile(p), { force: true });
  return { undone: true, enabledChanges: last.enabled ?? {} };
});

/** CLI only: write the enabled flag into the Paseo config file (the daemon applies it after a restart). The Settings page uses the daemon API instead. */
export function writeEnabledFile(changes, p = paths()) {
  if (!Object.keys(changes).length) return;
  return withLock(lockOf(p), () => {
    const cfg = rd(p.paseo, {}); cfg.agents ??= {}; cfg.agents.providers ??= {};
    for (const [id, b] of Object.entries(changes)) { cfg.agents.providers[id] = { ...(own(cfg.agents.providers, id) ?? {}), enabled: b }; }
    wr(p.paseo, cfg);
  });
}

/** The one entry the Settings page calls (and tests): {verb,args} -> JSON. */
export async function api({ verb, args = {} }, p = paths(), o = {}) {
  if (verb === 'show') return show(p, o);
  if (verb === 'models') { const m = await modelsOf(args.provider, p, o); return { models: m.models, known: m.known, error: m.error }; }
  if (verb === 'set') return await set(args, p, o);
  if (verb === 'undo') return await undo(p);
  throw new Error(`unknown verb ${verb}`);
}

const USAGE = `usage:
  routes show [--json]
  routes models <provider>
  routes set <provider> [--slots 1..${MAX_SLOTS}] [--models id,id|all] [--enabled true|false]
  routes chain <type> <entry,entry,...>     (types: ${TASK_TYPES.join(', ')})
  routes move <type> <entry> up|down|off
  routes undo`;

function render(s) {
  const L = [`Configured slots ${s.configuredTotal}   effective now ${s.effective.effective} (${s.effective.source})${s.effective.reasons.length ? '\n  ' + s.effective.reasons.join('\n  ') : ''}`, '', 'Providers:'];
  for (const x of s.providers) L.push(`  ${x.id.padEnd(26)} ${x.enabled ? 'on ' : 'OFF'}  slots ${String(x.slots ?? '-').padEnd(3)} models ${x.models ? x.models.join(',') : 'all'}${x.readOnlyAllowed ? '  read-only ok' : ''}`);
  L.push('', 'Chains (first is tried first):');
  for (const t of s.types) L.push(`  ${t.padEnd(15)} ${s.chains[t].map((e, i) => `${i + 1}. ${e}`).join('  ') || '(empty)'}`);
  return L.join('\n');
}

export async function main(argv, p = paths(), o = {}) {
  const [cmd, ...rest] = argv; const f = {}; const pos = [];
  for (let i = 0; i < rest.length; i++) { if (rest[i] === '--json') f.json = true; else if (rest[i].startsWith('--')) f[rest[i].slice(2)] = rest[++i]; else pos.push(rest[i]); }
  try {
    if (cmd === 'show') { const s = show(p, o); console.log(f.json ? JSON.stringify(s, null, 2) : render(s)); return 0; }
    if (cmd === 'models') { if (!pos[0] || !providerIds(p, o, rdr(p, {})).has(pos[0])) throw new Error(pos[0] ? `unknown provider "${pos[0]}" (see: agent-hub routes show)` : 'models needs a provider id'); const m = await modelsOf(pos[0], p, o); console.log(m.known ? m.ids.join('\n') : `(no model list for ${pos[0]}${m.error ? ': ' + m.error : ''})`); return 0; }
    let r;
    if (cmd === 'set') {
      if (!pos[0]) throw new Error('set needs a provider id');
      const c = {}; if (f.slots !== undefined) c.slots = f.slots; if (f.enabled !== undefined) c.enabled = f.enabled;
      if (f.models !== undefined) c.models = f.models === 'all' ? 'all' : f.models.split(',').map((x) => x.trim()).filter(Boolean);
      if (!Object.keys(c).length) throw new Error('nothing to set: pass --slots, --models or --enabled');
      r = await set({ providers: { [pos[0]]: c } }, p, o);
    } else if (cmd === 'chain') {
      if (!pos[0]) throw new Error('chain needs a task type');
      r = await set({ chains: { [pos[0]]: (pos[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean) } }, p, o);
    } else if (cmd === 'move') {
      const [t, e, dir] = pos; const cur = [...(rdr(p, {}).routes?.[t] ?? [])]; const i = cur.indexOf(e);
      if (!t || !e || !['up', 'down', 'off'].includes(dir)) throw new Error('move <type> <entry> up|down|off');
      if (i < 0) throw new Error(`${e} is not in the ${t} chain (${cur.join(', ') || 'empty'})`);
      cur.splice(i, 1); if (dir !== 'off') cur.splice(Math.max(0, Math.min(cur.length, i + (dir === 'up' ? -1 : 1))), 0, e);
      r = await set({ chains: { [t]: cur } }, p, o);
    } else if (cmd === 'undo') r = await undo(p);
    else { console.log(USAGE); return 2; }
    if (r.enabledChanges && Object.keys(r.enabledChanges).length) { (o.writeEnabled ?? writeEnabledFile)(r.enabledChanges, p); console.log(`Paseo enabled flag written for ${Object.keys(r.enabledChanges).join(', ')}; restart the daemon to apply it (just down && just up), or use Settings > Routing & slots which applies it live.`); }
    console.log(r.saved === false ? `[OK] ${r.note}` : cmd === 'undo' ? '[OK] undone. Run `agent-hub routes show` to see what is back.' : '[OK] saved. Undo: agent-hub routes undo. No restart needed: routes are read at dispatch.');
    return 0;
  } catch (e) { console.error(`[REFUSED] ${e.message}`); return 1; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [c, ...r] = process.argv.slice(2);
  if (c === 'api') { let t = ''; for await (const x of process.stdin) t += x; try { console.log(JSON.stringify(await api(JSON.parse(t)))); process.exitCode = 0; } catch (e) { console.log(JSON.stringify({ error: String(e.message || e) })); process.exitCode = 1; } }
  else process.exitCode = await main([c, ...r]);
  setTimeout(() => process.exit(), 5000).unref();
}
