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
// The gate exempts an agent only when its label carries a nonce that is still in this store (claimed once, bound to that agent id). Neither a cwd nor a label alone proves anything.
export const DIRECT_MARKER_TTL_MS = 10 * 60_000;
const NONCE = /^[0-9a-f]{32}$/;
const directFile = (dir, nonce) => join(dir, "direct", nonce + ".json");
export function writeDirectMarker(dir, nonce, now = Date.now()) {
  if (!NONCE.test(String(nonce))) throw new Error("direct nonce must be 32 hex characters");
  mkdirSync(join(dir, "direct"), { recursive: true }); writeFileSync(directFile(dir, nonce), JSON.stringify({ ts: now }), { flag: "wx" }); // wx: never overwrites
}
export const removeDirectMarker = (dir, nonce) => { if (NONCE.test(String(nonce))) try { unlinkSync(directFile(dir, nonce)); } catch { /* gone */ } };
export const hasDirectMarkers = (dir) => { try { return readdirSync(join(dir, "direct")).length > 0; } catch { return false; } };
/** Take (and delete) a fresh marker for this nonce; true only once, only inside the TTL. */
export function claimDirect(dir, nonce, now = Date.now()) {
  if (!NONCE.test(String(nonce))) return false;
  try { const m = JSON.parse(readFileSync(directFile(dir, nonce), "utf8")); unlinkSync(directFile(dir, nonce)); return now - (m.ts ?? 0) < DIRECT_MARKER_TTL_MS; } catch { return false; }
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
