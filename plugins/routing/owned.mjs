// Hub-owned record of every agent the hub made, keyed by agent id, written by the route side outside the task folder (<gate dir>/owned/<id>.json).
// Paseo's injected MCP lets any agent rewrite any agent's labels (update_agent has no caller check), so a label never decides who the hub may stop, archive or keep:
// the reaper and cleanup act on an agent only when this record exists (fail closed), and take its type/keep/kind from here. Labels stay for display.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listState, readStateJson, tryWriteState } from "./runstate.mjs";
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
const UNIT = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };
/** Upper bound (s) of the age `paseo ls` prints ("3 minutes ago" is 3 to 4 minutes): Infinity when unreadable. */
export function ageUpperS(created) { const t = String(created ?? "").trim(); const m = /^(\d+)\s+(second|minute|hour|day|week)s?\s+ago$/i.exec(t); return m ? (Number(m[1]) + (/^second/i.test(m[2]) ? 0 : 1)) * UNIT[m[2].toLowerCase()] : /^(just now|now)$/i.test(t) ? 0 : Infinity; }
const badCwd = (c) => !c || c === "/" || /^[a-z]:$/.test(c) || c === "~";
export const PENDING_MAX_MS = 24 * 3600_000;
const pendDir = (dir) => join(dir, "pending");
/** Before the create call: this route may look for an agent it never got an id for. cwd = the folder the agent will run in. Old pending records are purged here (bounded pile). */
export function markPending(rid, cwd, dir = ownedDir(), now = Date.now()) {
  if (!/^[0-9a-f]{8}$/.test(String(rid))) return false;
  try { mkdirSync(pendDir(dir), { recursive: true }); for (const f of listState(pendDir(dir), /\.json$/)) { const r = readStateJson(join(pendDir(dir), f)); if (!r || now - r.start > PENDING_MAX_MS) { try { rmSync(join(pendDir(dir), f), { force: true }); } catch { /* next time */ } } } } catch { return false; }
  return tryWriteState(join(pendDir(dir), rid + ".json"), { rid, cwd, start: now });
}
export const readPending = (rid, dir = ownedDir()) => (/^[0-9a-f]{8}$/.test(String(rid)) ? readStateJson(join(pendDir(dir), rid + ".json")) : null);
export function clearPending(rid, dir = ownedDir()) { try { rmSync(join(pendDir(dir), rid + ".json"), { force: true }); } catch { /* expires */ } }

/**
 * An agent found only by its route/run label (its id was never returned). A label proves nothing, so it only nominates; the agent is ours ONLY when ALL hold:
 * a hub-owned pending record for this rid exists (written before the create call), the agent was created at or after that record's start, its cwd equals the record's cwd exactly (never empty or a drive root),
 * and no hub record binds its id to another rid. Anything else is left alone and logged. No record never means ours.
 */
export function ghostOf(rows, { rid, dir = ownedDir(), now = Date.now(), log = (m) => console.error(m) }) {
  const pend = readPending(rid, dir); const c0 = norm(pend?.cwd);
  const skip = (a, why) => { log(`hub: ghost lookup left ${a?.id} alone (${why})`); return false; };
  return (Array.isArray(rows) ? rows : []).filter((a) => {
    if (!pend || !Number.isFinite(pend.start) || badCwd(c0)) return skip(a, "no usable pending record for this route");
    if (norm(a.cwd) !== c0) return skip(a, "cwd differs");
    if (!(ageUpperS(a.created) * 1000 <= now - pend.start)) return skip(a, "not provably created after the attempt started");
    const rec = readOwned(a.id, dir); if (rec && rec.rid !== rid) return skip(a, "hub record binds it to another route");
    return true;
  });
}
