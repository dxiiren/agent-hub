#!/usr/bin/env node
// Routing wrapper (decision 41): task type -> ordered provider/model chain; the caller may override;
// a provider at its slot limit is skipped and a failed or timed-out one falls to the next entry.
// shortcut: wrapper, not a daemon hook. agent.create.before has no labels and cannot spawn a replacement; move to a plugin if the hook grows.
// Usage: route.mjs <type> "<prompt>" [--provider P/M] [--cwd D] [--gate CMD] [--mode M] [--session ID] [--dev D] [--client C] [--home H]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { gateDir, writeRequest } from "../gate/server/store.mjs";

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

/** Default CLI runner: parsed JSON of `paseo <args> --json`, or {error}. */
export function cliPaseo(home, env = process.env) {
  const [cmd, ...pre] = paseoCommand(env);
  return (args) => {
    const r = spawnSync(cmd, [...pre, ...args, ...(home ? ["--home", home] : []), "--json"], { encoding: "utf8", timeout: 15 * 60_000, env });
    const out = r.stdout || "";
    try { return JSON.parse(out.slice(out.search(/[[{]/))); } catch { return { error: (r.stderr || out || "no output").slice(-200) }; }
  };
}

const base = (p) => p.split("/")[0];

/**
 * Run a task through the chain. `paseo(args)` is injected (tests use a fake).
 * Returns { used, agentId, status, trace }; used is null when every entry failed.
 */
export function runRoute(o, paseo, routes) {
  const chain = o.provider ? [o.provider] : routes.routes?.[o.type];
  if (!chain?.length) return { used: null, trace: [{ error: `unknown task type ${o.type}` }] };
  const slots = routes.slots ?? {};
  const trace = [];
  for (const prov of chain) {
    const rows = paseo(["ls"]);
    const busy = (Array.isArray(rows) ? rows : []).filter((a) => String(a.status).toLowerCase() === "running" && a.provider === base(prov)).length;
    if (busy >= (slots[base(prov)] ?? 99)) { trace.push({ provider: prov, skip: `busy ${busy}/${slots[base(prov)]}` }); continue; }
    const labels = { "route/type": o.type, "route/provider": prov, dev: o.dev, caller: o.client, session: o.session };
    const args = ["run", "--cwd", o.cwd, "--provider", prov, "--wait-timeout", o.waitTimeout ?? routes.waitTimeout ?? "10m"];
    const mode = o.mode ?? routes.mode;
    if (mode) args.push("--mode", mode);
    for (const [k, v] of Object.entries(labels)) if (v) args.push("--label", `${k}=${v}`);
    // caller-supplied gate (decision 47) goes to the plugin-side store, not into agent-writable labels
    if (o.gate) writeRequest(o.gateDir ?? gateDir(), o.cwd, o.gate);
    const j = paseo([...args, o.prompt]);
    trace.push({ provider: prov, status: j.status ?? "error", ...(j.error ? { error: j.error } : {}) });
    if (j.status === "completed") return { used: prov, agentId: j.agentId, status: "completed", trace };
    if (j.agentId) paseo(["stop", j.agentId]); // a timed-out agent must not keep running while the next entry works
  }
  return { used: null, trace };
}

function main(argv) {
  const [type, prompt, ...rest] = argv;
  const opt = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
  if (!type || !prompt) { console.error('usage: route.mjs <type> "<prompt>" [--provider P/M] [--cwd D] [--gate CMD] [--mode M] [--session ID] [--dev D] [--client C] [--home H]'); return 2; }
  const home = opt("--home") ?? process.env.PASEO_HOME;
  const res = runRoute({
    type, prompt, provider: opt("--provider"), cwd: opt("--cwd") ?? process.cwd(), gate: opt("--gate"), mode: opt("--mode"),
    session: opt("--session") ?? process.env.AGENT_HUB_SESSION, dev: opt("--dev") ?? process.env.AGENT_HUB_DEV ?? os.userInfo().username,
    client: opt("--client") ?? process.env.AGENT_HUB_CLIENT,
  }, cliPaseo(home), loadRoutes());
  console.log(JSON.stringify(res));
  return res.used ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
