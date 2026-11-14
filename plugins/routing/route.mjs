#!/usr/bin/env node
// Routing wrapper (decision 41): task type -> ordered provider/model chain; the caller may override;
// a provider at its slot limit is skipped and a failed or timed-out one falls to the next entry.
// shortcut: wrapper, not a daemon hook. agent.create.before has no labels and cannot spawn a replacement; move to a plugin if the hook grows.
// Usage: route.mjs reply <agentId> "<text>" | route.mjs --resolve <alias> | route.mjs <type> "<prompt>" [--provider P/M] [--cwd D] [--gate CMD] [--mode M] [--new-workspace worktree|--in-place] [--session ID] [--dev D] [--client C] [--home H] [--keep] [--mcp NAME[,NAME]]
import { modelNotAllowed } from "./allow.mjs";
import { outsideHours } from "./hours.mjs";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, rmdirSync, mkdtempSync, copyFileSync, realpathSync } from "node:fs";
import path, { basename, dirname, join, resolve, sep, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { gateDir, loadState, writeRequest, peekRequest } from "../gate/server/store.mjs";
import { appendLedger, ledgerLine, ledgerFile } from "./ledger.mjs";
import { runGate, gateOpts, EMPTY_TREE, hasSecret, gitSig, OVERRUN } from "../gate/server/gate.mjs";
import { resolveCached } from "./resolve.mjs";
import { migrate } from "../../scripts/provider.mjs"; // cyclic with provider.mjs, used only at call time
import { batchAllowed, pathAllowed } from "./readguard.mjs";
import { own } from "./jsonfile.mjs";
import { endpointSkip } from "./endpoint.mjs";
import { grantMcp, loadMcpAllow, MCP_ENV } from "./mcp-grant.mjs";
import { runDir, readStateJson, tryWriteState, paseoHome } from "./runstate.mjs";
import { acquireEntry, maxInFlight } from "./entry-gate.mjs";
import { recordHubWorktree, spoolCleanup, workspaceCapError } from "./guards.mjs";
import { effectiveBudget, chainOrder, costGb, laptopNow, availableGb, dropWslCache, heldIn, kindOf } from "./budget.mjs";

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
/** Per-attempt time limit by task type: a read-only task that gets no answer in this long fails that provider and the chain moves on. routes.timeouts.<type> overrides it. */
export const DEFAULT_TIMEOUTS = { review: "8m", summarise: "8m" };
export const attemptLimit = (o, routes) => toSeconds(o.waitTimeout ?? own(routes.timeouts, o.type) ?? own(DEFAULT_TIMEOUTS, o.type) ?? routes.waitTimeout ?? "10m");
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
  return (args, opts = {}) => {
    const create = args[0] === "run" && args.includes("--no-wait");
    if (args[0] === "pending") { // path-bearing pending permissions: the CLI's `permit ls` hides the path
      const q = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "pending.mjs")], { encoding: "utf8", timeout: 15_000, env });
      try { return JSON.parse(q.stdout); } catch { return { error: "pending permissions unreadable: " + String(q.stderr || q.stdout).slice(0, 200) }; }
    }
    const text = args[0] === "logs"; // `paseo logs` has no JSON output: hand back the raw text
    // Every CLI call is bounded (a hung `paseo logs` once held a route for the whole 15 min). Only wait/run legitimately run long; logs is short and retried once, then reported unreadable so the route still returns.
    const long = args[0] === "wait" || args[0] === "run";
    const timeout = opts.timeoutMs ?? (create ? createTimeoutS(env) * 1000 : text ? logsTimeoutS(env) * 1000 : long ? 15 * 60_000 : 2 * 60_000);
    const call = () => spawn(cmd, [...pre, ...cliArgs(args, home, !text)], { encoding: "utf8", timeout, killSignal: "SIGKILL", env });
    let r = call();
    if (text && r.error?.code === "ETIMEDOUT") { r = call(); if (r.error?.code === "ETIMEDOUT") return { error: `logs call hung and was killed after 2 x ${logsTimeoutS(env)} s` }; }
    if (opts.timeoutMs && r.error?.code === "ETIMEDOUT") return { error: `no answer in ${Math.round(opts.timeoutMs / 1000)} s: the call was stopped` };
    if (create && r.error?.code === "ETIMEDOUT") return { error: `CREATE_TIMEOUT: the daemon did not create the agent within ${createTimeoutS(env)} s (saturated daemon or a provider that stalls at initialize; upstream Paseo, not a worktree bug). Check \`paseo ls\` and the laptop load, then retry; raise AGENT_HUB_CREATE_TIMEOUT_S if the host is just slow.` };
    const out = r.stdout || "";
    if (text) return r.status === 0 ? { text: out } : { error: `exit=${r.status} ` + String(r.stderr || out).slice(0, 300) };
    try { return flattenError(JSON.parse(out.slice(out.search(/[[{]/)))); } catch { const t = String(r.stderr || out || "no output"); return { error: `exit=${r.status} ` + (t.length > 500 ? t.slice(0, 300) + " ... " + t.slice(-200) : t) }; }
  };
}

/** The Paseo CLI answers a failure as {"error":{"code":"AGENT_NOT_FOUND","message":"..."}}: an object. Every "not found|archived" check in the hub tests a STRING, so [object Object] never matched and cleanup jobs for agents that were already gone stayed in the spool forever (HUBFIX3: 17 jobs, one 43 s worktree call each, per pass). -> {error: "CODE: message"}. */
export function flattenError(j) { return j && typeof j === "object" && !Array.isArray(j) && j.error && typeof j.error === "object" ? { ...j, error: (`${j.error.code ?? "ERROR"}: ${j.error.message ?? ""}`.slice(0, 400)) + (j.error.code === "DAEMON_NOT_RUNNING" ? " -- the Paseo daemon is down or restarting (a restart takes about 1 min): retry the route in 1 min; do not start it yourself" : "") } : j; }
/** Paseo's 1.5 s status probe fails while the daemon is busy (upstream #6584): retry the call, nothing was started. */
export const transient = (j) => !j?.agentId && !/^CREATE_TIMEOUT|exited before initialization/.test(String(j?.error ?? "")) && j?.status !== "completed" && /DAEMON_UNREACHABLE|DAEMON_NOT_RUNNING|unreachable|ECONNREFUSED|ECONNRESET|timed? ?out|connection timed out|top-level await|^exit=(?!0)\d+|^exit=null/i.test(String(j?.error ?? ""));
/** A failed agent create arrives as "exit=1 Created workspace wks_... Tip: ... { error: { code: AGENT_CREATE_FAILED, message: ... } }": keep only the reason, in one plain line. */
export function plainError(e) {
  const t = String(e ?? ""); if (!/AGENT_CREATE_FAILED/.test(t)) return e;
  let msg = (/"message":\s*"((?:[^"\\]|\\.)*)"/.exec(t) ?? [])[1]; try { msg = JSON.parse(`"${msg}"`); } catch { /* keep the raw text */ }
  const lines = String(msg ?? t).split(/\r?\n/).map((x) => x.trim()).filter(Boolean); const last = lines.at(-1) ?? "";
  return `could not start: ${/^Not answering/i.test(last) ? last.replace(/^Not answering/i, "endpoint not answering") : (lines[0] ?? "no reason given").replace(/^Failed to create agent:\s*/i, "")}`;
}
export function withRetry(paseo, { tries = 6, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), jitter = () => Math.random() * 1000 } = {}) {
  return (args, opts) => {
    let j = paseo(args, opts);
    if (opts?.noRetry) return j; // a create the daemon may still be running: a resend only queues a duplicate behind the first
    for (let i = 1; i < tries && transient(j) && args[0] !== "stop"; i++) { sleep(2000 * 2 ** (i - 1) + jitter()); j = paseo(args, opts); }
    return j;
  };
}

/** Where Paseo puts a worktree: <home>/worktrees/<project hash>/<name>; found on disk, so asking the daemon is not needed. */
export const findWorktreeDir = (home, name) => { try { const r = join(home || join(os.homedir(), ".paseo"), "worktrees"); for (const h of readdirSync(r)) { const d = join(r, h, name); if (existsSync(join(d, ".git"))) return d.split(sep).join("/"); } } catch { /* none yet */ } return null; };
/**
 * `paseo worktree create` through a busy daemon (08-11: 80 active workspaces behind one git queue, a create took 4-15 min while the CLI gives up after 60 s). Never resent: the CLI's own 60 s timeout used to be retried 6 times
 * with the same branch (daemon log: "branch already exists" x5), and every provider of the chain created again, so one stuck route filled the daemon with 30 creates. Now ONE create per branch (at most 2 at once across
 * routes), progress on stderr, and after a client timeout the worktree folder is awaited on disk until `AGENT_HUB_CREATE_TIMEOUT_S` (240 s). Still absent: { daemonBusy } and the route stops (a provider cannot fix that).
 */
