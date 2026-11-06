// Usage panel cards for self-hosted OpenAI-compatible providers (no plan quota): endpoint status, served model, tokens from our usage feed, optional running/queued from a Prometheus /metrics URL.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// import.meta.url is not set when Paseo bundles the plugin, so resolve the repo config lazily and tolerate its absence
const localConfigPath = (env) => { if (env.AGENT_HUB_LOCAL) return env.AGENT_HUB_LOCAL; try { return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "hub.local.json"); } catch { return ""; } };
const readJson = (f) => { try { if (!f) return {}; return JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")); } catch { return {}; } };
const nonRo = (s) => s.replace(/-ro$/, "");
export const paseoHome = (env = process.env) => env.PASEO_HOME ?? join(homedir(), ".paseo");

/** Providers with an HTTP endpoint, read from the Paseo config (never hard-coded): [{name, label, kind, base, key?, metricsUrl?}]. Read-only twins (-ro) are folded into their base. */
export function selfHostedProviders(cfg, local = {}) {
  const all = cfg?.agents?.providers ?? {};
  const out = [];
  for (const [name, p] of Object.entries(all)) {
    if (name.endsWith("-ro") && all[nonRo(name)]) continue;
    const cmd = Array.isArray(p?.command) ? p.command.map(String) : [];
    let base = cmd.find((a) => /^https?:\/\//i.test(a));
    if (!base && p?.env?.LAPTOP_PORT) base = `http://127.0.0.1:${p.env.LAPTOP_PORT}/v1`; // the hub's laptop llama.cpp launcher serves on a local port
    if (!base) continue;
    const label = String(p?.label || name);
    out.push({ name, label, kind: kindOfProvider(name, label, base, local), base, key: p.env?.HUB_OPENAI_API_KEY, metricsUrl: local.metricsUrls?.[name] });
  }
  return out;
}

const hostOfUrl = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];
/** Provider kind label: local config `kinds[name]` wins; else the display label minus its trailing "where it runs" word (the endpoint host, an IP/hostname, or any last word for a loopback endpoint). */
export function kindOfProvider(name, label, base, local = {}) {
  if (local.kinds?.[name]) return String(local.kinds[name]);
  const words = label.trim().split(/\s+/);
  const host = hostOfUrl(base), last = words[words.length - 1];
  const where = words.length > 1 && (last === host || /^\d{1,3}(\.\d{1,3}){3}$/.test(last) || /^[\w-]+(\.[\w-]+)+$/.test(last) || LOOPBACK.includes(host));
  return where ? words.slice(0, -1).join(" ") : label;
}
export const kindId = (kind) => kind.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "kind";

export const modelsUrl = (base) => base.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/models";

/** Sum tokens per provider (-ro twins folded) for today (UTC day) and the last 7 days, from usage.jsonl text. */
export function tally(jsonl, name, now = Date.now()) {
  const t = { today: { in: 0, out: 0, n: 0 }, week: { in: 0, out: 0, n: 0 } };
  const day = new Date(now).toISOString().slice(0, 10);
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (nonRo(String(r.provider)) !== name) continue;
    if (!(now - Date.parse(r.ts) < 7 * 864e5)) continue;
    for (const b of String(r.ts).slice(0, 10) === day ? [t.today, t.week] : [t.week]) { b.in += r.in || 0; b.out += r.out || 0; b.n += 1; }
  }
  return t;
}

/** Running/queued request counts from Prometheus text for the common servers (vLLM, SGLang, llama.cpp). null when none of those series exist. */
export function parseMetrics(text) {
  const num = (names) => { for (const n of names) { const m = new RegExp(`^${n}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, "m").exec(text); if (m) return Number(m[1]); } return null; };
  const running = num(["vllm:num_requests_running", "sglang:num_running_reqs", "llamacpp:requests_processing"]);
  const queued = num(["vllm:num_requests_waiting", "sglang:num_queue_reqs", "llamacpp:requests_deferred"]);
  return running == null && queued == null ? null : { running, queued };
}

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

const tone = (up, total) => (up === total ? "ok" : up === 0 ? "danger" : "warning");
const line = (t) => `${fmt(t.in)} in / ${fmt(t.out)} out, ${t.n} tasks`;
/** Endpoints of one kind -> ONE Paseo UsageReport: a status row, TOTAL rows, then one row per endpoint (Paseo's UsageDetail has no collapse/children, so they are plain rows).
 *  items = [{label, probe:{up, model?, error?, metrics?}, t:tally}]. Pure. No plan percentage is invented. */
export function groupReport(items) {
  const up = items.filter((i) => i.probe.up).length, n = items.length, sum = (k) => items.reduce((a, i) => ({ in: a.in + i.t[k].in, out: a.out + i.t[k].out, n: a.n + i.t[k].n }), { in: 0, out: 0, n: 0 });
  const details = [
    { id: "status", label: "Endpoints", value: `${up} of ${n} up`, tone: tone(up, n) },
    { id: "total-today", label: "Total today", value: line(sum("today")) },
    { id: "total-week", label: "Total last 7 days", value: line(sum("week")) },
    ...items.map((i, k) => ({
      id: `ep-${k}`, label: i.label,
      value: [i.probe.up ? "up" : `down${i.probe.error ? ` (${i.probe.error})` : ""}`, i.probe.up && i.probe.model, i.probe.metrics && `${i.probe.metrics.running ?? "?"} running, ${i.probe.metrics.queued ?? "?"} queued`, `today ${line(i.t.today)}`].filter(Boolean).join(" · "),
      tone: i.probe.up ? "ok" : "danger",
    })),
  ];
  return { status: "available", planLabel: `${n} endpoint${n === 1 ? "" : "s"}, ${up} up`, windows: [], details };
}

/** GET <base>/models (and the optional metrics URL) with a short timeout. Never throws; the key is sent as a Bearer token and never returned. */
export async function probe(pv, { f = fetch, timeoutMs = 4000 } = {}) {
  try {
    const r = await f(modelsUrl(pv.base), { headers: pv.key ? { Authorization: `Bearer ${pv.key}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { up: false, error: `HTTP ${r.status}` };
    const j = await r.json().catch(() => ({}));
    const out = { up: true, model: String(j?.data?.[0]?.id ?? "").slice(0, 120) };
    if (pv.metricsUrl) { try { const m = await f(pv.metricsUrl, { signal: AbortSignal.timeout(timeoutMs) }); if (m.ok) out.metrics = parseMetrics(await m.text()); } catch { /* metrics are optional */ } }
    return out;
  } catch (e) { return { up: false, error: String(e?.cause?.code ?? e?.name ?? "unreachable").slice(0, 40) }; }
}

const cache = new Map();
/** Cached (default 60 s) report for one provider KIND (kindId); config and usage feed are re-read on a miss. */
export async function selfHostedReport(id, { env = process.env, ttlMs = 60_000, now = Date.now, f = fetch, readFeed } = {}) {
  const hit = cache.get(id);
  if (hit && now() - hit.at < ttlMs) return hit.r;
  const home = paseoHome(env);
  const local = readJson(localConfigPath(env));
  const members = selfHostedProviders(readJson(join(home, "config.json")), local).filter((x) => kindId(x.kind) === id);
  if (!members.length) return { status: "error", error: `provider kind ${id} not configured` };
  const feed = (readFeed ?? (() => { try { return readFileSync(join(env.AGENT_HUB_USAGE_DIR ?? join(home, "usage"), "usage.jsonl"), "utf8"); } catch { return ""; } }))();
  const items = await Promise.all(members.map(async (pv) => ({ label: pv.label, probe: await probe(pv, { f }), t: tally(feed, pv.name, now()) })));
  const r = groupReport(items);
  cache.set(id, { r, at: now() });
  return r;
}
export const _resetForTest = () => cache.clear();
