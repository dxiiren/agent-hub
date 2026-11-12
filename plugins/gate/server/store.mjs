// Plugin-side gate state. Agents can rewrite their own labels, so the decision never reads labels back:
// attempts, status and the caller's gate command live here. route.mjs writes the caller request (keyed by cwd) before it creates the agent.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export function gateDir(env = process.env) {
  return env.AGENT_HUB_GATE_DIR ?? join(env.PASEO_HOME ?? join(os.homedir(), ".paseo"), "gate");
}

const norm = (cwd) => cwd.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "").toLowerCase();
const reqFile = (dir, cwd) => join(dir, "requests", createHash("sha1").update(norm(cwd)).digest("hex") + ".json");

/** Caller side: register the caller-supplied gate command for the next agent created in cwd. */
export function writeRequest(dir, cwd, cmd, base = null, extra = {}) {
  mkdirSync(join(dir, "requests"), { recursive: true });
  writeFileSync(reqFile(dir, cwd), JSON.stringify({ cmd: cmd ?? null, base, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)) })); // extra: { readOnly, maxLines }
}

/** Plugin side: take (and delete) the pending request for cwd. */
export function claimRequest(dir, cwd) {
  const f = reqFile(dir, cwd);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } finally { try { unlinkSync(f); } catch { /* gone */ } }
}

/** Read the pending request for cwd without taking it (route --status: a cut-off route never ran its caller-side gate). */
export function peekRequest(dir, cwd) {
  try { return JSON.parse(readFileSync(reqFile(dir, cwd), "utf8")); } catch { return null; }
}

const stateFile = (dir) => join(dir, "state.json");

export function loadState(dir) {
  try { return JSON.parse(readFileSync(stateFile(dir), "utf8")); } catch { return {}; }
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const tmp = stateFile(dir) + ".tmp";
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, stateFile(dir));
}
