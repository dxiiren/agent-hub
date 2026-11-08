// Hub throughput guards (08-11-2026, owner: "MAKE SURE IT DOESN'T HAPPEN AGAIN"). Root cause of the pile-up: ~90-115 active Paseo workspaces make every daemon git op take minutes, routes held their
// slot through the slow archive, and a stuck route held a slot for hours. Five guards, all pure functions with injected I/O so they are unit-tested without a daemon:
//   1 workspace cap (refuse new routes over WORKSPACE_CAP) + sweep of idle workspaces      2 cleanup spool: a route frees its slot when the agent answered; archive runs off-slot
//   3 stuck-route watchdog (no agent progress for STUCK_S)                                  4 healthLine() for `agent-hub doctor`
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
const devNull = process.platform === "win32" ? "NUL" : "/dev/null"; // os.devNull is a UNC-style path on Windows that git refuses
import { execFile } from "node:child_process";

export const WORKSPACE_CAP = Number(process.env.AGENT_HUB_WORKSPACE_CAP) || 20;
export const STUCK_S = Number(process.env.AGENT_HUB_STUCK_S) || 10 * 60;
export const SWEEP_IDLE_S = 30 * 60;
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

/** A workspace is idle when it is a worktree-isolated one (or a ghost), is not a permanent NextGen folder, no unfinished agent runs in it, nothing in it changed for `idleS`, and it has no uncommitted work. */
export async function sweepIdleWorkspaces({ run, now = Date.now, idleS = SWEEP_IDLE_S, max = 40, dry = false, exists = existsSync, mtimeMs = defaultMtime, dirty = gitDirty, log = () => {} }) {
  let rows = await run(["workspace", "ls", "--json"]); if (!Array.isArray(rows)) rows = await run(["workspace", "ls", "--json"]); // one retry: a busy daemon drops the first call
  if (!Array.isArray(rows)) return { archived: [], skipped: [], failed: rows?.error ? String(rows.error).slice(0, 120) : null };
  const agents = await run(["ls"]);
  const busy = new Set((Array.isArray(agents) ? agents : []).filter((a) => !FINISHED.test(String(a.status ?? ""))).map((a) => norm(String(a.cwd ?? "").replace(/^~(?=[\\/])/, process.env.USERPROFILE || process.env.HOME || ""))));
  const victims = [], skipped = [];
  for (const w of rows) {
    const cwd = String(w.cwd ?? ""), why = (m) => skipped.push({ id: w.workspaceId, cwd, why: m });
    if (!cwd || !w.workspaceId) continue;
    if (PERMANENT.test(norm(cwd))) { why("permanent folder"); continue; }
    if (!exists(cwd)) { if (exists(dirname(cwd))) victims.push(w); else why("parent missing (unmounted volume?)"); continue; }
    if (w.isolation !== "worktree") { why("not a worktree workspace"); continue; }
    if (busy.has(norm(cwd))) { why("agent running"); continue; }
    if (now() - mtimeMs(cwd) < idleS * 1000) { why("changed in the last " + idleS / 60 + " min"); continue; }
    if (await dirty(cwd)) { why("uncommitted changes"); continue; }
    victims.push(w);
  }
  const archived = []; let failed = null;
  for (const w of victims.slice(0, max)) {
    if (dry) { archived.push(w.workspaceId); continue; }
    const r = await run(["workspace", "archive", w.workspaceId, "--json"]);
    if (r?.error && !/not found|archived/i.test(JSON.stringify(r.error))) { failed = JSON.stringify(r.error).slice(0, 160); break; }
    archived.push(w.workspaceId); log(`archived ${w.workspaceId} ${w.cwd}`);
  }
  return { archived, skipped, failed };
}
function defaultMtime(dir) { // newest of the folder, the git admin HEAD/index (a commit or checkout touches them even when the folder mtime does not)
  let m = 0; const t = (f) => { try { m = Math.max(m, statSync(f).mtimeMs); } catch { /* absent */ } };
  t(dir); t(join(dir, ".git"));
  try { const g = safeGitdir(dir); if (g) { t(join(g, "HEAD")); t(join(g, "index")); } } catch { /* plain repo */ }
  return m || Date.now();
}
const fwd = (p) => String(p).split("\\").join("/");
export const GIT_ROOTS = () => [join(homedir(), "Desktop", "code"), join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "worktrees")];
/**
 * The git admin dir of a linked worktree, or null. Trusted only when: <dir>/.git is a file naming a gitdir whose REAL path is <repo>/.git/worktrees/<name> with <repo> under an allowed root, and that gitdir's own
 * `gitdir` file points back at <dir>/.git (a crafted .git aimed at someone else's admin dir fails the round trip). A plain clone, a symlink trick or anything else -> null and the workspace is never touched.
 */
