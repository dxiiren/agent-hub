// Usage feed core (decisions 20 and 62): one record per finished turn, an append-only local file
// (global log plus one file per session for the fast statusline read) and an OTLP/JSON export.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

/** Usage dir: AGENT_HUB_USAGE_DIR, else <PASEO_HOME or ~/.paseo>/usage. */
export function usageDir(env = process.env) {
  return env.AGENT_HUB_USAGE_DIR ?? join(env.PASEO_HOME ?? join(os.homedir(), ".paseo"), "usage");
}

/**
 * Build the record from a get_agent_status snapshot.
 * Subagents roll up to the parent session: label `parent_session` wins over `session`.
 */
export function toRecord(snap, now = new Date()) {
  const labels = snap.labels ?? {};
  const u = snap.lastUsage ?? {};
  const session = labels.parent_session || labels.session || "";
  return {
    ts: now.toISOString(),
    agent: snap.id,
    session,
    alt: labels.claude_session && labels.claude_session !== session ? labels.claude_session : undefined, // the Claude Code session that made a tagged call (--session <tag>): its statusline reads this id
    sub: labels.parent_session && labels.session ? labels.session : undefined,
    provider: String(snap.provider ?? ""),
    model: String(snap.model ?? snap.runtimeInfo?.model ?? ""),
    dev: labels.dev ?? "",
    client: labels.caller ?? "",
    task: labels["route/type"] ?? "",
    in: Number(u.inputTokens ?? 0),
    out: Number(u.outputTokens ?? 0),
    cached: Number(u.cachedInputTokens ?? 0),
    cost_usd: Number(u.totalCostUsd ?? 0),
    credits: Number(u.credits ?? labels["usage/credits"] ?? 0),
  };
}

// A Windows device name (CON, NUL, COM1 ... with or without an extension) opens the device, not a file: prefix it.
export const safe = (s) => { const t = Array.from(s, (c) => (/^[A-Za-z0-9._-]$/.test(c) ? c : "_")).join("").slice(0, 80); /* per code point, same as the Python reader */ return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.].*)?$/i.test(t) ? "_" + t : t; };

const zero = () => ({ in: 0, out: 0, cached: 0, cost_usd: 0, credits: 0, n: 0 });

/** Fold one record into a session summary {providers, total}; same shape the python reader prints. */
export function sumInto(sum, r) {
  for (const d of [(sum.providers[r.provider] ??= zero()), sum.total]) {
    d.in += r.in; d.out += r.out; d.cached += r.cached; d.cost_usd += r.cost_usd; d.credits += r.credits; d.n += 1;
  }
  return sum;
}

/** Global append-only log, per-session log, and a per-session summary file so the statusline read is one tiny file. */
export function appendUsage(dir, rec) {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const line = JSON.stringify(rec) + "\n";
  appendFileSync(join(dir, "usage.jsonl"), line);
  for (const id of [rec.session, rec.alt]) { // the tag, and the Claude session id when they differ: each file is counted once, the global log above only once
    if (!id) continue;
    const base = join(dir, "sessions", safe(id));
    appendFileSync(base + ".jsonl", line);
    let sum;
    try { sum = JSON.parse(readFileSync(base + ".sum.json", "utf8")); } catch { sum = { session: id, providers: {}, total: zero() }; }
    writeFileSync(base + ".sum.json", JSON.stringify(sumInto(sum, rec)));
  }
}

/** OTLP/JSON metrics body: counts only, attributes provider, model, dev, client (never the session id: cardinality). */
export function otlpBody(rec) {
  const attrs = ["provider", "model", "dev", "client"].map((k) => ({ key: k, value: { stringValue: rec[k] ?? "" } }));
  const t = String(Date.now() * 1e6);
  const m = (name, v, kind = "asInt") => ({ name, sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ [kind]: String(v), timeUnixNano: t, attributes: attrs }] } });
  return { resourceMetrics: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "agent-hub" } }] }, scopeMetrics: [{ metrics: [
    m("agent_hub.tokens.input", rec.in), m("agent_hub.tokens.output", rec.out), m("agent_hub.tokens.cached", rec.cached),
    m("agent_hub.cost.usd", rec.cost_usd, "asDouble"), m("agent_hub.credits", rec.credits, "asDouble"),
  ] }] }] };
}

export async function emitOtlp(endpoint, rec, timeoutMs = 5_000) {
  if (!endpoint) return false;
  const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otlpBody(rec)), signal: AbortSignal.timeout(timeoutMs) });
  return r.ok;
}

/** Agent ids that already have a record in the global log. */
export function bookedAgents(dir) {
  const ids = new Set();
  try { for (const l of readFileSync(join(dir, "usage.jsonl"), "utf8").split(String.fromCharCode(10))) { if (!l) continue; try { ids.add(JSON.parse(l).agent); } catch { /* partial line */ } } } catch { /* no log yet */ }
  return ids;
}
const FINISHED = /^(idle|closed|completed|stopped)$/i;
/**
 * A usage plugin reload (disable/enable, Paseo update) drops the turn hook of an agent that finishes meanwhile, so its record is lost.
 * Re-book recent finished agents that have no record. Idempotent by agent id (an agent with any record is skipped, also on a second run).
 * list() -> [{id, status, updatedAt, provider}], book(agent) -> Promise<boolean> (true when it wrote a record).
 */
export async function backfillUsage({ list, book, dir, now = Date.now(), windowMs = 6 * 3600_000, max = 50 }) {
  const seen = bookedAgents(dir);
  const todo = (await list()).filter((a) => a?.id && FINISHED.test(String(a.status ?? "")) && now - Date.parse(a.updatedAt) <= windowMs && !seen.has(a.id)).slice(0, max);
  let n = 0;
  for (const a of todo) { try { if (await book(a)) n++; } catch { /* one bad agent never stops the rest */ } }
  return n;
}
