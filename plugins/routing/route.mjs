#!/usr/bin/env node
// Routing wrapper (decision 41): task type -> ordered provider/model chain; the caller may override;
// a provider at its slot limit is skipped and a failed or timed-out one falls to the next entry.
// shortcut: wrapper, not a daemon hook. agent.create.before has no labels and cannot spawn a replacement; move to a plugin if the hook grows.
// Usage: route.mjs --resolve <alias> | route.mjs <type> "<prompt>" [--provider P/M] [--cwd D] [--gate CMD] [--mode M] [--new-workspace worktree] [--session ID] [--dev D] [--client C] [--home H]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { gateDir, writeRequest } from "../gate/server/store.mjs";
import { runGate, gateOpts } from "../gate/server/gate.mjs";
import { resolveCached } from "./resolve.mjs";

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
    const r = spawn(cmd, [...pre, ...args, ...(home ? ["--home", home] : []), "--json"], { encoding: "utf8", timeout: create ? createTimeoutS(env) * 1000 : 15 * 60_000, env });
    if (create && r.error?.code === "ETIMEDOUT") return { error: `CREATE_TIMEOUT: the daemon did not create the agent within ${createTimeoutS(env)} s (saturated daemon or a provider that stalls at initialize; upstream Paseo, not a worktree bug). Check \`paseo ls\` and the laptop load, then retry; raise AGENT_HUB_CREATE_TIMEOUT_S if the host is just slow.` };
    const out = r.stdout || "";
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
// Read-only task types write nothing, so they get the provider's configured mode anywhere (otherwise the agent waits for a permission nobody answers and the run ends as `permission`).
export const readOnlyType = (type, routes = {}) => (routes.readOnlyTypes ?? ["summarise", "review"]).includes(type);

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
  for (const entry of chain) {
    let prov;
    try { prov = resolveCached(entry, paseo); } catch (e) { trace.push({ provider: entry, error: String(e.message) }); continue; }
    const rows = paseo(["ls"]);
    const busy = (Array.isArray(rows) ? rows : []).filter((a) => String(a.status).toLowerCase() === "running" && a.provider === base(prov)).length;
    if (busy >= (slots[base(prov)] ?? 99)) { trace.push({ provider: prov, skip: `busy ${busy}/${slots[base(prov)]}` }); continue; }
    const labels = { "route/type": o.type, "route/provider": prov, dev: o.dev, caller: o.client, session: o.session };
    const args = ["run", "--cwd", o.cwd, "--provider", prov, "--wait-timeout", o.waitTimeout ?? routes.waitTimeout ?? "10m"];
    const mode = o.mode ?? routes.modes?.[base(prov)] ?? routes.mode; // per-provider default: codex full-access, claude bypassPermissions ...
    if (o.worktree) args.push("--new-workspace", "worktree");
    if (mode && (o.worktree || !unsafeMode(mode) || readOnlyType(o.type, routes))) args.push("--mode", mode);
    else if (mode) trace.push({ provider: prov, note: `mode ${mode} dropped: needs --new-workspace worktree` });
    for (const [k, v] of Object.entries(labels)) if (v) args.push("--label", `${k}=${v}`);
    // caller-supplied gate (decision 47) goes to the plugin-side store, not into agent-writable labels
    if (o.gate) writeRequest(o.gateDir ?? gateDir(), o.cwd, o.gate);
    // worktree runs: create without waiting (the create call is bounded by cliPaseo), then wait for the agent separately
    if (o.worktree) args.push("--no-wait");
    let j = paseo([...args, o.prompt]);
    if (o.worktree && j.agentId && !j.error && j.status !== "completed") {
      const w = paseo(["wait", j.agentId, "--timeout", String(toSeconds(o.waitTimeout ?? routes.waitTimeout ?? "10m"))]);
      j = { agentId: j.agentId, status: w?.status === "idle" ? "completed" : (w?.status ?? "error"), ...(w?.error ? { error: w.error } : {}) };
    }
    const hint = j.status === "permission" ? { error: `agent waited for a permission: type ${o.type} edits files, but outside --new-workspace worktree its full-access mode is dropped (decision 21). Run it in a git repo with --new-workspace worktree, or use a read-only type (summarise, review).` } : {};
    trace.push({ provider: prov, status: j.status ?? "error", ...(j.error ? { error: j.error } : hint) });
    if (j.status === "completed") {
      if (!o.gate) return { used: prov, agentId: j.agentId, status: "completed", trace };
      // Caller-side gate: the plugin cannot match a request to a worktree it did not know at create time, so the caller runs the gate itself in the agent's real cwd.
      const g = callerGate(o, j.agentId, paseo, gate, routes);
      trace.push({ provider: prov, gate: g.status, ...(g.reasons.length ? { reasons: g.reasons } : {}), attempts: g.attempts });
      return { used: prov, agentId: j.agentId, status: g.status === "PASS" ? "completed" : "gate-failed", gate: g, trace };
    }
    if (j.agentId) paseo(["stop", j.agentId]); // a timed-out agent must not keep running while the next entry works
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
  if (!type || !prompt) { console.error('usage: route.mjs <type> "<prompt>" [--provider P/M] [--cwd D] [--gate CMD] [--mode M] [--new-workspace worktree] [--session ID] [--dev D] [--client C] [--home H]'); return 2; }
  const home = opt("--home") ?? process.env.PASEO_HOME;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.random() * 2000); // stagger: many parallel routes must not hit the daemon in the same instant
  const routes = loadRoutes();
  const unmark = markActive(routes, opt("--provider"));
  let res;
  try { res = runRoute({
    type, prompt, provider: opt("--provider"), cwd: opt("--cwd") ?? process.cwd(), gate: opt("--gate"), mode: opt("--mode"), worktree: opt("--new-workspace") === "worktree",
    session: opt("--session") ?? process.env.AGENT_HUB_SESSION, dev: opt("--dev") ?? process.env.AGENT_HUB_DEV ?? os.userInfo().username,
    client: opt("--client") ?? process.env.AGENT_HUB_CLIENT,
  }, withRetry(cliPaseo(home)), routes); } finally { unmark(); }
  console.log(JSON.stringify(res));
  return res.used && res.status === "completed" ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
