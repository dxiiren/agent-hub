// Hub reaper: an agent keeps its provider CLI (a qoder ~240 MB, a codex chain, a claude ~250 MB) until it is archived. A route archives its own agents (route.mjs drain), but a hard-killed
// route, a crashed caller or an agent made outside route.mjs leaves them idle/error for hours. Every `everyMs` (5 min) this archives, in parallel:
//   1. agents of a route process that is dead (its run-dir ledger agents-<pid>.json),
//   2. agent-hub-created agents (route/type=* or doctor label) that are idle/error/closed for longer than `olderThan` (20 min); running, permission and parked agents and `--keep` routes are never touched.
// `archive --force` ends the CLI process tree. Calls are async (it runs inside the daemon as a plugin, and as `agent-hub reaper`), `concurrency` at a time: the CLI takes seconds per call.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { cliArgs, paseoCommand, loadRoutes, parkFile, attemptLimit } from "./route.mjs";
import { ageSeconds, DOCTOR_LABEL } from "./cleanup.mjs";
import { listState, readStateJson, runDir } from "./runstate.mjs";

const FINISHED = /^(idle|closed|error|completed|stopped|failed)$/i;
export const RUN_MARGIN_S = Number(process.env.AGENT_HUB_REAP_MARGIN_S) || 5 * 60; // the env override is for the throwaway-hub proof
export const REAP_AFTER_S = 20 * 60, REAP_EVERY_MS = 5 * 60_000;

