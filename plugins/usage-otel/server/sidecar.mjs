// Side-channel usage for providers Paseo reports as 0 tokens (decision 62): Qwen Code writes per-request token counts into its own
// chat file (per session, so exact per task, no shared server counter); Qoder exposes only account credits (poller before/after a turn).
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileTree } from "./exec-tree.mjs";
import { fileURLToPath } from "node:url";
import os from "node:os";

/** Qwen's own session id for the one Paseo knows (the read-only restart changes it); the proxy records it in the hub run dir.
 *  Self-contained on purpose: Paseo bundles this plugin alone, it cannot import from plugins/routing. Same folder rule as plugins/routing/runstate.mjs (a test pins them together). */
export function innerSession(outer, env = process.env) {
  try {
    const dir = env.AGENT_HUB_RUN_DIR || join(env.PASEO_HOME || env.AGENT_HUB_HOME || join(os.homedir(), ".paseo"), "run");
    return JSON.parse(readFileSync(join(dir, `qwen-session-${String(outer).replace(/[^A-Za-z0-9-]/g, "_")}.json`), "utf8")).inner ?? null;
  } catch { return null; }
}

/** Sum usageMetadata of one Qwen Code session file: {in (uncached), out (incl. thoughts), cached}. */
export function qwenSession(sessionId, home = join(os.homedir(), ".qwen")) {
  const root = join(home, "projects");
  if (!sessionId || !existsSync(root)) return null;
  sessionId = innerSession(sessionId) ?? sessionId; // the read-only restart gives qwen a new session id; the proxy recorded it
  for (const p of readdirSync(root)) {
    const f = join(root, p, "chats", sessionId + ".jsonl");
    if (!existsSync(f)) continue;
    const t = { in: 0, out: 0, cached: 0 };
    for (const l of readFileSync(f, "utf8").split("\n")) {
      if (!l.includes("usageMetadata")) continue;
      try {
        const u = JSON.parse(l).usageMetadata ?? {};
        const c = Number(u.cachedContentTokenCount ?? 0);
        t.in += Number(u.promptTokenCount ?? 0) - c; t.cached += c; t.out += Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0);
      } catch { /* partial line */ }
    }
    return t;
  }
  return null;
}

/** Credits of one Qoder session from its own transcript (<home>/projects/<cwd>/<sessionId>.jsonl; fractional per message, unlike the whole-number account counter). Looks in the user dir and in the hub's private qoder-home (qodercli --config-dir). null if no file. */
export function qoderSession(sessionId, homes = [join(os.homedir(), ".qoder"), join(os.homedir(), ".paseo", "hub", "qoder-home")]) {
  if (!sessionId) return null;
  for (const home of [].concat(homes)) {
    const root = join(home, "projects");
    if (!existsSync(root)) continue;
    for (const p of readdirSync(root)) {
      const f = join(root, p, sessionId + ".jsonl");
      if (!existsSync(f)) continue;
      const seen = new Map();
      for (const l of readFileSync(f, "utf8").split("\n")) {
        if (!l.includes("credits")) continue;
        try { const j = JSON.parse(l), m = j.message, c = Number(m?.usage?.credits ?? 0); if (c > 0) seen.set(m.id ?? j.uuid, Math.max(c, seen.get(m.id ?? j.uuid) ?? 0)); } catch { /* partial line */ }
      }
      return [...seen.values()].reduce((a, b) => a + b, 0);
    }
  }
  return null;
}

/** Account credits used so far (qoder_poll.py, about 3 s, async so the plugin loop is never blocked); null when the poller cannot run. */
export function qoderCredits(env = process.env) {
  let dir = env.AGENT_HUB_POLLER_DIR;
  if (!dir) { try { dir = join(dirname(fileURLToPath(import.meta.url)), "..", "pollers"); } catch { return Promise.resolve(null); } }
  return new Promise((res) => execFileTree(env.AGENT_HUB_PYTHON ?? "python", [join(dir, "qoder_poll.py")], { env, timeout: 20_000 }, (e, out) => {
    try { const v = JSON.parse(out).credits_used; res(typeof v === "number" ? v : null); } catch { res(null); }
  }));
}

const rd = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } };

/** Turn-level delta against what was already booked for this agent (a session file is cumulative). Mutates the cursor file. */
export function fillRecord(rec, cursorFile, side) {
  if (rec.in + rec.out + rec.credits > 0) return rec;
  const cur = rd(cursorFile);
  const prev = cur[rec.agent] ?? { in: 0, out: 0, cached: 0 };
  if (side.tokens) {
    rec.in = Math.max(0, side.tokens.in - prev.in); rec.out = Math.max(0, side.tokens.out - prev.out); rec.cached = Math.max(0, side.tokens.cached - prev.cached);
    cur[rec.agent] = side.tokens;
  }
  if (side.sessionCredits != null) { // cumulative per-session total: book the delta since the last turn
    rec.credits = Math.max(0, Math.round((side.sessionCredits - (prev.credits ?? 0)) * 1000) / 1000);
    cur[rec.agent] = { ...(cur[rec.agent] ?? prev), credits: side.sessionCredits };
  } else if (side.credits != null) rec.credits = Math.max(0, Math.round(side.credits * 1000) / 1000);
  writeFileSync(cursorFile, JSON.stringify(cur));
  return rec;
}
