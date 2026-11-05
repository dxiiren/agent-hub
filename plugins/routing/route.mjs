#!/usr/bin/env node
// Routing wrapper (decision 41): task type -> ordered provider/model chain; the caller may override;
// a provider at its slot limit is skipped and a failed or timed-out one falls to the next entry.
// shortcut: wrapper, not a daemon hook. agent.create.before has no labels and cannot spawn a replacement; move to a plugin if the hook grows.
// Usage: route.mjs --resolve <alias> | route.mjs <type> "<prompt>" [--provider P/M] [--cwd D] [--gate CMD] [--mode M] [--new-workspace worktree] [--session ID] [--dev D] [--client C] [--home H] [--keep]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { gateDir, writeRequest } from "../gate/server/store.mjs";
import { runGate, gateOpts } from "../gate/server/gate.mjs";
import { resolveCached } from "./resolve.mjs";
import { batchAllowed } from "./readguard.mjs";

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
  for (const p of [env.AGENT_HUB_ROUTES, join(root, "routes.local.json"), join(root, "routes.template.json")])
    if (p && existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  throw new Error("no routing file (set AGENT_HUB_ROUTES)");
}

/** Seconds a `paseo run --no-wait` (agent + worktree creation) may take before the CLI gives up. Upstream Paseo has no bound: under load or a provider ACP init stall the daemon holds the request for 120 s+ (agent.create.request, "Timed out refreshing <provider> ... pending: initialize") and the caller used to hang for the 15 min spawn cap. */
export const createTimeoutS = (env = process.env) => Number(env.AGENT_HUB_CREATE_TIMEOUT_S) || 240;
export const toSeconds = (d) => { const m = /^(\d+)\s*(s|m|h)?$/.exec(String(d ?? "").trim()); return m ? Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] ?? "s"]) : 900; };

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
    const r = spawn(cmd, [...pre, ...args, ...(home ? ["--home", home] : []), ...(text ? [] : ["--json"])], { encoding: "utf8", timeout: create ? createTimeoutS(env) * 1000 : 15 * 60_000, env });
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
/** Provider -> its most read-only mode id (from list_providers; checked 05-11). Codex has no read-only mode: "auto" is its default-permissions mode, the post-check is the backstop. Override per provider with routes.readOnlyModes. */
export const READ_ONLY_MODES = { claude: "plan", "claude-clean": "plan", opencode: "plan", "qwen-code": "plan", "qwen-code-2": "plan", "qwen-laptop": "plan", qoder: "dontAsk", codex: "auto", copilot: "https://agentclientprotocol.com/protocol/session-modes#plan" };
export const readOnlyMode = (prov, routes = {}) => routes.readOnlyModes?.[prov] ?? READ_ONLY_MODES[prov];
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
const TAG = /^\[[A-Z][A-Za-z_ ]*\] /;
/** The agent's last assistant message from `paseo logs` text: everything after the last tagged line ([User], [Read] ...), capped. */
export function lastAnswer(text, cap = 4096) {
  const lines = String(text ?? "").split(/\r?\n/); let i = lines.length;
  while (i > 0 && !TAG.test(lines[i - 1])) i--;
  const a = lines.slice(i).join("\n").trim();
  return a.length > cap ? { answer: a.slice(0, cap), truncated: true } : { answer: a, truncated: false };
}
const withAnswer = (r, paseo) => {
  if (!r.agentId) return r;
  const l = paseo(["logs", r.agentId]); const a = lastAnswer(l?.text);
  if (!a.answer) return r;
  return { ...r, answer: a.answer, ...(a.truncated ? { answerTruncated: true, answerFull: `paseo logs ${r.agentId}` } : {}) };
};

/** Shallow snapshot of a folder (names + mtimes, capped) for the read-only post-check. */
export function snapshot(dir, max = 5000) {
  const out = []; const walk = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { if (out.length >= max) return; if (e.name === ".git" || e.name === "node_modules") continue; const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { out.push(p + "|" + statSync(p).mtimeMs); } catch { /* vanished */ } } } };
  walk(dir); return out.sort().join(String.fromCharCode(10));
}

