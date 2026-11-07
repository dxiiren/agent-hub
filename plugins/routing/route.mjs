#!/usr/bin/env node
// Routing wrapper (decision 41): task type -> ordered provider/model chain; the caller may override;
// a provider at its slot limit is skipped and a failed or timed-out one falls to the next entry.
// shortcut: wrapper, not a daemon hook. agent.create.before has no labels and cannot spawn a replacement; move to a plugin if the hook grows.
// Usage: route.mjs reply <agentId> "<text>" | route.mjs --resolve <alias> | route.mjs <type> "<prompt>" [--provider P/M] [--cwd D] [--gate CMD] [--mode M] [--new-workspace worktree] [--session ID] [--dev D] [--client C] [--home H] [--keep]
import { modelNotAllowed } from "./allow.mjs";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import path, { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { gateDir, loadState, writeRequest } from "../gate/server/store.mjs";
import { runGate, gateOpts, EMPTY_TREE, hasSecret } from "../gate/server/gate.mjs";
import { resolveCached } from "./resolve.mjs";
import { migrate } from "../../scripts/provider.mjs"; // cyclic with provider.mjs, used only at call time
import { batchAllowed } from "./readguard.mjs";
import { own } from "./jsonfile.mjs";
import { runDir } from "./runstate.mjs";

/** The Windows npm shim paseo.cmd cuts multi-line args, so run the CLI entry through node directly. */
export function paseoCommand(env = process.env) {
  if (env.PASEO_BIN) return [env.PASEO_BIN];
  if (process.platform === "win32") {
    const w = spawnSync("where", ["paseo.cmd"], { encoding: "utf8" });
    const shim = (w.stdout || "").split(/\r?\n/)[0];
    if (shim) {
      const entry = join(dirname(shim), "node_modules", "@getpaseo", "cli", "bin", "paseo");
      if (existsSync(entry)) return [process.execPath, entry];
    }
  }
  return ["paseo"];
}

export function loadRoutes(env = process.env) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "routes");
  for (const p of [env.AGENT_HUB_ROUTES, env.AGENT_HUB_NO_LOCAL === "1" ? null : join(root, "routes.local.json"), join(root, "routes.template.json")]) // AGENT_HUB_NO_LOCAL=1 (tests): never the developer's own file
    if (p && existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  throw new Error("no routing file (set AGENT_HUB_ROUTES)");
}

/** Seconds a `paseo run --no-wait` (agent + worktree creation) may take before the CLI gives up. Upstream Paseo has no bound: under load or a provider ACP init stall the daemon holds the request for 120 s+ (agent.create.request, "Timed out refreshing <provider> ... pending: initialize") and the caller used to hang for the 15 min spawn cap. */
export const createTimeoutS = (env = process.env) => Number(env.AGENT_HUB_CREATE_TIMEOUT_S) || 240;
/** Seconds one `paseo logs` call may take (it answers in ~2 s when healthy). */
export const logsTimeoutS = (env = process.env) => Number(env.AGENT_HUB_LOGS_TIMEOUT_S) || 30;
export const toSeconds = (d) => { const m = /^(\d+)\s*(s|m|h)?$/.exec(String(d ?? "").trim()); return m ? Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] ?? "s"]) : 900; };

/** The ONE place a paseo argv is built. Callers put caller/agent text after a "--" marker; here the options (--home, --json) go BEFORE the "--" and the text after it, so text such as "--help" or "--provider x" arrives verbatim as a positional and never as an option. */
export function cliArgs(args, home, json) {
  const i = args.indexOf("--");
  const [head, tail] = i < 0 ? [args, []] : [args.slice(0, i), args.slice(i)];
  return [...head, ...(home ? ["--home", home] : []), ...(json ? ["--json"] : []), ...tail];
}

/** Default CLI runner: parsed JSON of `paseo <args> --json`, or {error}. */
export function cliPaseo(home, env = process.env, spawn = spawnSync) {
  const [cmd, ...pre] = paseoCommand(env);
  return (args) => {
    const create = args[0] === "run" && args.includes("--no-wait");
    if (args[0] === "pending") { // path-bearing pending permissions: the CLI's `permit ls` hides the path
      const q = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "pending.mjs")], { encoding: "utf8", timeout: 15_000, env });
      try { return JSON.parse(q.stdout); } catch { return { error: "pending permissions unreadable: " + String(q.stderr || q.stdout).slice(0, 200) }; }
    }
    const text = args[0] === "logs"; // `paseo logs` has no JSON output: hand back the raw text
    // Every CLI call is bounded (a hung `paseo logs` once held a route for the whole 15 min). Only wait/run legitimately run long; logs is short and retried once, then reported unreadable so the route still returns.
    const long = args[0] === "wait" || args[0] === "run";
    const timeout = create ? createTimeoutS(env) * 1000 : text ? logsTimeoutS(env) * 1000 : long ? 15 * 60_000 : 2 * 60_000;
    const call = () => spawn(cmd, [...pre, ...cliArgs(args, home, !text)], { encoding: "utf8", timeout, killSignal: "SIGKILL", env });
    let r = call();
    if (text && r.error?.code === "ETIMEDOUT") { r = call(); if (r.error?.code === "ETIMEDOUT") return { error: `logs call hung and was killed after 2 x ${logsTimeoutS(env)} s` }; }
    if (create && r.error?.code === "ETIMEDOUT") return { error: `CREATE_TIMEOUT: the daemon did not create the agent within ${createTimeoutS(env)} s (saturated daemon or a provider that stalls at initialize; upstream Paseo, not a worktree bug). Check \`paseo ls\` and the laptop load, then retry; raise AGENT_HUB_CREATE_TIMEOUT_S if the host is just slow.` };
    const out = r.stdout || "";
    if (text) return r.status === 0 ? { text: out } : { error: `exit=${r.status} ` + String(r.stderr || out).slice(0, 300) };
    try { return JSON.parse(out.slice(out.search(/[[{]/))); } catch { const t = String(r.stderr || out || "no output"); return { error: `exit=${r.status} ` + (t.length > 500 ? t.slice(0, 300) + " ... " + t.slice(-200) : t) }; }
  };
}