export function createWorktree(paseo, o, { sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), now = Date.now, log = (m) => console.error(m), find = findWorktreeDir, limitS = createTimeoutS() } = {}) {
  const name = "route-" + randomBytes(5).toString("hex"), t0 = now();
  let gate = null; if (o.ledgerDir) { try { gate = acquireEntry({ dir: join(o.ledgerDir, "wtcreate"), max: 2, waitMs: limitS * 1000, onWait: () => log("route: another worktree create is in progress: waiting for it (keeps the daemon's git queue short)") }); } catch { /* no gate */ } if (gate === null) return { daemonBusy: true, error: `WORKTREE_BUSY: waited ${limitS} s for a free create slot; other routes are creating worktrees: retry later` }; }
  try {
    log("route: creating the worktree (a busy daemon can take minutes; it is created once, not retried)");
    const c = paseo(["worktree", "create", "--mode", "branch-off", "--new-branch", name, "--base", o.base, "--cwd", o.cwd], { noRetry: true });
    if (c?.worktreePath && !c.error) return c;
    if (!/timeout|no answer|DAEMON_REQUEST_TIMEOUT|unreachable/i.test(String(c?.error ?? ""))) return c;
    for (;;) { // the CLI gave up but the daemon is still working on it
      const d = find(o.home, name); if (d) return { name, branchName: name, worktreePath: d };
      if ((now() - t0) / 1000 >= limitS) return { daemonBusy: true, error: `WORKTREE_CREATE_TIMEOUT: the daemon did not create the worktree within ${limitS} s (saturated daemon: too many active workspaces or other routes queued); nothing was retried. Run \`node plugins/routing/reaper.mjs --sweep --idle 5m\`, check \`paseo workspace ls\`, retry.` };
      sleep(3000);
    }
  } finally { gate?.release?.(); }
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
export function grantReads(paseo, j, timeoutS, ctx = {}, max = 8, left = () => timeoutS) {
  let refused = 0;
  for (let i = 0; i < max && j.status === "permission" && j.agentId; i++) {
    const pend = paseo(["pending"]);
    const mine = (Array.isArray(pend) ? pend : []).filter((p) => p.agentId === j.agentId);
    if (!mine.length) break;
    const roots = [ctx.cwd, ...(ctx.allow ?? [])].filter(Boolean);
    const v = batchAllowed(mine, roots);
    for (const p of mine) paseo(["permit", v.ok ? "allow" : "deny", j.agentId, p.id]);
    if (!v.ok && mine.every((p) => p.kind === "execute" || /shell|bash|command/i.test(String(p.name ?? "")))) { // HUBFIX3: the refusal text goes back to the agent, which may carry on with its own read tools; only a 3rd refusal ends the route (with the reason)
      refused++; if (refused >= 3) return { ...j, denied: v.why + " (refused " + refused + " times)" };
      const w2 = paseo(["wait", j.agentId, "--timeout", String(left())]);
      if (w2?.status === "idle") return { agentId: j.agentId, status: "completed" };
      if (w2?.status === "permission") { j = { agentId: j.agentId, status: "permission", denied: v.why }; continue; }
      return { ...j, denied: v.why };
    }
    if (!v.ok) return { ...j, denied: v.why };
    const w = paseo(["wait", j.agentId, "--timeout", String(left())]);
    j = { agentId: j.agentId, status: w?.status === "idle" ? "completed" : (w?.status ?? "error"), ...(w?.error ? { error: w.error } : {}) };
  }
  return j;
}
const TAG = /^\[[A-Z][A-Za-z_ ]*\](?: |$)/;
const trimEnd = (l) => { while (l.length && !l[l.length - 1].trim()) l.pop(); return l; };
const NL = String.fromCharCode(10);
const lines = (t) => String(t ?? "").replace(/\r\n/g, NL).split(NL);
/** Session id when --session is absent: AGENT_HUB_SESSION, else Claude Code's CLAUDE_CODE_SESSION_ID (set in every Bash call, inherited by its subagents), so any Claude helper lands under its session's usage counter. */
export const sessionFromEnv = (env) => env.AGENT_HUB_SESSION || env.CLAUDE_CODE_SESSION_ID || undefined;
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
/** A trace entry for a task that did not complete always says why. The daemon reports an agent that died at start (a launcher refusal such as "LAPTOP-REFUSED: free RAM 2.7 GB < 3") only as status "error" and keeps the reason in the agent log, so read the log: the text after the last "[System Error]" tag, the most telling line, capped at 200 characters. */
export function stopReason(j, paseo) {
  const st = j?.status ?? "error";
  const fallback = `agent ended with status ${st} and the daemon gave no reason${j?.agentId ? `: see \`paseo logs ${j.agentId}\`` : ""}`;
  if (!j?.agentId) return fallback;
  try {
    const t = lines(paseo(["logs", j.agentId])?.text);
    const i = t.map((l) => l.startsWith("[System Error]")).lastIndexOf(true);
    const ls = (i < 0 ? t : t.slice(i)).map((l) => l.replace(/^\[System Error\]\s*/, "").trim()).filter((l) => l && !/^warning: mcp server/i.test(l));
    const best = ls.find((l) => /refused|cannot|failed|error|timed? ?out|not found/i.test(l) && !/^ACP agent exited/i.test(l)) ?? ls.find((l) => !/^ACP agent exited/i.test(l)) ?? ls[0];
    return best ? `agent stopped (${st}): ${best.slice(0, 200)}` : fallback;
  } catch { return fallback; }
}
/** Appended to a read-only task on a small local model: the laptop 9B answered "k" and "apple" for a one-word file it never opened (no read call in the log), so the prompt says to open the file and not to answer from memory. */
export const READ_FIRST = "\n\n(Open every file named above with your file-reading tool before you answer. Answer only from what it returns, never from memory. If a file cannot be read, say that in one sentence.)";
/** Files a read-only agent may Read in `cwd` (what pathAllowed accepts, depth <= 3, at most `max`), as relative paths. Glob/Grep/LS are denied for it and Read of a folder fails, so without this list it cannot find the files (HUBFIX2, 11 of 20 summarise calls in the 14-11 pilot came back "could not read the folder"). */
export function listReadable(cwd, max = 60) {
  const out = [];
  const walk = (dir, depth) => {
    let names; try { names = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of names) {
      if (out.length >= max || e.name.startsWith(".") || e.name === "node_modules") continue;
      const f = join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(f, depth + 1); } else if (e.isFile() && pathAllowed(f, [cwd]).ok) out.push(relative(cwd, f).split(sep).join("/"));
    }
  };
  walk(cwd, 0);
  return out;
}
/** Task text for a read-only agent: the prompt plus the readable file list (see listReadable). */
export const withFileList = (prompt, cwd) => { const l = cwd ? listReadable(cwd) : []; return l.length ? `${prompt}

(Files you can open with your Read tool, one call per file, folders cannot be read: ${l.join(", ")})` : prompt; };
/** Why a completed read-only answer is not usable, or "". The answer IS the product of summarise/review, so an empty one or a short refusal ("I cannot complete this task. I am Qwen Code...") falls through to the next chain entry like an error does. */
export function unusableAnswer(text) {
  const t = String(text ?? "").trim();
  if (!t) return "the agent completed with an empty answer";
  if (t.length < 600 && /^(i cannot|i can't|i am unable|i'm unable|i am sorry|i'm sorry|sorry,|i am qwen code|as an ai)/i.test(t)) return `the agent refused: ${t.replace(/\s+/g, " ").slice(0, 120)}`;
  if (t.length < 1500 && /(couldn'?t|could not|can'?t|cannot|unable to|wasn'?t able to|not able to) (read|open|access|list)\b[^.]{0,80}\b(folder|director|files?|path)|read-only (task|hook)[^.]{0,60}(refus|denied|not allowed|blocked)|(refused|blocked|denied) by (a |the )?(PreToolUse )?hook/i.test(t)) return `the agent could not read its inputs: ${t.replace(/\s+/g, " ").slice(0, 120)}`;
  return "";
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
  if (!x.a.answer) return { ...r, answer: "", answerReason: x.f?.error || typeof x.f?.text !== "string" ? "logs unreadable: " + String(x.f?.error ?? "no text returned").slice(0, 120) : "the agent log holds no assistant text (or only Paseo's empty-state text)" };
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
/** Every git call on a folder an agent can write runs with repo config that could execute code switched off (fsmonitor, hooks) and no system config. Empty hooks dir = an empty folder under the temp dir. */
export function safeGit(cwd, args) {
  const hooks = join(os.tmpdir(), "agent-hub-no-hooks"); try { mkdirSync(hooks, { recursive: true }); } catch { /* best effort */ }
  return spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", `core.hooksPath=${hooks.split(String.fromCharCode(92)).join("/")}`, ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
}
/**
 * Diff of an agent's worktree against its start commit, written to outFile (returns the path, or null when nothing changed). Nothing the agent can write is trusted: git runs on a SCRATCH git dir (empty config, no hooks, objects borrowed read-only through GIT_ALTERNATE_OBJECT_DIRECTORIES), so a filter / textconv / ext-diff driver planted in the worktree's .gitattributes or the repo config is never defined there and cannot run, and `git add` never touches the agent's own index or config.
 */
export function harvestPatch(wtPath, base, outFile) {
  let tmp = null;
  try {
    const common = safeGit(wtPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.status !== 0) return null;
    tmp = mkdtempSync(join(os.tmpdir(), "agent-hub-harvest-"));
    const empty = join(tmp, "empty"); writeFileSync(empty, ""); const gd = join(tmp, "gd"), hooks = join(tmp, "hooks"); mkdirSync(hooks);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: empty, GIT_ATTR_NOSYSTEM: "1", GIT_DIR: gd, GIT_WORK_TREE: wtPath, GIT_INDEX_FILE: join(tmp, "index"), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common.stdout.trim(), "objects") };
    const g = (a) => { const r = spawnSync("git", ["-c", `core.attributesFile=${empty.split(sep).join("/")}`, "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${hooks.split(sep).join("/")}`, ...a], { cwd: tmp, encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 }); if (process.env.HARVEST_DEBUG && r.status !== 0) console.error(a.join(" "), r.stderr); return r; };
    if (spawnSync("git", ["init", "-q", "--bare", gd], { cwd: tmp, env: { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).status !== 0) return null;
    if (g(["read-tree", base]).status !== 0 || g(["add", "-A"]).status !== 0) return null;
    const d = g(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", base]);
    if (d.status !== 0 || !d.stdout) return null;
    mkdirSync(dirname(outFile), { recursive: true }); writeFileSync(outFile, d.stdout);
    return outFile.split(sep).join("/");
  } catch (e) { if (process.env.HARVEST_DEBUG) console.error(e); return null; } finally { if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
}
export function headSha(cwd) {
  const inRepo = safeGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inRepo.status !== 0) return null;
  const r = safeGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  return r.status === 0 ? r.stdout.trim() : EMPTY_TREE;
}

/** In-place edit guard: "" when cwd is a git work tree with nothing uncommitted (git can revert whatever the agent does), else the reason it is not. */
export function cleanGitReason(cwd) {
  const g = (a) => safeGit(cwd, a);
  if (g(["rev-parse", "--is-inside-work-tree"]).status !== 0) return "not a git work tree";
  // --ignored=no: a normal repo always holds ignored files (node_modules, build output), so they do not count as dirty; they are unprotected in in-place mode (see README)
  const s = g(["status", "--porcelain", "--ignored=no"]);
  return s.status !== 0 ? "git status failed" : s.stdout.trim() ? "has uncommitted changes" : "";
}
/** { branch, headSha } of a folder, {} when it is not a git work tree: lets a caller cherry-pick without grepping. */
export function gitInfo(dir) {
  const g = (a) => { const r = safeGit(dir, a); return r.status === 0 ? r.stdout.trim() : ""; };
  const headSha = g(["rev-parse", "--verify", "HEAD"]); if (!headSha) return {};
  const branch = g(["rev-parse", "--abbrev-ref", "HEAD"]);
  return { ...(branch && branch !== "HEAD" ? { branch } : {}), headSha };
}
/** A failed attempt that says the account is out of quota / at its usage limit (not a transient rate limit, which withRetry handles). */
export const LIMIT_RE = /usage limit|quota|hit your limit|limit reached|exceeded your|out of (extra )?usage|insufficient credits/i;
/** When that limit lifts, from the message ("try again at Nov 11th, 2026 9:00 AM", "resets on 2026-11-11", "in 3 hours"), else one hour after `now`. */
export function limitUntil(text, now = Date.now()) {
  const t = String(text ?? "");
  const rel = /\bin (\d+)\s*(hour|hr|minute|min|day)/i.exec(t);
  if (rel) return now + Number(rel[1]) * { hour: 3.6e6, hr: 3.6e6, minute: 6e4, min: 6e4, day: 864e5 }[rel[2].toLowerCase()];
  const abs = /(?:until|at|on|resets?(?: at| on)?)\s+([A-Z][a-z]{2,8}\.? \d{1,2}(?:st|nd|rd|th)?,? (?:\d{4},? ?)?\d{1,2}:\d{2}\s*(?:[AP]M)?|\d{4}-\d{2}-\d{2}[T ]?[\d:.Z+-]*)/.exec(t);
  const d = abs ? Date.parse(abs[1].replace(/(\d)(st|nd|rd|th)/, "$1")) : NaN;
  return Number.isFinite(d) && d > now ? d : now + 36e5;
}
const limitsFile = (o) => join(o.limitsDir ?? (() => { try { return runDir(); } catch { return os.tmpdir(); } })(), "limits.json");
const readLimits = (o) => readStateJson(limitsFile(o)) ?? {};
/** A provider that just failed to START an agent (ACP process exited, spawn error, "could not start") is skipped by every route for a short while and the shared provider-list cache is dropped, so a stale "enabled" can never make a route try it again (14-11: qwen-code-laptop had no GPU, the cache still said ready). */
export const START_FAIL_RE = /^could not start|ACP agent( process)? exited|failed to (create|start) agent|spawn .*(ENOENT|EACCES)|provider .*(unavailable|not available)/i;
export const PROVIDER_FAIL_TTL_MS = 120_000;
const failFile = (o) => join(o.limitsDir ?? (() => { try { return runDir(); } catch { return os.tmpdir(); } })(), "provider-fail.json");
const readFails = (o) => readStateJson(failFile(o)) ?? {};
const markStartFail = (o, id) => { tryWriteState(failFile(o), { ...readFails(o), [id]: (o.now ?? Date.now)() + PROVIDER_FAIL_TTL_MS }); if (o.providerCache) { try { rmSync(o.providerCache, { force: true }); } catch { /* best effort */ } } };

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

/** A gate that saw no change at all is not a PASS for an edit task. */
const judgeNoDiff = (r, cwd) => r.status === "PASS" && !r.noRepo && r.files === 0 && r.changed === 0 ? { ...r, status: "FAIL", reasons: ["no diff produced: the agent changed nothing in " + cwd] } : r;

/** Read-only post-check: null = unchanged, else the reason. Uses the git fingerprint taken before the run; with none (not a git tree, an old request) the folder snapshot hash; with neither the task is unverifiable, never a PASS. */
export function roProblem(cwd, { sig, guardHash } = {}) {
  if (sig?.endsWith(OVERRUN)) return "unverifiable: the ignored files under " + cwd + " are too many to fingerprint within the budget (cannot show a read-only task changed nothing)";
  if (sig) return gitSig(cwd) === sig ? null : "read-only task changed the work tree in " + cwd;
  if (guardHash) return sha(snapshot(cwd)) === guardHash ? null : "read-only task changed files in " + cwd;
  return "unverifiable: no before-state was recorded for this read-only task (cannot show it changed nothing)";
}

/** Run the gate in the agent's cwd with the same options the plugin hook uses (gateOpts). First failure: re-prompt once (decision 47) and block until the agent is idle; freeze it; second gate. */
export function callerGate(o, agentId, paseo, gate = runGate, routes = {}) {
  // `paseo ls` abbreviates the home folder as "~"
  // `paseo ls` can fail or miss the agent while the daemon is busy: fall back to the cwd the route started the agent in
  const cwdOf = () => agentCwd(paseo, agentId) ?? o.knownCwd; // ONE `paseo ls` (it lists every agent; two in a row doubled the load on a busy daemon), then the cwd the route started the agent in
  const cwd = cwdOf();
  if (!cwd) return { status: "FAIL", reasons: ["agent cwd unknown: gate not run"], attempts: 0 };
  // a gate that saw no change at all is not a PASS for an edit task: the agent produced nothing (the fake gates of older callers carry no counts, so they are unaffected)
  // read-only task: "no diff" is the expected result; instead the work tree must be exactly as it was (o.roSig, taken before the agent started)
  const judge = o.ro ? (r) => r : (r) => judgeNoDiff(r, cwd);
  // the secret scan is bounded too (a 1,800-file folder held a slot for 3+ min per gate, twice): at least 120 s, at most until the attempt deadline
  const gopts = () => ({ ...gateOpts(routes, cwd, o.gate, o.base, o.maxLines), ...(o.ro ? { readOnly: true } : {}), ...(o.deadlineMs ? { deadlineMs: Math.max(o.deadlineMs, (o.now ?? Date.now)() + 120_000) } : {}) });
  let res = judge(gate(cwd, gopts()));
  if (o.ro) { // no re-prompt for a read-only task: a changed tree or a failed command is the result
    const reasons = [...(res.reasons ?? [])]; { const why = roProblem(cwd, { sig: o.roSig, guardHash: o.roGuardHash }); if (why) reasons.push(why); }
    return reasons.length ? { status: "FAIL", reasons, attempts: 1 } : { status: "PASS", reasons: [], attempts: 0 };
  }
  if (res.status === "PASS") return { status: "PASS", reasons: [], attempts: 0 };
  if (routes.gateRetry === false) return { status: "FAIL", reasons: res.reasons, attempts: 1 };
  const fail = (why) => ({ status: "FAIL", reasons: [...res.reasons, why], attempts: 1 });
  const s = paseo(["send", agentId, "--", "Your work failed the gate: " + res.reasons.join("; ") + "\nFix it and finish."]);
  if (s?.error) return fail("re-prompt failed: " + String(s.error).slice(0, 120));
  // bounded by the attempt deadline (waitTimeout): this was a flat 900 s on top of the 10-15 min run, so a route lived 32-37 min holding its slot. At least 60 s so the retry gets a real chance.
  const waitS = Math.min(900, Math.max(60, Math.ceil(((o.deadlineMs ?? Infinity) - (o.now ?? Date.now)()) / 1000)));
  const w = paseo(["wait", agentId, "--timeout", String(waitS)], { timeoutMs: (waitS + 30) * 1000 });
  if (w?.error) return fail("wait for re-prompt failed: " + String(w.error).slice(0, 120));
  const st = paseo(["stop", agentId]);
  if (st?.error && !/AGENT_NOT_FOUND|No agent found/.test(String(st.error))) return fail("could not freeze the agent: " + String(st.error).slice(0, 120));
  // freeze: the second gate must judge the final tree, not one the agent is still editing
  res = judge(gate(cwdOf() ?? cwd, gopts()));
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
  { const r = paseo(["archive", rec.agentId, "--force"]); if (r?.error && !/not found|archived/i.test(String(r.error))) { paseo(["stop", rec.agentId]); paseo(["archive", rec.agentId]); } }
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
  const g = callerGate({ gate: rec.gate, base: rec.base, maxLines: rec.maxLines }, agentId, paseo, gate, routes);
  trace.push({ provider: rec.provider, gate: g.status, ...(g.reasons.length ? { reasons: g.reasons } : {}), attempts: g.attempts });
  const out = withAnswer({ used: rec.provider, agentId, status: g.status === "PASS" ? "completed" : "gate-failed", gate: g, trace }, paseo, answerRetryMs);
  if (!rec.keep) retireParked(paseo, rec);
  return out;
}

/** Allow-lists for every CLI/MCP value that becomes a paseo argument, a label or a path. Free text (prompt, reply text, --gate command) is the task itself and is not listed here. */
const ALLOW = {
  type: /^[a-z][a-z0-9-]{0,31}$/,
  provider: /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/,
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
export function permissionHint({ o, mode, ro, wt, paseo, agentId, gate = runGate, routes = {}, denied }) {
  const m = mode ?? "provider default";
  if (ro) return `read-only task ${o.type} (mode ${m}) asked for a permission it may not have (it can only read plain files inside the task folder; sensitive files, writes and shell are refused)` + (denied ? `; refused: ${denied}` : "");
  if (!o.worktree) return `edit task ${o.type} ran outside a worktree (mode ${m}) and asked for a permission the provider default mode does not grant: pass --new-workspace worktree, or --in-place on a clean git work tree (full-access is dropped otherwise, decision 21)`;
  const why = [];
  try { const g = gate(wt.path, gateOpts(routes, wt.path, undefined, o.base)); why.push(...(g?.reasons ?? []).filter((r) => /secret/i.test(r))); } catch { /* the gate result is only an explanation */ }
  try { const pend = paseo(["pending"]); for (const p of (Array.isArray(pend) ? pend : []).filter((x) => x.agentId === agentId)) why.push(`pending ${p.name ?? p.kind ?? "request"}${p.paths?.length ? " on " + p.paths.join(", ") : ""}`); } catch { /* optional */ }
  return `agent in the worktree (type ${o.type}, mode ${m}) stopped on a permission request that was not granted` + (why.length ? `: ${why.join("; ")}` : ` (no secret pattern found in its tree and no pending request visible: check \`paseo logs ${agentId ?? "<agent>"}\`)`);
}
/** An unknown --mode is refused loudly (it used to be dropped silently on read-only types); null when fine or absent. */
export const modeError = (mode, routes = {}) => (mode === undefined || mode === null || knownModes(routes).has(mode) ? null : `unknown --mode "${mode}": use one of ${[...knownModes(routes)].filter((m) => !m.startsWith("http")).sort().join(", ")} (read-only task types always run read-only whatever --mode says)`);
/** Drain functions of the routes running in this process: main()'s exit/signal handler runs them. */
export const ACTIVE = new Set();
/** Providers whose launcher (deploy/shared/acp-grant.mjs, deploy/office/office-agent.mjs) honours the HUB_MCP grant. */
const MCP_LANES = /^(qoder|qwen)/;
export function runRoute(o, paseo, routes, gate = runGate) {
  const bad = inputError(o) ?? modeError(o.mode, routes); if (bad) return { used: null, status: "error", trace: [{ error: bad }] };
  // a credential in the task or the gate command is refused before anything is created or sent (same scanner as reply and the diff gate; fails closed when the scanner is missing)
  try { if ((o.scan ?? hasSecret)([o.prompt, o.gate].filter((x) => typeof x === "string").join(String.fromCharCode(10)))) return { used: null, status: "rejected", error: "task rejected: the prompt or --gate looks like it contains a credential, token or key. Remove it (pass it by an environment variable the command reads) and run again.", trace: [] }; }
  catch (e) { return { used: null, status: "rejected", error: "task rejected: " + e.message, trace: [] }; }
  const chain = o.provider ? [o.provider] : own(routes.routes, o.type);
  if (!chain) return { used: null, trace: [{ error: `unknown task type ${o.type}` }] };
  if (!chain.length) return { used: null, trace: [{ error: `no provider configured for ${o.type}: add one in Settings > Providers` }] };
  const trace = [];
  const lapNow = () => (o.laptop ? o.laptop() : o.freeMem ? { freeGb: o.freeMem() } : {}); // no laptop reader (unit tests): no laptop limit
  const heldOthers = () => (o.marker?.dir ? heldIn(o.marker.dir).filter((x) => x.n !== basename(o.marker.file)).length : 0);
  let slots = routes.slots ?? {}; // per-provider slots after a disabled provider's slots moved to the enabled ones (budget.mjs); set once the provider state is known
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
  // `paseo ls` lists every agent of the daemon and costs a CLI process + websocket each time: the per-entry busy check reads one list at most every 5 s per route (the retire path below always reads fresh)
  let lsAt = 0, lsRows; const lsCached = () => { const t = (o.now ?? Date.now)(); if (lsRows === undefined || t - lsAt > 5000 || Array.isArray(lsRows) === false) { lsRows = paseo(["ls"]); lsAt = t; } return lsRows; };
  const projects = () => { try { const r = paseo(["project", "ls"]); return Array.isArray(r) ? r : []; } catch { return []; } };
  const pnorm = (p) => String(p ?? "").split(String.fromCharCode(92)).join("/").replace(/\/+$/, "").toLowerCase();
  const projBefore = o.keep ? null : new Set(projects().map((p) => p.projectId));
  const dropProjects = (wt) => {
    const targets = [o.cwd, wt?.path].filter(Boolean).map(pnorm);
    const rows = paseo(["ls"]); const live = (Array.isArray(rows) ? rows : []).filter((a) => String(a.status).toLowerCase() === "running").map((a) => pnorm(a.cwd?.replace(/^~(?=[\/])/, os.homedir())));
    for (const p of projects()) if (!projBefore.has(p.projectId) && targets.includes(pnorm(p.path)) && !live.includes(pnorm(p.path))) paseo(["project", "delete", p.projectId]);
  };
  // Every agent this route creates is tracked until it is archived. `archive --force` interrupts a running agent and ends its CLI process tree (verified on Windows; `stop` alone leaves the CLI alive), retried once, then stop + archive.
  const live = new Map(); // key -> { id, wt }: created and not yet retired
  const rid = randomBytes(4).toString("hex"); let unnamed = false; // unnamed: a create call returned no agent id (timeout), found again by its route/run label
  const ledger = () => { // survives a hard kill of this process (no handler can run then): the hub reaper archives these agents once this pid is dead
    if (!o.ledgerDir || o.keep) return;
    const f = join(o.ledgerDir, `agents-${process.pid}.json`);
    if (!live.size && !wsOpen.size) { try { rmSync(f, { force: true }); } catch { /* gone */ } return; }
    tryWriteState(f, { pid: process.pid, home: o.home ?? null, cwd: o.cwd, agents: [...live.values()].filter((v) => !v.run).map((v) => ({ id: v.id ?? null, wt: v.wt ? { name: v.wt.name } : null })), workspaces: [...wsOpen], runs: [...live.values()].some((v) => v.run) ? [rid] : [] }); // runs: a create call is in flight and its agent id is not known yet (found by the route/run label)
  };
  // A plain (non-worktree) run makes the daemon open a NEW local workspace per call even for a shared cwd, and nothing maps an agent back to it (paseo ls has no workspace id). So the route creates its workspace itself, runs in it with --workspace and archives exactly that id with its agent.
  const wsOf = new Map(), wsOpen = new Set(); // agentId -> workspaceId; workspaces created and not yet archived (also in the ledger, for a route that dies)
  const archiveWs = (w) => { if (!w) return; wsOpen.delete(w); const r = paseo(["workspace", "archive", w]); if (r?.error && !/not found|archived/i.test(String(r.error))) paseo(["workspace", "archive", w]); ledger(); };
  const track = (id, wt) => { if (o.keep || (!id && !wt)) return; live.set(id ?? "wt:" + wt.name, { id, wt }); ledger(); };
  const archive = (id) => { let r = paseo(["archive", id, "--force"]); if (r?.error && !/not found|archived/i.test(String(r.error))) r = paseo(["archive", id, "--force"]); if (r?.error && !/not found|archived/i.test(String(r.error))) { paseo(["stop", id]); paseo(["archive", id]); } };
  const retire = (id, wt, defer = false) => {
    if (o.keep) return;
    // finished route: free the slot first, archive later (guards.mjs spool; the slow daemon archive used to hold the slot 40-55 s per call). Failed attempts still retire in line.
    if (defer && o.deferCleanup && o.ledgerDir && (id || wt)) { try { spoolCleanup(o.ledgerDir, { agentId: id ?? null, workspaceId: wsOf.get(id) ?? null, wt: wt ? { name: wt.name, path: wt.path } : null, cwd: o.cwd, home: o.home ?? null }); live.delete(id ?? "wt:" + wt?.name); if (id && wt) live.delete("wt:" + wt.name); wsOpen.delete(wsOf.get(id)); ledger(); return; } catch { /* spool unwritable: archive in line */ } }
    if (id) { archive(id); archiveWs(wsOf.get(id)); }
    if (wt) { const rows = paseo(["workspace", "ls", "--json"]); for (const w of Array.isArray(rows) ? rows : []) if (w.workspaceId && String(w.cwd ?? "").split("\\").join("/").toLowerCase() === wt.path.split("\\").join("/").toLowerCase()) paseo(["workspace", "archive", w.workspaceId]); paseo(["worktree", "archive", wt.name, "--cwd", o.cwd]); }
    live.delete(id ?? "wt:" + wt?.name); if (id && wt) live.delete("wt:" + wt.name);
    dropProjects(wt); ledger();
  };
  // runs on every exit of the loop below (ok, gate fail, error, usage limit, timeout, refusal, an exception) and from the exit/signal handler in main()
  const drain = () => {
    if (o.keep) return;
    for (const v of [...live.values()]) { if (v.run) continue; try { retire(v.id, v.wt); } catch { /* keep going: the reaper retries */ } }
    if (unnamed) { const r = paseo(["ls", "--label", `route/run=${rid}`]); for (const a of Array.isArray(r) ? r : []) { try { archive(a.id); } catch { /* the reaper retries */ } } unnamed = false; }
  };
  // edit types report where the work is (branch, headSha, and the worktree the hub made) before retire can remove the worktree
  // The route-created worktree is archived by retire, and an agent that edited without committing loses its diff with it (09-11: CR-004 "gate PASS", worktree gone, branch route-1c96f76704 empty). Save the diff against the start commit first.
  const savePatch = (wt) => { if (!wt || !o.base) return {}; const f = harvestPatch(wt.path, o.base, join(o.home || paseoHome(), "route-patches", wt.name + ".patch")); return f ? { patch: f } : {}; };
  const done = (r, wt) => { const info = readOnlyType(o.type, routes) ? {} : { ...gitInfo(wt?.path ?? o.cwd), ...(wt ? { worktree: wt.path, ...savePatch(wt) } : {}) }; retire(r.agentId, wt, true); return { ...r, ...info }; };
  let partial = null; let ramLeftMs;
  // providers the daemon really has: a route entry for an id nobody configured is skipped, never sent to the daemon (null = list unavailable: no filtering)
  const state = o.providerState !== undefined ? o.providerState : providerState(paseo); // provider id -> enabled (null = list unavailable: no filtering)
  const installed = state ? new Set(state.keys()) : null;
  if (routes.slots) slots = budgetFor(routes, state, {}, 0).perProvider;
  ACTIVE.add(drain);
  try {
  for (const entry of chain) {
    let prov;
    try { prov = resolveCached(entry, paseo); } catch (e) { trace.push({ provider: entry, error: String(e.message) }); continue; }
    if (installed && !installed.has(base(prov))) { trace.push({ provider: prov, skip: "provider not configured: add it in Settings > Providers" }); continue; }
    if (state && state.get(base(prov)) === false) { trace.push({ provider: prov, skip: "provider disabled or unavailable in Paseo (Settings > Providers)" }); continue; }
    { const until = Number(readLimits(o)[base(prov)]); if (until > (o.now ?? Date.now)()) { trace.push({ provider: prov, skip: `${base(prov)}: usage limit until ${new Date(until).toISOString()}, skipped` }); continue; } }
    { const until = Number(readFails(o)[base(prov)]); if (until > (o.now ?? Date.now)()) { trace.push({ provider: prov, skip: `${base(prov)} failed to start a moment ago: skipped for ${Math.ceil((until - (o.now ?? Date.now)()) / 1000)} s` }); continue; } }
    { const dn = o.endpointDown?.(base(prov)); if (dn) { trace.push({ provider: prov, skip: dn }); continue; } } // a known-down endpoint is skipped at once, not retried for minutes
    { const oh = outsideHours(routes, entry, (o.now ?? Date.now)()); if (oh) { trace.push({ provider: prov, skip: oh }); continue; } } // chain entry with a time window (routes.hours)
    { const na = modelNotAllowed(routes, prov); if (na) { trace.push({ provider: prov, skip: na }); continue; } }
    if (o.mcp && !MCP_LANES.test(base(prov))) { trace.push({ provider: prov, skip: `--mcp: ${base(prov)} has no hub MCP grant launcher (only Qoder and Qwen Code lanes do); skipped` }); continue; } // Routing & slots model allow-list
    const rows = lsCached();
    const busy = (Array.isArray(rows) ? rows : []).filter((a) => String(a.status).toLowerCase() === "running" && a.provider === base(prov)).length;
    if (busy >= (own(slots, base(prov)) ?? 99)) { trace.push({ provider: prov, skip: `busy ${busy}/${own(slots, base(prov))}` }); continue; }
    if (!claimSlot(o.marker, base(prov), own(slots, base(prov)))) { trace.push({ provider: prov, skip: `slots full: ${own(slots, base(prov))} other routes already hold ${base(prov)}` }); continue; }
    const tEntry = (o.now ?? Date.now)(); // the per-attempt time limit starts here, so the RAM wait below counts inside it
    // RAM admission (09:10-09:14 hang: 15 tasks, <1 GB free): wait with backoff for free RAM before creating an agent; give up on this entry at waitTimeout. Only when the caller passes freeMem (main() does; unit tests that do not, never read the real machine).
    if (o.freeMem) {
      const floor = routes.minFreeRamGbByProvider?.[base(prov)] ?? routes.minFreeRamGb ?? 2;
      const sleep = o.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
      ramLeftMs ??= Math.min(attemptLimit(o, routes), toSeconds(routes.resourceWait ?? "90s")) * 1000; // a resource wait is bounded: after that the next provider is tried
      // Hold until this laptop can carry one more agent: free RAM above the provider's floor AND the laptop budget (budget.mjs) not used up by the routes already running. A waiting route is "queued" (holds no slot) and starts no CLI.
      const blocked = () => {
        if (o.freeMem() < floor) return `low RAM: ${o.freeMem().toFixed(1)} GB free, floor ${floor} GB`;
        const held = heldOthers(); const lap = lapNow(); const b = budgetFor(routes, state, kindOf(base(prov)) === "local" ? lap : { ...lap, cpuPct: undefined }, held); // CPU load only gates a model that computes on this laptop; claude/codex/qoder run their model remotely
        return b.laptopCap !== null && held >= b.effective ? `laptop budget ${b.effective} used up (configured ${b.configured}): ${b.reasons.filter((r) => r.startsWith("laptop")).join("; ") || "all slots busy"}` : null;
      };
      let why = blocked(); let waited = false;
      if (why && kindOf(base(prov)) === "local") { setMarker(o.marker, null); trace.push({ provider: prov, skip: why + ": this model runs on the laptop, so it is skipped at once and the next provider is tried" }); continue; }
      if (why) {
        setMarker(o.marker, null); waited = true; trace.push({ provider: prov, note: `waiting, nothing started: ${why}` });
        if (routes.dropWslCache === true) { const l = (o.dropCache ?? (() => dropWslCache({ logDir: o.marker?.dir })))(); if (l) trace.push({ provider: prov, note: l }); why = blocked(); }
      }
      let wait = 2000; while (why && ramLeftMs > 0) { const w = Math.min(wait, ramLeftMs); sleep(w); ramLeftMs -= w; wait = Math.min(wait * 2, 30000); why = blocked(); }
      if (why) { trace.push({ provider: prov, skip: why }); continue; }
      if (waited && !claimSlot(o.marker, base(prov), own(slots, base(prov)))) { trace.push({ provider: prov, skip: `slots full: ${own(slots, base(prov))} other routes already hold ${base(prov)}` }); continue; }
    }
    const labels = { "route/type": o.type, "route/provider": prov, "route/run": rid, ...(process.env.CLAUDE_CODE_SESSION_ID && process.env.CLAUDE_CODE_SESSION_ID !== o.session ? { claude_session: process.env.CLAUDE_CODE_SESSION_ID } : {}), ...(o.keep ? { "route/keep": "1" } : {}), dev: o.dev, caller: o.client, session: o.session };
    let wt = null; // this entry's route-created worktree
    // Qwen read-only: the launcher (acp-proxy.mjs) offers the session mode "read-only"; choosing it restarts qwen with the deny settings (config/qwen/system-settings-readonly.json). Nothing is ever written under the task cwd.
    const lim = attemptLimit(o, routes); const t0 = tEntry; const left = () => Math.max(1, Math.round(lim - ((o.now ?? Date.now)() - t0) / 1000)); // one provider attempt gets lim seconds in all (run, waits, permission rounds)
    const args = ["run", "--cwd", o.cwd, "--provider", prov, "--wait-timeout", `${left()}s`];
    const ro = readOnlyType(o.type, routes); // read-only types: the provider's read-only mode, whatever the caller or the routes file asks for
    if (ro && !readOnlyMode(base(prov), routes)) { trace.push({ provider: prov, skip: "provider has no verified read-only mode (read-only task types never run on it; for a Qwen provider run `agent-hub provider migrate`)" }); continue; }
    if (ro && !readOnlyEnforced(base(prov), routes)) { trace.push({ provider: prov, skip: "no enforced sensitive-read guard for this provider (read-only task types never run on it)" }); continue; }
    const mode = ro ? readOnlyMode(base(prov), routes) : o.mode ?? own(routes.modes, base(prov)) ?? routes.mode; // per-provider default: codex full-access, claude bypassPermissions ...
    if (o.worktree) {
      // The task's start commit and gate request must exist BEFORE the agent can act, and must not come from state the agent can write at turn end. So the route creates the worktree itself, from the pinned base commit, and registers the request under its path before `run`: the hook finds it by the agent's cwd. No request = the hook fails closed.
      if (!o.base) o.base = headSha(o.cwd);
      if (!o.base || o.base === EMPTY_TREE) { trace.push({ provider: prov, error: "worktree task needs a git repo with at least one commit (the base commit is pinned at creation)" }); continue; }
      const c = createWorktree(paseo, o);
      if (c?.daemonBusy) { trace.push({ provider: prov, error: c.error }); break; } // the daemon, not this provider, is the bottleneck: the next provider would queue another create behind this one
      if (!c?.worktreePath || c.error) { trace.push({ provider: prov, error: "worktree create failed: " + String(c?.error ?? "no path returned").slice(0, 200) }); continue; }
      wt = { name: c.name, path: c.worktreePath }; track(null, wt);
      if (o.ledgerDir) recordHubWorktree(o.ledgerDir, c.worktreePath); // provably ours: the idle-workspace sweep may archive it (guards.mjs)
      args[2] = wt.path;
      writeRequest(o.gateDir ?? gateDir(), wt.path, o.gate, o.base, { readOnly: ro, maxLines: o.maxLines });
    }
    // an unsafe mode also runs in place when --cwd is a git work tree with nothing uncommitted (git can revert it); dirty or non-git stays on the provider default, with the reason
    // fail closed: full access in place only with the explicit --in-place flag AND a clean git work tree; .git and paths outside cwd are not protected then
    const inPlaceWhy = mode && !o.worktree && o.inPlace && unsafeMode(mode) ? cleanGitReason(o.cwd) : null;
    if (mode && (o.worktree || !unsafeMode(mode) || inPlaceWhy === "")) args.push("--mode", mode);
    // --in-place on a dirty tree: refuse the whole route at once (a run without edit rights only confuses the model; every provider would hit the same)
    else if (mode && o.inPlace && inPlaceWhy) { trace.push({ provider: prov, error: `--in-place refused: the work tree is not clean (${inPlaceWhy}); commit or stash first, or use --new-workspace worktree` }); break; }
    else if (mode === "bypassPermissions" && !ro) { trace.push({ provider: prov, skip: "claude default mode asks before every write, and bypassPermissions is dropped outside a worktree (decision 21): it cannot edit here; use --in-place or --new-workspace worktree" }); continue; } // HUBFIX3: scaf-1 burned 116 s on Haiku that could only ask "[ASK] wait for Write?"
    else if (mode) trace.push({ provider: prov, note: `mode ${mode} dropped: ` + (!o.inPlace ?"use --in-place to edit this worktree directly, or --new-workspace worktree" : `--in-place needs a clean git work tree (--cwd ${inPlaceWhy}); commit or stash first, or use --new-workspace worktree`) });
    for (const [k, v] of Object.entries(labels)) if (v) args.push("--label", `${k}=${v}`);
    if (o.mcp) { const g = grantMcp({ names: o.mcp, allow: o.mcpAllow ?? loadMcpAllow(), readOnly: ro }); if (g.refused) { trace.push({ provider: prov, error: g.refused }); break; } args.push("--env", `${MCP_ENV}=${g.servers.map((x) => x.name).join(",")}`); } // names only: the provider launcher re-resolves them against the hub allowlist
    // caller-supplied gate (decision 47) goes to the plugin-side store, not into agent-writable labels (worktree runs registered theirs above, under the worktree path)
    if (!o.base) o.base = headSha(o.cwd); // the task starts here: the gate diffs against it so committed work is judged too
    const sig0 = ro ? gitSig(o.cwd) : null; // read-only: fingerprint of the work tree before the agent starts (null outside git)
    if (!o.worktree && (ro || o.gate || o.base)) writeRequest(o.gateDir ?? gateDir(), o.cwd, o.gate, o.base, { readOnly: ro, maxLines: o.maxLines, sig: sig0, guardHash: ro ? sha(snapshot(o.cwd)) : null });
    // worktree runs: create without waiting (the create call is bounded by cliPaseo), then wait for the agent separately
    args.push("--no-wait"); // the create call is bounded by startLimitS; the answer is awaited separately with the attempt limit
    const guard = ro ? snapshot(o.cwd) : null;
    let ws = null, wsCreateS = null; if (!o.worktree && !o.keep) { let g = null; try { g = o.ledgerDir ? acquireEntry({ dir: join(o.ledgerDir, "wtcreate"), max: 2, waitMs: createTimeoutS() * 1000 }) : { release() {} }; } catch { g = { release() {} }; } // same 2-at-once gate as worktree creates; never resent (a retry only queues a duplicate behind the stuck one: 16:37-16:47 09-11, 60 in flight)
      // 14-11: reuse the local workspace this cwd already has (25 duplicates of one folder filled the 20-workspace cap); a reused one is not ours to archive, the idle-local sweep drops it later
      const have = (() => { const r = paseo(["workspace", "ls", "--json"]); const key = (p) => String(p ?? "").split("\\").join("/").toLowerCase().replace(/\/+$/, ""); return Array.isArray(r) ? r.find((x) => x.workspaceId && x.isolation === "local" && key(x.cwd) === key(o.cwd)) : null; })();
      if (have) { args.push("--workspace", have.workspaceId); g?.release(); } else {
      let c = null; if (g) { const tw = (o.now ?? Date.now)(); try { c = paseo(["workspace", "create", "--isolation", "local", "--path", o.cwd], { noRetry: true }); } finally { g.release(); wsCreateS = Math.round(((o.now ?? Date.now)() - tw) / 1000); } } if (c?.workspaceId && !c.error) { ws = c.workspaceId; wsOpen.add(ws); args.push("--workspace", ws); } } }
    live.set("run:" + rid, { run: true }); ledger(); // survives a hard kill while `paseo run` still waits and the agent id is unknown
    // HUBFIX3: a create that times out (saturated daemon) is retried with backoff, bounded (routes.createRetries, default 2); the half-made agent of a failed try is archived first. Still failing: the chain moves on. Each try and its seconds go in the trace (createTries).
    const ctries = []; let j;
    const isCreateTimeout = (x) => !x?.agentId && /^(CREATE_TIMEOUT|no answer in )/.test(String(x?.error ?? ""));
    for (let k = 0; ; k++) {
      const tc = (o.now ?? Date.now)();
      j = paseo([...args, "--", ro && readOnlyMode(base(prov), routes) === "read-only" ? withFileList(o.prompt, o.cwd) + READ_FIRST : withFileList(o.prompt, ro ? o.cwd : null)], { timeoutMs: Math.min(left() + 30, startLimitS(routes)) * 1000 });
      const to = isCreateTimeout(j); ctries.push({ try: k + 1, seconds: Math.round(((o.now ?? Date.now)() - tc) / 1000), ...(to ? { timedOut: true } : {}) });
      if (!to || k >= createRetries(routes) || left() < 60) break;
      { const r = paseo(["ls", "--label", `route/run=${rid}`]); for (const a of Array.isArray(r) ? r : []) { try { archive(a.id); } catch { /* the reaper retries */ } } }
      (o.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)))(createBackoffMs(k, routes));
    }
    live.delete("run:" + rid); if (ws && j?.agentId) wsOf.set(j.agentId, ws); else if (ws && !/^CREATE_TIMEOUT|^no answer in /.test(String(j?.error ?? ""))) archiveWs(ws); // no agent was made: nothing owns this workspace
    if (j?.agentId) { track(j.agentId, wt); try { o.onAgent?.(j.agentId); } catch { /* informational */ } } else { unnamed = true; ledger(); }
    if (j.agentId && !j.error && !["completed", "permission", "error", "timeout"].includes(String(j.status))) { // the create call returned the agent id; its answer is awaited here (a terminal status from the create call itself needs no wait)
      const w = paseo(["wait", j.agentId, "--timeout", String(left())], { timeoutMs: (left() + 30) * 1000 });
      j = { agentId: j.agentId, status: w?.status === "idle" ? "completed" : (w?.status ?? "error"), ...(w?.error ? { error: w.error } : {}) };
    }
    if (ro && j.status === "permission") j = grantReads(paseo, j, left(), { cwd: o.cwd, allow: routes.readAllow }, 8, left);
    const hint = j.status === "permission" ? { error: permissionHint({ o, mode, ro, wt, paseo, agentId: j.agentId, gate, routes, denied: j.denied }) } : {};
    // 14-11: the create call itself timed out (no agent id): say so, and stop the chain, the next provider would queue another create behind the stuck one on the same busy daemon
    const createTimedOut = !j.agentId && /^(CREATE_TIMEOUT|no answer in )/.test(String(j.error ?? ""));
    if (createTimedOut && !/^CREATE_TIMEOUT/.test(String(j.error))) j = { ...j, error: `CREATE_TIMEOUT: the daemon did not create the agent within ${startLimitS(routes)} s (saturated daemon, not a slow provider); tried ${ctries.length} time(s) with backoff, all timed out; the next provider is tried. Check \`paseo ls\` and the laptop load, retry, or raise AGENT_HUB_START_TIMEOUT.` };
    const slow = !createTimedOut && ((!["completed", "permission", "error"].includes(j.status) && (o.now ?? Date.now)() - t0 >= (lim - 3) * 1000) || /^no answer in /.test(String(j.error ?? "")));
    if (slow) j = { ...j, error: `no answer in ${lim % 60 ? lim + " s" : lim / 60 + " min"}: this provider took too long, the next one is tried (routes.timeouts.${o.type} sets the limit)` };
    const why = j.status !== "completed" && !j.error && !hint.error ? { error: stopReason(j, paseo) } : {};
    trace.push({ provider: prov, status: j.status ?? "error", ...(j.error ? { error: plainError(j.error) } : hint), ...why, ...(ctries.length > 1 ? { createTries: ctries } : {}), ...(wsCreateS !== null ? { workspaceCreateS: wsCreateS } : {}), agentCreateS: ctries.at(-1)?.seconds });
    if (j.status !== "completed" && j.status !== "permission" && START_FAIL_RE.test(String(trace.at(-1).error ?? "") + " " + String(j.error ?? ""))) { try { markStartFail(o, base(prov)); } catch { /* best effort */ } }
    { const t = trace.at(-1); const msg = t.error ?? "";
      if (j.status !== "completed" && j.status !== "permission" && LIMIT_RE.test(msg)) { // remember it: every later route skips this provider until the reset
        const until = limitUntil(msg, (o.now ?? Date.now)()); tryWriteState(limitsFile(o), { ...readLimits(o), [base(prov)]: until });
        t.error = `${msg} (${base(prov)}: usage limit until ${new Date(until).toISOString()}, skipped from now on)`; } }
    if (j.status === "completed" && guard !== null && snapshot(o.cwd) !== guard) {
      trace.push({ provider: prov, status: "error", error: `read-only task ${o.type} changed files in ${o.cwd}: failed` });
      return done({ used: prov, agentId: j.agentId, status: "failed-readonly-changed", trace }, wt);
    }
    if (j.status === "completed" && sig0?.endsWith(OVERRUN)) {
      trace.push({ provider: prov, status: "error", error: `read-only task ${o.type}: ${roProblem(o.cwd, { sig: sig0 })}` });
      return done({ used: prov, agentId: j.agentId, status: "unverifiable", trace }, wt);
    }
    if (j.status === "completed" && sig0 !== null && gitSig(o.cwd) !== sig0) { // git view of the same check (the snapshot above skips .git and node_modules)
      trace.push({ provider: prov, status: "error", error: `read-only task ${o.type} changed the git work tree in ${o.cwd}: failed` });
      return done({ used: prov, agentId: j.agentId, status: "failed-readonly-changed", trace }, wt);
    }
    if (j.status === "completed" && !o.noAsk && !ro) { // read-only types never park: text inside a summarised file could otherwise hold a slot for 10 min
     // talk-back: the agent ended with `[ASK] <question>`: park it (alive, no gate, no retire) until `agent-hub reply`
      const a = withAnswer({ used: prov, agentId: j.agentId, status: "completed", trace }, paseo, o.answerRetryMs);
      const q = parseAsk(a.answer);
      if (q && j.agentId) {
        live.delete(j.agentId); if (wt) live.delete("wt:" + wt.name); wsOpen.delete(wsOf.get(j.agentId)); ledger(); // parked: its own reaper owns it now
        park({ agentId: j.agentId, provider: prov, cwd: wt?.path ?? o.cwd, type: o.type, gate: o.gate, base: o.base, maxLines: o.maxLines, wt, keep: !!o.keep, asks: 1, home: o.home, ...(guard !== null ? { ro: true, guardCwd: o.cwd, guardHash: sha(guard) } : {}) }, { home: o.home, reaper: o.reaper });
        return { ...a, status: "asking", question: q, round: 1, hint: `answer with: agent-hub reply ${j.agentId} "<text>" (a parked agent is stopped after ${PARK_SECONDS / 60} min with no reply)` };
      }
    }
    if (j.status === "completed" && ro && j.agentId) { // read-only: the answer is the product, so an empty or refusing one is a failed entry, not a result
      const a = withAnswer({ agentId: j.agentId }, paseo, o.answerRetryMs); const bad = /^logs unreadable/.test(a.answerReason ?? "") ? "" : unusableAnswer(a.answer); // an unreadable log proves nothing: the result stands
      if (bad) { trace.push({ provider: prov, status: "error", error: bad + " (next provider tried)" }); retire(j.agentId, wt); continue; }
    }
    if (j.status === "completed") {
      // read-only task with --gate: callerGate runs the command and the nothing-changed check only (no diff or ignored-file scan of the caller's own tree)
      if (!o.gate) return done(withAnswer({ used: prov, agentId: j.agentId, status: "completed", trace }, paseo, o.answerRetryMs), wt);
      // Caller-side gate: the plugin cannot match a request to a worktree it did not know at create time, so the caller runs the gate itself in the agent's real cwd.
      const g = callerGate({ ...o, ro, roSig: sig0, roGuardHash: guard !== null ? sha(guard) : null, knownCwd: args[2], deadlineMs: t0 + lim * 1000 }, j.agentId, paseo, gate, routes);
      // the plugin hook may have re-prompted already (its attempts live in the plugin store, keyed by agent id)
      const pluginAttempts = (() => { try { return Number(loadState(o.gateDir ?? gateDir())[j.agentId]?.attempts) || 0; } catch { return 0; } })();
      g.attempts += pluginAttempts;
      trace.push({ provider: prov, gate: g.status, ...(g.reasons.length ? { reasons: g.reasons } : {}), attempts: g.attempts });
      return done(withAnswer({ used: prov, agentId: j.agentId, status: g.status === "PASS" ? "completed" : "gate-failed", gate: g, trace }, paseo, o.answerRetryMs), wt);
    }
    // a read-only agent stopped on a refused read may still have written an answer: keep it (the refusal stays in the trace) in case no entry completes
    if (ro && j.status === "permission" && j.agentId) { const w = withAnswer({ agentId: j.agentId }, paseo, o.answerRetryMs); if (w.answer) partial = { provider: prov, agentId: j.agentId, answer: w.answer, refusedRead: true, ...(w.answerTruncated ? { answerTruncated: true } : {}) }; }
    if (j.agentId || wt) retire(j.agentId, wt); // a timed-out agent must not keep running while the next entry works
    if (createTimedOut) { archiveWs(ws); unnamed = true; } // HUBFIX3: out of retries here: free this try's workspace and ghost agent, then the next provider is tried
    setMarker(o.marker, null); // a failed attempt gives its slot back at once: the next entry, a parallel route, or the end of this one never sees it held
  }
  } finally { drain(); ACTIVE.delete(drain); }
  if (!partial && trace.length && trace.every((t) => /^provider not configured/.test(t.skip ?? ""))) trace.push({ error: `no provider configured for ${o.type}: add one in Settings > Providers` });
  return partial ? { used: null, status: "permission", partial, trace } : { used: null, trace };
}

