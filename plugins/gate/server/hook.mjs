// The gate decision for one finished turn. Takes no agent labels on purpose: an agent can rewrite its own labels.
import { decide, repoGate, runGate } from "./gate.mjs";
import { claimRequest, loadState, saveState } from "./store.mjs";

/** Returns { d, res, mirror } and persists attempts/status in the plugin store. */
export function evaluate({ dir, id, cwd, routes }) {
  const row = repoGate(routes, cwd);
  const state = loadState(dir);
  const mine = (state[id] ??= { attempts: 0, cmd: claimRequest(dir, cwd)?.cmd ?? null });
  const res = runGate(cwd, { cmd: mine.cmd ?? row.cmd, maxLines: Number(row.maxLines ?? 400), forbid: row.forbid ?? null, allow: row.allow ?? null });
  const d = decide(mine.attempts, res, routes.gateRetry === false);
  if (res.noRepo) d.reprompt = false; // the agent cannot fix a missing repo; the FAIL label is the signal, no tokens burned
  mine.attempts = d.attempts; mine.status = d.status;
  saveState(dir, state);
  const mirror = { "gate/status": d.status, "gate/reasons": res.reasons.join(" | ").slice(0, 400), "gate/attempts": String(d.attempts), "gate/diff": `${res.files} files, ${res.changed} lines` };
  return { d, res, mirror };
}
