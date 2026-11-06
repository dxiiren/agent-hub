// Qoder row for the Paseo web UI Usage panel (plugin usage source). Data = the account quota qoder_poll.py already reads (no new meter).
import { execFileTree } from "./exec-tree.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tone = (pct) => (typeof pct !== "number" ? "default" : pct > 90 ? "danger" : pct >= 70 ? "warning" : "ok"); // same thresholds as the Paseo SDK toneFromUsedPct

/** Poller summary -> Paseo UsageReport. Pure. Quota = used / (used + remaining) credits, so it works when the plan reports no percentage. */
export function toReport(s) {
  const used = s?.credits_used, left = s?.credits_remaining;
  if (typeof used !== "number" || typeof left !== "number") return { status: "error", error: "Qoder quota not readable (qoder_poll.py returned no credits)" };
  const limit = used + left, pct = limit > 0 ? Math.round((used / limit) * 1000) / 10 : null, t = s.isQuotaExceeded ? "danger" : tone(pct);
  return {
    status: "available",
    planLabel: s.userType ? String(s.userType) : undefined,
    windows: [{ id: "quota", label: "Monthly quota", shortLabel: "quota", summary: true, usedPct: pct, remainingPct: pct == null ? null : Math.max(0, 100 - pct), resetsAt: s.reset_time ?? null, tone: t }],
    balances: [{ id: "credits", label: "Credits", used, remaining: left, limit, unit: "credits", resetsAt: s.reset_time ?? null, tone: t }],
    ...(typeof s.credits_used_today === "number" ? { details: [{ id: "today", label: "Used today", value: `${s.credits_used_today} credits` }] } : {}),
  };
}

/** Run qoder_poll.py (about 3 s) and return its JSON summary; rejects on failure. Slow on a loaded laptop (3 s idle, 30 s+ busy), so use qoderSummary() for the panel. */
export function pollQoder(env = process.env) {
  const dir = env.AGENT_HUB_POLLER_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "pollers");
  return new Promise((res, rej) => execFileTree(env.AGENT_HUB_PYTHON ?? "python", [join(dir, "qoder_poll.py")], { env, timeout: 90_000 }, (e, out) => {
    try { res(JSON.parse(out)); } catch { rej(e ?? new Error("qoder_poll.py printed no JSON")); }
  }));
}

// Last good summary on disk, so a daemon restart shows the previous numbers while the slow first poll runs (instead of an error).
const cacheFile = (env = process.env) => join(env.PASEO_HOME || join(homedir(), ".paseo"), "usage", "qoder-last.json");
const diskStore = {
  read: () => { try { return JSON.parse(readFileSync(cacheFile(), "utf8")); } catch { return null; } },
  write: (v) => { try { mkdirSync(dirname(cacheFile()), { recursive: true }); writeFileSync(cacheFile(), JSON.stringify(v)); } catch { /* cache only */ } },
};

let last = null, inflight = null; // last good summary + the one running poll (a slow poll finishes in the background and feeds the next fetch)

/** Panel read: fresh cache, else wait up to waitMs (Paseo drops a fetch after 20 s) for the poll, else the stale summary, else throw. */
export async function qoderSummary({ ttlMs = 300_000, waitMs = 15_000, poll = pollQoder, now = Date.now, store = diskStore } = {}) {
  last ??= store.read();
  if (last && now() - last.at < ttlMs) return last.s;
  inflight ??= poll().then((s) => { last = { s, at: now() }; store.write(last); return s; }).finally(() => { inflight = null; });
  inflight.catch(() => {}); // a failed background poll is reported by the waiting call below, never as an unhandled rejection
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error("Qoder poll still running")), waitMs).unref());
  try { return await Promise.race([inflight, timer]); } catch (e) { if (last) return last.s; throw e; }
}
export const _resetForTest = () => { last = null; inflight = null; };