/** Paseo's 1.5 s status probe fails while the daemon is busy (upstream #6584): retry the call, nothing was started. */
export const transient = (j) => !j?.agentId && !/^CREATE_TIMEOUT/.test(String(j?.error ?? "")) && j?.status !== "completed" && /DAEMON_UNREACHABLE|unreachable|ECONNREFUSED|ECONNRESET|timed? ?out|connection timed out|top-level await|^exit=(?!0)\d+|^exit=null/i.test(String(j?.error ?? ""));
export function withRetry(paseo, { tries = 6, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), jitter = () => Math.random() * 1000 } = {}) {
  return (args) => {
    let j = paseo(args);
    for (let i = 1; i < tries && transient(j) && args[0] !== "stop"; i++) { sleep(2000 * 2 ** (i - 1) + jitter()); j = paseo(args); }
    return j;
  };
}

const base = (p) => p.split("/")[0];
// Owner decision 21: full-access/bypass/yolo only inside a throwaway worktree; elsewhere drop --mode (provider default).
export const unsafeMode = (m) => /full-?access|bypass|yolo/i.test(m ?? "");
// Read-only task types never get an unsafe mode outside a worktree (same rule as every type): a "summarise" prompt must not be able to edit files. They run in the provider's default mode, and a post-check fails the task if the folder changed.
export const readOnlyType = (type, routes = {}) => (routes.readOnlyTypes ?? ["summarise", "review"]).includes(type);
/** Provider -> its most read-only mode id (from list_providers; checked 05-11). Codex has NONE (its Paseo modes are Default Permissions, Auto-review, Full Access: all can write in the folder), so it is left out and a read-only type skips it. Qoder "dontAsk" was proven live on 06-11: Write and shell refused, Read outside the task folder refused. Override per provider with routes.readOnlyModes. */
export const READ_ONLY_MODES = { claude: "plan", "claude-clean": "plan", opencode: "plan", "qwen-code": "read-only", "qwen-code-2": "read-only", "qwen-laptop": "read-only", qoder: "dontAsk", copilot: "https://agentclientprotocol.com/protocol/session-modes#plan" };
/** Provider ids this hub knows: slot keys, every route entry's id, and the built-in read-only-mode table. */
export const knownProviders = (routes = {}) => new Set(["codex", ...Object.keys(routes.slots ?? {}), ...Object.keys(READ_ONLY_MODES), ...Object.values(routes.routes ?? {}).flat().map(base)]);
/** Providers on which a read-only task may run: sensitive reads are ENFORCEABLY refused (claude-clean = PreToolUse read hook, Qwen = readguard). Qoder, plain claude, opencode, copilot and codex have no such enforcement (an in-cwd .env was read through qoder/efficient), so read-only types never run on them. Override with routes.readOnlyEnforced. */
export const READ_ONLY_ENFORCED = ["claude-clean", "qwen-code", "qwen-code-2", "qwen-laptop"];
export const readOnlyEnforced = (prov, routes = {}) => (routes.readOnlyEnforced ?? READ_ONLY_ENFORCED).includes(prov);
/** Modes that really are read-only, per provider family. A mode outside this set is never used for a read-only task (fail closed: the route refuses, it never falls back to the default mode). */
const SAFE_MODES = { claude: ["plan"], "claude-clean": ["plan"], opencode: ["plan"], qoder: ["dontAsk"], copilot: [READ_ONLY_MODES.copilot] };
/** The one read-only mode a read-only task may use on `prov`, or undefined (= refuse). Qwen-style providers (the hub's ACP proxy launcher: the three built-in ids and every user-added one) always get "read-only", whatever readOnlyModes says; a user-added id whose recorded mode is not "read-only" (stale "plan") is refused until `provider migrate` fixes it. */
export const readOnlyMode = (prov, routes = {}) => {
  if (own(READ_ONLY_MODES, prov) === "read-only") return "read-only";
  const safe = own(SAFE_MODES, prov);
  if (safe) { const m = own(routes.readOnlyModes, prov) ?? own(READ_ONLY_MODES, prov); return safe.includes(m) ? m : undefined; }
  return own(routes.readOnlyModes, prov) === "read-only" ? "read-only" : undefined; // unknown kind: only the proxy's own mode counts
};
/** Resolve a read-only agent stopped on `permission`. Its pending requests are judged as ONE batch (readguard.mjs): every request a plain local read of a path inside ctx.cwd / ctx.allow (realpath, no dotfiles, no credentials, no protected folders) => allow all and wait again; any other => deny all and the status stays `permission`. A request with no path is denied. */
export function grantReads(paseo, j, timeoutS, ctx = {}, max = 8) {
  for (let i = 0; i < max && j.status === "permission" && j.agentId; i++) {
    const pend = paseo(["pending"]);
    const mine = (Array.isArray(pend) ? pend : []).filter((p) => p.agentId === j.agentId);
    if (!mine.length) break;
    const roots = [ctx.cwd, ...(ctx.allow ?? [])].filter(Boolean);
    const v = batchAllowed(mine, roots);
    for (const p of mine) paseo(["permit", v.ok ? "allow" : "deny", j.agentId, p.id]);
    if (!v.ok) return { ...j, denied: v.why };
    const w = paseo(["wait", j.agentId, "--timeout", String(timeoutS)]);
    j = { agentId: j.agentId, status: w?.status === "idle" ? "completed" : (w?.status ?? "error"), ...(w?.error ? { error: w.error } : {}) };
  }
  return j;
}
const TAG = /^\[[A-Z][A-Za-z_ ]*\](?: |$)/;
const trimEnd = (l) => { while (l.length && !l[l.length - 1].trim()) l.pop(); return l; };
const NL = String.fromCharCode(10);
const lines = (t) => String(t ?? "").replace(/\r\n/g, NL).split(NL);
/** The agent's last assistant message. `paseo logs` has no JSON, so two reads are combined: `full` is the whole transcript (tagged [User]/[Thought]/tool lines; a multi-line User or Thought block continues on untagged lines that look like an answer) and `assistant` is `paseo logs --filter assistant` (assistant messages only, untagged). The answer is the last untagged run of the full log, cut to the lines the assistant-only text also ends with, so a re-prompt tail or a thought continuation never leaks in. Without the assistant-only text (read failed) it is the last untagged run alone. Capped. */
export function lastAnswer(full, cap = 4096, assistant = null) {
  const ls = lines(full);
  let end = ls.length; while (end > 0 && (!ls[end - 1].trim() || TAG.test(ls[end - 1]))) end--; // tool lines printed after the final message
  let start = end; while (start > 0 && !TAG.test(ls[start - 1])) start--;
  let run = trimEnd(ls.slice(start, end));
  if (assistant !== null) {
    const al = trimEnd(lines(assistant));
    let n = 0; while (n < run.length && n < al.length && run[run.length - 1 - n].trimEnd() === al[al.length - 1 - n].trimEnd()) n++;
    run = n ? run.slice(run.length - n) : trimEnd(al.join(NL).split(/\n\s*\n/).pop().split(NL)); // no overlap (the run is a thought): last paragraph of the assistant text
  }
  const a = run.join(NL).trim();
  return a.length > cap ? { answer: a.slice(0, cap), truncated: true } : { answer: a, truncated: false };
}
/** Paseo prints these when an agent has no transcript yet; they are UI text, never an answer. */
export const isEmptyState = (t) => /^\s*(no activity to display|no activity|nothing to display|no (messages|output|logs?)( yet| to display)?)\.?\s*$/i.test(String(t ?? ""));
/** Attach `answer` (always present: "" plus `answerReason` when nothing could be read). The log is re-read once when its last line is a tool line or the text is empty: the final message may not be flushed yet. */
export function withAnswer(r, paseo, retryMs = 1500, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  if (!r.agentId) return r;
  const read = () => {
    const f = paseo(["logs", r.agentId]); const as = paseo(["logs", r.agentId, "--filter", "assistant"]);
    const a = lastAnswer(isEmptyState(f?.text) ? "" : f?.text, 4096, isEmptyState(as?.text) ? null : as?.text ?? null);
    return { f, a: isEmptyState(a.answer) ? { answer: "", truncated: false } : a };
  };
  let x = read();
  const tail = lines(x.f?.text).filter((l) => l.trim()).pop() ?? "";
  if (retryMs && (!x.a.answer || TAG.test(tail))) { sleep(retryMs); const y = read(); if (y.a.answer) x = y; }
  if (!x.a.answer) return { ...r, answer: "", answerReason: x.f?.error ? "logs unreadable: " + String(x.f.error).slice(0, 120) : "the agent log holds no assistant text (or only Paseo's empty-state text)" };
  return { ...r, answer: x.a.answer, ...(x.a.truncated ? { answerTruncated: true, answerFull: `paseo logs ${r.agentId}` } : {}) };
}