export function safeGitdir(dir, roots = GIT_ROOTS()) {
  try {
    const g = readFileSync(join(dir, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim(); if (!g) return null;
    const real = fwd(realpathSync.native(g)); if (!/\/\.git\/worktrees\/[^/]+$/.test(real)) return null;
    const lower = real.toLowerCase(); if (!roots.some((r) => lower.startsWith(fwd(realpathSync.native(r)).toLowerCase() + "/"))) return null;
    const back = readFileSync(join(real, "gitdir"), "utf8").trim();
    return fwd(realpathSync.native(back)).toLowerCase() === fwd(realpathSync.native(join(dir, ".git"))).toLowerCase() ? real : null;
  } catch { return null; }
}
/** Git without the workspace's own say: config can name core.fsmonitor, hooks and filter drivers (clean/smudge/process) that run code during `status`. All three are forced off, system and global config are ignored, no optional lock. */
export const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, "-c", "core.untrackedCache=false", "-c", `core.attributesFile=${devNull}`];
export const SAFE_GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
const git = (args, o = {}) => new Promise((res) => execFile("git", args, { env: SAFE_GIT_ENV, timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...o }, (e, out) => res({ e, out: String(out ?? "") })));
/** `-c filter.<name>.{clean,smudge,process}= -c filter.<name>.required=false` for every filter driver the repo config defines (reading config runs nothing; a driver that is not defined cannot run). */
export async function filterOffArgs(dir) {
  const { e, out } = await git([...SAFE_GIT, "-C", dir, "config", "--get-regexp", "^filter\."]); if (e && !out) return [];
  const names = new Set(); for (const l of out.split("\n")) { const k = l.split(/\s/)[0]; const m = /^filter\.(.+)\.[^.]+$/i.exec(k); if (m) names.add(m[1]); }
  return [...names].flatMap((n) => ["-c", `filter.${n}.clean=`, "-c", `filter.${n}.smudge=`, "-c", `filter.${n}.process=`, "-c", `filter.${n}.required=false`]);
}
export async function gitDirty(dir, { roots } = {}) { // async (the sweep runs inside the daemon: a sync git call per workspace blocked its event loop for minutes); unreadable or unsafe = treated as dirty (never archive on doubt)
  if (!safeGitdir(dir, roots)) return true;
  const off = await filterOffArgs(dir);
  const { e, out } = await git([...SAFE_GIT, ...off, "-C", dir, "status", "--porcelain"]);
  return !!e || out.trim() !== "";
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
export function healthLine({ inflight, max, done30m, workspaces, cap = WORKSPACE_CAP }) {
  const jam = max > 0 && inflight >= max && done30m < 4, over = workspaces > cap;
  const why = [jam ? `${inflight}/${max} slots busy but only ${done30m} done in 30 min` : "", over ? `workspaces ${workspaces} > ${cap}` : ""].filter(Boolean).join("; ");
  return { ok: !jam && !over, line: `HUB-HEALTH: slots ${inflight}/${max}, done30m ${done30m}, workspaces ${workspaces} -> ${jam || over ? "FAIL (" + why + ")" : "OK"}` };
}
/** Tasks finished in the last 30 min, from ~/.paseo/usage/usage.jsonl (one line per finished agent turn; distinct agent ids). */
export function doneInWindow(usageFile, now = Date.now(), windowS = 30 * 60) {
  try { const ids = new Set(); for (const l of readFileSync(usageFile, "utf8").split("\n").slice(-4000)) { if (!l) continue; try { const j = JSON.parse(l); if (now - Date.parse(j.ts) <= windowS * 1000) ids.add(j.agent); } catch { /* torn line */ } } return ids.size; } catch { return 0; }
}
export const slotsHeld = (runDir) => { try { return readdirSync(join(runDir, "inflight")).filter((f) => /^slot-\d+\.json$/.test(f)).length; } catch { return 0; } };