/** The Paseo config file (switches live there at once); {} when unreadable. */
export const readConfig = (home) => { try { return JSON.parse(readFileSync(join(home || paseoHome(), "config.json"), "utf8").replace(/^﻿/, "")); } catch { return {}; } };
/** Provider id -> enabled, from `paseo provider ls` (one call). Disabled (the Settings toggle) or unavailable (no CLI) = false. null when the list cannot be read. */
export function providerState(paseo, cfg, cache) {
  try {
    const r = cache ? cachedProviderLs(paseo, cache) : paseo(["provider", "ls"]); const m = new Map();
    for (const x of Array.isArray(r) ? r : r?.providers ?? []) {
      const id = x?.provider ?? x?.id ?? x?.name; if (!id) continue;
      // what the daemon reports is the truth: disabled, unavailable (no CLI, no GPU) or error means the provider cannot start, whatever the config file says (13-11: a laptop Qwen the config listed as enabled held a route 8 min while paseo said unavailable). The config switch can only turn a provider OFF at once.
      const bad = /unavail|^error$/i.test(String(x.status ?? "")) || /^disabled$/i.test(String(x.enabled ?? "")) || x.enabled === false || /disabled/i.test(String(x.status ?? ""));
      m.set(id, own(cfg?.agents?.providers, id)?.enabled !== false && !bad);
    }
    return m.size ? m : null;
  } catch { return null; }
}
/** The provider list, cached in a file for ttlMs (default 60 s) so every route process shares one daemon call a minute. cache = { file, ttlMs?, now? }. A failed or empty read is never cached. */
export function cachedProviderLs(paseo, { file, ttlMs = 15_000, now = Date.now }) {
  try { const c = JSON.parse(readFileSync(file, "utf8")); if (Array.isArray(c.rows) && c.rows.length && now() - c.at < ttlMs) return c.rows; } catch { /* no cache yet */ }
  const r = paseo(["provider", "ls"]); const rows = Array.isArray(r) ? r : r?.providers;
  if (Array.isArray(rows) && rows.length) { try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ at: now(), rows })); } catch { /* best effort */ } }
  return r;
}
export const providerCacheFile = (home) => join(home || paseoHome(), "provider-ls-cache.json");
/** Seconds a provider may take to START an agent (the create call returns the agent id) before the route drops it and tries the next one; routes.startTimeout overrides (default 90 s). The answer itself still gets the full attempt limit. */
/** Extra tries after a create timeout (routes.createRetries or AGENT_HUB_CREATE_RETRIES, default 2) and the wait before try k+2: 5 s, 10 s, 20 s ... */
export const createRetries = (routes, env = process.env) => { const n = Number(env.AGENT_HUB_CREATE_RETRIES ?? routes?.createRetries); return Number.isInteger(n) && n >= 0 ? n : 2; };
export const createBackoffMs = (k, routes) => (Number(routes?.createBackoffMs) || 5000) * 2 ** k;
export const startLimitS = (routes, env = process.env) => toSeconds(env.AGENT_HUB_START_TIMEOUT ?? routes?.startTimeout ?? "90s");
/** Slots per provider with enabled flag, and the total the hub may use now (budget.mjs: configured slots of enabled providers, a disabled one's slots moved under the others' caps, limited by what the laptop can hold). `lap` = { freeGb, cpuPct }; `busy` = routes holding a slot. */
export function slotInfo(routes, state, lap = {}, busy = 0) {
  const b = budgetFor(routes, state, lap, busy); const providers = {};
  for (const [id, n] of Object.entries(routes.slots ?? {})) providers[id] = { slots: n, enabled: !state || state.get(id) !== false, effective: b.perProvider[id] };
  return { providers, total: b.effective, configured: b.configured, configEffective: b.configEffective, laptopCap: b.laptopCap, reasons: b.reasons, freeGb: lap.freeGb ?? null, at: Date.now() };
}
/** effectiveBudget for a routes file and the daemon's provider state. */
export function budgetFor(routes, state, lap = {}, busy = 0) {
  const enabled = {}; for (const id of Object.keys(routes.slots ?? {})) enabled[id] = !state || state.get(id) !== false;
  return effectiveBudget({ slots: routes.slots ?? {}, enabled, caps: routes.slotCaps ?? {}, order: chainOrder(routes), freeGb: lap.freeGb, cpuPct: lap.cpuPct, busy, floorGb: routes.minFreeRamGb ?? 2, cost: (id) => costGb(id, routes) });
}
/** Statusline source (cheap, no daemon call): one marker file per running route in <home>/usage/active, plus total.json (sum of routes.slots). Best effort; a killed route leaves a file the reader ignores after 30 min. */
export function markActive(routes, provider, dir = join(process.env.PASEO_HOME ?? join(os.homedir(), ".paseo"), "usage", "active"), state = null, lap = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    for (const n of readdirSync(dir)) { // sweep markers of killed routes (the reader ignores them after 30 min anyway)
      if (!n.startsWith("t-")) continue;
      try { if (Date.now() - statSync(join(dir, n)).mtimeMs > 30 * 60 * 1000) rmSync(join(dir, n), { force: true }); } catch { /* best effort */ }
    }
    writeFileSync(join(dir, "total.json"), JSON.stringify(slotInfo(routes, state, lap, heldIn(dir).length))); // total = slots of enabled providers; refreshed on every route, so a toggle shows from the next one
    const f = join(dir, `t-${process.pid}-${Date.now()}.json`);
    writeFileSync(f, JSON.stringify({ provider: provider ?? null, state: provider ? "run" : "queued" }));
    const un = () => { try { rmSync(f, { force: true }); } catch { /* best effort */ } };
    un.file = f; un.dir = dir;
    return un;
  } catch { return () => {}; }
}
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
    const rank = heldIn(un.dir).filter((x) => x.provider === provider).findIndex((x) => x.n === basename(un.file));
    if (rank >= 0 && rank < slots) return true;
    setMarker(un, null); return false;
  } catch { return true; }
}

