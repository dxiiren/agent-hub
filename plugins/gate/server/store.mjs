// Plugin-side gate state. Agents can rewrite their own labels, so the decision never reads labels back:
// attempts, status and the caller's gate command live here. route.mjs writes the caller request (keyed by cwd) before it creates the agent.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export function gateDir(env = process.env) {
  return env.AGENT_HUB_GATE_DIR ?? join(env.PASEO_HOME ?? join(os.homedir(), ".paseo"), "gate");
}

// Requests are keyed by AGENT ID only (nothing an agent can write selects one): the route writes the request after Paseo returns the id, the plugin looks up event.agent.id. No match = no gate request = the plugin fails the turn closed.
const REQ_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/; // a file name: no dots, slashes or colons
const reqFile = (dir, id) => join(dir, "requests", "by-agent", id + ".json");

/** Caller side: bind the caller-supplied gate command and limits to ONE agent id . */
export function writeRequest(dir, agentId, cmd, base = null, extra = {}) {
  if (!REQ_ID.test(String(agentId))) throw new Error("a gate request needs the agent id (1-64 letters, digits, _ or -)");
  mkdirSync(join(dir, "requests", "by-agent"), { recursive: true });
  writeFileSync(reqFile(dir, agentId), JSON.stringify({ cmd: cmd ?? null, base, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)) }));
}

/** Plugin side: take (and delete) the request bound to this agent id. */
export function claimRequest(dir, agentId) {
  if (!REQ_ID.test(String(agentId))) return null;
  const f = reqFile(dir, agentId);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } finally { try { unlinkSync(f); } catch { /* gone */ } }
}

/** Read the request bound to this agent id without taking it (route --status: a cut-off route never ran its caller-side gate). */
export function peekRequest(dir, agentId) {
  if (!REQ_ID.test(String(agentId))) return null;
  try { return JSON.parse(readFileSync(reqFile(dir, agentId), "utf8")); } catch { return null; }
}

/** True while a request or a direct marker exists for this agent id (the plugin waits for it right after a turn: the route binds it a moment after Paseo returns the id). */
export const hasBinding = (dir, agentId) => REQ_ID.test(String(agentId)) && (existsSync(reqFile(dir, agentId)) || (AGENT_ID.test(String(agentId)) && existsSync(directFile(dir, agentId))));

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
