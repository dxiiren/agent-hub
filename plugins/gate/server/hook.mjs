// The gate decision for one finished turn. Labels are never trusted: an agent can rewrite its own. The one label-derived input is a single-use direct-run nonce that only counts while the plugin store still holds it.
import { decide, gateOpts, runGate } from "./gate.mjs";
import { claimDirect, claimRequest, loadState, peekRequest, saveState } from "./store.mjs";

/** Returns { d, res, mirror } and persists attempts/status in the plugin store. */
const DIRECT = { d: { status: "N/A", attempts: 0, reprompt: false }, res: { reasons: [] }, mirror: { "gate/status": "N/A", "gate/reasons": "direct run: the hub gate never applies" } };
export function evaluate({ dir, id, cwd, routes, directNonce = null }) {
  const state = loadState(dir);
  // A direct run (`agent-hub direct paseo`) is never gated or re-prompted. It proves itself with the single-use nonce the launcher stored here before the agent existed (and put on the agent as a label):
  // the launcher binds the marker to the id of the agent it created, so only that id is exempt (a label copied to another agent never matches). A route request for the cwd always wins (gated normally), and no nonce, a wrong, used or expired one = gated as before (fail closed).
  if (state[id]?.direct) return DIRECT;
  if (!state[id] && directNonce && !peekRequest(dir, cwd) && claimDirect(dir, directNonce, id) === true) { state[id] = { direct: true, status: "N/A" }; saveState(dir, state); return DIRECT; }
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