/** Git-Bash and Cygwin drive paths (/c/Users/x, /cygdrive/c/x) are not paths to the Windows daemon: it spent 74 s on WORKSPACE_CREATE_FAILED. Rewrite them to C:/... on win32. */
export function normCwd(p, platform = process.platform) {
  if (platform !== "win32" || typeof p !== "string") return p;
  const m = /^\/(?:cygdrive\/)?([A-Za-z])(?=\/|$)(.*)$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${m[2] || "/"}` : p;
}

/** A relative path option is resolved against the CALLER's folder before it is sent: the daemon would otherwise resolve it against its own (an agent once ran in C:\Windows\System32 for --cwd .). Dash-led and empty values stay as they are for inputError. */
export function absPath(p) { return typeof p !== "string" || !p || p.startsWith("-") || path.isAbsolute(p) ? p : path.resolve(p); }

/** The commit a task starts from; the gate diffs against it. Null only outside a git repo; a repo with no commits yet (unborn HEAD) gets the empty-tree hash so the gate diffs and scans everything. */
export function headSha(cwd) {
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" });
  if (inRepo.status !== 0) return null;
  const r = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : EMPTY_TREE;
}

/** Shallow snapshot of a folder (names + mtimes, capped) for the read-only post-check. */
export function snapshot(dir, max = 5000) {
  const out = []; const walk = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { if (out.length >= max) return; if (e.name === ".git" || e.name === "node_modules") continue; const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { out.push(p + "|" + statSync(p).mtimeMs); } catch { /* vanished */ } } } };
  walk(dir); return out.sort().join(String.fromCharCode(10));
}

/** The agent's real cwd (`paseo ls` abbreviates the home folder as "~"); undefined when unknown. */
export function agentCwd(paseo, agentId) {
  const r = paseo(["ls"]); const c = (Array.isArray(r) ? r : []).find((a) => a.id === agentId)?.cwd;
  return c?.replace(/^~(?=[\\/])/, os.homedir());
}

/** Run the gate in the agent's cwd with the same options the plugin hook uses (gateOpts). First failure: re-prompt once (decision 47) and block until the agent is idle; freeze it; second gate. */
export function callerGate(o, agentId, paseo, gate = runGate, routes = {}) {
  // `paseo ls` abbreviates the home folder as "~"
  const cwdOf = () => agentCwd(paseo, agentId);
  const cwd = cwdOf();
  if (!cwd) return { status: "FAIL", reasons: ["agent cwd unknown: gate not run"], attempts: 0 };
  let res = gate(cwd, gateOpts(routes, cwd, o.gate, o.base));
  if (res.status === "PASS") return { status: "PASS", reasons: [], attempts: 0 };
  if (routes.gateRetry === false) return { status: "FAIL", reasons: res.reasons, attempts: 1 };
  const fail = (why) => ({ status: "FAIL", reasons: [...res.reasons, why], attempts: 1 });
  const s = paseo(["send", agentId, "--", "Your work failed the gate: " + res.reasons.join("; ") + "\nFix it and finish."]);
  if (s?.error) return fail("re-prompt failed: " + String(s.error).slice(0, 120));
  const w = paseo(["wait", agentId, "--timeout", "900"]);
  if (w?.error) return fail("wait for re-prompt failed: " + String(w.error).slice(0, 120));
  const st = paseo(["stop", agentId]);
  if (st?.error && !/AGENT_NOT_FOUND|No agent found/.test(String(st.error))) return fail("could not freeze the agent: " + String(st.error).slice(0, 120));
  // freeze: the second gate must judge the final tree, not one the agent is still editing
  res = gate(cwdOf() ?? cwd, gateOpts(routes, cwd, o.gate, o.base));
  return { status: res.status, reasons: res.reasons, attempts: 1 };
}

// --- talk-back: a task agent that is blocked ends its final message with `[ASK] <question>` ---
export const ASK_CLAUSE = "\n\n(If you are blocked and need the caller's input, end your final message with one last line `[ASK] <question>` and stop. Never put credentials in it. Never call agent-hub.)";
export const MAX_ASKS = 3;
export const PARK_SECONDS = 600;
/** The question when the LAST non-empty line of the answer is `[ASK] ...`; null otherwise (a mid-text [ASK] is ordinary prose). */
export function parseAsk(answer) {
  const l = lines(answer).map((x) => x.trim()).filter(Boolean).pop() ?? "";
  const m = /^\[ASK\]\s+(\S.*)$/.exec(l);
  return m ? m[1] : null;
}
/** Asking is allowed while fewer than MAX_ASKS questions were asked; after that the answer is final even if it ends with [ASK]. */
export const sha = (t) => createHash("sha1").update(String(t)).digest("hex");
export const mayAsk = (asks) => asks < MAX_ASKS;
const parkDir = (home) => join(home || process.env.PASEO_HOME || join(os.homedir(), ".paseo"), "usage", "parked");
/** Remember what a parked agent needs for its reply (gate, base, worktree) and arm a detached reaper that stops it after PARK_SECONDS without a reply. */
/** Paseo ids are UUIDs; the id becomes a file name, so allow only plain id characters and keep the resolved path inside the park folder. */
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9; any case, any extension) open the device, not a file. */
export const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.].*)?$/i;
export const safeName = (n) => typeof n === "string" && AGENT_ID_RE.test(n) && !RESERVED_NAME_RE.test(n);
export function parkFile(dir, agentId) {
  if (!safeName(agentId)) return null;
  const f = resolve(dir, agentId + ".json");
  return f.startsWith(resolve(dir) + sep) ? f : null;
}
export function park(rec, { home, dir = parkDir(home), seconds = PARK_SECONDS, reaper = true } = {}) {
  const parkedAt = Date.now();
  mkdirSync(dir, { recursive: true });
  const f = parkFile(dir, rec.agentId); if (!f) throw new Error("invalid agent id for parking");
  writeFileSync(f, JSON.stringify({ ...rec, parkedAt }));
  if (reaper) { // shortcut: one detached node per parked agent, not a daemon timer; upgrade if parking becomes frequent
    try { spawn(process.execPath, [fileURLToPath(import.meta.url), "--reap", rec.agentId, String(parkedAt), String(seconds), home ?? "", dir], { detached: true, stdio: "ignore", windowsHide: true, cwd: runDir() }).unref(); } catch { /* the park file stays; a reply still works */ }
  }
  return parkedAt;
}
export const loadPark = (agentId, dir = parkDir()) => { try { return JSON.parse(readFileSync(parkFile(dir, agentId), "utf8")); } catch { return null; } };
const dropPark = (agentId, dir = parkDir()) => { try { const f = parkFile(dir, agentId); if (f) rmSync(f, { force: true }); } catch { /* best effort */ } };
/** Stop and archive a parked agent (and its route-created worktree). */
export function retireParked(paseo, rec) {
  paseo(["stop", rec.agentId]); paseo(["archive", rec.agentId]);
  if (rec.wt) paseo(["worktree", "archive", rec.wt.name, "--cwd", rec.cwd]);
}
/** Parked and still unanswered after the park time: retire it. A later park (new parkedAt) or a reply (file gone) cancels this reap. */
export function reapParked(paseo, agentId, parkedAt, dir = parkDir()) {
  const rec = loadPark(agentId, dir);
  if (!rec || String(rec.parkedAt) !== String(parkedAt)) return false;
  retireParked(paseo, rec); dropPark(agentId, dir); return true;
}
/**
 * `agent-hub reply <agentId> "<text>"`: send the caller's answer to a parked agent and return the same shape as route.
 * It may ask again (up to MAX_ASKS questions in total); the original --gate runs on the final answer.
 */
export function runReply(agentId, text, paseo, routes = {}, { gate = runGate, dir = parkDir(), answerRetryMs, reaper = true, waitTimeout } = {}) {
  if (!parkFile(dir, agentId)) return { used: null, status: "error", error: `invalid agent id: only ${AGENT_ID_RE} is accepted` };
  try {
    if (hasSecret(text)) return { used: null, status: "rejected", error: "reply rejected: it looks like a credential, token or key. Reply without it." };
  } catch (e) { return { used: null, status: "rejected", error: "reply rejected: " + e.message }; }
  const rec = loadPark(agentId, dir);
  if (!rec) return { used: null, status: "error", error: `no parked agent ${agentId}: it never asked, already finished, or was stopped after ${PARK_SECONDS / 60} min without a reply` };
  dropPark(agentId, dir); // the reaper must not stop it while this reply runs
  const last = !mayAsk(rec.asks);
  const trace = [{ provider: rec.provider, reply: rec.asks }];
  const fail = (error, status = "error") => { retireParked(paseo, rec); return { used: rec.provider, agentId, status, error, trace }; };
  const s = paseo(["send", agentId, "--", String(text) + (last ? "\n\n(This is the last reply you get: finish the task now, do not ask again.)" : "")]);
  if (s?.error) return fail("send failed: " + String(s.error).slice(0, 160));
  const w = paseo(["wait", agentId, "--timeout", String(toSeconds(waitTimeout ?? routes.waitTimeout ?? "10m"))]);
  if (w?.error || (w?.status && w.status !== "idle")) return fail(w?.error ? "wait failed: " + String(w.error).slice(0, 160) : `agent ended with status ${w.status}`, w?.status ?? "error");
  if (rec.ro && sha(snapshot(rec.guardCwd)) !== rec.guardHash) { // read-only post-check, same as route: a summarise/review agent must not change files during a reply either
    trace.push({ provider: rec.provider, status: "error", error: `read-only task ${rec.type} changed files in ${rec.guardCwd} after the reply: failed` });
    retireParked(paseo, rec); return { used: rec.provider, agentId, status: "failed-readonly-changed", trace };
  }
  const r = withAnswer({ used: rec.provider, agentId, status: "completed", trace }, paseo, answerRetryMs);
  const q = mayAsk(rec.asks) ? parseAsk(r.answer) : null;
  if (q) { park({ ...rec, asks: rec.asks + 1 }, { dir, reaper, home: rec.home }); return { ...r, status: "asking", question: q, round: rec.asks + 1 }; }
  if (!rec.gate) { if (!rec.keep) retireParked(paseo, rec); return r; }
  const g = callerGate({ gate: rec.gate, base: rec.base }, agentId, paseo, gate, routes);
  trace.push({ provider: rec.provider, gate: g.status, ...(g.reasons.length ? { reasons: g.reasons } : {}), attempts: g.attempts });
  const out = withAnswer({ used: rec.provider, agentId, status: g.status === "PASS" ? "completed" : "gate-failed", gate: g, trace }, paseo, answerRetryMs);
  if (!rec.keep) retireParked(paseo, rec);
  return out;
}

/** Allow-lists for every CLI/MCP value that becomes a paseo argument, a label or a path. Free text (prompt, reply text, --gate command) is the task itself and is not listed here. */
const ALLOW = {
  type: /^[a-z][a-z0-9-]{0,31}$/,
  provider: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/,
  label: /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,63}$/, // session, dev, client
  mode: /^[A-Za-z0-9][A-Za-z0-9:/._#-]{0,119}$/,
};
export function inputError(o) {
  for (const [k, re, v] of [["type", ALLOW.type, o.type], ["provider", ALLOW.provider, o.provider], ["mode", ALLOW.mode, o.mode], ["session", ALLOW.label, o.session], ["dev", ALLOW.label, o.dev], ["client", ALLOW.label, o.client]])
    if (v !== undefined && v !== null && !(typeof v === "string" && re.test(v) && (re !== ALLOW.label || !RESERVED_NAME_RE.test(v)))) return `invalid ${k}: only ${re} is accepted (and no Windows device name)`;
  for (const [k, v] of [["cwd", o.cwd], ["home", o.home]])
    if (v !== undefined && v !== null && (typeof v !== "string" || !v || v.startsWith("-") || [...v].some((c) => c.charCodeAt(0) < 32))) return `invalid ${k}: an absolute path without control characters or a leading dash is required`;
  return null;
}

/**
 * Run a task through the chain. `paseo(args)` is injected (tests use a fake).
 * Returns { used, agentId, status, trace }; used is null when every entry failed.
 */
/** Session-mode ids a caller may pass with --mode: the ones the routes file names, the read-only tables, and the common ACP ones (routes.knownModes adds more). */
export const knownModes = (routes = {}) => new Set([routes.mode, ...Object.values(routes.modes ?? {}), ...Object.values(routes.readOnlyModes ?? {}), ...Object.values(READ_ONLY_MODES), ...Object.values(SAFE_MODES).flat(), ...(routes.knownModes ?? []),
  "default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto", "auto-edit", "auto-review", "yolo", "full-access", "read-only"].filter(Boolean));
/** Why a task stopped on `permission`, from facts: no worktree for an edit type; else the secret gate reasons found in the agent's tree and the pending request (tool + paths) nobody granted. Never claims a flag is missing when it was passed. */
export function permissionHint({ o, mode, ro, wt, paseo, agentId, gate = runGate, routes = {} }) {
  const m = mode ?? "provider default";
  if (ro) return `read-only task ${o.type} (mode ${m}) asked for a permission it may not have (it can only read plain files inside the task folder; sensitive files, writes and shell are refused)`;
  if (!o.worktree) return `edit task ${o.type} ran outside a worktree (mode ${m}) and asked for a permission the provider default mode does not grant: pass --new-workspace worktree (full-access is dropped outside one, decision 21)`;
  const why = [];
  try { const g = gate(wt.path, gateOpts(routes, wt.path, undefined, o.base)); why.push(...(g?.reasons ?? []).filter((r) => /secret/i.test(r))); } catch { /* the gate result is only an explanation */ }
  try { const pend = paseo(["pending"]); for (const p of (Array.isArray(pend) ? pend : []).filter((x) => x.agentId === agentId)) why.push(`pending ${p.name ?? p.kind ?? "request"}${p.paths?.length ? " on " + p.paths.join(", ") : ""}`); } catch { /* optional */ }
  return `agent in the worktree (type ${o.type}, mode ${m}) stopped on a permission request that was not granted` + (why.length ? `: ${why.join("; ")}` : ` (no secret pattern found in its tree and no pending request visible: check \`paseo logs ${agentId ?? "<agent>"}\`)`);
}
/** An unknown --mode is refused loudly (it used to be dropped silently on read-only types); null when fine or absent. */
export const modeError = (mode, routes = {}) => (mode === undefined || mode === null || knownModes(routes).has(mode) ? null : `unknown --mode "${mode}": use one of ${[...knownModes(routes)].filter((m) => !m.startsWith("http")).sort().join(", ")} (read-only task types always run read-only whatever --mode says)`);
export function runRoute(o, paseo, routes, gate = runGate) {
  const bad = inputError(o) ?? modeError(o.mode, routes); if (bad) return { used: null, status: "error", trace: [{ error: bad }] };
  // a credential in the task or the gate command is refused before anything is created or sent (same scanner as reply and the diff gate; fails closed when the scanner is missing)
  try { if ((o.scan ?? hasSecret)([o.prompt, o.gate].filter((x) => typeof x === "string").join(String.fromCharCode(10)))) return { used: null, status: "rejected", error: "task rejected: the prompt or --gate looks like it contains a credential, token or key. Remove it (pass it by an environment variable the command reads) and run again.", trace: [] }; }
  catch (e) { return { used: null, status: "rejected", error: "task rejected: " + e.message, trace: [] }; }
  const chain = o.provider ? [o.provider] : own(routes.routes, o.type);
  if (!chain) return { used: null, trace: [{ error: `unknown task type ${o.type}` }] };
  if (!chain.length) return { used: null, trace: [{ error: `no provider configured for ${o.type}: add one in Settings > Providers` }] };
  const slots = routes.slots ?? {};
  const trace = [];
  if (o.provider && readOnlyType(o.type, routes)) {
    const p = base(o.provider);
    if (p !== "claude" && !readOnlyEnforced(p, routes) // "claude/<alias>" resolves to claude-clean, re-checked below
    ) return { used: null, trace: [{ provider: o.provider, error: `read-only task type "${o.type}" refused on ${p}: no enforced sensitive-read guard there (allowed: ${(routes.readOnlyEnforced ?? READ_ONLY_ENFORCED).join(", ")}). Use a claude-haiku/qwen provider, or code-edit in a git worktree.` }] };
  }
  // fail fast: an unknown provider id would otherwise reach the daemon, which holds the create for minutes with no agent
  if (o.provider) { const known = knownProviders(routes); if (!known.has(base(o.provider))) return { used: null, trace: [{ provider: o.provider, error: `unknown provider id "${base(o.provider)}": not in routes slots, any route chain or the built-in provider list (known: ${[...known].sort().join(", ")})` }] }; }
  // A finished agent keeps its provider process (a claude is ~250 MB idle): stop and archive it once its answer and gate are read, unless --keep.
  // A route-created worktree (--new-workspace worktree) is removed with its agent, or it piles up under ~/.paseo/worktrees. The route creates it itself (named, so retire needs no lookup).
  // The daemon registers a Paseo project for every cwd and route worktree a run touches; remove the ones this route created (not in the before-snapshot, path = this run's cwd or worktree) once no other agent still runs there, or the UI project list fills with scratch folders.
  const projects = () => { try { const r = paseo(["project", "ls"]); return Array.isArray(r) ? r : []; } catch { return []; } };
  const pnorm = (p) => String(p ?? "").split(String.fromCharCode(92)).join("/").replace(/\/+$/, "").toLowerCase();
  const projBefore = o.keep ? null : new Set(projects().map((p) => p.projectId));
  const dropProjects = (wt) => {
    const targets = [o.cwd, wt?.path].filter(Boolean).map(pnorm);
    const rows = paseo(["ls"]); const live = (Array.isArray(rows) ? rows : []).filter((a) => String(a.status).toLowerCase() === "running").map((a) => pnorm(a.cwd?.replace(/^~(?=[\/])/, os.homedir())));
    for (const p of projects()) if (!projBefore.has(p.projectId) && targets.includes(pnorm(p.path)) && !live.includes(pnorm(p.path))) paseo(["project", "delete", p.projectId]);
  };
  const retire = (id, wt) => {
    if (o.keep) return;
    if (id) { paseo(["stop", id]); paseo(["archive", id]); }
    if (wt) paseo(["worktree", "archive", wt.name, "--cwd", o.cwd]);
    dropProjects(wt);
  };
  const done = (r, wt) => { retire(r.agentId, wt); return r; };
  let partial = null; let ramLeftMs;
  // providers the daemon really has: a route entry for an id nobody configured is skipped, never sent to the daemon (null = list unavailable: no filtering)
  const state = o.providerState !== undefined ? o.providerState : providerState(paseo); // provider id -> enabled (null = list unavailable: no filtering)
  const installed = state ? new Set(state.keys()) : null;
  for (const entry of chain) {
    let prov;
    try { prov = resolveCached(entry, paseo); } catch (e) { trace.push({ provider: entry, error: String(e.message) }); continue; }
    if (installed && !installed.has(base(prov))) { trace.push({ provider: prov, skip: "provider not configured: add it in Settings > Providers" }); continue; }
    if (state && state.get(base(prov)) === false) { trace.push({ provider: prov, skip: "provider disabled or unavailable in Paseo (Settings > Providers)" }); continue; }
    { const na = modelNotAllowed(routes, prov); if (na) { trace.push({ provider: prov, skip: na }); continue; } } // Routing & slots model allow-list
    const rows = paseo(["ls"]);
    const busy = (Array.isArray(rows) ? rows : []).filter((a) => String(a.status).toLowerCase() === "running" && a.provider === base(prov)).length;
    if (busy >= (own(slots, base(prov)) ?? 99)) { trace.push({ provider: prov, skip: `busy ${busy}/${own(slots, base(prov))}` }); continue; }
    if (!claimSlot(o.marker, base(prov), own(slots, base(prov)))) { trace.push({ provider: prov, skip: `slots full: ${own(slots, base(prov))} other routes already hold ${base(prov)}` }); continue; }
    // RAM admission (09:10-09:14 hang: 15 tasks, <1 GB free): wait with backoff for free RAM before creating an agent; give up on this entry at waitTimeout. Only when the caller passes freeMem (main() does; unit tests that do not, never read the real machine).
    if (o.freeMem) {
      const floor = routes.minFreeRamGbByProvider?.[base(prov)] ?? routes.minFreeRamGb ?? 2;
      const sleep = o.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
      ramLeftMs ??= toSeconds(o.waitTimeout ?? routes.waitTimeout ?? "10m") * 1000;
      let wait = 2000; while (o.freeMem() < floor && ramLeftMs > 0) { sleep(wait); ramLeftMs -= wait; wait = Math.min(wait * 2, 30000); }
      if (o.freeMem() < floor) { trace.push({ provider: prov, skip: `low RAM: ${o.freeMem().toFixed(1)} GB free, floor ${floor} GB` }); continue; }
    }
    const labels = { "route/type": o.type, "route/provider": prov, dev: o.dev, caller: o.client, session: o.session };
    let wt = null; // this entry's route-created worktree
    // Qwen read-only: the launcher (acp-proxy.mjs) offers the session mode "read-only"; choosing it restarts qwen with the deny settings (config/qwen/system-settings-readonly.json). Nothing is ever written under the task cwd.
    const args = ["run", "--cwd", o.cwd, "--provider", prov, "--wait-timeout", o.waitTimeout ?? routes.waitTimeout ?? "10m"];
    const ro = readOnlyType(o.type, routes); // read-only types: the provider's read-only mode, whatever the caller or the routes file asks for
    if (ro && !readOnlyMode(base(prov), routes)) { trace.push({ provider: prov, skip: "provider has no verified read-only mode (read-only task types never run on it; for a Qwen provider run `agent-hub provider migrate`)" }); continue; }
    if (ro && !readOnlyEnforced(base(prov), routes)) { trace.push({ provider: prov, skip: "no enforced sensitive-read guard for this provider (read-only task types never run on it)" }); continue; }
    const mode = ro ? readOnlyMode(base(prov), routes) : o.mode ?? own(routes.modes, base(prov)) ?? routes.mode; // per-provider default: codex full-access, claude bypassPermissions ...
    if (o.worktree) {
      // The task's start commit and gate request must exist BEFORE the agent can act, and must not come from state the agent can write at turn end. So the route creates the worktree itself, from the pinned base commit, and registers the request under its path before `run`: the hook finds it by the agent's cwd. No request = the hook fails closed.
      if (!o.base) o.base = headSha(o.cwd);
      if (!o.base || o.base === EMPTY_TREE) { trace.push({ provider: prov, error: "worktree task needs a git repo with at least one commit (the base commit is pinned at creation)" }); continue; }
      const c = paseo(["worktree", "create", "--mode", "branch-off", "--new-branch", "route-" + randomBytes(5).toString("hex"), "--base", o.base, "--cwd", o.cwd]);
      if (!c?.worktreePath || c.error) { trace.push({ provider: prov, error: "worktree create failed: " + String(c?.error ?? "no path returned").slice(0, 200) }); continue; }
      wt = { name: c.name, path: c.worktreePath };
      args[2] = wt.path;
      writeRequest(o.gateDir ?? gateDir(), wt.path, o.gate, o.base);
    }
    if (mode && (o.worktree || !unsafeMode(mode))) args.push("--mode", mode);
    else if (mode) trace.push({ provider: prov, note: `mode ${mode} dropped: needs --new-workspace worktree` });
    for (const [k, v] of Object.entries(labels)) if (v) args.push("--label", `${k}=${v}`);
    // caller-supplied gate (decision 47) goes to the plugin-side store, not into agent-writable labels (worktree runs registered theirs above, under the worktree path)
    if (!o.base) o.base = headSha(o.cwd); // the task starts here: the gate diffs against it so committed work is judged too
    if (!o.worktree && (o.gate || o.base)) writeRequest(o.gateDir ?? gateDir(), o.cwd, o.gate, o.base);
    // worktree runs: create without waiting (the create call is bounded by cliPaseo), then wait for the agent separately
    if (o.worktree) args.push("--no-wait");
    const guard = ro ? snapshot(o.cwd) : null;
    let j = paseo([...args, "--", o.prompt]);
    if (o.worktree && j.agentId && !j.error && j.status !== "completed") {
      const w = paseo(["wait", j.agentId, "--timeout", String(toSeconds(o.waitTimeout ?? routes.waitTimeout ?? "10m"))]);
      j = { agentId: j.agentId, status: w?.status === "idle" ? "completed" : (w?.status ?? "error"), ...(w?.error ? { error: w.error } : {}) };
    }
    if (ro && j.status === "permission") j = grantReads(paseo, j, toSeconds(o.waitTimeout ?? routes.waitTimeout ?? "10m"), { cwd: o.cwd, allow: routes.readAllow });
    const hint = j.status === "permission" ? { error: permissionHint({ o, mode, ro, wt, paseo, agentId: j.agentId, gate, routes }) } : {};
    trace.push({ provider: prov, status: j.status ?? "error", ...(j.error ? { error: j.error } : hint) });
    if (j.status === "completed" && guard !== null && snapshot(o.cwd) !== guard) {
      trace.push({ provider: prov, status: "error", error: `read-only task ${o.type} changed files in ${o.cwd}: failed` });
      return done({ used: prov, agentId: j.agentId, status: "failed-readonly-changed", trace }, wt);
    }
    if (j.status === "completed" && !o.noAsk && !ro) { // read-only types never park: text inside a summarised file could otherwise hold a slot for 10 min
     // talk-back: the agent ended with `[ASK] <question>`: park it (alive, no gate, no retire) until `agent-hub reply`
      const a = withAnswer({ used: prov, agentId: j.agentId, status: "completed", trace }, paseo, o.answerRetryMs);
      const q = parseAsk(a.answer);
      if (q && j.agentId) {
        park({ agentId: j.agentId, provider: prov, cwd: wt?.path ?? o.cwd, type: o.type, gate: o.gate, base: o.base, wt, keep: !!o.keep, asks: 1, home: o.home, ...(guard !== null ? { ro: true, guardCwd: o.cwd, guardHash: sha(guard) } : {}) }, { home: o.home, reaper: o.reaper });
        return { ...a, status: "asking", question: q, round: 1, hint: `answer with: agent-hub reply ${j.agentId} "<text>" (a parked agent is stopped after ${PARK_SECONDS / 60} min with no reply)` };
      }
    }
    if (j.status === "completed") {
      if (!o.gate) return done(withAnswer({ used: prov, agentId: j.agentId, status: "completed", trace }, paseo, o.answerRetryMs), wt);
      // Caller-side gate: the plugin cannot match a request to a worktree it did not know at create time, so the caller runs the gate itself in the agent's real cwd.
      const g = callerGate(o, j.agentId, paseo, gate, routes);
      // the plugin hook may have re-prompted already (its attempts live in the plugin store, keyed by agent id)
      const pluginAttempts = (() => { try { return Number(loadState(o.gateDir ?? gateDir())[j.agentId]?.attempts) || 0; } catch { return 0; } })();
      g.attempts += pluginAttempts;
      trace.push({ provider: prov, gate: g.status, ...(g.reasons.length ? { reasons: g.reasons } : {}), attempts: g.attempts });
      return done(withAnswer({ used: prov, agentId: j.agentId, status: g.status === "PASS" ? "completed" : "gate-failed", gate: g, trace }, paseo, o.answerRetryMs), wt);
    }
    // a read-only agent stopped on a refused read may still have written an answer: keep it (the refusal stays in the trace) in case no entry completes
    if (ro && j.status === "permission" && j.agentId) { const w = withAnswer({ agentId: j.agentId }, paseo, o.answerRetryMs); if (w.answer) partial = { provider: prov, agentId: j.agentId, answer: w.answer, refusedRead: true, ...(w.answerTruncated ? { answerTruncated: true } : {}) }; }
    if (j.agentId || wt) retire(j.agentId, wt); // a timed-out agent must not keep running while the next entry works
  }
  if (!partial && trace.length && trace.every((t) => /^provider not configured/.test(t.skip ?? ""))) trace.push({ error: `no provider configured for ${o.type}: add one in Settings > Providers` });
  return partial ? { used: null, status: "permission", partial, trace } : { used: null, trace };
}