/** Run the gate in the agent's cwd with the same options the plugin hook uses (gateOpts). First failure: re-prompt once (decision 47) and block until the agent is idle; freeze it; second gate. */
export function callerGate(o, agentId, paseo, gate = runGate, routes = {}) {
  // `paseo ls` abbreviates the home folder as "~"
  const cwdOf = () => { const r = paseo(["ls"]); const c = (Array.isArray(r) ? r : []).find((a) => a.id === agentId)?.cwd; return c?.replace(/^~(?=[\\/])/, os.homedir()); };
  const cwd = cwdOf();
  if (!cwd) return { status: "FAIL", reasons: ["agent cwd unknown: gate not run"], attempts: 0 };
  let res = gate(cwd, gateOpts(routes, cwd, o.gate));
  if (res.status === "PASS") return { status: "PASS", reasons: [], attempts: 0 };
  if (routes.gateRetry === false) return { status: "FAIL", reasons: res.reasons, attempts: 1 };
  const fail = (why) => ({ status: "FAIL", reasons: [...res.reasons, why], attempts: 1 });
  const s = paseo(["send", agentId, "Your work failed the gate: " + res.reasons.join("; ") + "\nFix it and finish."]);
  if (s?.error) return fail("re-prompt failed: " + String(s.error).slice(0, 120));
  const w = paseo(["wait", agentId, "--timeout", "900"]);
  if (w?.error) return fail("wait for re-prompt failed: " + String(w.error).slice(0, 120));
  const st = paseo(["stop", agentId]);
  if (st?.error && !/AGENT_NOT_FOUND|No agent found/.test(String(st.error))) return fail("could not freeze the agent: " + String(st.error).slice(0, 120));
  // freeze: the second gate must judge the final tree, not one the agent is still editing
  res = gate(cwdOf() ?? cwd, gateOpts(routes, cwd, o.gate));
  return { status: res.status, reasons: res.reasons, attempts: 1 };
}

/**
 * Run a task through the chain. `paseo(args)` is injected (tests use a fake).
 * Returns { used, agentId, status, trace }; used is null when every entry failed.
 */
export function runRoute(o, paseo, routes, gate = runGate) {
  const chain = o.provider ? [o.provider] : routes.routes?.[o.type];
  if (!chain?.length) return { used: null, trace: [{ error: `unknown task type ${o.type}` }] };
  const slots = routes.slots ?? {};
  const trace = [];
  // A finished agent keeps its provider process (a claude is ~250 MB idle): stop and archive it once its answer and gate are read, unless --keep.
  // A route-created worktree (--new-workspace worktree) is removed with its agent, or it piles up under ~/.paseo/worktrees.
  const retire = (id) => {
    if (o.keep || !id) return;
    const wt = o.worktree ? [].concat(paseo(["worktree", "ls"]) ?? []).find((w) => w.agent && w.agent !== "-" && id.startsWith(w.agent)) : null;
    paseo(["stop", id]); paseo(["archive", id]);
    if (wt) paseo(["worktree", "archive", wt.name, "--cwd", o.cwd]);
  };
  const done = (r) => { retire(r.agentId); return r; };
  for (const entry of chain) {
    let prov;
    try { prov = resolveCached(entry, paseo); } catch (e) { trace.push({ provider: entry, error: String(e.message) }); continue; }
    const rows = paseo(["ls"]);
    const busy = (Array.isArray(rows) ? rows : []).filter((a) => String(a.status).toLowerCase() === "running" && a.provider === base(prov)).length;
    if (busy >= (slots[base(prov)] ?? 99)) { trace.push({ provider: prov, skip: `busy ${busy}/${slots[base(prov)]}` }); continue; }
    const labels = { "route/type": o.type, "route/provider": prov, dev: o.dev, caller: o.client, session: o.session };
    const args = ["run", "--cwd", o.cwd, "--provider", prov, "--wait-timeout", o.waitTimeout ?? routes.waitTimeout ?? "10m"];
    const ro = readOnlyType(o.type, routes); // read-only types: the provider's read-only mode, whatever the caller or the routes file asks for
    const mode = ro ? readOnlyMode(base(prov), routes) : o.mode ?? routes.modes?.[base(prov)] ?? routes.mode; // per-provider default: codex full-access, claude bypassPermissions ...
    if (o.worktree) args.push("--new-workspace", "worktree");
    if (mode && (o.worktree || !unsafeMode(mode))) args.push("--mode", mode);
    else if (mode) trace.push({ provider: prov, note: `mode ${mode} dropped: needs --new-workspace worktree` });
    for (const [k, v] of Object.entries(labels)) if (v) args.push("--label", `${k}=${v}`);
    // caller-supplied gate (decision 47) goes to the plugin-side store, not into agent-writable labels
    if (o.gate) writeRequest(o.gateDir ?? gateDir(), o.cwd, o.gate);
    // worktree runs: create without waiting (the create call is bounded by cliPaseo), then wait for the agent separately
    if (o.worktree) args.push("--no-wait");
    const guard = ro ? snapshot(o.cwd) : null;
    let j = paseo([...args, o.prompt]);
    if (o.worktree && j.agentId && !j.error && j.status !== "completed") {
      const w = paseo(["wait", j.agentId, "--timeout", String(toSeconds(o.waitTimeout ?? routes.waitTimeout ?? "10m"))]);
      j = { agentId: j.agentId, status: w?.status === "idle" ? "completed" : (w?.status ?? "error"), ...(w?.error ? { error: w.error } : {}) };
    }
    if (ro && j.status === "permission") j = grantReads(paseo, j, toSeconds(o.waitTimeout ?? routes.waitTimeout ?? "10m"), { cwd: o.cwd, allow: routes.readAllow });
    const hint = j.status === "permission" ? { error: `agent asked for a permission its mode does not grant (type ${o.type}, mode ${mode ?? "provider default"}). Edit types (code-edit, test-scaffold) need --new-workspace worktree (full-access is dropped outside one, decision 21); read-only types run in the provider read-only mode and cannot edit.` } : {};
    trace.push({ provider: prov, status: j.status ?? "error", ...(j.error ? { error: j.error } : hint) });
    if (j.status === "completed" && guard !== null && snapshot(o.cwd) !== guard) {
      trace.push({ provider: prov, status: "error", error: `read-only task ${o.type} changed files in ${o.cwd}: failed` });
      return done({ used: prov, agentId: j.agentId, status: "failed-readonly-changed", trace });
    }
    if (j.status === "completed") {
      if (!o.gate) return done(withAnswer({ used: prov, agentId: j.agentId, status: "completed", trace }, paseo));
      // Caller-side gate: the plugin cannot match a request to a worktree it did not know at create time, so the caller runs the gate itself in the agent's real cwd.
      const g = callerGate(o, j.agentId, paseo, gate, routes);
      trace.push({ provider: prov, gate: g.status, ...(g.reasons.length ? { reasons: g.reasons } : {}), attempts: g.attempts });
      return done(withAnswer({ used: prov, agentId: j.agentId, status: g.status === "PASS" ? "completed" : "gate-failed", gate: g, trace }, paseo));
    }
    if (j.agentId) retire(j.agentId); // a timed-out agent must not keep running while the next entry works
  }
  return { used: null, trace };
}

