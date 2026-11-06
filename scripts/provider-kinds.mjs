// The provider kinds `agent-hub provider add/edit` and the Paseo Settings screen offer. ONE schema: the CLI validates with it, the UI draws its form from it.
// Add a kind = add an entry here (fields, how to list its models, how its Paseo entry is built). Nothing personal or company-specific lives in this file.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelsUrl } from '../plugins/routing/office.mjs';

const KEY_ENV = 'HUB_OPENAI_API_KEY'; // read by deploy/office/office-agent.mjs, which keeps it in a local auth proxy and strips it from the agent's env; never argv
const ENDPOINT_FIELDS = [
  { id: 'url', label: 'Base URL', type: 'url', required: true, help: 'OpenAI-compatible base URL, e.g. http://host:8000/v1' },
  { id: 'model', label: 'Model', type: 'model', required: true, help: 'Picked from the endpoint\'s /v1/models list' },
  { id: 'key', label: 'API key (optional)', type: 'secret', help: 'Sent as a Bearer token; stored in the local hub config only' },
];

/** type -> definition. `base` = an installed CLI provider reached as <base>/<model> in route chains (no new Paseo provider is created). */
export const KINDS = {
  'qwen-code': { aliases: ['qwen'], label: 'Qwen Code (OpenAI-compatible endpoint)', fields: ENDPOINT_FIELDS, modelsFrom: 'endpoint', own: true, twin: true, slots: true,
    nameRe: /^qwen-[a-z0-9]+(-[a-z0-9]+)*$/, nameHelp: 'must start with "qwen-" (e.g. qwen-lab)' },
  // opencode has no key field: it runs without a hub launcher, so its agent could read a stored key
  opencode: { label: 'OpenCode (OpenAI-compatible endpoint)', fields: ENDPOINT_FIELDS.filter((f) => f.id !== 'key'), modelsFrom: 'endpoint', own: true, twin: false, slots: true,
    nameRe: /^opencode-[a-z0-9]+(-[a-z0-9]+)*$/, nameHelp: 'must start with "opencode-" (e.g. opencode-lab)' },
  qoder: { label: 'Qoder (model tier)', base: 'qoder', fields: [{ id: 'model', label: 'Tier / model', type: 'model', required: true, help: 'From `paseo provider models qoder`' }], modelsFrom: 'cli', own: false, twin: false, slots: false,
    nameRe: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, nameHelp: 'lower-case letters, digits, dashes' },
  codex: { label: 'Codex (model)', base: 'codex', fields: [{ id: 'model', label: 'Model', type: 'model', required: true, help: 'From `paseo provider models codex`' }], modelsFrom: 'cli', own: false, twin: false, slots: false,
    nameRe: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, nameHelp: 'lower-case letters, digits, dashes' },
  claude: { label: 'Claude (model)', base: 'claude', fields: [{ id: 'model', label: 'Model', type: 'model', required: true, help: 'From `paseo provider models claude`' }], modelsFrom: 'cli', own: false, twin: false, slots: false,
    nameRe: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, nameHelp: 'lower-case letters, digits, dashes' },
};
/** Names a new provider may never take: the hub's own providers and the CLI base providers. */
// Custom kinds: add your own in config/provider-kinds.local.json (or $AGENT_HUB_KINDS); see README "Add a provider".
//   { "my-agent": { "label": "My agent", "launch": ["{node}", "my-launcher.mjs", "{url}", "{model}"], "modelsFrom": "endpoint",
//                   "fields": [ {"id":"url","label":"Base URL","type":"url","required":true}, {"id":"model","label":"Model","type":"model","required":true} ] } }
//   launch = the ACP agent command ({node} {repo} {url} {model} are substituted; the key arrives in env HUB_OPENAI_API_KEY),
//   or "base": "<installed provider id>" to only add route tokens "<base>/<model>" (modelsFrom "cli" then lists `paseo provider models <base>`).
function loadCustom() {
  const f = process.env.AGENT_HUB_KINDS || join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'provider-kinds.local.json');
  let j; try { j = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.error(`provider-kinds: ${f} ignored (${e.message})`); return; }
  for (const [id, c] of Object.entries(j)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id) || KINDS[id]) { console.error(`provider-kinds: kind "${id}" skipped (bad or duplicate id)`); continue; }
    const own = !c.base; if (own && !Array.isArray(c.launch)) { console.error(`provider-kinds: kind "${id}" needs launch[] or base`); continue; }
    KINDS[id] = { label: c.label || id, fields: c.fields || ENDPOINT_FIELDS, modelsFrom: c.modelsFrom || (own ? 'endpoint' : 'cli'), own, twin: false, slots: own, launch: c.launch, base: c.base,
      nameRe: new RegExp(`^${id}-[a-z0-9]+(-[a-z0-9]+)*$`), nameHelp: `must start with "${id}-"` };
  }
}
export const RESERVED = new Set(['qwen-code', 'qwen-code-2', 'qwen-laptop', 'qoder', 'codex', 'claude', 'claude-clean', 'opencode']);

export function kindOf(t = 'qwen-code') {
  const type = Object.keys(KINDS).find((k) => k === t || KINDS[k].aliases?.includes(t));
  if (!type) throw new Error(`unknown type ${t} (known kinds: ${Object.keys(KINDS).concat('qwen').join(', ')})`);
  return { type, ...KINDS[type] };
}
/** The chain token a provider occupies in routes: "<base>/<model>" for CLI kinds, its own name otherwise. */
export const chainToken = (name, spec) => { const k = kindOf(spec.type); return k.own ? name : `${k.base}/${spec.model}`; };

/** Models the kind offers. Endpoint kinds: GET <url>/v1/models. CLI kinds: `paseo provider models <base> --json` (what the CLI itself lists). */
export async function discover(type, { url, key } = {}, { f = fetch, run = defaultRun } = {}) {
  const k = kindOf(type);
  if (k.modelsFrom === 'endpoint') {
    if (!/^https?:\/\/[^\s"]+$/.test(url || '')) throw new Error('url must be an http(s) base URL');
    let body;
    try { const r = await f(modelsUrl(url), { signal: AbortSignal.timeout(8000), headers: key ? { Authorization: `Bearer ${key}` } : {} }); if (!r.ok) throw new Error(`HTTP ${r.status}`); body = await r.json(); }
    catch (e) { throw new Error(`endpoint check failed: GET ${modelsUrl(url)} -> ${e.message}`); }
    return (Array.isArray(body?.data) ? body.data : []).map((m) => m?.id).filter(Boolean).map((id) => ({ id, label: id }));
  }
  const r = run('paseo', ['provider', 'models', k.base, '--json']);
  let l; try { l = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  if (!Array.isArray(l) || !l.length) throw new Error(`${k.base} CLI check failed: \`paseo provider models ${k.base}\` listed nothing (${k.label.split(' ')[0]} installed and signed in? daemon running?)`);
  return l.map((m) => ({ id: m.id, label: m.model || m.id }));
}
function defaultRun(cmd, args) { return spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000 }); }

/** True when `model` is one the kind lists (id or display name, case-insensitive) or a latest-alias the router resolves. */
export const modelListed = (model, models) => /^latest(-|$)/.test(model) || models.some((m) => [m.id, m.label].some((x) => String(x).toLowerCase() === String(model).replace(/@latest$/, '').toLowerCase() || x === model));

loadCustom();
export { KEY_ENV };
export const hubDirOf = (paseoCfgPath) => join(paseoCfgPath, '..', 'hub');
