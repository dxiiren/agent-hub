// Hub throughput guards (08-11-2026, owner: "MAKE SURE IT DOESN'T HAPPEN AGAIN"). Root cause of the pile-up: ~90-115 active Paseo workspaces make every daemon git op take minutes, routes held their
// slot through the slow archive, and a stuck route held a slot for hours. Five guards, all pure functions with injected I/O so they are unit-tested without a daemon:
//   1 workspace cap (refuse new routes over WORKSPACE_CAP) + sweep of idle workspaces      2 cleanup spool: a route frees its slot when the agent answered; archive runs off-slot
//   3 stuck-route watchdog (no agent progress for STUCK_S)                                  4 healthLine() for `agent-hub doctor`
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const WORKSPACE_CAP = Number(process.env.AGENT_HUB_WORKSPACE_CAP) || 20;
export const STUCK_S = Number(process.env.AGENT_HUB_STUCK_S) || 25 * 60; // soak 08-11: a route queued behind the laptop budget waits 9-11 min before it has an agent, so 10 min reaped a healthy route
export const SWEEP_IDLE_S = 30 * 60;
const ARCHIVE_PARALLEL = 3;
const norm = (p) => String(p ?? "").split("\\").join("/").replace(/\/+$/, "").toLowerCase();
const PERMANENT = /\/desktop\/code\/kollectapps-nextgen-(workspace|staging|sit)$/;
const FINISHED = /^(idle|closed|error|completed|stopped|failed)$/i;

// ---- 1. workspace cap
/** -> null when the daemon may take another route, else the refusal text with the count. `paseo` = sync CLI wrapper. A list that cannot be read never blocks (fail open: the cap protects, it must not take the hub down). */
export function workspaceCapError(paseo, cap = WORKSPACE_CAP) {
  const r = paseo(["workspace", "ls", "--json"]);
  if (!Array.isArray(r)) return null;
  return r.length > cap ? `WORKSPACE_CAP: ${r.length} active Paseo workspaces (limit ${cap}); every daemon git operation slows down with each one, so no new route starts. Run \`agent-hub reaper --once\` (archives idle workspaces) and retry.` : null;
}

// NO git anywhere in this file (security review 08-11, three rounds): git run against a folder an agent could write to executes that folder's fsmonitor, hooks, filter drivers and submodule config. Idleness is read with lstat only.
const SKIP_DIRS = new Set([".git", "node_modules", ".devdb"]);
/** True when any regular file under `dir` (not .git/node_modules/.devdb) was modified after `sinceMs`. lstat only (a symlink is never followed), and it fails closed: a file/dir count over `cap`, a deadline overrun or any read error = true (treated as active). */
export function recentlyTouched(dir, sinceMs, { cap = 20000, deadlineMs = 15000, lstat = lstatSync, readdir = readdirSync, now = Date.now } = {}) {
  const t0 = now(); let seen = 0; const stack = [dir];
  try {
    while (stack.length) {
      const d = stack.pop();
      for (const e of readdir(d, { withFileTypes: true })) {
        if (++seen > cap || now() - t0 > deadlineMs) return true;
        if (e.isSymbolicLink()) continue;
        const f = join(d, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(f); continue; }
        if (e.isFile() && lstat(f).mtimeMs > sinceMs) return true;
      }
    }
    return false;
  } catch { return true; }
}
/** Worktrees this hub created (route-*): a record per path under <run>/hubwt, written when the route's worktree exists. Paseo deletes the FOLDER of a worktree it owns when archiving, so only these (provably ours) are ever archived there. */
export const hubWtDir = (runDir) => join(runDir, "hubwt");
const wtKey = (p) => norm(p).replace(/[^a-z0-9]+/g, "_").slice(-120);
export const recordHubWorktree = (runDir, path) => { try { mkdirSync(hubWtDir(runDir), { recursive: true }); writeFileSync(join(hubWtDir(runDir), wtKey(path) + ".json"), JSON.stringify({ path, at: Date.now() })); } catch { /* the reaper then treats it as unknown (kept) */ } };
export const isHubWorktree = (runDir, path) => existsSync(join(hubWtDir(runDir), wtKey(path) + ".json"));
export const forgetHubWorktree = (runDir, path) => { try { rmSync(join(hubWtDir(runDir), wtKey(path) + ".json"), { force: true }); } catch { /* gone */ } };
const paseoWorktreesRoot = () => norm(join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "worktrees")) + "/";

