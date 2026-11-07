import type { PluginServerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Runs inside the daemon: one pass every 5 min in a child node process (plugin modules may only import from their own folders, and the pass takes seconds per agent).
// The pass never touches running agents except a route agent past its time limit; see OVERVIEW.md.
// The bundled plugin has no usable import.meta.url: find the repo from the plugin path Paseo recorded in its config (same way the gate plugin does).
function script(): string {
  if (process.env.AGENT_HUB_REPO) return join(process.env.AGENT_HUB_REPO, "plugins", "routing", "reaper.mjs");
  const cfg = JSON.parse(readFileSync(join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "config.json"), "utf8"));
  const p = Object.values<any>(cfg.plugins ?? {}).map((x) => x?.path).find((x) => x && existsSync(join(x, "..", "routing", "reaper.mjs")));
  if (!p) throw new Error("agent-hub-reaper: repo not found (set AGENT_HUB_REPO)");
  return join(p, "..", "routing", "reaper.mjs");
}

export default function contribute(_server: PluginServerContext) {
  let busy = false;
  const pass = () => {
    if (busy) return; busy = true;
    let file: string; try { file = script(); } catch (e) { busy = false; console.error(String(e)); return; }
    execFile(process.execPath, [file, "--once"], { env: process.env, timeout: 10 * 60_000, windowsHide: true }, (e, out) => {
      busy = false;
      if (e) console.error("agent-hub-reaper", String(e.message).slice(0, 300)); else if (/"(dead|archived)":\[[^\]]/.test(out)) console.error("agent-hub-reaper " + out.trim().slice(0, 300));
    });
  };
  const first = setTimeout(pass, 60_000);
  const timer = setInterval(pass, 5 * 60_000);
  return () => { clearTimeout(first); clearInterval(timer); };
}
