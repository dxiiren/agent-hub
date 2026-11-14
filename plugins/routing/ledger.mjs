// HUBFIX3: one append-only line per finished route + `reliability` report. Answers "is this provider reliable" from outcomes, not from usage.
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

export const ledgerFile = (home = process.env.PASEO_HOME || join(os.homedir(), ".paseo")) => join(home, "usage", "route-ledger.jsonl");
export const CLASSES = ["pass", "gate-fail", "timeout", "create-fail", "refused", "ungrounded", "daemon-down", "error"];

/** Outcome class of a finished route result (res = the JSON the route prints). Every non-pass is a visible class, never "pass". */
export function classifyResult(res) {
  const text = [res?.error, ...(res?.trace ?? []).map((t) => t.error ?? t.skip ?? "")].filter(Boolean).join(" | ");
  if (res?.used && res.status === "completed") return "pass";
  if (res?.status === "gate-failed") return "gate-fail";
  if (/DAEMON_NOT_RUNNING|daemon is down/i.test(text)) return "daemon-down";
  if (res?.status === "failed-readonly-changed" || /ungrounded|not grounded|invented|reply rejected/i.test(text)) return "ungrounded";
  if (/CREATE_TIMEOUT|could not start|exited before initialization|AGENT_CREATE_FAILED/i.test(text)) return "create-fail";
  if (/timed? ?out|no answer in|stopped after|deadline/i.test(text)) return "timeout";
  if (res?.status === "rejected" || res?.status === "permission" || /refus|rejected|slots full|no provider|WORKSPACE_CAP|usage limit|at its limit/i.test(text)) return "refused";
  return "error";
}

export function ledgerLine(res, { type, session, startedMs, nowMs = Date.now() }) {
  const used = res?.used ?? null;
  return { ts: new Date(nowMs).toISOString(), session: session ?? null, type: type ?? null, provider: used, rc: res?.status === "completed" && used ? 0 : 1, outcome: classifyResult(res), secs: Math.round((nowMs - startedMs) / 1000), tries: (res?.trace ?? []).filter((t) => t.provider).length || null, credits: res?.credits ?? null, tokens: res?.tokens ?? null, firstProvider: (res?.trace ?? []).find((t) => t.provider)?.provider ?? null };
}

export function appendLedger(line, file = ledgerFile()) { try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(line) + "\n"); return true; } catch { return false; } }

export function readLedger(file = ledgerFile()) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export const parseSince = (s, now = Date.now()) => { const m = /^(\d+)\s*([mhd])$/.exec(String(s ?? "")); return m ? now - Number(m[1]) * { m: 6e4, h: 36e5, d: 864e5 }[m[2]] : 0; };
const pct = (xs, p) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)]; };

/** rows -> per provider {runs, judged, pass, passPct, medianS, p90S, fails:{class:n}, unknown}. Rows with outcome "unknown" (backfilled from usage only) count as runs, not in pass %. */
export function reliability(rows, { sinceMs = 0, provider } = {}) {
  const by = new Map();
  for (const r of rows) {
    if (sinceMs && Date.parse(r.ts) < sinceMs) continue;
    const p = r.provider ?? r.firstProvider ?? "(none)"; if (provider && !p.includes(provider)) continue;
    const e = by.get(p) ?? { provider: p, runs: 0, pass: 0, judged: 0, secs: [], fails: {}, unknown: 0 };
    e.runs++;
    if (r.outcome === "unknown") e.unknown++; else { e.judged++; if (r.outcome === "pass") { e.pass++; if (Number.isFinite(r.secs)) e.secs.push(r.secs); } else e.fails[r.outcome] = (e.fails[r.outcome] ?? 0) + 1; }
    by.set(p, e);
  }
  return [...by.values()].map((e) => ({ provider: e.provider, runs: e.runs, judged: e.judged, pass: e.pass, passPct: e.judged ? Math.round((1000 * e.pass) / e.judged) / 10 : null, medianS: pct(e.secs, 0.5), p90S: pct(e.secs, 0.9), fails: e.fails, unknown: e.unknown })).sort((a, b) => b.runs - a.runs);
}

export function formatReliability(rs) {
  const out = ["provider                         runs judged pass%  med_s  p90_s  failures (by class)"];
  for (const r of rs) out.push(`${r.provider.padEnd(32)} ${String(r.runs).padStart(4)} ${String(r.judged).padStart(6)} ${String(r.passPct ?? "-").padStart(5)} ${String(r.medianS ?? "-").padStart(6)} ${String(r.p90S ?? "-").padStart(6)}  ${Object.entries(r.fails).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}${r.unknown ? `  (+${r.unknown} runs with no recorded outcome)` : ""}`);
  return out.join("\n");
}

/** Backfill from usage.jsonl: one row per agent, outcome "unknown" (usage records tokens and credits, not pass/fail). Idempotent by agent id. */
export function backfillFromUsage(usageFile, file = ledgerFile()) {
  if (!existsSync(usageFile)) return { added: 0, seen: 0 };
  const have = new Set(readLedger(file).map((r) => r.agent).filter(Boolean)); let added = 0, seen = 0;
  for (const l of readFileSync(usageFile, "utf8").split("\n").filter(Boolean)) {
    let u; try { u = JSON.parse(l); } catch { continue; } seen++;
    if (!u.agent || have.has(u.agent)) continue; have.add(u.agent);
    appendLedger({ ts: u.ts, session: u.session ?? null, type: u.task ?? null, provider: [u.provider, u.model].filter(Boolean).join("/") || null, rc: null, outcome: "unknown", secs: null, credits: u.credits ?? null, tokens: (u.in ?? 0) + (u.out ?? 0) || null, agent: u.agent, backfill: true }, file); added++;
  }
  return { added, seen };
}
