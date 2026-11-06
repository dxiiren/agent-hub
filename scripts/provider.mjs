// One command to add, list and remove an OpenAI-compatible model endpoint as a hub provider (Paseo's UI catalog cannot take a URL, model or env).
//   node scripts/hub.mjs provider add <name> --type qwen-code --url <base-url> --model <id> [--slots N] [--routes code-edit,summarise]
//   node scripts/hub.mjs provider list | remove <name>        (also: agent-hub provider ...)
// Writes config/hub.local.json (extraProviders), the routes file (slots, modes, route chains) and the Paseo config.json entries (<name> and the read-only <name>-ro twin).
// Restart the daemon afterwards (`just down && just up`) so Paseo reloads its providers.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelsUrl, safeId } from '../plugins/routing/office.mjs';
import { READ_ONLY_ENFORCED } from '../plugins/routing/route.mjs';
import { writeJsonKeepEol } from '../plugins/routing/jsonfile.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NAME_RE = /^qwen-[a-z0-9]+(-[a-z0-9]+)*$/; // routing derives the read-only twin only for names starting "qwen" (roTwin in route.mjs)
const CORE = new Set(['qwen-code', 'qwen-code-2', 'qwen-laptop']); // written by `configure` from the officeQwen*/laptop keys
// A type = how to launch it. Add a type here (one function) to support another OpenAI-compatible launcher.
export const TYPES = {
  'qwen-code': { label: 'Qwen Code', command: (repo, s, bin) => [process.execPath, join(repo, 'deploy', 'office', 'office-agent.mjs'), bin, s.url, s.model] },
};

export function paths(env = process.env) {
  const home = resolve(env.AGENT_HUB_HOME || join(homedir(), '.paseo'));
  const routesDir = join(REPO, 'config', 'routes');
  return { local: join(REPO, 'config', 'hub.local.json'), paseo: join(home, 'config.json'),
    routes: env.AGENT_HUB_ROUTES || (existsSync(join(routesDir, 'routes.local.json')) ? join(routesDir, 'routes.local.json') : join(routesDir, 'routes.template.json')) };
}
const rd = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const wr = writeJsonKeepEol; // keeps the file's own line endings
const sha = (b) => (b ? createHash('sha256').update(b).digest('hex') : null);
const bytes = (p) => { try { return readFileSync(p); } catch { return null; } };
const FILES = ['local', 'paseo', 'routes'];
const undoPath = (p, name) => join(dirname(p.local), `hub.local.undo-${name}.json`); // matches .gitignore *.local.*

