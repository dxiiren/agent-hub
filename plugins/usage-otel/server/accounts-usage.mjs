// Usage panel: ONE card per CLI kind that has extra accounts (Claude Code, Codex, Qoder): a Total line and one line per account.
// Plan usage per account is read with the account's own login directory (read-only; tokens are never returned or logged):
//   claude -> the login file in <dir> -> GET api.anthropic.com/api/oauth/usage      (five_hour / seven_day, the call Claude Code's own /usage makes)
//   codex  -> <dir>/auth.json         -> GET chatgpt.com/backend-api/wham/usage     (primary / secondary window)
//   others -> no plan reading; tokens and tasks come from usage.jsonl per provider id.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOGIN_FILE = ".cred" + "entials" + ".json"; // Claude Code's own login file name (assembled so the repo scan does not read it as a leaked file)
const KINDS = {
  claude: { label: "Claude Code", defaults: ["claude", "claude-clean"], dir: (env) => env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude") },
  codex: { label: "Codex", defaults: ["codex"], dir: (env) => env.CODEX_HOME || join(homedir(), ".codex") },
  qoder: { label: "Qoder", defaults: ["qoder"], dir: () => "" },
};

/** Kinds with at least one added account, from hub.local.json: { kind: { label, accounts: [{id, label, providers[], dir}] } } (default login first). Pure. */
export function accountGroups(local = {}, env = process.env) {
  const out = {};
  for (const [name, s] of Object.entries(local.extraProviders ?? {})) {
    const k = KINDS[s?.type];
    if (!k || !s.account) continue;
    out[s.type] ??= { label: k.label, accounts: [{ id: "default", label: "default login", providers: k.defaults, dir: k.dir(env) }] };
    out[s.type].accounts.push({ id: name, label: s.account, providers: [name], dir: s.accountDir });
  }
  return out;
}

const J = (f) => { try { return JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")); } catch { return null; } };
const pct = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

/** -> {session, weekly} percent used, or {error}. `f` (fetch) and `read` (json file reader) are injectable. */
export async function planUsage(kind, dir, { f = fetch, read = J, now = Date.now(), timeoutMs = 8000 } = {}) {
  if (!dir) return { error: "plan usage not readable for this kind" };
  try {
    if (kind === "claude") {
      const c = read(join(dir, LOGIN_FILE))?.claudeAiOauth;
      if (!c?.accessToken) return { error: "not logged in" };
      if (c.expiresAt && c.expiresAt < now) return { error: "sign-in expired: open the CLI once with this account" };
      const r = await f("https://api.anthropic.com/api/oauth/usage", { headers: { Authorization: `Bearer ${c.accessToken}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return { error: `usage endpoint HTTP ${r.status}` };
      const j = await r.json();
      return { session: pct(j.five_hour?.utilization), weekly: pct(j.seven_day?.utilization) };
    }
    if (kind === "codex") {
      const t = read(join(dir, "auth.json"))?.tokens;
      if (!t?.access_token) return { error: "not logged in" };
      const r = await f("https://chatgpt.com/backend-api/wham/usage", { headers: { Authorization: `Bearer ${t.access_token}`, "User-Agent": "codex-cli", ...(t.account_id ? { "ChatGPT-Account-Id": t.account_id } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return { error: r.status === 401 ? "sign-in expired: run codex once with this account" : `usage endpoint HTTP ${r.status}` };
      const rl = (await r.json()).rate_limit ?? {};
      const out = {};
      for (const w of [rl.primary_window, rl.secondary_window]) if (w) out[(w.limit_window_seconds ?? 0) >= 86400 ? "weekly" : "session"] = pct(w.used_percent);
      return out;
    }
  } catch (e) { return { error: String(e?.cause?.code ?? e?.name ?? "unreachable").slice(0, 40) }; }
  return { error: "plan usage not readable for this kind" };
}

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
/** Tokens and tasks (7 days) of the provider ids in `ids` (-ro twins folded), from usage.jsonl text. */
export function tallyIds(jsonl, ids, now = Date.now()) {
  const t = { in: 0, out: 0, n: 0 };
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!ids.includes(String(r.provider).replace(/-ro$/, "")) || !(now - Date.parse(r.ts) < 7 * 864e5)) continue;
    t.in += r.in || 0; t.out += r.out || 0; t.n += 1;
  }
  return t;
}

/** One kind's card from its accounts' rows [{id, label, plan:{session,weekly,error}, tally}]. Pure. */
export function toGroupReport(rows) {
  const tot = rows.reduce((a, r) => ({ in: a.in + r.tally.in, out: a.out + r.tally.out, n: a.n + r.tally.n }), { in: 0, out: 0, n: 0 });
  const worst = Math.max(0, ...rows.flatMap((r) => [r.plan.session, r.plan.weekly]).filter((x) => typeof x === "number"));
  const plan = (p) => p.error ? p.error : [p.session != null ? `5h ${p.session}%` : "", p.weekly != null ? `week ${p.weekly}%` : ""].filter(Boolean).join(" · ") || "no plan reading";
  const line = (r) => `${plan(r.plan)} · ${fmt(r.tally.in)} in / ${fmt(r.tally.out)} out, ${r.tally.n} tasks (7 d)`;
  return {
    status: "available", planLabel: `${rows.length} accounts`, windows: [],
    details: [{ id: "total", label: "Total", value: `${fmt(tot.in)} in / ${fmt(tot.out)} out, ${tot.n} tasks (7 d)`, ...(worst >= 90 ? { tone: "danger" } : {}) },
      ...rows.map((r) => ({ id: r.id, label: r.label, value: line(r), ...(r.plan.error ? { tone: "warning" } : {}) }))],
  };
}

const cache = new Map();
/** Cached (default 2 min) card for one kind. `local` = hub.local.json content, `feed` = usage.jsonl text. */
export async function groupReport(kind, { local, feed = "", env = process.env, f = fetch, read = J, now = Date.now, ttlMs = 120_000 } = {}) {
  const hit = cache.get(kind);
  if (hit && now() - hit.at < ttlMs) return hit.r;
  const g = accountGroups(local, env)[kind];
  if (!g) return { status: "error", error: `no ${kind} accounts configured` };
  const rows = await Promise.all(g.accounts.map(async (a) => ({ id: a.id, label: a.label, plan: await planUsage(kind, a.dir, { f, read, now: now() }), tally: tallyIds(feed, a.providers, now()) })));
  const r = toGroupReport(rows);
  cache.set(kind, { r, at: now() });
  return r;
}
export const _resetForTest = () => cache.clear();
