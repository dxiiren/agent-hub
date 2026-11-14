// Hub reaper: an agent keeps its provider CLI (a qoder ~240 MB, a codex chain, a claude ~250 MB) until it is archived. A route archives its own agents (route.mjs drain), but a hard-killed
// route, a crashed caller or an agent made outside route.mjs leaves them idle/error for hours. Every `everyMs` (5 min) this archives, in parallel:
//   1. agents of a route process that is dead (its run-dir ledger agents-<pid>.json),
//   2. agent-hub-created agents (route/type=* or doctor label) that are idle/error/closed for longer than `olderThan` (20 min); running, permission and parked agents and `--keep` routes are never touched.
// `archive --force` ends the CLI process tree. Calls are async (it runs inside the daemon as a plugin, and as `agent-hub reaper`), `concurrency` at a time: the CLI takes seconds per call.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath as toPath } from "node:url";
import os from "node:os";
import { cliArgs, paseoCommand, loadRoutes, parkFile, attemptLimit } from "./route.mjs";
import { ageSeconds, DOCTOR_LABEL } from "./cleanup.mjs";
import { listState, readStateJson, runDir } from "./runstate.mjs";
import { sweepDead } from "./entry-gate.mjs";
import { spawnSyncSafe } from "./spawn-safe.mjs";
import { PERMANENT, healWorkspaces, archiveIdleLocalWorkspaces, drainSpool, reapStuckRoutes, sweepIdleWorkspaces, sweepRegistryOffline, pruneArchivedOffline, archivePermanentDuplicates, reprobeErrorProviders } from "./guards.mjs";

const FINISHED = /^(idle|closed|error|completed|stopped|failed)$/i;
export const RUN_MARGIN_S = Number(process.env.AGENT_HUB_REAP_MARGIN_S) || 5 * 60; // the env override is for the throwaway-hub proof
export const DIRECT_MAX_S = Number(process.env.AGENT_HUB_DIRECT_MAX_S) || 3 * 3600;
export const REAP_AFTER_S = 20 * 60, REAP_EVERY_MS = 5 * 60_000;