/** Provider id -> enabled, from `paseo provider ls` (one call). Disabled (the Settings toggle) or unavailable (no CLI) = false. null when the list cannot be read. */
export function providerState(paseo) {
  try {
    const r = paseo(["provider", "ls"]); const m = new Map();
    for (const x of Array.isArray(r) ? r : r?.providers ?? []) { const id = x?.provider ?? x?.id ?? x?.name; if (id) m.set(id, !(/^disabled$/i.test(String(x.enabled ?? "")) || x.enabled === false || /unavail|disabled/i.test(String(x.status ?? "")))); }
    return m.size ? m : null;
  } catch { return null; }
}
/** Slots per provider with enabled flag, and the total over ENABLED providers only (a provider absent from the state counts as enabled). */
export function slotInfo(routes, state) {
  const providers = {}; let total = 0;
  for (const [id, n] of Object.entries(routes.slots ?? {})) { const enabled = !state || state.get(id) !== false; providers[id] = { slots: n, enabled }; if (enabled) total += n; }
  return { providers, total };
}
/** Statusline source (cheap, no daemon call): one marker file per running route in <home>/usage/active, plus total.json (sum of routes.slots). Best effort; a killed route leaves a file the reader ignores after 30 min. */
export function markActive(routes, provider, dir = join(process.env.PASEO_HOME ?? join(os.homedir(), ".paseo"), "usage", "active"), state = null) {
  try {
    mkdirSync(dir, { recursive: true });
    for (const n of readdirSync(dir)) { // sweep markers of killed routes (the reader ignores them after 30 min anyway)
      if (!n.startsWith("t-")) continue;
      try { if (Date.now() - statSync(join(dir, n)).mtimeMs > 30 * 60 * 1000) rmSync(join(dir, n), { force: true }); } catch { /* best effort */ }
    }
    writeFileSync(join(dir, "total.json"), JSON.stringify(slotInfo(routes, state))); // total = slots of enabled providers; refreshed on every route, so a toggle shows from the next one
    const f = join(dir, `t-${process.pid}-${Date.now()}.json`);
    writeFileSync(f, JSON.stringify({ provider: provider ?? null, state: provider ? "run" : "queued" }));
    const un = () => { try { rmSync(f, { force: true }); } catch { /* best effort */ } };
    un.file = f; un.dir = dir;
    return un;
  } catch { return () => {}; }
}
const markerAge = 30 * 60 * 1000;
/** Set what this route holds: a provider (a slot, state "run") or null (queued, waiting for one). Best effort. */
export function setMarker(un, provider) { try { if (un?.file) writeFileSync(un.file, JSON.stringify({ provider: provider ?? null, state: provider ? "run" : "queued" })); } catch { /* best effort */ } }
/**
 * Slot reservation across processes. A route writes its provider into its own marker FIRST, then counts the live markers holding that provider in start order:
 * it keeps the slot only when its rank is below `slots`. Without it, 30 routes started in one second all read "0 busy" from `paseo ls` (agents are not registered yet) and all piled onto the same provider.
 */
