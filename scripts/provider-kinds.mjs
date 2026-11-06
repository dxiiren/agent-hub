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

/** How a kind separates ACCOUNTS (one schema entry per kind, read by the CLI, the Settings form and the Usage panel):
 *  by 'config-dir' = the CLI keeps its login in a directory; env (variable) or arg (flag) points it at one directory per account.
 *  by 'endpoint'   = no login: another account is another provider entry with its own Base URL and/or API key.
 *  none            = the kind cannot separate accounts (the text says why; the UI shows it).
 *  usage = where the Usage panel reads plan usage per account ('claude-oauth', 'codex-wham'), else tokens and tasks from usage.jsonl only. */
const ACCOUNT_ENDPOINT = { by: 'endpoint', usage: 'feed', help: 'Another account is another entry with its own Base URL and/or API key.' };

/** type -> definition. `base` = an installed CLI provider reached as <base>/<model> in route chains (no new Paseo provider is created). */
export const KINDS = {
  'qwen-code': { aliases: ['qwen'], label: 'Qwen Code (OpenAI-compatible endpoint)', fields: ENDPOINT_FIELDS, modelsFrom: 'endpoint', own: true, twin: true, slots: true, account: ACCOUNT_ENDPOINT,
    nameRe: /^qwen-[a-z0-9]+(-[a-z0-9]+)*$/, nameHelp: 'must start with "qwen-" (e.g. qwen-lab)' },
  // opencode has no key field: it runs without a hub launcher, so its agent could read a stored key
  opencode: { label: 'OpenCode (OpenAI-compatible endpoint)', fields: ENDPOINT_FIELDS.filter((f) => f.id !== 'key'), modelsFrom: 'endpoint', own: true, twin: false, slots: true, account: ACCOUNT_ENDPOINT,
    nameRe: /^opencode-[a-z0-9]+(-[a-z0-9]+)*$/, nameHelp: 'must start with "opencode-" (e.g. opencode-lab)' },
  qoder: { label: 'Qoder (model tier)', base: 'qoder', fields: [{ id: 'model', label: 'Tier / model', type: 'model', required: true, help: 'From `paseo provider models qoder`' }], modelsFrom: 'cli', own: false, twin: false, slots: false, account: { by: 'config-dir', arg: '--config-dir', login: 'qodercli --config-dir {dir} login', usage: 'feed', help: 'Own --config-dir per account (the hub already runs Qoder with a private one).' },
    nameRe: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, nameHelp: 'lower-case letters, digits, dashes' },
  codex: { label: 'Codex (model)', base: 'codex', fields: [{ id: 'model', label: 'Model', type: 'model', required: true, help: 'From `paseo provider models codex`' }], modelsFrom: 'cli', own: false, twin: false, slots: false, account: { by: 'config-dir', env: 'CODEX_HOME', login: 'codex login', usage: 'codex-wham', help: 'CODEX_HOME per account.' },
    nameRe: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, nameHelp: 'lower-case letters, digits, dashes' },
  claude: { label: 'Claude (model)', base: 'claude', fields: [{ id: 'model', label: 'Model', type: 'model', required: true, help: 'From `paseo provider models claude`' }], modelsFrom: 'cli', own: false, twin: false, slots: false, account: { by: 'config-dir', env: 'CLAUDE_CONFIG_DIR', login: 'claude auth login', usage: 'claude-oauth', help: 'CLAUDE_CONFIG_DIR per account.' },
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
      account: c.account || (own ? ACCOUNT_ENDPOINT : { none: 'a base-provider kind has no account separation unless its JSON declares "account"' }),
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
export const chainToken = (name, spec) => { const k = kindOf(spec.type); return spec.account ? `${name}/${spec.model}` : k.own ? name : `${k.base}/${spec.model}`; };

/** Models the kind offers. Endpoint kinds: GET <url>/v1/models. CLI kinds: `paseo provider models <base> --json` (what the CLI itself lists). */
export async function discover(type, { url, key, provider } = {}, { f = fetch, run = defaultRun } = {}) {
  const k = kindOf(type);
  if (k.modelsFrom === 'endpoint') {
    if (!/^https?:\/\/[^\s"]+$/.test(url || '')) throw new Error('url must be an http(s) base URL');
    let body;
    try { const r = await f(modelsUrl(url), { signal: AbortSignal.timeout(8000), headers: key ? { Authorization: `Bearer ${key}` } : {} }); if (!r.ok) throw new Error(`HTTP ${r.status}`); body = await r.json(); }
    catch (e) { throw new Error(`endpoint check failed: GET ${modelsUrl(url)} -> ${e.message}`); }
    return (Array.isArray(body?.data) ? body.data : []).map((m) => m?.id).filter(Boolean).map((id) => ({ id, label: id }));
  }
  // an added account lists ITS provider's models (its own login); before the daemon knows it, the base provider's list stands in
  let l;
  for (const prov of [...new Set([provider, k.base].filter((x) => x && /^[a-z][a-z0-9-]*$/.test(x)))]) {
    try { l = JSON.parse(run('paseo', ['provider', 'models', prov, '--json']).stdout); } catch { l = undefined; }
    if (Array.isArray(l) && l.length) break;
  }
  if (!Array.isArray(l) || !l.length) throw new Error(`${k.base} model list failed: \`paseo provider models ${k.base}\` listed nothing. Fix: install ${k.label.split(' ')[0]}, sign in (for an extra account run its login command once), and make sure the daemon is running (\`just up\`).`);
  return l.map((m) => ({ id: m.id, label: m.model || m.id, ...(m.description ? { hint: m.description } : {}) }));
}
function defaultRun(cmd, args) { return spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000 }); }

/** True when `model` is one the kind lists (id or display name, case-insensitive) or a latest-alias the router resolves. */
export const modelListed = (model, models) => /^latest(-|$)/.test(model) || models.some((m) => [m.id, m.label].some((x) => String(x).toLowerCase() === String(model).replace(/@latest$/, '').toLowerCase() || x === model));

loadCustom();
/** Host part of an endpoint URL for display: "local" for loopback, "" when the URL does not parse. */
export const hostOf = (url) => { try { const h = new URL(url).hostname; return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(h) ? 'local' : h; } catch { return ''; } };
/** Default display name of a provider: "<Kind> <host>" (e.g. "Qwen Code 10.0.0.5"); the user can override it with --label / the Display name field. */
export const displayName = (short, url) => `${short} ${hostOf(url)}`.trim();
export { KEY_ENV };
/** True when `add --account` applies: the kind logs in through a config dir. */
export const hasAccounts = (k) => k.account?.by === 'config-dir';
/** The one-line login command for an account directory: runs the CLI once against that dir (the user types the credentials; the hub never sees them). */
export function loginCommand(k, dir, win = process.platform === 'win32') {
  const a = k.account; if (!hasAccounts(k)) return '';
  if (a.arg) return a.login.replace('{dir}', dir);
  return win ? `$env:${a.env}='${dir}'; ${a.login}` : `${a.env}='${dir}' ${a.login}`;
}
export const hubDirOf = (paseoCfgPath) => join(paseoCfgPath, '..', 'hub');