/** --file inputs go to an outside provider, so each one passes the same sensitive-read guard as an agent read (realpath: symlinks and ../ resolve first; sensitive name, dotfile, protected folder, hardlink) plus the secret scanner on its content. One refusal refuses the whole call. */
export function checkFileInputs(files, { roots = [process.cwd()], env = process.env, home = os.homedir(), scan = hasSecret } = {}) {
  const ok = [];
  for (const f of files) {
    const abs = absPath(normCwd(f)); let real; try { real = realpathSync.native(abs); } catch { return { error: `--file ${f}: does not resolve` }; }
    // every file must sit INSIDE an allow root (the caller's folder, routes.readAllow) so each path segment is judged: no dot-folder (~/.ssh, ~/.aws), no sensitive name, no protected folder
    const g = pathAllowed(real, roots, env, home);
    if (!g.ok) return { error: `--file ${f} refused: ${g.why} (allowed: files inside ${roots.join(", ")} without dot-folders or sensitive names)` };
    try {
      if (statSync(real).size > 2_000_000) return { error: `--file ${f} refused: larger than 2 MB` };
      const buf = readFileSync(real);
      // fail closed on anything that is not plain UTF-8/ASCII text: UTF-16/32 (BOM or NUL bytes) would hide a token from the scanner
      if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff) || buf.includes(0)) return { error: `--file ${f} refused: not plain UTF-8 text (BOM or NUL bytes)` };
      if (scan(buf.toString("utf8"))) return { error: `--file ${f} refused: looks like it contains a credential, token or key` };
    } catch (e) { return { error: `--file ${f} refused: ${e.message}` }; }
    ok.push({ real, name: basename(real) });
  }
  return { ok };
}