/**
 * Archive idle Paseo workspaces (a record per workspace slows every daemon git queue). Skipped: the permanent NextGen folders, local (non-worktree) workspaces, anything with an unfinished agent in it, anything with a file touched
 * in the last `idleS`, and - inside Paseo's own worktree root, where Paseo's archive DELETES the folder - anything this hub cannot prove it created. Outside that root Paseo's archive only drops its record and leaves the folder
 * (proven live 08-11: a dirty worktree with an untracked file survived), so uncommitted work there is safe; the lstat scan only decides "someone is still working here".
 */
export async function sweepIdleWorkspaces({ run, runDir = null, now = Date.now, idleS = SWEEP_IDLE_S, max = 40, dry = false, exists = existsSync, touched = recentlyTouched, isHub = (cwd) => (runDir ? isHubWorktree(runDir, cwd) : false), paseoRoot = paseoWorktreesRoot(), log = () => {} }) {
  const safe = async (a) => { try { return await run(a); } catch (e) { return { error: String(e?.message ?? e) }; } };
  let rows = await safe(["workspace", "ls", "--json"]); if (!Array.isArray(rows)) rows = await safe(["workspace", "ls", "--json"]); // one retry: a busy daemon drops the first call
  if (!Array.isArray(rows)) return { archived: [], skipped: [], failed: rows?.error ? String(rows.error).slice(0, 120) : null };
  let agents = await safe(["ls"]); if (!Array.isArray(agents)) agents = await safe(["ls"]); // one retry
  if (!Array.isArray(agents)) { log("sweep skipped: the agent list could not be read, so a busy workspace cannot be told from an idle one (nothing archived)"); return { archived: [], skipped: [], failed: "agent list unreadable: sweep skipped (fail closed)" }; }
  const home = norm(process.env.USERPROFILE || process.env.HOME || "");
  const cwdKey = (c) => norm(c).replace(/^~(?=\/)/, home); // separators first, then ~: a Windows "~\x" cwd must match too
  const busy = new Set(agents.filter((a) => !FINISHED.test(String(a.status ?? ""))).map((a) => cwdKey(a.cwd ?? "")));
  const victims = [], skipped = [];
  for (const w of rows) {
    const cwd = String(w.cwd ?? ""), why = (m) => skipped.push({ id: w.workspaceId, cwd, why: m });
    if (!cwd || !w.workspaceId) continue;
    if (PERMANENT.test(norm(cwd))) { why("permanent folder"); continue; }
    if (!exists(cwd)) { if (exists(dirname(cwd))) victims.push(w); else why("parent missing (unmounted volume?)"); continue; }
    if (w.isolation !== "worktree") { why("not a worktree workspace"); continue; }
    if (busy.has(cwdKey(cwd))) { why("agent running"); continue; }
    if (norm(cwd).startsWith(paseoRoot) && !isHub(cwd)) { why("Paseo-owned folder not created by this hub (archive would delete it)"); continue; }
    if (touched(cwd, now() - idleS * 1000)) { why("a file changed in the last " + idleS / 60 + " min (or the scan could not finish)"); continue; }
    victims.push(w);
  }
  const archived = []; let failed = null; const todo = victims.slice(0, max);
  for (let i = 0; i < todo.length && !failed; i += ARCHIVE_PARALLEL) { // a few at a time: one archive takes 30-40 s on a loaded daemon (08-11), 40 in a row was 25 min
    await Promise.all(todo.slice(i, i + ARCHIVE_PARALLEL).map(async (w) => {
      if (dry) { archived.push(w.workspaceId); return; }
      const r = await safe(["workspace", "archive", w.workspaceId, "--json"]);
      if (r?.error && !/not found|archived/i.test(JSON.stringify(r.error))) { failed ??= JSON.stringify(r.error).slice(0, 160); return; }
      archived.push(w.workspaceId); if (runDir) forgetHubWorktree(runDir, w.cwd); log(`archived ${w.workspaceId} ${w.cwd}`);
    }));
  }
  return { archived, skipped, failed };
}