/** async paseo(args) -> parsed JSON or {error}. */
export function asyncPaseo(home, env = process.env, timeout = 120_000) {
  const [cmd, ...pre] = paseoCommand(env);
  return (args) => new Promise((res) => {
    execFile(cmd, [...pre, ...cliArgs(args, home, true)], { env, timeout, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (e, out) => {
      try { res(JSON.parse(String(out).slice(String(out).search(/[[{]/)))); } catch { res({ error: String(e?.message ?? out ?? "no output").slice(0, 300) }); }
    });
  });
}

/** Run fn over items, `n` at a time. */
export async function pmap(items, fn, n = 6) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/** Archive (and force-stop) one agent; one retry on an error that is not "already gone". */
export async function archiveAgent(run, id) {
  let r = await run(["archive", id, "--force"]);
  if (r?.error && !/not found|archived/i.test(String(r.error))) r = await run(["archive", id, "--force"]);
  return !r?.error || /not found|archived/i.test(String(r.error));
}

const pidDead = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e?.code === "ESRCH"; } };

/** Agents of route processes that died without cleaning up. Returns the agent ids archived. */
export async function reapDeadRoutes({ run, dir = runDir(), dead = pidDead, dry = false, concurrency = 6 }) {
  const done = [];
  for (const f of listState(dir, /^agents-\d+\.json$/)) {
    const rec = readStateJson(join(dir, f));
    if (!rec || !Number.isInteger(rec.pid) || !dead(rec.pid)) continue;
    const ids = (rec.agents ?? []).map((a) => a.id).filter(Boolean);
    for (const rid of rec.runs ?? []) { const l = await run(["ls", "--label", `route/run=${rid}`]); for (const a of Array.isArray(l) ? l : []) ids.push(a.id); } // an attempt that was still creating/waiting when the route died
    if (!dry) {
      await pmap(ids, (id) => archiveAgent(run, id), concurrency);
      for (const a of rec.agents ?? []) if (a.wt?.name && rec.cwd) await run(["worktree", "archive", a.wt.name, "--cwd", rec.cwd]);
      try { rmSync(join(dir, f), { force: true }); } catch { /* retried next time */ }
    }
    done.push(...ids);
  }
  return done;
}

/**
 * Archive finished agents older than `olderThan` seconds. mine (default): only agent-hub-made ones (route/type=<type>, doctor); all: every finished agent of the daemon.
 * `parked(id)` true = a parked route agent (waiting for `agent-hub reply`), left alone. Returns { archived: [ids], skipped: n }.
 */
export async function reapFinished({ run, routes = {}, all = false, olderThan = REAP_AFTER_S, dry = false, parked = () => false, concurrency = 6 }) {
  const rows = async (a) => { const r = await run(a); return Array.isArray(r) ? r : []; };
  const labels = all ? [null] : [...Object.keys(routes.routes ?? {}).map((t) => `route/type=${t}`), DOCTOR_LABEL];
  const [keep, lists] = await Promise.all([rows(["ls", "--label", "route/keep=1"]), pmap(labels, (l) => rows(l ? ["ls", "--label", l] : ["ls"]), concurrency)]);
  const keepIds = new Set(keep.map((a) => a.id));
  const pool = new Map(), typeOf = new Map(); lists.forEach((l, i) => { for (const a of l) { pool.set(a.id, a); if (labels[i]?.startsWith("route/type=")) typeOf.set(a.id, labels[i].slice(11)); } });
  const victims = [];
  for (const a of pool.values()) {
    const age = ageSeconds(a.created); // unreadable = Infinity: archived only when no age limit was asked for
    // a route-made agent still "running" long after its route's own per-attempt time limit has nobody waiting for it (its route died or timed out): stop and archive it
    const t = typeOf.get(a.id);
    if (t && /^running$/i.test(String(a.status ?? "")) && age !== Infinity && age > attemptLimit({ type: t }, routes) + RUN_MARGIN_S && !keepIds.has(a.id)) { victims.push(a.id); continue; }
    if (!FINISHED.test(String(a.status ?? "")) || (age === Infinity ? olderThan > 0 : age < olderThan) || keepIds.has(a.id) || parked(a.id)) continue;
    victims.push(a.id);
  }
  if (!dry) await pmap(victims, (id) => archiveAgent(run, id), concurrency);
  return { archived: victims, skipped: pool.size - victims.length };
}

export const GHOST_MAX_PER_PASS = 30, GHOST_ROUTE_IDLE_S = 30 * 60;
/**
 * Workspaces that only cost the daemon git work. Paseo's reconciliation runs git rev-parse/status/config for every ACTIVE workspace every 5 min and at boot behind one git queue; on 08-11 the registry held 325
 * (84 with the folder gone, 63 more finished route-* worktrees) and the queue never drained: event-loop stalls of 40-250 s, then two hangs (upstream getpaseo/paseo #3426, #8244). Paseo itself never archives a workspace
 * whose project root is gone too, so route worktrees the route had removed stayed active forever. Archived here, up to 30 per pass, one at a time (an archive is a daemon request):
 *   1. cwd missing while its parent folder exists (a missing parent = an unmounted volume, proves nothing: left alone),
 *   2. a route-* worktree under <paseo home>/worktrees with no unfinished agent in it, untouched for 30 min (a route between worktree create and agent create is younger).
 * Stops the pass at the first failed archive (a busy daemon): the next pass continues. Returns { archived: [workspaceId], failed }.
 */
export async function reapGhostWorkspaces({ run, home, exists = existsSync, mtimeMs = (f) => { try { return statSync(f).mtimeMs; } catch { return Date.now(); } }, now = Date.now, dry = false, max = GHOST_MAX_PER_PASS }) {
  const rows = await run(["workspace", "ls", "--json"]); if (!Array.isArray(rows)) return { archived: [], failed: rows?.error ? String(rows.error).slice(0, 120) : null };
  const agents = await run(["ls"]); const live = new Set((Array.isArray(agents) ? agents : []).filter((a) => !FINISHED.test(String(a.status ?? ""))).map((a) => String(a.cwd ?? "").replace(/^~(?=[\/])/, os.homedir()).split("\\").join("/").toLowerCase()));
  const wt = join(home || join(os.homedir(), ".paseo"), "worktrees").split("\\").join("/").toLowerCase() + "/";
  const norm = (p) => String(p).split("\\").join("/").toLowerCase();
  const victims = rows.filter((w) => {
    const cwd = String(w.cwd ?? ""); if (!cwd || !w.workspaceId) return false;
    if (!exists(cwd)) return exists(dirname(cwd));
    return norm(cwd).startsWith(wt) && /(^|\/)route-[0-9a-f]+/.test(norm(cwd)) && !live.has(norm(cwd)) && now() - mtimeMs(cwd) > GHOST_ROUTE_IDLE_S * 1000;
  }).slice(0, max);
  const archived = []; let failed = null;
  if (!dry) for (const w of victims) {
    const r = await run(["workspace", "archive", w.workspaceId, "--json"]);
    if (r?.error && !/not found|archived/i.test(JSON.stringify(r.error))) { failed = JSON.stringify(r.error).slice(0, 160); break; }
    archived.push(w.workspaceId);
  } else archived.push(...victims.map((w) => w.workspaceId));
  return { archived, failed };
}

/** One reaper pass: dead routes' agents, then old finished agents. */
export async function reapOnce({ run, env = process.env, home = env.PASEO_HOME, ...opts }) {
  const parkDir = join(home || join(env.USERPROFILE || env.HOME || "", ".paseo"), "usage", "parked");
  const parked = (id) => { try { readFileSync(parkFile(parkDir, id), "utf8"); return true; } catch { return false; } };
  let dead = []; try { dead = await reapDeadRoutes({ run, dry: opts.dry, concurrency: opts.concurrency }); } catch { /* no run dir yet */ }
  const fin = await reapFinished({ run, routes: opts.routes ?? loadRoutes(env), parked, ...opts });
  let ghosts = { archived: [] }; if (opts.ghosts !== false) { try { ghosts = await reapGhostWorkspaces({ run, home, dry: opts.dry }); } catch { /* next pass */ } }
  return { dead, ...fin, ghosts: ghosts.archived, ...(ghosts.failed ? { ghostsFailed: ghosts.failed } : {}) };
}

/** Start the periodic reaper; returns stop(). One pass at a time; the timer never keeps the process alive. */
export function startReaper({ run, everyMs = REAP_EVERY_MS, log = (m) => console.error(m), ...opts }) {
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { const r = await reapOnce({ run, ...opts }); if (r.dead.length || r.archived.length) log(`agent-hub reaper: archived ${r.dead.length} agent(s) of dead routes and ${r.archived.length} finished agent(s) idle over ${Math.round((opts.olderThan ?? REAP_AFTER_S) / 60)} min`); }
    catch (e) { log("agent-hub reaper: " + String(e?.message ?? e)); } finally { busy = false; }
  };
  const t = setInterval(tick, everyMs); t.unref?.();
  return () => clearInterval(t);
}

// node reaper.mjs [--once] [--dry-run] [--older-than 20m] [--every 5m] [--home H]: standalone form of the daemon plugin (plugins/reaper)
import { fileURLToPath } from "node:url";
import { parseAge } from "./cleanup.mjs";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2), opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const run = asyncPaseo(opt("--home") ?? process.env.PASEO_HOME), olderThan = opt("--older-than") ? parseAge(opt("--older-than")) : REAP_AFTER_S, dry = a.includes("--dry-run");
  if (a.includes("--once") || dry) { const r = await reapOnce({ run, olderThan, dry }); console.log(JSON.stringify(r)); process.exit(0); }
  startReaper({ run, olderThan, everyMs: (opt("--every") ? parseAge(opt("--every")) : REAP_EVERY_MS / 1000) * 1000, log: console.log }); // the interval is unref'd, so hold the process open
  setInterval(() => {}, 1 << 30);
}