/** HUBFIX3 (qwenbench 3b: 0 of 3 read-only routes on a 372 KB input, the agent kept reaching for a shell command and every shell command is refused). A read-only route with --file gets the already-checked
 * files (sensitive-name, secret scan and size checks of checkFileInputs ran first) INLINED into the prompt up to a cap, so the agent needs no search command at all; past the cap it is told to use its read tools and that shell is refused.
 * No shell-command judging was added: removing the need beat adding a validator. */
export const INLINE_CAP = 600_000;
export function inlineFiles(prompt, files, cap = INLINE_CAP, read = (f) => readFileSync(f, "utf8")) {
  let used = 0; const parts = [], left = [];
  for (const f of files) { const t = read(f.path); if (used + t.length <= cap) { used += t.length; parts.push(`=== FILE ${f.name} ===
${t}
=== END ${f.name} ===`); } else left.push(f.name); }
  const note = left.length ? `
Not inlined (over the size cap): ${left.join(", ")}: read them with your own read tool; shell commands are refused on this task.` : "";
  return parts.length || left.length ? `${prompt}

The input file contents follow, inlined by the hub. Answer from them; shell commands are refused here.${note}

${parts.join(String.fromCharCode(10).repeat(2))}` : prompt;
}

/** `route --status <agentId>`: what a route that was cut off (caller timeout, Ctrl-C) would have returned: the agent's status, the plugin's gate state and its last answer. */
export function runStatus(id, paseo, dir = gateDir(), gate = runGate, routes = {}) {
  if (!AGENT_ID_RE.test(id ?? "")) return { error: "not an agent id: " + String(id).slice(0, 60) };
  const i = paseo(["inspect", id]);
  if (!i || i.error) return { agentId: id, error: String(i?.error ?? "no answer from the daemon").slice(0, 200) };
  const st = String(i.Status ?? "").toLowerCase();
  let g = null; try { g = loadState(dir)[id] ?? null; } catch { /* no gate state yet */ }
  const done = st === "idle" || st === "closed";
  let out = { agentId: id, status: done ? "completed" : st || "unknown", agentStatus: i.Status, archived: i.Archived === true, cwd: i.Cwd, gate: g ? { status: g.status ?? null, attempts: g.attempts ?? 0 } : null, ...(done ? {} : { hint: "the agent is still working; ask again later" }) };
  // A route cut off before its caller-side gate ran leaves the request unclaimed and no gate state: "completed, gate null" would accept a no-op edit. Run the requested gate now.
  const cwd = i.Cwd ? (agentCwd(paseo, id) ?? i.Cwd) : null;
  const req = !g && done && cwd ? peekRequest(dir, cwd) : null;
  if (req && req.readOnly) { // read-only: the work tree must be unchanged (fingerprint taken at start), then the gate command if any; no diff/ignored-file scan
    const reasons = []; { const why = roProblem(cwd, req); if (why) reasons.push(why); }
    if (req.cmd) reasons.push(...(gate(cwd, { cmd: req.cmd, readOnly: true }).reasons ?? []));
    out = { ...out, status: reasons.length ? (reasons.some((r) => /^unverifiable/.test(r)) ? "unverifiable" : "failed-readonly-changed") : "completed", gate: { status: reasons.length ? "FAIL" : "PASS", reasons, attempts: 0, ranBy: "status" } };
  } else if (req && req.cmd) {
    const r = judgeNoDiff(gate(cwd, gateOpts(routes, cwd, req.cmd, req.base, req.maxLines)), cwd);
    out = { ...out, status: r.status === "PASS" ? "completed" : "gate-failed", gate: { status: r.status, reasons: r.reasons ?? [], attempts: 0, ranBy: "status" } };
  }
  return withAnswer(out, paseo);
}