/**
 * Local (non-worktree) workspaces that own no agent at all, of any status: every `paseo run --cwd` makes a new one and nothing archived it (09-11: 10 copies of one cwd, HUB-HEALTH "workspaces 21 > 20").
 * Archive only drops the record of a local workspace, the folder stays. Never: isolation=worktree, the permanent NextGen folders, a cwd any agent (even finished, unarchived) still names, an unreadable agent list (fail closed).
 * `run(args)` -> parsed JSON, same shape as sweepIdleWorkspaces.
 */
export async function archiveIdleLocalWorkspaces({ run, dry = false, log = () => {} }) {
  const safe = async (a) => { try { return await run(a); } catch (e) { return { error: String(e?.message ?? e) }; } };
  let rows = await safe(["workspace", "ls", "--json"]); if (!Array.isArray(rows)) rows = await safe(["workspace", "ls", "--json"]);
  let agents = await safe(["ls"]); if (!Array.isArray(agents)) agents = await safe(["ls"]);
  if (!Array.isArray(rows) || !Array.isArray(agents)) return [];
  const home = norm(process.env.USERPROFILE || process.env.HOME || "");
  const cwdKey = (c) => norm(c).replace(/^~(?=\/)/, home);
  const owned = new Set(agents.map((a) => cwdKey(a.cwd ?? "")));
  const out = [];
  for (const w of rows) {
    if (!w.workspaceId || !w.cwd || w.isolation !== "local" || PERMANENT.test(norm(w.cwd)) || owned.has(cwdKey(w.cwd))) continue;
    if (!dry) { const r = await safe(["workspace", "archive", w.workspaceId, "--json"]); if (r?.error && !/not found|archived/i.test(JSON.stringify(r.error))) continue; }
    out.push(w.workspaceId); log(`archived local ${w.workspaceId} ${w.cwd}`);
  }
  return out;
}

// ---- 2. cleanup spool: the route frees its slot as soon as the agent answered; this runs afterwards
export const spoolDir = (runDir) => join(runDir, "cleanup");
export function spoolCleanup(runDir, job) {
  const d = spoolDir(runDir); mkdirSync(d, { recursive: true });
  const f = join(d, `${job.agentId ?? "wt-" + (job.wt?.name ?? Date.now())}.json`);
  writeFileSync(f, JSON.stringify({ ...job, at: Date.now() })); return f;
}
/** Archive what the spooled jobs name (agent, then its worktree + workspace). A failed job stays for the next pass. -> ids done. */
export async function drainSpool({ runDir, run, archiveAgent, concurrency = 2 }) {
  const d = spoolDir(runDir); let files = []; try { files = readdirSync(d).filter((f) => f.endsWith(".json")); } catch { return []; }
  const done = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (i < files.length) {
      const f = join(d, files[i++]); let job; try { job = JSON.parse(readFileSync(f, "utf8")); } catch { rmSync(f, { force: true }); continue; }
      let ok = true;
      if (job.agentId) ok = await archiveAgent(run, job.agentId);
      if (ok && job.workspaceId) { const r = await run(["workspace", "archive", job.workspaceId, "--json"]); if (r?.error && !/not found|archived/i.test(String(r.error))) ok = false; } // the route's own workspace, only after its agent is gone
      if (ok && job.wt?.name) { const r = await run(["worktree", "archive", job.wt.name, ...(job.cwd ? ["--cwd", job.cwd] : [])]); if (r?.error && !/not found|archived|no such/i.test(String(r.error))) ok = false; }
      if (ok) { rmSync(f, { force: true }); done.push(job.agentId ?? job.wt?.name); }
    }
  }));
  return done;
}

