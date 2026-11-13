// The gate decision for one finished turn. Takes no agent labels on purpose: an agent can rewrite its own labels.
import { decide, gateOpts, runGate } from "./gate.mjs";
import { claimRequest, loadState, peekRequest, saveState } from "./store.mjs";

/** Returns { d, res, mirror } and persists attempts/status in the plugin store. */
export const DIRECT_MARKER_TTL_MS = 10 * 60_000;
const DIRECT = { d: { status: "N/A", attempts: 0, reprompt: false }, res: { reasons: [] }, mirror: { "gate/status": "N/A", "gate/reasons": "direct run: the hub gate never applies" } };
export function evaluate({ dir, id, cwd, routes }) {
  const state = loadState(dir);
  // `agent-hub direct paseo` writes a marker in this store (keyed by cwd, with a timestamp) BEFORE it creates the agent; the first turn of the agent that claims a fresh marker is a direct run:
  // never gated, never re-prompted. Nothing an agent can write (labels included) switches the gate off: no marker in the store means gated as before (fail closed).
  if (state[id]?.direct) return DIRECT;
  if (!state[id]) { const q = peekRequest(dir, cwd); if (q?.direct === true && Date.now() - (q.ts ?? 0) < DIRECT_MARKER_TTL_MS) { claimRequest(dir, cwd); state[id] = { direct: true, status: "N/A" }; saveState(dir, state); return DIRECT; } }
  const mine = (state[id] ??= (() => { const q = claimRequest(dir, cwd); return { attempts: 0, cmd: q?.cmd ?? null, base: q?.base ?? null, readOnly: q?.readOnly === true, maxLines: q?.maxLines ?? null }; })());
  // summarise/review judge the answer, not a diff: the code-edit gate has nothing to verify and must neither fail them nor re-prompt them
  if (mine.readOnly) { mine.status = "N/A"; saveState(dir, state); return { d: { status: "N/A", attempts: 0, reprompt: false }, res: { reasons: [] }, mirror: { "gate/status": "N/A", "gate/reasons": "read-only task: the diff gate does not apply" } }; }
  const res = runGate(cwd, gateOpts(routes, cwd, mine.cmd, mine.base, mine.maxLines));
  const d = decide(mine.attempts, res, routes.gateRetry === false);
  if (res.noRepo) { d.reprompt = false; d.status = "FAIL"; } // the agent cannot fix a missing repo; the FAIL label is the signal, no tokens burned
  mine.attempts = d.attempts; mine.status = d.status;
  saveState(dir, state);
  const mirror = { "gate/status": d.status, "gate/reasons": res.reasons.join(" | ").slice(0, 400), "gate/attempts": String(d.attempts), "gate/diff": `${res.files} files, ${res.changed} lines` };
  return { d, res, mirror };
}
