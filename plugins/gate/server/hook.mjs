// The gate decision for one finished turn. Labels are never trusted: an agent can rewrite its own. A direct run is exempt only when the plugin store holds a marker keyed by its agent id (written by the launcher after create, before the prompt).
import { decide, gateOpts, runGate } from "./gate.mjs";
import { claimDirect, claimRequest, loadState, peekRequest, saveState } from "./store.mjs";

/** Returns { d, res, mirror } and persists attempts/status in the plugin store. */
const DIRECT = { d: { status: "N/A", attempts: 0, reprompt: false }, res: { reasons: [] }, mirror: { "gate/status": "N/A", "gate/reasons": "direct run: the hub gate never applies" } };
export function evaluate({ dir, id, cwd, routes }) {
  const state = loadState(dir);
  // A direct run (`agent-hub direct paseo`) is never gated or re-prompted: the launcher created the agent without a prompt, wrote <gate>/direct/<agentId>.json, then sent the prompt, so the marker exists before the first turn.
  // A route request for the cwd always wins (gated normally); no marker, an expired or used one = gated as before (fail closed).
  if (state[id]?.direct) return DIRECT;
  if (!state[id] && !peekRequest(dir, cwd) && claimDirect(dir, id) === true) { state[id] = { direct: true, status: "N/A" }; saveState(dir, state); return DIRECT; }
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