export function claimSlot(un, provider, slots) {
  if (!un?.file || !Number.isFinite(slots)) return true;
  setMarker(un, provider);
  try {
    const stamp = (n) => Number(n.split("-")[2]?.replace(".json", "")) || 0;
    const live = readdirSync(un.dir).filter((n) => n.startsWith("t-") && Date.now() - statSync(join(un.dir, n)).mtimeMs < markerAge)
      .filter((n) => { try { return JSON.parse(readFileSync(join(un.dir, n), "utf8")).provider === provider; } catch { return false; } })
      .sort((a, b) => stamp(a) - stamp(b) || a.localeCompare(b));
    const rank = live.indexOf(basename(un.file));
    if (rank >= 0 && rank < slots) return true;
    setMarker(un, null); return false;
  } catch { return true; }
}

function main(argv) {
  if (argv[0] === "--resolve") { // print what an alias maps to right now
    try { console.log(resolveCached(argv[1], cliPaseo(process.env.PASEO_HOME))); return 0; } catch (e) { console.error(e.message); return 1; }
  }
  if (argv[0] === "--reap") { // detached reaper armed by park(): --reap <agentId> <parkedAt> <seconds> <home> <dir>
    const [, id, at, secs, h, d] = argv; if (!AGENT_ID_RE.test(id ?? "") || !(Number(secs) > 0) || !Number.isFinite(Number(secs))) return 2; const paseo = cliPaseo(h || process.env.PASEO_HOME);
    setTimeout(() => process.exit(reapParked(paseo, id, at, d || parkDir(h || undefined)) ? 0 : 1), Number(secs) * 1000); return null;
  }
  if (argv[0] === "reply") {
    const [, id, text, ...r] = argv;
    if (!id || !text) { console.error('usage: route.mjs reply <agentId> "<text>" [--home H]'); return 2; }
    const home = absPath((r.includes("--home") ? r[r.indexOf("--home") + 1] : undefined) ?? process.env.PASEO_HOME);
    { const e = inputError({ home }); if (e) { console.error("route: " + e); return 2; } }
    try { migrate(); } catch { /* best effort */ }
    const res = runReply(id, text, withRetry(cliPaseo(home)), loadRoutes(), { dir: parkDir(home) });
    console.log(JSON.stringify(res));
  if (!res.used && !res.status && (res.trace ?? []).every((t) => t.skip || t.error)) console.error(`route: no provider took this ${type} task (see trace). summarise/review run only on providers with an enforced read guard (a Qwen Code endpoint or claude-clean): add one with agent-hub provider add <name> --kind qwen-code --url <base>/v1 --model <id> --routes ${type}. code-edit works with codex or claude and needs --new-workspace worktree.`);
    return res.status === "completed" ? 0 : res.status === "asking" ? 3 : 1;
  }
  const [type, prompt, ...rest] = argv;
  const opt = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
  if (!type || !prompt) { console.error('usage: route.mjs <type> "<prompt>" [--provider P/M] [--cwd D] [--gate CMD] [--mode M] [--new-workspace worktree] [--session ID] [--dev D] [--client C] [--home H] [--keep]'); return 2; }
  const home = absPath(opt("--home") ?? process.env.PASEO_HOME);
  const cwd = absPath(normCwd(opt("--cwd") ?? process.cwd()));
  const dev = opt("--dev") ?? process.env.AGENT_HUB_DEV ?? os.userInfo().username.replace(/[^A-Za-z0-9._@:-]/g, "_");
  const early = inputError({ type, provider: opt("--provider"), cwd, home, mode: opt("--mode"), session: opt("--session") ?? process.env.AGENT_HUB_SESSION, dev, client: opt("--client") ?? process.env.AGENT_HUB_CLIENT });
  if (early) { console.error("route: " + early); return 2; }
  if (!existsSync(cwd)) { console.error(`route: --cwd ${cwd} is not an existing folder (on Windows pass C:/abs/path; Git-Bash /c/... is rewritten to C:/...)`); return 2; }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.random() * 2000); // stagger: many parallel routes must not hit the daemon in the same instant
  try { migrate(); } catch { /* best effort: an unreadable config is reported by the route itself */ } // idempotent: converts an older install's presets/twins and stale read-only modes before any task is routed
  const routes = loadRoutes();
  { const me = modeError(opt("--mode"), routes); if (me) { console.error("route: " + me); return 2; } }
  const pstate = providerState(withRetry(cliPaseo(process.env.PASEO_HOME)));
  const unmark = markActive(routes, opt("--provider"), undefined, pstate);
  let res;
  try { res = runRoute({
    providerState: pstate, marker: unmark, type, prompt: prompt + (readOnlyType(type, routes) ? "" : ASK_CLAUSE), provider: opt("--provider"), cwd, gate: opt("--gate"), mode: opt("--mode"), worktree: opt("--new-workspace") === "worktree",
    session: opt("--session") ?? process.env.AGENT_HUB_SESSION, dev,
    client: opt("--client") ?? process.env.AGENT_HUB_CLIENT, keep: rest.includes("--keep"), home, freeMem: () => os.freemem() / 2 ** 30,
  }, withRetry(cliPaseo(home)), routes); } finally { unmark(); }
  console.log(JSON.stringify(res));
  const bad = res.trace?.length === 1 && /^unknown provider id/.test(res.trace[0].error ?? "") ? res.trace[0].error : null;
  if (bad) { console.error("route: " + bad); return 2; }
  return res.used && res.status === "completed" ? 0 : res.status === "asking" ? 3 : 1; // 3 = parked, waiting for `agent-hub reply`
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { const c = main(process.argv.slice(2)); if (c !== null) process.exit(c); }