/** async paseo(args) -> parsed JSON or {error}. */
export function asyncPaseo(home, env = process.env, timeout = 300_000) {
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
      for (const w of rec.workspaces ?? []) await run(["workspace", "archive", w, "--json"]); // after its agents were archived above
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
export async function reapFinished({ run, routes = {}, all = false, olderThan = REAP_AFTER_S, dry = false, parked = () => false, concurrency = 6, errorAny = true }) {
  const rows = async (a) => { const r = await run(a); return Array.isArray(r) ? r : []; };
  const labels = all ? [null] : [...Object.keys(routes.routes ?? {}).map((t) => `route/type=${t}`), DOCTOR_LABEL];
  const [keep, lists] = await Promise.all([rows(["ls", "--label", "route/keep=1"]), pmap(labels, (l) => rows(l ? ["ls", "--label", l] : ["ls"]), concurrency)]);
  const keepIds = new Set(keep.map((a) => a.id));
  const pool = new Map(), typeOf = new Map(); lists.forEach((l, i) => { for (const a of l) { pool.set(a.id, a); if (labels[i]?.startsWith("route/type=")) typeOf.set(a.id, labels[i].slice(11)); } });
  // an agent in `error` made outside route.mjs (a driver's bare `paseo run`, no route/type label) holds its workspace and CLI forever (13-11: Qwen .122 agent in error): any error agent past olderThan is archived too
  if (!all && errorAny) for (const a of await rows(["ls"])) if (/^error$/i.test(String(a.status ?? "")) && !pool.has(a.id)) pool.set(a.id, a);
  // 13-11 (hubfix-0911): 16 qwen agents started by a driver (`agent-hub direct paseo`, label route=direct) sat "running" 3-4 h on a pending permission, held every slot and sent each chain to qoder; a route-made agent is bounded above, a direct one was not
  const direct = new Set(); if (!all) for (const a of await rows(["ls", "--label", "route=direct"])) { const g = ageSeconds(a.created); if (/^running$/i.test(String(a.status ?? "")) && g !== Infinity && g > DIRECT_MAX_S && !keepIds.has(a.id)) direct.add(a.id); }
  const victims = [...direct];
  for (const a of pool.values()) {
    if (direct.has(a.id)) continue;
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

export const GHOST_MAX_PER_PASS = 30, GHOST_ROUTE_IDLE_S = 10 * 60;
/**
 * Workspaces that only cost the daemon git work. Paseo's reconciliation runs git rev-parse/status/config for every ACTIVE workspace every 5 min and at boot behind one git queue; on 08-11 the registry held 325
 * (84 with the folder gone, 63 more finished route-* worktrees) and the queue never drained: event-loop stalls of 40-250 s, then two hangs (upstream getpaseo/paseo #3426, #8244). Paseo itself never archives a workspace
 * whose project root is gone too, so route worktrees the route had removed stayed active forever. Archived here, up to 30 per pass, one at a time (an archive is a daemon request):
 *   1. cwd missing while its parent folder exists (a missing parent = an unmounted volume, proves nothing: left alone),
 *   2. a route-* worktree under <paseo home>/worktrees with no unfinished agent in it, untouched for 10 min (a route between worktree create and agent create is younger).
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

const NULL_DEV = process.platform === "win32" ? "NUL" : "/dev/null";
// minimal env, no inherited GIT_* variable, no global/system config; fsmonitor and hooks off. Only ever run on a TRUSTED repo, never inside a route worktree.
const hardGit = (repo, args) => spawnSyncSafe("git", ["-c", "core.fsmonitor=", "-c", `core.hooksPath=${NULL_DEV}`, "-C", repo, ...args], { encoding: "utf8", timeout: 120_000, windowsHide: true, env: { PATH: process.env.PATH ?? process.env.Path ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NULL_DEV, GIT_TERMINAL_PROMPT: "0" } });
let repoCfg = null;
/** Main repos hub routes run in: AGENT_HUB_WORKTREE_REPOS (comma list) or "worktreeRepos" in the git-ignored config/hub.local.json. Used only to `git worktree prune` after a folder is deleted. */
export function trustedRepos(env = process.env) {
  if (env.AGENT_HUB_WORKTREE_REPOS !== undefined) return env.AGENT_HUB_WORKTREE_REPOS.split(",").map((x) => x.trim()).filter(Boolean);
  if (!repoCfg) { try { repoCfg = JSON.parse(readFileSync(join(dirname(toPath(import.meta.url)), "..", "..", "config", "hub.local.json"), "utf8")).worktreeRepos ?? []; } catch { repoCfg = []; } }
  return repoCfg;
}
const lower = (p) => String(p).split("\\").join("/").replace(/\/+$/, "").toLowerCase();

/**
 * Remove one route worktree folder WITHOUT running git inside it (status/clean checks would run the worktree's own filter/textconv/include config) and without following links:
 *   - the folder must sit directly under `root`: realpath(parent) + the literal basename must still be inside realpath(root), else refused;
 *   - a symlink or junction at the path is unlinked as a link, never recursed into or handed to git;
 *   - a real folder is rmSync'd (rmSync unlinks links inside it, it does not follow them), only when `force` (idle past the 1 h bar: a dirty worktree is not told apart without git);
 *   - then `git worktree prune` runs on each TRUSTED repo (never one read from the folder's .git file) so its admin record goes too.
 */
export function gitWorktreeRemove(path, force = false, repos = trustedRepos(), root = join(process.env.PASEO_HOME || join(os.homedir(), ".paseo"), "worktrees")) {
  try {
    let st; try { st = lstatSync(path); } catch { return true; } // already gone
    const parent = realpathSync.native(dirname(path)), rootReal = realpathSync.native(root);
    const target = join(parent, basename(path));
    if (!(lower(target) + "/").startsWith(lower(rootReal) + "/") || lower(target) === lower(rootReal)) return false; // outside the worktrees root
    if (st.isSymbolicLink()) { unlinkSync(target); return !existsSync(path); } // a planted junction/link: drop the link only
    if (!force) return false;
    rmSync(target, { recursive: true, force: true });
    for (const repo of repos) if (existsSync(repo)) hardGit(repo, ["worktree", "prune"]);
    return !existsSync(path);
  } catch { return false; }
}

export const FOLDER_IDLE_S = 10 * 60, FOLDER_FORCE_S = 60 * 60;
/**
 * Disk, not daemon records: finished route worktrees left in <paseo home>/worktrees (13-11: 382 folders, 44 GB). A folder <home>/worktrees/<hash>/route-* is removed with `git worktree remove` when no unfinished agent
 * and no active workspace names it, it is not a permanent folder, and nothing touched it for 10 min (--force after 1 h, plain remove only before). Emptied <hash> parents (and empty ones) are rmdir'd, which refuses a non-empty folder.
 * Returns { removed: [paths], kept: [{path, why}], bytes }; `size(path)` is injectable for the proof.
 */
export async function reapWorktreeFolders({ run, home, dry = false, list = (d) => { try { return readdirSync(d); } catch { return []; } }, mtimeMs = (f) => { try { return statSync(f).mtimeMs; } catch { return Date.now(); } }, now = Date.now, remove = null, size = () => 0, rmEmpty = (d) => { try { rmdirSync(d); return true; } catch { return false; } }, max = 400 }) {
  const root = join(home || join(os.homedir(), ".paseo"), "worktrees"); remove ??= (p, f) => gitWorktreeRemove(p, f, trustedRepos(), root);
  const norm = (p) => String(p).split("\\").join("/").replace(/^~(?=[\/])/, os.homedir()).toLowerCase();
  const agents = await run(["ls"]); const wss = await run(["workspace", "ls", "--json"]);
  if (!Array.isArray(agents) || !Array.isArray(wss)) return { removed: [], kept: [], bytes: 0, failed: "daemon list unreadable" }; // fail closed
  const busy = [...agents.filter((a) => !FINISHED.test(String(a.status ?? ""))).map((a) => a.cwd), ...wss.map((w) => w.cwd)].map(norm);
  const removed = [], kept = []; let bytes = 0;
  for (const h of list(root)) {
    const hd = join(root, h);
    for (const r of list(hd)) {
      if (removed.length >= max) break;
      const p = join(hd, r), n = norm(p);
      const why = !/^route-[0-9a-f]+/.test(r) ? "not a route worktree" : PERMANENT.test(n) ? "permanent folder" : busy.some((b) => b === n || b.startsWith(n + "/")) ? "agent or workspace uses it" : null;
      const idle = (now() - mtimeMs(p)) / 1000;
      if (why || idle < FOLDER_IDLE_S) { kept.push({ path: p, why: why ?? "touched in the last 10 min" }); continue; }
      const sz = size(p);
      if (dry || remove(p, idle >= FOLDER_FORCE_S)) { removed.push(p); bytes += sz; } else kept.push({ path: p, why: "git worktree remove refused" });
    }
    if (!dry) rmEmpty(hd);
  }
  return { removed, kept, bytes };
}

/** One reaper pass: dead routes' agents, then old finished agents. */
export async function reapOnce({ run, env = process.env, home = env.PASEO_HOME, ...opts }) {
  const parkDir = join(home || join(env.USERPROFILE || env.HOME || "", ".paseo"), "usage", "parked");
  const parked = (id) => { try { readFileSync(parkFile(parkDir, id), "utf8"); return true; } catch { return false; } };
  let dead = []; try { dead = await reapDeadRoutes({ run, dry: opts.dry, concurrency: opts.concurrency }); } catch { /* no run dir yet */ }
  const fin = await reapFinished({ run, routes: opts.routes ?? loadRoutes(env), parked, ...opts });
  let ghosts = { archived: [] }; if (opts.ghosts !== false) { try { ghosts = await reapGhostWorkspaces({ run, home, dry: opts.dry }); } catch { /* next pass */ } }
  let folders = { removed: [] }; if (opts.ghosts !== false) { try { folders = await reapWorktreeFolders({ run, home, dry: opts.dry }); } catch { /* next pass */ } }
  let spooled = [], stuck = []; // guards.mjs: off-slot cleanup of finished routes, and slots held by routes whose agents went silent
  if (!opts.dry) { try { spooled = await drainSpool({ runDir: runDir(), run, archiveAgent }); } catch { /* next pass */ } try { stuck = await reapStuckRoutes({ runDir: runDir(), run, archiveAgent }); } catch { /* next pass */ } }
  let dupes = []; if (!opts.dry && opts.dupes !== false) { try { dupes = (await archivePermanentDuplicates({ run, home })).archived; } catch { /* next pass */ } } // duplicate records of a permanent folder (the folder is never touched)
  return { dead, ...fin, ghosts: ghosts.archived, folders: folders.removed, dupes, ...(ghosts.failed ? { ghostsFailed: ghosts.failed } : {}), spooled, stuck };
}

/** Office model servers that moved: scripts/discover.mjs repoints the provider config (own log ~/.agent-hub/discovery.log). A changed provider needs the next daemon restart to take effect in Paseo. */
export const discoverEndpoints = (log) => new Promise((resolve) => execFile(process.execPath, [join(dirname(toPath(import.meta.url)), "..", "..", "scripts", "discover.mjs")], { timeout: 60_000, windowsHide: true }, (e, out) => { if (e) log("agent-hub discover: " + String(e.message).slice(0, 200)); else if (/"changed":\s*[1-9]/.test(out)) log("agent-hub discover: provider endpoint(s) repointed, see ~/.agent-hub/discovery.log (daemon restart loads them)"); resolve(); }));

/** Start the periodic reaper; returns stop(). One pass at a time; the timer never keeps the process alive. */
export function startReaper({ run, everyMs = REAP_EVERY_MS, log = (m) => console.error(m), ...opts }) {
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { const r = await reapOnce({ run, ...opts }); if (r.dead.length || r.archived.length) log(`agent-hub reaper: archived ${r.dead.length} agent(s) of dead routes and ${r.archived.length} finished agent(s) idle over ${Math.round((opts.olderThan ?? REAP_AFTER_S) / 60)} min`); }
    catch (e) { log("agent-hub reaper: " + String(e?.message ?? e)); } finally { busy = false; }
  };
  const t = setInterval(tick, everyMs); t.unref?.();
  let sbusy = false; // workspace sweep every 10 min (guards.mjs): idle, clean worktree workspaces; the cap in route.mjs refuses routes over 20
  const sweep = async () => { if (sbusy) return; sbusy = true; try { const r = await sweepIdleWorkspaces({ run, runDir: runDir(), log }); if (r.archived.length) log(`agent-hub reaper: archived ${r.archived.length} idle workspace(s)`); const l = await archiveIdleLocalWorkspaces({ run, log }); if (l.length) log(`agent-hub reaper: archived ${l.length} idle local workspace(s)`); const d = await archivePermanentDuplicates({ run, log }); if (d.archived.length) log(`agent-hub reaper: archived ${d.archived.length} duplicate record(s) of a permanent folder`); await reprobeErrorProviders({ run, log }); await discoverEndpoints(log); } catch (e) { log("agent-hub reaper sweep: " + String(e?.message ?? e)); } finally { sbusy = false; } };
  const t2 = setInterval(sweep, 10 * 60_000); t2.unref?.();
  const t3 = setTimeout(() => discoverEndpoints(log), 60_000); t3.unref?.(); // after a daemon start: repoint office providers that moved
  return () => { clearInterval(t); clearInterval(t2); clearTimeout(t3); };
}

// node reaper.mjs [--once] [--dry-run] [--older-than 20m] [--every 5m] [--home H]: standalone form of the daemon plugin (plugins/reaper)
import { fileURLToPath } from "node:url";
import { parseAge } from "./cleanup.mjs";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2), opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const run = asyncPaseo(opt("--home") ?? process.env.PASEO_HOME), olderThan = opt("--older-than") ? parseAge(opt("--older-than")) : REAP_AFTER_S, dry = a.includes("--dry-run");
  if (a.includes("--watch")) { // detached watchdog started by route.mjs: route is synchronous, so a caller's hard kill (timeout) runs no handler; this process waits for the route pid, kills it after --kill-after seconds, then reaps what it left (agents, workspaces, slots)
    const pid = Number(opt("--watch")), killAfter = Number(opt("--kill-after") ?? 0) * 1000, t0 = Date.now(); const alive = () => !pidDead(pid);
    while (alive() && Date.now() - t0 < 3 * 3600_000) { if (killAfter && Date.now() - t0 >= killAfter) { try { process.kill(pid); } catch { /* gone */ } } await new Promise((r) => setTimeout(r, 2000)); }
    await new Promise((r) => setTimeout(r, 1500)); const rd = runDir(); sweepDead(join(rd, "inflight"));
    try { for (const d of readdirSync(rd)) if (d.startsWith("session-")) sweepDead(join(rd, d, "inflight")); } catch { /* none */ }
    const r = await reapDeadRoutes({ run, dry: false }); console.log(JSON.stringify({ watched: pid, reaped: r })); process.exit(0);
  }
  if (a.includes("--spool")) { const done = await drainSpool({ runDir: runDir(), run, archiveAgent }); console.log(JSON.stringify({ spooled: done })); process.exit(0); } // detached worker started by a finished route
  if (a.includes("--prune-offline")) { // daemon STOPPED: drop archived records (backup first) so boot-time git reconciliation has nothing to scan
    const home = opt("--home") ?? process.env.PASEO_HOME ?? join(os.homedir(), ".paseo"); const port = process.env.AGENT_HUB_PORT ?? "6767"; const up = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
    if (up) { console.log(JSON.stringify({ refused: "daemon answers on port " + port + ": prune only while it is stopped" })); process.exit(0); }
    console.log(JSON.stringify(pruneArchivedOffline({ file: join(home, "projects", "workspaces.json") }))); process.exit(0);
  }
  if (a.includes("--sweep-offline")) { // daemon STOPPED: archive idle workspaces in ~/.paseo/projects/workspaces.json (backup first)
    const home = opt("--home") ?? process.env.PASEO_HOME ?? join(os.homedir(), ".paseo"); const r = await sweepRegistryOffline({ file: join(home, "projects", "workspaces.json"), runDir: runDir(), dry, log: console.log });
    console.log(JSON.stringify({ archived: r.archived.length, skipped: r.skipped.map((x) => `${x.cwd}: ${x.why}`), failed: r.failed })); process.exit(0);
  }
  if (a.includes("--reprobe")) { console.log(JSON.stringify({ probed: await reprobeErrorProviders({ run, log: console.log }) })); process.exit(0); }
  if (a.includes("--dedupe-permanent")) { const r = await archivePermanentDuplicates({ run, dry, log: console.log }); console.log(JSON.stringify(r)); process.exit(0); }
  if (a.includes("--heal-cap")) { const r = await healWorkspaces({ run, runDir: runDir(), log: console.log }); console.log(JSON.stringify(r)); process.exit(0); } // route.mjs calls this once when the workspace cap would refuse a route
  if (a.includes("--sweep")) { const r = await sweepIdleWorkspaces({ run, runDir: runDir(), dry, idleS: opt("--idle") ? parseAge(opt("--idle")) : undefined, log: console.log }); console.log(JSON.stringify({ archived: r.archived, skipped: r.skipped.length, failed: r.failed })); process.exit(0); }
  if (a.includes("--once") || dry) { const r = await reapOnce({ run, olderThan, dry }); console.log(JSON.stringify(r)); process.exit(0); }
  startReaper({ run, olderThan, everyMs: (opt("--every") ? parseAge(opt("--every")) : REAP_EVERY_MS / 1000) * 1000, log: console.log }); // the interval is unref'd, so hold the process open
  setInterval(() => {}, 1 << 30);
}
