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

// Direct runs (`agent-hub direct paseo`): an unguessable single-use nonce, stored here BEFORE the agent exists and also passed to it as the label direct-nonce.
// The gate exempts an agent only when its label carries a nonce that is still in this store (bound by the launcher to the agent id it created, claimed once by that id). Neither a cwd nor a label alone proves anything.
export const DIRECT_MARKER_TTL_MS = 10 * 60_000;
const NONCE = /^[0-9a-f]{32}$/;
const directFile = (dir, nonce) => join(dir, "direct", nonce + ".json");
export function writeDirectMarker(dir, nonce, now = Date.now()) {
  if (!NONCE.test(String(nonce))) throw new Error("direct nonce must be 32 hex characters");
  mkdirSync(join(dir, "direct"), { recursive: true }); writeFileSync(directFile(dir, nonce), JSON.stringify({ ts: now }), { flag: "wx" }); // wx: never overwrites
}
export const removeDirectMarker = (dir, nonce) => { if (NONCE.test(String(nonce))) try { unlinkSync(directFile(dir, nonce)); } catch { /* gone */ } };
export const hasDirectMarkers = (dir) => { try { return readdirSync(join(dir, "direct")).length > 0; } catch { return false; } };
/** The launcher binds the marker to the agent id it found by the label (first bind wins). Returns false when the marker is gone or already bound to another id. */
export function bindDirect(dir, nonce, agentId) {
  if (!NONCE.test(String(nonce)) || !agentId) return false;
  try {
    const m = JSON.parse(readFileSync(directFile(dir, nonce), "utf8"));
    if (m.agentId) return m.agentId === agentId;
    const tmp = directFile(dir, nonce) + "." + process.pid + ".tmp"; writeFileSync(tmp, JSON.stringify({ ...m, agentId })); renameSync(tmp, directFile(dir, nonce)); return true;
  } catch { return false; }
}
/** true = the marker is bound to exactly this agent id (taken and deleted: once only, inside the TTL); "pending" = not bound yet (the launcher is still looking the agent up); false = anything else.
 *  A label copied onto another agent never matches the bound id, so it neither exempts that agent nor burns the real one's marker. */
export function claimDirect(dir, nonce, agentId, now = Date.now(), consume = true) {
  if (!NONCE.test(String(nonce)) || !agentId) return false;
  try {
    const m = JSON.parse(readFileSync(directFile(dir, nonce), "utf8"));
    if (now - (m.ts ?? 0) >= DIRECT_MARKER_TTL_MS) { unlinkSync(directFile(dir, nonce)); return false; }
    if (!m.agentId) return "pending";
    if (m.agentId !== agentId) return false;
    if (consume) unlinkSync(directFile(dir, nonce)); return true;
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