const ROUTE_T0 = Date.now();
function main(argv) {
  if (argv[0] === "--status") {
    const home = absPath(argv.includes("--home") ? argv[argv.indexOf("--home") + 1] : process.env.PASEO_HOME);
    const res = runStatus(argv[1], withRetry(cliPaseo(home)), undefined, runGate, loadRoutes());
    console.log(JSON.stringify(res)); return res.error || res.status === "gate-failed" ? 1 : 0;
  }
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
  entry.release(); // the answer is out: free the hub slot now, the archive runs off-slot in a detached worker (and the reaper drains the same spool if this one dies)
  try { spawn(process.execPath, [fileURLToPath(new URL("./reaper.mjs", import.meta.url)), "--spool", ...(home ? ["--home", home] : [])], { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch { /* the reaper drains it */ }
  if (!res.used && !res.status && (res.trace ?? []).every((t) => t.skip || t.error)) console.error(`route: no provider took this ${type} task (see trace). summarise/review run only on providers with an enforced read guard (a Qwen Code endpoint or claude-clean): add one with agent-hub provider add <name> --kind qwen-code --url <base>/v1 --model <id> --routes ${type}. code-edit works with codex or claude and needs --new-workspace worktree.`);
    return res.status === "completed" ? 0 : res.status === "asking" ? 3 : 1;
  }
  const [type, prompt0, ...rest] = argv; let prompt = prompt0;
  const opt = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
  if (!type || !prompt) { console.error('usage: route.mjs <type> "<prompt>" [--provider P/M] [--cwd D] [--gate CMD] [--mode M] [--new-workspace worktree|--in-place] [--session ID] [--dev D] [--client C] [--home H] [--keep] [--max-lines N] [--file PATH ...]  |  route.mjs --status <agentId>'); return 2; }
  const home = absPath(opt("--home") ?? process.env.PASEO_HOME);
  let cwd = absPath(normCwd(opt("--cwd") ?? process.cwd()));
  const maxLines = opt("--max-lines") === undefined ? undefined : Number(opt("--max-lines"));
  if (maxLines !== undefined && !(Number.isInteger(maxLines) && maxLines > 0)) { console.error("route: --max-lines needs a positive whole number"); return 2; }
  const files = rest.flatMap((x, i) => (rest[i - 1] === "--file" ? [x] : []));
  if (files.length) { // read-only inputs outside --cwd: copied into a private folder that becomes the task's cwd, so no hand-built snapshot dir and no "outside the task folder" refusal
    if (!readOnlyType(type, loadRoutes())) { console.error("route: --file is for read-only task types (summarise, review)"); return 2; }
    if (rest.includes("--cwd")) { console.error("route: use either --cwd or --file, not both"); return 2; }
    const dir = mkdtempSync(join(os.tmpdir(), "hub-files-"));
    const chk = checkFileInputs(files, { roots: [process.cwd(), ...(loadRoutes().readAllow ?? [])] });
    if (chk.error) { console.error("route: " + chk.error); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } return 2; }
    for (const [i, c] of chk.ok.entries()) { mkdirSync(join(dir, String(i))); copyFileSync(c.real, join(dir, String(i), c.name)); } // original basename kept
    prompt = inlineFiles(prompt, chk.ok.map((c, i) => ({ name: c.name, path: join(dir, String(i), c.name) })));
    process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });
    cwd = dir.split(String.fromCharCode(92)).join("/");
  }
  const dev = opt("--dev") ?? process.env.AGENT_HUB_DEV ?? os.userInfo().username.replace(/[^A-Za-z0-9._@:-]/g, "_");
  const mcpNames = opt("--mcp");
  if (mcpNames !== undefined) { const g = grantMcp({ names: mcpNames, allow: loadMcpAllow(), readOnly: readOnlyType(type, loadRoutes()) }); if (g.refused) { console.error("route: " + g.refused); return 2; } }
  const early = inputError({ type, provider: opt("--provider"), cwd, home, mode: opt("--mode"), session: opt("--session") ?? sessionFromEnv(process.env), dev, client: opt("--client") ?? process.env.AGENT_HUB_CLIENT });
  if (early) { console.error("route: " + early); return 2; }
  if (!(opt("--session") ?? sessionFromEnv(process.env))) console.error("route: note: no session id (CLAUDE_CODE_SESSION_ID is not set in this shell, e.g. a PowerShell tool), so this task is counted under no session; pass --session <id> or set AGENT_HUB_SESSION to see it in `agent-hub usage --session <id>`.");
  if (!existsSync(cwd)) { console.error(`route: --cwd ${cwd} is not an existing folder (on Windows pass C:/abs/path; Git-Bash /c/... is rewritten to C:/...)`); return 2; }
  const routes0 = loadRoutes();
  { const cap = Number(process.env.AGENT_HUB_WORKSPACE_CAP) || undefined; let capErr = workspaceCapError(withRetry(cliPaseo(home)), cap);
    if (capErr) { // self-heal once (13-11: idle dr-* workspaces refused routes at 24 and 81 > 20): archive idle workspaces now, then look again
      try { console.error("route: " + capErr.split(";")[0] + ": archiving idle workspaces, then retrying the check"); spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "reaper.mjs"), "--heal-cap", ...(home ? ["--home", home] : [])], { timeout: 240_000, windowsHide: true, stdio: "ignore" }); capErr = workspaceCapError(withRetry(cliPaseo(home)), cap); } catch { /* keep the refusal */ }
    }
    if (capErr) { console.error("route: " + capErr); return 1; } }
  // 14-11: one session fired 11 parallel routes and all 11 timed out at 600 s (38 credits, 0 files). At most AGENT_HUB_SESSION_MAX (default 2) routes per session run at once; the rest queue on disk (no daemon traffic) for AGENT_HUB_SESSION_WAIT_S (default 300 s), then are refused with this message.
  const sessId = opt("--session") ?? sessionFromEnv(process.env);
  const sessGate = (() => { const max = process.env.AGENT_HUB_SESSION_MAX === undefined ? 2 : Number(process.env.AGENT_HUB_SESSION_MAX); if (!sessId || !Number.isFinite(max)) return { release() {} };
    try { return acquireEntry({ dir: join(runDir(), "session-" + String(sessId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)), max, waitMs: (Number(process.env.AGENT_HUB_SESSION_WAIT_S) || 300) * 1000, onWait: (n, m) => console.error(`route: session ${sessId} already has ${n}/${m} routes running: queued here (AGENT_HUB_SESSION_MAX raises it); start fewer parallel calls`) }); } catch { return { release() {} }; } })();
  if (sessGate === null) { console.error(`route: session ${sessId} has ${process.env.AGENT_HUB_SESSION_MAX ?? 2} routes running and none finished within the wait; nothing was started. Run fewer parallel routes per session (AGENT_HUB_SESSION_MAX, AGENT_HUB_SESSION_WAIT_S).`); return 1; }
  process.on("exit", () => sessGate.release());
  const entry = (() => { try { return acquireEntry({ dir: runDir(), max: maxInFlight(routes0), onWait: (n, m) => console.error(`route: ${n}/${m} routes already in flight: queued here (no daemon traffic) until a slot frees`) }); } catch { return { release() {}, waitedMs: 0 }; } })();
  if (entry === null) { console.error("route: gave up waiting 30 min for a free hub slot (maxInFlight in routes.local.json, env AGENT_HUB_MAX_INFLIGHT); nothing was started"); return 1; }
  { // HUBFIX2: a caller's hard kill (the 600 s `timeout`) runs no exit handler here (route is synchronous), so a detached watchdog waits for this pid, stops it at --timeout, and reaps its agents, workspaces and slots at once instead of up to 5 min later
    const tmo = opt("--timeout") === undefined ? 0 : toSeconds(opt("--timeout"));
    try { spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "reaper.mjs"), "--watch", String(process.pid), ...(tmo ? ["--kill-after", String(tmo)] : []), ...(home ? ["--home", home] : [])], { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch { /* the 5-minute reaper still covers it */ } }
  process.on("exit", () => entry.release()); // every exit path, including process.exit(130) from a signal
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.random() * 2000); // stagger: many parallel routes must not hit the daemon in the same instant
  try { migrate(); } catch { /* best effort: an unreadable config is reported by the route itself */ } // idempotent: converts an older install's presets/twins and stale read-only modes before any task is routed
  const routes = loadRoutes();
  { const me = modeError(opt("--mode"), routes); if (me) { console.error("route: " + me); return 2; } }
  const cfgNow = readConfig(process.env.PASEO_HOME);
  const pcache = { file: providerCacheFile(process.env.PASEO_HOME) };
  const pstate = providerState(withRetry(cliPaseo(process.env.PASEO_HOME)), cfgNow, pcache);
  { const bail = () => { for (const d of [...ACTIVE]) { try { d(); } catch { /* best effort */ } } }; process.on("exit", bail); for (const sg of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sg, () => process.exit(130)); } // Ctrl-C / kill: the exit handler archives what this route started
  const unmark = markActive(routes, opt("--provider"), undefined, pstate, laptopNow());
  let res; const slotWaitUntil = Date.now() + (Number(process.env.AGENT_HUB_SLOT_WAIT_MIN) || 25) * 60_000;
  // every provider skipped only because its slots are held by other routes: queue here and retry, never exit 1 with nothing started
  const allFull = (r) => !r.used && Array.isArray(r.trace) && r.trace.length > 0 && r.trace.every((t) => /^(slots full|busy \d+\/)/.test(t.skip ?? ""));
  try { for (;;) { res = runRoute({
    providerState: providerState(withRetry(cliPaseo(process.env.PASEO_HOME)), cfgNow, pcache) ?? pstate, providerCache: pcache.file, endpointDown: (id) => endpointSkip(id, cfgNow), marker: unmark, type, prompt: prompt + (readOnlyType(type, routes) ? "" : ASK_CLAUSE), provider: opt("--provider"), cwd, gate: opt("--gate"), maxLines, onAgent: (id) => console.error(`route: agent ${id} started; if this call is cut off, fetch the result later with: agent-hub route --status ${id}`), mode: opt("--mode"), worktree: opt("--new-workspace") === "worktree", inPlace: rest.includes("--in-place"),
    session: opt("--session") ?? sessionFromEnv(process.env), dev,
    client: opt("--client") ?? process.env.AGENT_HUB_CLIENT, keep: rest.includes("--keep"), mcp: mcpNames, deferCleanup: true, home, ledgerDir: (() => { try { return runDir(); } catch { return null; } })(), freeMem: () => availableGb(), laptop: () => laptopNow(),
  }, withRetry(cliPaseo(home)), routes); if (!allFull(res) || Date.now() > slotWaitUntil) break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000 + Math.random() * 4000); } } finally { unmark(); }
  try { appendLedger(ledgerLine(res, { type, session: opt("--session") ?? sessionFromEnv(process.env), startedMs: ROUTE_T0 }), ledgerFile(process.env.PASEO_HOME || undefined)); } catch { /* the ledger never fails a route */ }
  console.log(JSON.stringify(res));
  const bad = res.trace?.length === 1 && /^unknown provider id/.test(res.trace[0].error ?? "") ? res.trace[0].error : null;
  if (bad) { console.error("route: " + bad); return 2; }
  const code = routeExitCode(res); const why = noRunLine(res); if (why) console.error(why);
  return code; // 3 = parked, waiting for `agent-hub reply`
}
/** HUBFIX3 (T031): a route that ran on no provider, or that "completed" with nothing to read, never exits 0 and always prints one line saying which providers were tried and why each was skipped. */
export function routeExitCode(res) {
  if (res?.status === "asking") return 3;
  return res?.used && res.status === "completed" && (res.gate || String(res.answer ?? "").trim()) ? 0 : 1; // a gated edit may end with no prose; a read-only answer may not
}
export function noRunLine(res) {
  if (routeExitCode(res) !== 1) return null;
  const t = (res?.trace ?? []).map((x) => `${x.provider ?? "?"}: ${String(x.skip ?? x.error ?? "no result").slice(0, 120)}`);
  return "route: " + (res?.used ? "completed with an empty answer on " + res.used : "no provider ran") + (t.length ? " (" + t.join("; ") + ")" : "") + ": retry, or pass --provider to pick one";
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { const c = main(process.argv.slice(2)); if (c !== null) process.exit(c); }