/** Statusline source (cheap, no daemon call): one marker file per running route in <home>/usage/active, plus total.json (sum of routes.slots). Best effort; a killed route leaves a file the reader ignores after 30 min. */
export function markActive(routes, provider, dir = join(process.env.PASEO_HOME ?? join(os.homedir(), ".paseo"), "usage", "active")) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "total.json"), JSON.stringify({ total: Object.values(routes.slots ?? {}).reduce((a, b) => a + b, 0) }));
    const f = join(dir, `t-${process.pid}-${Date.now()}.json`);
    writeFileSync(f, JSON.stringify({ provider: provider ?? null }));
    return () => { try { rmSync(f, { force: true }); } catch { /* best effort */ } };
  } catch { return () => {}; }
}

function main(argv) {
  if (argv[0] === "--resolve") { // print what an alias maps to right now
    try { console.log(resolveCached(argv[1], cliPaseo(process.env.PASEO_HOME))); return 0; } catch (e) { console.error(e.message); return 1; }
  }
  const [type, prompt, ...rest] = argv;
  const opt = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
  if (!type || !prompt) { console.error('usage: route.mjs <type> "<prompt>" [--provider P/M] [--cwd D] [--gate CMD] [--mode M] [--new-workspace worktree] [--session ID] [--dev D] [--client C] [--home H] [--keep]'); return 2; }
  const home = opt("--home") ?? process.env.PASEO_HOME;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.random() * 2000); // stagger: many parallel routes must not hit the daemon in the same instant
  const routes = loadRoutes();
  const unmark = markActive(routes, opt("--provider"));
  let res;
  try { res = runRoute({
    type, prompt, provider: opt("--provider"), cwd: opt("--cwd") ?? process.cwd(), gate: opt("--gate"), mode: opt("--mode"), worktree: opt("--new-workspace") === "worktree",
    session: opt("--session") ?? process.env.AGENT_HUB_SESSION, dev: opt("--dev") ?? process.env.AGENT_HUB_DEV ?? os.userInfo().username,
    client: opt("--client") ?? process.env.AGENT_HUB_CLIENT, keep: rest.includes("--keep"),
  }, withRetry(cliPaseo(home)), routes); } finally { unmark(); }
  console.log(JSON.stringify(res));
  return res.used && res.status === "completed" ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