/** Refuse unless GET <url>/v1/models lists `model`. `f` is injectable for tests. */
export async function checkEndpoint(url, model, f = fetch) {
  let body;
  try { const r = await f(modelsUrl(url), { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); body = await r.json(); }
  catch (e) { throw new Error(`endpoint check failed: GET ${modelsUrl(url)} -> ${e.message}`); }
  const ids = (Array.isArray(body?.data) ? body.data : []).map((m) => m?.id).filter(Boolean);
  if (!ids.includes(model)) throw new Error(`endpoint check failed: model "${model}" not served (served: ${ids.join(', ') || 'none'})`);
}

/** Paseo provider entries for one extra provider: the entry plus its read-only twin. */
export function entries(name, spec, qwenBin, repo = REPO) {
  const t = TYPES[spec.type]; if (!t) throw new Error(`unknown type ${spec.type} (known: ${Object.keys(TYPES).join(', ')})`);
  const e = { extends: 'acp', label: `${t.label} (${name})`, command: t.command(repo, spec, qwenBin) };
  return { [name]: e, [name + '-ro']: { ...e, label: e.label + ' (read-only)', command: [...e.command, '--read-only'] } };
}

export async function add(a, p = paths(), { f = fetch, which = () => 'qwen' } = {}) {
  const { name, type = 'qwen-code', url, model } = a; const slots = Number(a.slots ?? 2);
  if (!NAME_RE.test(name || '') || name.endsWith('-ro') || CORE.has(name)) throw new Error(`name must match ${NAME_RE} (not ending -ro, not one of ${[...CORE]})`);
  if (!TYPES[type]) throw new Error(`unknown type ${type} (known: ${Object.keys(TYPES).join(', ')})`);
  if (!/^https?:\/\/[^\s"]+$/.test(url || '')) throw new Error('--url must be an http(s) base URL');
  if (!safeId(model)) throw new Error('--model must be a plain model id');
  if (!Number.isInteger(slots) || slots < 1) throw new Error('--slots must be a positive integer');
  const pre = Object.fromEntries(FILES.map((f) => [f, bytes(p[f])]));
  const local = rd(p.local, {});
  if (local.extraProviders?.[name]) throw new Error(`${name} already exists (remove it first)`);
  await checkEndpoint(url, model, f);
  const bin = which(); if (!bin) throw new Error('qwen CLI not found on PATH');
  const routes = rd(p.routes, null); if (!routes) throw new Error(`routes file unreadable: ${p.routes}`);
  const chains = String(a.routes || '').split(',').filter(Boolean);
  for (const c of chains) if (!Array.isArray(routes.routes?.[c])) throw new Error(`unknown route type ${c} (known: ${Object.keys(routes.routes || {})})`);
  const cfg = rd(p.paseo, { version: 1 });
  cfg.agents ??= {}; cfg.agents.providers = { ...cfg.agents.providers, ...entries(name, { type, url, model }, bin) };
  local.extraProviders = { ...local.extraProviders, [name]: { type, url, model } };
  routes.slots = { ...routes.slots, [name]: slots }; routes.modes = { ...routes.modes, [name]: 'yolo' };
  // the -ro twin runs the same launcher with the sensitive-read deny settings, so summarise/review may run on it (route.mjs refuses read-only types on unlisted providers)
  routes.readOnlyEnforced = [...new Set([...(routes.readOnlyEnforced ?? READ_ONLY_ENFORCED), name])]; routes.readOnlyModes = { ...routes.readOnlyModes, [name]: 'plan' };
  for (const c of chains) routes.routes[c].push(name);
  wr(p.local, local); wr(p.routes, routes); wr(p.paseo, cfg);
  // remove() puts the exact pre-add bytes back while nothing else touched the files since
  writeFileSync(undoPath(p, name), JSON.stringify(Object.fromEntries(FILES.map((f) => [f, { pre: pre[f]?.toString('base64') ?? null, post: sha(bytes(p[f])) }]))));
  return { name, slots, routes: chains };
}

export function remove(name, p = paths()) {
  const local = rd(p.local, {});
  if (!local.extraProviders?.[name]) throw new Error(`${name} is not an added provider (list: ${Object.keys(local.extraProviders || {}).join(', ') || 'none'})`);
  if (restoreSnapshot(name, p)) return; // untouched since add: byte-identical to before
  delete local.extraProviders[name]; if (!Object.keys(local.extraProviders).length) delete local.extraProviders;
  const routes = rd(p.routes, {});
  delete routes.slots?.[name]; delete routes.modes?.[name]; delete routes.readOnlyModes?.[name];
  if (routes.readOnlyEnforced) routes.readOnlyEnforced = routes.readOnlyEnforced.filter((x) => x !== name);
  // add() materialised the built-in defaults and an empty readOnlyModes: drop what is back to its default so the file returns to its pre-add form
  if (routes.readOnlyEnforced && routes.readOnlyEnforced.length === READ_ONLY_ENFORCED.length && READ_ONLY_ENFORCED.every((x) => routes.readOnlyEnforced.includes(x))) delete routes.readOnlyEnforced;
  if (routes.readOnlyModes && !Object.keys(routes.readOnlyModes).length) delete routes.readOnlyModes;
  for (const c of Object.keys(routes.routes || {})) routes.routes[c] = routes.routes[c].filter((x) => x.split('/')[0] !== name);
  const cfg = rd(p.paseo, {});
  if (cfg.agents?.providers) { delete cfg.agents.providers[name]; delete cfg.agents.providers[name + '-ro']; }
  if (cfg.agents?.providers && !Object.keys(cfg.agents.providers).length) delete cfg.agents.providers;
  if (cfg.agents && !Object.keys(cfg.agents).length) delete cfg.agents;
  wr(p.local, local); wr(p.routes, routes); wr(p.paseo, cfg);
}
/** Restore each file whose bytes still equal what add() left; true when every file was restored. */
function restoreSnapshot(name, p) {
  let u; try { u = JSON.parse(readFileSync(undoPath(p, name), 'utf8')); } catch { return false; }
  const done = FILES.filter((f) => u[f] && sha(bytes(p[f])) === u[f].post);
  for (const f of done) { if (u[f].pre === null) rmSync(p[f], { force: true }); else writeFileSync(p[f], Buffer.from(u[f].pre, 'base64')); }
  if (done.length === FILES.length) { rmSync(undoPath(p, name), { force: true }); return true; }
  return false;
}

export const list = (p = paths()) => {
  const routes = rd(p.routes, {});
  return Object.entries(rd(p.local, {}).extraProviders || {}).map(([name, s]) => ({ name, ...s, slots: routes.slots?.[name],
    routes: Object.entries(routes.routes || {}).filter(([, v]) => v.some((x) => x.split('/')[0] === name)).map(([k]) => k) }));
};

function whichQwen() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['qwen'], { encoding: 'utf8' });
  const l = (r.stdout || '').split(/\r?\n/).filter(Boolean);
  return process.platform === 'win32' ? l.find((x) => /\.(cmd|exe|bat)$/i.test(x)) || l[0] || '' : l[0] || '';
}

export async function main(argv) {
  const [cmd, ...rest] = argv; const o = {}; const pos = [];
  for (let i = 0; i < rest.length; i++) rest[i].startsWith('--') ? (o[rest[i].slice(2)] = rest[++i]) : pos.push(rest[i]);
  try {
    if (cmd === 'add') {
      const r = await add({ name: pos[0], ...o }, paths(), { which: () => process.env.QWEN_BIN || whichQwen() });
      console.log(`[OK] provider ${r.name} (+ ${r.name}-ro) added, slots ${r.slots}, routes: ${r.routes.join(', ') || '(none: pass --routes code-edit,summarise,...)'}\nRestart the daemon so Paseo reloads: just down && just up`);
    } else if (cmd === 'remove') { remove(pos[0]); console.log(`[OK] provider ${pos[0]} removed. Restart the daemon: just down && just up`); }
    else if (cmd === 'list') { const l = list(); console.log(l.length ? l.map((x) => `${x.name}  ${x.type}  ${x.model}  ${x.url}  slots ${x.slots}  routes ${x.routes.join(',') || '-'}`).join('\n') : '(no added providers)'); }
    else { console.log('usage: provider add <name> --type qwen-code --url <base-url> --model <id> [--slots N] [--routes code-edit,summarise] | list | remove <name>'); return 2; }
    return 0;
  } catch (e) { console.error(`[REFUSED] ${e.message}`); return 1; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(await main(process.argv.slice(2)));
