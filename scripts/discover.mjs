// Auto-discover moved office model servers (owner 13-11-2026: "can we make like auto discover").
//   node scripts/discover.mjs [--dry]      also run by the reaper sweep (every 10 min), so after each daemon start too.
// Per host in hub.local.json "discoverHosts" (no default: set it in hub.local.json): read http://host:9091/api/stats engines[], CONFIRM each port with GET /v1/models
// (the served id comes from there, never from the dashboard), fall back to a port scan when engines is null or the monitor is down. A qwen-code provider
// whose url host matches is repointed with `provider edit` (same writer as the CLI: hub.local.json, Paseo config, backups). A provider Paseo has enabled:false is never touched.
// Hardening (security review 13-11): the :9091 data is unauthenticated, so (1) only ports in the per-host allowlist (hub.local.json "discoverPorts", numbers or "8000-8010") count,
// (2) the host never changes, (3) a provider with a key or auth header is only PROPOSED in the log, (4) a repoint needs 3 consecutive failed ticks of the current endpoint (counter persisted),
// (5) the new endpoint must list a same-family chat model AND answer a tiny chat completion, (6) every repoint is logged (discovery.log + one line in the incident log) with the backup kept by `provider edit`.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeId } from '../plugins/routing/office.mjs';
import { readJsonStrict } from '../plugins/routing/jsonfile.mjs';

export const DEFAULT_HOSTS = []; // hosts and allowed ports live in the git-ignored config/hub.local.json (discoverHosts, discoverPorts), never in this public repo
export const DEFAULT_PORTS = {};
export const FAIL_TICKS = 3;
/** Expand an allowlist ([8000, '8000-8010']) to unique valid port numbers. */
export const expandPorts = (list = []) => [...new Set(list.flatMap((x) => { const m = /^(\d+)-(\d+)$/.exec(String(x)); const r = m ? Array.from({ length: Math.max(0, Math.min(+m[2], 65535) - +m[1] + 1) }, (_, i) => +m[1] + i) : [Number(x)]; return r; }).filter((n) => Number.isInteger(n) && n > 0 && n < 65536))];
export const isChat = (id) => /qwen/i.test(id) && !/embed|guard|rerank|nemo|bge/i.test(id);

/** Ports of the online engines in a monitor /api/stats body, or null when there is no usable engines[] (null, missing, empty). */
export function parseEngines(stats) {
  const e = stats?.engines;
  if (!Array.isArray(e) || !e.length) return null;
  const ports = e.filter((x) => !/offline|down|error|fail/i.test(String(x?.status ?? ''))).map((x) => Number(x?.port)).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return ports.length ? ports : null;
}