// ---- 3. stuck-route watchdog
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
/**
 * A slot whose route is alive but whose agents made no progress for `stuckS` (agent UpdatedAt) - or that has no agent at all and is older than `stuckS` - is released: slot file removed, the route's own agents
 * (from its ledger agents-<pid>.json, i.e. hub-created only) archived by id, and the route process ended by its exact pid. Never touches an agent that is not in a route ledger.
 */
export async function reapStuckRoutes({ runDir, run, archiveAgent, now = Date.now, stuckS = STUCK_S, isAlive = alive, kill = (pid) => process.kill(pid), dry = false }) {
  const inflight = join(runDir, "inflight"); let slots = []; try { slots = readdirSync(inflight).filter((f) => /^slot-\d+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const s of slots) {
    let slot; try { slot = JSON.parse(readFileSync(join(inflight, s), "utf8")); } catch { continue; }
    if (!Number.isInteger(slot?.pid) || !isAlive(slot.pid)) continue; // dead owners are reclaimed by the entry gate itself
    let led = null; try { led = JSON.parse(readFileSync(join(runDir, `agents-${slot.pid}.json`), "utf8")); } catch { /* no agent yet */ }
    const ids = (led?.agents ?? []).map((a) => a.id).filter(Boolean);
    let last = slot.at ?? 0;
    for (const id of ids) { const r = await run(["inspect", id, "--json"]); const u = Date.parse(r?.UpdatedAt ?? ""); if (Number.isFinite(u)) last = Math.max(last, u); else if (r?.error && !/not found/i.test(String(r.error))) last = now(); /* unreadable = alive */ }
    if (now() - last < stuckS * 1000) continue;
    out.push({ slot: s, pid: slot.pid, agents: ids, idleS: Math.round((now() - last) / 1000) });
    if (dry) continue;
    rmSync(join(inflight, s), { force: true });
    for (const id of ids) await archiveAgent(run, id);
    try { kill(slot.pid); } catch { /* gone */ }
  }
  return out;
}

// ---- 4. health line
/** One stable line for `agent-hub doctor` and peer reports. FAIL: every slot busy while fewer than 4 tasks finished in 30 min, or workspaces over the cap. */
export function healthLine({ inflight, max, done30m, workspaces, cap = WORKSPACE_CAP, creating = 0 }) {
  const jam = max > 0 && inflight >= max && done30m < 4, over = workspaces > cap, hung = creating > 0;
  const why = [jam ? `${inflight}/${max} slots busy but only ${done30m} done in 30 min` : "", over ? `workspaces ${workspaces} > ${cap}` : "", hung ? `${creating} route(s) stuck creating the worktree/agent over ${Math.round(STUCK_S / 60)} min` : ""].filter(Boolean).join("; ");
  return { ok: !jam && !over && !hung, line: `HUB-HEALTH: slots ${inflight}/${max}, done30m ${done30m}, workspaces ${workspaces} -> ${why ? "FAIL (" + why + ")" : "OK"}` };
}
/** Live routes that hold a slot for over STUCK_S and never got an agent (hung while creating the worktree): HUB-HEALTH FAILs on them. */
export function stuckCreating(runDir, { now = Date.now, stuckS = STUCK_S, isAlive = alive } = {}) {
  let n = 0; const dir = join(runDir, "inflight");
  let slots = []; try { slots = readdirSync(dir).filter((f) => /^slot-\d+\.json$/.test(f)); } catch { return 0; }
  for (const f of slots) {
    let slot; try { slot = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (!Number.isInteger(slot?.pid) || !isAlive(slot.pid) || now() - (slot.at ?? now()) < stuckS * 1000) continue;
    let led = null; try { led = JSON.parse(readFileSync(join(runDir, `agents-${slot.pid}.json`), "utf8")); } catch { /* none */ }
    if (!(led?.agents ?? []).some((a) => a?.id)) n++;
  }
  return n;
}
/** Tasks finished in the last 30 min, from ~/.paseo/usage/usage.jsonl (one line per finished agent turn; distinct agent ids). */
export function doneInWindow(usageFile, now = Date.now(), windowS = 30 * 60) {
  try { const ids = new Set(); for (const l of readFileSync(usageFile, "utf8").split("\n").slice(-4000)) { if (!l) continue; try { const j = JSON.parse(l); if (now - Date.parse(j.ts) <= windowS * 1000) ids.add(j.agent); } catch { /* torn line */ } } return ids.size; } catch { return 0; }
}
export const slotsHeld = (runDir) => { try { return readdirSync(join(runDir, "inflight")).filter((f) => /^slot-\d+\.json$/.test(f)).length; } catch { return 0; } };

/**
 * Archive idle workspaces straight in Paseo's registry file while the daemon is STOPPED (a daemon with ~90 active workspaces needed 12+ min to boot on 08-11, so it cannot be asked to archive them). Same rules as the live sweep
 * (permanent folders, recent files, fail closed), no agent is running with the daemon down, and an offline edit deletes nothing on disk: a workspace is only marked archivedAt, exactly what Paseo's own archive writes.
 * The file is backed up first; refuses to run when anything answers on the daemon port (caller checks) or the file is unreadable.
 */
export async function sweepRegistryOffline({ file, now = Date.now, backup = true, write = writeFileSync, read = readFileSync, ...opts }) {
  const text = read(file, "utf8"), recs = JSON.parse(text.replace(/^﻿/, "")); if (!Array.isArray(recs)) throw new Error("workspaces.json is not a list");
  const active = recs.filter((r) => !r.archivedAt), seen = new Set();
  const rows = active.filter((r) => r.workspaceId && !seen.has(r.workspaceId) && seen.add(r.workspaceId)).map((r) => ({ workspaceId: r.workspaceId, cwd: r.cwd, isolation: r.kind === "worktree" || r.kind === "directory" ? "worktree" : r.kind }));
  const ids = new Set();
  const run = async (a) => (a[0] === "workspace" && a[1] === "ls" ? rows : a[0] === "ls" ? [] : (ids.add(a[2]), { status: "archived" }));
  const r = await sweepIdleWorkspaces({ ...opts, run, now, max: 100000 });
  if (ids.size && !opts.dry) { if (backup) write(file + ".bak-sweep-" + now(), text); const at = new Date(now()).toISOString(); for (const x of recs) if (ids.has(x.workspaceId) && !x.archivedAt) { x.archivedAt = at; x.updatedAt = at; } write(file, JSON.stringify(recs, null, 2)); }
  return r;
}

/**
 * Drops archived records from Paseo's registry while the daemon is STOPPED. 08-11: 2664 of 2669 records were archived, and the daemon's workspace-reconciliation ran `git status` in every one whose folder still
 * existed (1391, NextGen worktrees among them): it saturated git/disk, provider ACP starts timed out and HTTP stopped answering. Backup first; keeps every active or pinned record and the newest `keep` archived ones.
 * Deletes no folder. -> {before, after}
 */
export function pruneArchivedOffline({ file, keep = 50, backup = true, now = Date.now, read = readFileSync, write = writeFileSync }) {
  const text = read(file, "utf8"), recs = JSON.parse(text.replace(/^﻿/, "")); if (!Array.isArray(recs)) throw new Error("workspaces.json is not a list");
  const arch = recs.filter((r) => r.archivedAt && !r.pinnedAt).sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
  const drop = new Set(arch.slice(keep));
  if (!drop.size) return { before: recs.length, after: recs.length };
  if (backup) write(file + ".bak-prune-" + now(), text);
  const out = recs.filter((r) => !drop.has(r)); write(file, JSON.stringify(out, null, 2));
  return { before: recs.length, after: out.length };
}
