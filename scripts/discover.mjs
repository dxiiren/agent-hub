// Auto-discover moved office model servers (owner 13-11-2026: "can we make like auto discover").
//   node scripts/discover.mjs [--dry]      also run by the reaper sweep (every 10 min), so after each daemon start too.
// Per host in hub.local.json "discoverHosts" (default: the office boxes): read http://host:9091/api/stats engines[], CONFIRM each port with GET /v1/models
// (the served id comes from there, never from the dashboard), fall back to a port scan when engines is null or the monitor is down. A qwen-code provider
// whose url host matches is repointed with `provider edit` (same writer as the CLI: hub.local.json, Paseo config, backups). A provider Paseo has enabled:false is never touched.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeId } from '../plugins/routing/office.mjs';
import { readJsonStrict } from '../plugins/routing/jsonfile.mjs';

export const DEFAULT_HOSTS = ['192.168.1.122', '192.168.1.110', '192.168.2.12'];
export const SCAN_PORTS = [8000, 8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010, 8888, 11434, 30000];
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
export async function discoverHost(host, { f = fetch, scan = SCAN_PORTS } = {}) {
  let stats = null;
  try { const r = await f(`http://${host}:9091/api/stats`, { signal: AbortSignal.timeout(4000) }); if (r.ok) stats = await r.json(); } catch { /* monitor down: scan */ }
  const confirm = async (ports) => (await Promise.all(ports.map(async (port) => { const ids = await probe(host, port, f); return ids ? { host, port, ids, chat: ids.filter(isChat) } : null; }))).filter((x) => x && x.chat.length);
  const fromMonitor = parseEngines(stats);
  const found = fromMonitor ? await confirm(fromMonitor) : [];
  return found.length ? found : confirm(scan);
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

/** Walk every enabled qwen-code provider on a discovery host and repoint it. `edit` is injectable (default: provider.mjs edit). Returns [{name, from, to}] (applied unless dry). */
export async function discoverAll({ p, hosts, f = fetch, edit, dry = false, log = () => {} }) {
  const local = readJsonStrict(p.local, {}); const paseo = readJsonStrict(p.paseo, {});
  const want = hosts ?? local.discoverHosts ?? DEFAULT_HOSTS;
  const specs = Object.entries(local.extraProviders ?? {}).filter(([, s]) => s.type === 'qwen-code' && s.url && want.includes(parts(s.url)?.host));
  const cache = new Map(); const changes = [];
  for (const [name, spec] of specs) {
    if (paseo.agents?.providers?.[name]?.enabled === false) { log(`${name}: switched off, left alone`); continue; }
    const h = parts(spec.url).host; if (!cache.has(h)) cache.set(h, await discoverHost(h, { f }));
    const found = cache.get(h);
    if (!found.length) { log(`${name}: ${h} answered nothing, config unchanged`); continue; }
    const to = plan(spec, found); if (!to) continue;
    const from = { url: spec.url, model: spec.model };
    log(`${name}: ${from.url} ${from.model} -> ${to.url} ${to.model}${dry ? ' (dry run)' : ''}`);
    if (!dry) await edit(name, to, p, { f, which: () => process.env.QWEN_BIN || paseo.agents?.providers?.[name]?.command?.[2] || 'qwen' });
    changes.push({ name, from, to });
  }
  return changes;
}

const logFile = () => process.env.AGENT_HUB_DISCOVER_LOG || join(homedir(), '.agent-hub', 'discovery.log');
export const fileLog = (m) => { try { mkdirSync(dirname(logFile()), { recursive: true }); appendFileSync(logFile(), `${new Date().toISOString()} ${m}\n`); } catch { /* log is best effort */ } };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { paths, edit } = await import('./provider.mjs');
  const dry = process.argv.includes('--dry');
  const ch = await discoverAll({ p: paths(), edit, dry, log: (m) => { console.log(m); fileLog(m); } });
  console.log(JSON.stringify({ changed: ch.length, changes: ch, dry, needsRestart: ch.length > 0 && !dry }));
}