/** Served model ids of http://host:port/v1/models, or null when it does not answer like an OpenAI endpoint. */
export async function probe(host, port, f = fetch) {
  try {
    const r = await f(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const ids = ((await r.json())?.data ?? []).map((m) => safeId(m?.id)).filter(Boolean);
    return ids.length ? ids : null;
  } catch { return null; }
}

/** [{host, port, ids, chat}] for every confirmed endpoint of one host that serves a chat model. Monitor first, port scan as the fallback. */
export async function discoverHost(host, { f = fetch, allow = [] } = {}) {
  const ok = new Set(expandPorts(allow)); if (!ok.size) return [];
  let stats = null;
  try { const r = await f(`http://${host}:9091/api/stats`, { signal: AbortSignal.timeout(4000) }); if (r.ok) stats = await r.json(); } catch { /* monitor down: scan */ }
  const confirm = async (ports) => (await Promise.all(ports.map(async (port) => { const ids = await probe(host, port, f); return ids ? { host, port, ids, chat: ids.filter(isChat) } : null; }))).filter((x) => x && x.chat.length);
  const fromMonitor = parseEngines(stats)?.filter((n) => ok.has(n)); // a port outside the allowlist is ignored
  const found = fromMonitor?.length ? await confirm(fromMonitor) : [];
  return found.length ? found : confirm([...ok]);
}

const parts = (url) => { try { const u = new URL(url); return { host: u.hostname, port: Number(u.port || 80), u }; } catch { return null; } };
/** Pure: the change for one provider spec ({url, model}) given discovered endpoints, or null for "leave it". Keeps the current endpoint when it still serves a chat model. */
export function plan(spec, found) {
  const c = parts(spec.url); if (!c) return null;
  const cands = found.filter((x) => x.host === c.host); if (!cands.length) return null;
  const pick = cands.find((x) => x.port === c.port) ?? cands[0];
  const model = pick.chat.includes(spec.model) ? spec.model : pick.chat[0];
  const u = new URL(c.u); u.port = String(pick.port);
  const url = u.toString().replace(/\/+$/, '');
  return url === spec.url.replace(/\/+$/, '') && model === spec.model ? null : { url, model };
}

const keyed = (spec, entry) => !!(spec.key || spec.apiKey || spec.headers || spec.authHeader || entry?.env?.OPENAI_API_KEY || entry?.headers);

/** Tiny real chat completion on the candidate: the endpoint must actually answer, not just list a model. */
export async function chatOk(host, port, model, f = fetch) {
  try {
    const r = await f(`http://${host}:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'say ok' }], max_tokens: 8 }), signal: AbortSignal.timeout(30_000) });
    return r.ok && Array.isArray((await r.json())?.choices);
  } catch { return false; }
}

/**
 * Walk every enabled qwen-code provider on a discovery host. Per provider: healthy (current endpoint lists its model) resets its failure counter; otherwise the counter
 * (persisted in `stateFile`) rises and only the FAIL_TICKS-th consecutive failure may repoint, to a candidate on the same host, inside the port allowlist, whose chat
 * completion works. Keyed providers get a PROPOSAL log line, never an edit. `edit` is injectable (default: provider.mjs edit). Returns [{name, from, to}].
 */
export async function discoverAll({ p, hosts, f = fetch, edit, dry = false, log = () => {}, stateFile = null, note = () => {} }) {
  const local = readJsonStrict(p.local, {}); const paseo = readJsonStrict(p.paseo, {});
  const want = hosts ?? local.discoverHosts ?? DEFAULT_HOSTS; const allowCfg = { ...DEFAULT_PORTS, ...(local.discoverPorts ?? {}) };
  let state = {}; try { if (stateFile) state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  const save = () => { try { if (stateFile && !dry) { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify(state)); } } catch { /* best effort */ } };
  const specs = Object.entries(local.extraProviders ?? {}).filter(([, s]) => s.type === 'qwen-code' && s.url && want.includes(parts(s.url)?.host));
  const cache = new Map(); const changes = [];
  for (const [name, spec] of specs) {
    const entry = paseo.agents?.providers?.[name];
    if (entry?.enabled === false) { log(`${name}: switched off, left alone`); continue; }
    const c = parts(spec.url); const h = c.host; const allow = allowCfg[h] ?? [];
    const ids = await probe(h, c.port, f);
    if (ids?.includes(spec.model)) { if (state[name]) { state[name] = 0; save(); } continue; } // healthy
    if (!keyed(spec, entry)) { state[name] = (state[name] ?? 0) + 1; save(); if (state[name] < FAIL_TICKS) { log(`${name}: ${spec.url} failing ${state[name]}/${FAIL_TICKS}, no change yet`); continue; } }
    if (!cache.has(h)) cache.set(h, await discoverHost(h, { f, allow }));
    const found = cache.get(h);
    if (!found.length) { log(`${name}: ${h} offers nothing inside the port allowlist, config unchanged`); continue; }
    const to = plan(spec, found); if (!to) continue;
    const from = { url: spec.url, model: spec.model };
    if (keyed(spec, entry)) { log(`PROPOSAL ${name} (keyed, not edited): ${from.url} ${from.model} -> ${to.url} ${to.model}`); continue; }
    if (!isChat(to.model) || !(await chatOk(h, parts(to.url).port, to.model, f))) { log(`${name}: candidate ${to.url} ${to.model} failed the chat check, refused`); continue; }
    log(`${name}: ${from.url} ${from.model} -> ${to.url} ${to.model}${dry ? ' (dry run)' : ''}`);
    if (!dry) { await edit(name, to, p, { f, which: () => process.env.QWEN_BIN || entry?.command?.[2] || 'qwen' }); state[name] = 0; save(); note(`${name} repointed ${from.url} ${from.model} -> ${to.url} ${to.model} (scripts/discover.mjs, backup by provider edit)`); }
    changes.push({ name, from, to });
  }
  return changes;
}

const logFile = () => process.env.AGENT_HUB_DISCOVER_LOG || join(homedir(), '.agent-hub', 'discovery.log');
export const fileLog = (m) => { try { mkdirSync(dirname(logFile()), { recursive: true }); appendFileSync(logFile(), `${new Date().toISOString()} ${m}\n`); } catch { /* log is best effort */ } };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { paths, edit } = await import('./provider.mjs');
  const dry = process.argv.includes('--dry'); const pp = paths();
  const incident = readJsonStrict(pp.local, {}).incidentLog;
  const note = (m) => { if (incident) try { appendFileSync(incident, `${new Date().toISOString().slice(0, 16).replace('T', ' ')} | discover | auto repoint | ${m} | -\n`); } catch { /* best effort */ } };
  const stateFile = process.env.AGENT_HUB_DISCOVER_STATE || join(homedir(), '.agent-hub', 'discovery-state.json');
  const ch = await discoverAll({ p: pp, edit, dry, stateFile, note, log: (m) => { console.log(m); fileLog(m); } });
  console.log(JSON.stringify({ changed: ch.length, changes: ch, dry, needsRestart: ch.length > 0 && !dry }));
}
