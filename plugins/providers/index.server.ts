import type { PluginServerContext } from "@getpaseo/plugin/server";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { providersRpc } from "./shared/rpc";

/** The repo that holds scripts/provider.mjs: AGENT_HUB_REPO, else two levels above this plugin, else the install path recorded in the Paseo config. */
function repoRoot(): string {
  const cands: string[] = [];
  if (process.env.AGENT_HUB_REPO) cands.push(process.env.AGENT_HUB_REPO);
  try { cands.push(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")); } catch { /* bundled: no import.meta.url */ }
  try {
    const cfg = JSON.parse(readFileSync(join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "config.json"), "utf8"));
    const own = cfg.plugins?.["agent-hub-providers"]?.path; // this plugin's own install path first: another hub plugin may sit in a different checkout
    if (own) cands.push(resolve(own, "..", ".."));
    for (const p of Object.values<any>(cfg.plugins ?? {})) if (p?.path) cands.push(resolve(p.path, "..", ".."));
  } catch { /* no config */ }
  const hit = cands.find((c) => existsSync(join(c, "scripts", "provider.mjs")));
  if (!hit) throw new Error("agent-hub repo not found: set AGENT_HUB_REPO");
  return hit;
}

/** Runs the CLI's api verb; the request (it may carry an API key) goes in on stdin, never on the command line. */
function call(verb: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((ok) => {
    let out = "";
    let err = "";
    let child;
    // The plugin host may not be node itself: use process.execPath only when it is node, else `node` from PATH.
    const node = /(^|[\\/])node(\.exe)?$/i.test(process.execPath) ? process.execPath : "node";
    try { child = spawn(node, [join(repoRoot(), "scripts", "provider.mjs"), "api"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
    catch (e: any) { return ok({ error: String(e?.message ?? e) }); }
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => ok({ error: String(e.message) }));
    child.on("close", (code) => { clearTimeout(timer); try { ok(JSON.parse(out)); } catch { ok({ error: `provider tool returned no result (exit ${code}, ${node}): ${err.slice(0, 200)}` }); } });
    child.stdin.end(JSON.stringify({ verb, args }));
  });
}

export default function contribute(server: PluginServerContext) {
  server.handle(providersRpc, async (input) => call(input.verb, input.args as Record<string, unknown>));
  return () => {};
}
