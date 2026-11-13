// Plugin-side gate state. Agents can rewrite their own labels, so the decision never reads labels back:
// attempts, status and the caller's gate command live here. route.mjs writes the caller request (keyed by cwd) before it creates the agent.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

// Direct runs (`agent-hub direct paseo`): create-then-prompt. The launcher creates the agent WITHOUT a prompt, learns its id, writes <gate>/direct/<agentId>.json, and only then sends the prompt.
// So no secret, nonce or label exists before the agent id does, and the marker is keyed by that id alone: nothing a racing agent can read or copy makes another agent exempt.
// The first turn cannot start before the marker exists. Residual: any process of the same OS user can write gate files (this one, requests/, state.json) and so exempt any agent id it knows.
export const DIRECT_MARKER_TTL_MS = 10 * 60_000;
const AGENT_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const directFile = (dir, id) => join(dir, "direct", id + ".json");
export function writeDirectMarker(dir, agentId, now = Date.now()) {
  if (!AGENT_ID.test(String(agentId))) throw new Error("direct marker needs the agent id (8-64 letters, digits, dashes)");
  mkdirSync(join(dir, "direct"), { recursive: true }); writeFileSync(directFile(dir, agentId), JSON.stringify({ ts: now }), { flag: "wx" }); // wx: never overwrites
}
export const removeDirectMarker = (dir, agentId) => { if (AGENT_ID.test(String(agentId))) try { unlinkSync(directFile(dir, agentId)); } catch { /* gone */ } };
export const hasDirectMarkers = (dir) => { try { return readdirSync(join(dir, "direct")).length > 0; } catch { return false; } };
/** true = this agent id has a fresh marker (taken and deleted: once only, inside the TTL); false = anything else. */
export function claimDirect(dir, agentId, now = Date.now()) {
  if (!AGENT_ID.test(String(agentId))) return false;
  try {
    const m = JSON.parse(readFileSync(directFile(dir, agentId), "utf8"));
    unlinkSync(directFile(dir, agentId));
    return now - (m.ts ?? 0) < DIRECT_MARKER_TTL_MS;
  } catch { return false; }
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
