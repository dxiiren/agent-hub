// Hub-owned record of every agent the hub made, keyed by agent id, written by the route side outside the task folder (<gate dir>/owned/<id>.json).
// Paseo's injected MCP lets any agent rewrite any agent's labels (update_agent has no caller check), so a label never decides who the hub may stop, archive or keep:
// the reaper and cleanup act on an agent only when this record exists (fail closed), and take its type/keep/kind from here. Labels stay for display.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readStateJson, tryWriteState } from "./runstate.mjs";
import { gateDir } from "../gate/server/store.mjs";

const ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;
export const ownedDir = (env = process.env) => join(gateDir(env), "owned");

/** rec: { kind: "route"|"direct"|"doctor", type?, keep?, rid?, session?, dev?, caller? }. Best effort: a failed write only means the reaper leaves this agent alone. */
export function markOwned(id, rec, dir = ownedDir()) {
  if (!ID.test(String(id))) return false;
  try { mkdirSync(dir, { recursive: true }); } catch { return false; }
  return tryWriteState(join(dir, id + ".json"), { ...rec, ts: Date.now() });
}
/** The record for this agent id, or null (never made by the hub, or unreadable). */
export const readOwned = (id, dir = ownedDir()) => (ID.test(String(id)) ? readStateJson(join(dir, id + ".json")) : null);

const norm = (p) => String(p ?? "").split("\\").join("/").toLowerCase().replace(/\/+$/, "");
/** An agent found only by its route/run label (its id was never returned): ours only when it sits in one of the route's own folders and no record says it belongs to another route. */
export function ghostOf(rows, { rid, cwds = [], dir = ownedDir() }) {
  const ok = cwds.map(norm).filter(Boolean);
  return (Array.isArray(rows) ? rows : []).filter((a) => {
    const c = norm(a.cwd); if (!c || !ok.some((r) => c === r || c.startsWith(r + "/"))) return false;
    const rec = readOwned(a.id, dir); return !rec || rec.rid === rid;
  });
}
