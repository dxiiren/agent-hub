import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepRegistryOffline, recentlyTouched, recordHubWorktree, workspaceCapError, sweepIdleWorkspaces, spoolCleanup, drainSpool, reapStuckRoutes, healthLine, doneInWindow, slotsHeld, WORKSPACE_CAP } from "../guards.mjs";
import { runRoute } from "../route.mjs";
import { acquireEntry } from "../entry-gate.mjs";

const ws = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ workspaceId: "wks_" + i, cwd: `C:/Users/u/Desktop/code/worktree/w${i}`, isolation: "worktree", ...extra }));
const tmp = () => mkdtempSync(join(tmpdir(), "guards-"));

test("(1)(5) 50 workspaces: new routes are refused with the count; 20 or fewer pass; unreadable list fails open", () => {
  const e = workspaceCapError(() => ws(50)); assert.match(e, /WORKSPACE_CAP: 50 active/); assert.match(e, /limit 20/);
  assert.equal(workspaceCapError(() => ws(WORKSPACE_CAP)), null);
  assert.equal(workspaceCapError(() => ({ error: "daemon down" })), null);
});

test("(1)(5) sweep of 50 workspaces archives only idle, clean, non-permanent, non-running ones and never deletes anything itself", async () => {
  const rows = [...ws(50), { workspaceId: "wks_perm", cwd: "C:/Users/u/Desktop/code/KollectApps-NextGen-staging", isolation: "worktree" }, { workspaceId: "wks_local", cwd: "C:/Users/u/Desktop/code/repo", isolation: "local" }];
  const archived = [];
  const run = async (a) => a[0] === "workspace" && a[1] === "ls" ? rows : a[0] === "ls" ? [{ status: "running", cwd: "C:\\Users\\u\\Desktop\\code\\worktree\\w3" }, { status: "idle", cwd: "C:/Users/u/Desktop/code/worktree/w4" }] : (archived.push(a[2]), { status: "archived" });
  const now = Date.now();
  const r = await sweepIdleWorkspaces({ run, now: () => now, exists: () => true, touched: (d) => d.endsWith("w5") || d.endsWith("w6"), paseoRoot: "c:/nowhere/", max: 100 });
  assert.equal(archived.length, 47); // 50 - running(w3) - recent(w5) - dirty(w6)
  for (const bad of ["wks_3", "wks_5", "wks_6", "wks_perm", "wks_local"]) assert.ok(!archived.includes(bad), bad);
  assert.ok(r.skipped.some((s) => s.id === "wks_perm" && s.why === "permanent folder"));
});

test("(1) a pass stops at the first failed archive (busy daemon) and a missing folder with a present parent is archived", async () => {
  let n = 0; const run = async (a) => a[1] === "ls" ? ws(5) : a[0] === "ls" ? [] : (++n === 2 ? { error: "timeout" } : { status: "archived" });
  const r = await sweepIdleWorkspaces({ run, exists: () => true, touched: () => false, paseoRoot: "c:/nowhere/" });
  assert.equal(r.archived.length, 2); assert.match(r.failed, /timeout/); // batch of 3: 1 ok, 1 failed, 1 ok, then the pass stops
  const g = await sweepIdleWorkspaces({ run: async (a) => (a[1] === "ls" ? ws(1) : a[0] === "ls" ? [] : { status: "archived" }), exists: (p) => !p.endsWith("w0") });
  assert.deepEqual(g.archived, ["wks_0"]);
});

test("(2) the slot is released the moment the route is done; the cleanup is spooled and runs afterwards", async () => {
  const dir = tmp(); const gate = acquireEntry({ dir, max: 2 });
  assert.equal(slotsHeld(dir), 1);
  spoolCleanup(dir, { agentId: "a1", wt: { name: "route-x" }, cwd: "C:/r" }); // what runRoute does instead of the slow archive
  gate.release(); assert.equal(slotsHeld(dir), 0); // slot free while the job is still waiting
  assert.equal(readdirSync(join(dir, "cleanup")).length, 1);
  const calls = []; const done = await drainSpool({ runDir: dir, run: async (a) => (calls.push(a.join(" ")), {}), archiveAgent: async (run, id) => (calls.push("agent " + id), true) });
  assert.deepEqual(done, ["a1"]); assert.deepEqual(calls, ["agent a1", "worktree archive route-x --cwd C:/r"]);
  assert.equal(readdirSync(join(dir, "cleanup")).length, 0);
});

test("(2) a failed cleanup stays in the spool for the next pass", async () => {
  const dir = tmp(); spoolCleanup(dir, { agentId: "a2" });
  assert.deepEqual(await drainSpool({ runDir: dir, run: async () => ({}), archiveAgent: async () => false }), []);
  assert.equal(readdirSync(join(dir, "cleanup")).length, 1);
});

test("(3) stuck route: alive pid, agent silent 10+ min -> slot released, own agent archived, route pid ended; a fresh one is left alone", async () => {
  const dir = tmp(); const infl = join(dir, "inflight"); mkdirSync(infl);
  const now = Date.now();
  writeFileSync(join(infl, "slot-0.json"), JSON.stringify({ pid: 111, at: now - 3600_000 }));
  writeFileSync(join(infl, "slot-1.json"), JSON.stringify({ pid: 222, at: now - 3600_000 }));
  writeFileSync(join(infl, "slot-2.json"), JSON.stringify({ pid: 333, at: now - 3600_000 })); // no agent, old -> stuck
  writeFileSync(join(dir, "agents-111.json"), JSON.stringify({ pid: 111, agents: [{ id: "stuck-agent" }] }));
  writeFileSync(join(dir, "agents-222.json"), JSON.stringify({ pid: 222, agents: [{ id: "busy-agent" }] }));
  const arch = [], killed = [];
  const run = async (a) => ({ UpdatedAt: new Date(a[1] === "stuck-agent" ? now - 26 * 60_000 : now - 30_000).toISOString() });
  const r = await reapStuckRoutes({ runDir: dir, run, now: () => now, isAlive: () => true, kill: (p) => killed.push(p), archiveAgent: async (_, id) => arch.push(id) });
  assert.deepEqual(r.map((x) => x.pid).sort(), [111, 333]);
  assert.deepEqual(arch, ["stuck-agent"]); assert.deepEqual(killed.sort(), [111, 333]);
  assert.deepEqual(readdirSync(infl), ["slot-1.json"]);
});

test("(3) a dead owner is not this watchdog's business (the entry gate reclaims it)", async () => {
  const dir = tmp(); mkdirSync(join(dir, "inflight")); writeFileSync(join(dir, "inflight", "slot-0.json"), JSON.stringify({ pid: 9, at: 0 }));
  assert.deepEqual(await reapStuckRoutes({ runDir: dir, run: async () => ({}), isAlive: () => false, archiveAgent: async () => true }), []);
});

test("(4) HUB-HEALTH line: OK, jam FAIL, workspace FAIL", () => {
  assert.equal(healthLine({ inflight: 3, max: 8, done30m: 12, workspaces: 7 }).line, "HUB-HEALTH: slots 3/8, done30m 12, workspaces 7 -> OK");
  const jam = healthLine({ inflight: 8, max: 8, done30m: 3, workspaces: 7 }); assert.equal(jam.ok, false); assert.match(jam.line, /FAIL \(8\/8 slots busy but only 3 done/);
  assert.equal(healthLine({ inflight: 8, max: 8, done30m: 4, workspaces: 7 }).ok, true);
  const w = healthLine({ inflight: 0, max: 8, done30m: 0, workspaces: 21 }); assert.equal(w.ok, false); assert.match(w.line, /workspaces 21 > 20/);
});

test("(4) done30m counts distinct agents inside the window", () => {
  const dir = tmp(); const f = join(dir, "u.jsonl"); const now = Date.now(); const L = (a, m) => JSON.stringify({ ts: new Date(now - m * 60_000).toISOString(), agent: a });
  writeFileSync(f, [L("a", 1), L("a", 2), L("b", 29), L("c", 31)].join("\n"));
  assert.equal(doneInWindow(f, now), 2);
  assert.equal(doneInWindow(join(dir, "none"), now), 0);
});


const fwd = (p) => p.split("\\").join("/");
test("(sec) no git is ever spawned: guards.mjs does not import child_process or name git, so planted fsmonitor/filter/submodule config in a workspace cannot execute", () => {
  const src = readFileSync(new URL("../guards.mjs", import.meta.url), "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/**")).join("\n");
  assert.ok(!/child_process|execFile|spawn|"git"|'git'/.test(src), "guards.mjs must not run git");
});

test("(sec) a full sweep over a workspace with planted fsmonitor/filter/hook config archives it without running any of it", async () => {
  const base = tmp(), wt = join(base, "w"), marker = join(base, "PWNED"); mkdirSync(join(wt, ".git"), { recursive: true });
  const cmd = `node -e "require('fs').writeFileSync('${fwd(marker)}','x')"`;
  writeFileSync(join(wt, ".git", "config"), `[core]\n\tfsmonitor = ${cmd}\n[filter "pw"]\n\tclean = ${cmd}\n`); writeFileSync(join(wt, ".gitmodules"), `[submodule "s"]\n\tpath = s\n\turl = ${cmd}\n`);
  const old = new Date(Date.now() - 2 * 3600_000); for (const f of [join(wt, ".gitmodules")]) utimesSync(f, old, old);
  const archived = [];
  const run = async (a) => (a[1] === "ls" ? [{ workspaceId: "wks_x", cwd: wt, isolation: "worktree" }] : a[0] === "ls" ? [] : (archived.push(a[2]), { status: "archived" }));
  const r = await sweepIdleWorkspaces({ run, paseoRoot: fwd(base).toLowerCase() + "/nowhere/" });
  assert.deepEqual(archived, ["wks_x"]); assert.equal(existsSync(marker), false); assert.equal(r.failed, null);
});

test("(sec) a file touched after the cut-off => active; an old tree => idle; .git/node_modules are ignored", () => {
  const d = tmp(), now = Date.now(); mkdirSync(join(d, "sub")); mkdirSync(join(d, "node_modules")); const f = join(d, "sub", "a.txt"); writeFileSync(f, "a");
  const old = new Date(now - 3 * 3600_000); utimesSync(f, old, old); utimesSync(join(d, "sub"), old, old);
  writeFileSync(join(d, "node_modules", "n.js"), "n");
  assert.equal(recentlyTouched(d, now - 30 * 60_000), false);
  writeFileSync(join(d, "sub", "b.txt"), "fresh"); assert.equal(recentlyTouched(d, now - 30 * 60_000), true);
});

test("(sec) a symlink is never followed (a link to a busy outside folder does not make us active, and no escape)", () => {
  const out = tmp(), d = tmp(); writeFileSync(join(out, "hot.txt"), "x"); // fresh file OUTSIDE
  try { symlinkSync(out, join(d, "link"), "junction"); } catch { return; } // no privilege for links: nothing to prove here
  const old = new Date(Date.now() - 3 * 3600_000); writeFileSync(join(d, "a"), "a"); utimesSync(join(d, "a"), old, old);
  assert.equal(recentlyTouched(d, Date.now() - 1000), false);
});

test("(sec) the scan fails closed: over the file cap, past the deadline, or an unreadable folder = active", () => {
  const d = tmp(); for (let i = 0; i < 5; i++) writeFileSync(join(d, "f" + i), "x");
  const old = new Date(Date.now() - 3 * 3600_000); for (let i = 0; i < 5; i++) utimesSync(join(d, "f" + i), old, old);
  assert.equal(recentlyTouched(d, Date.now() - 1000, { cap: 3 }), true);
  assert.equal(recentlyTouched(d, Date.now() - 1000, { readdir: () => { throw new Error("EACCES"); } }), true);
  let t = 0; assert.equal(recentlyTouched(d, Date.now() - 1000, { deadlineMs: 5, now: () => (t += 10) }), true);
  assert.equal(recentlyTouched(join(d, "nope"), 0), true);
});

test("(sec) inside Paseo's own worktree root only hub-created worktrees are archived (its archive deletes that folder); unknown => kept", async () => {
  const base = tmp(), root = join(base, "worktrees"), mine = join(root, "h", "route-aaaaaaaaaa"), theirs = join(root, "h", "peer-feature"), runDir = join(base, "run");
  mkdirSync(mine, { recursive: true }); mkdirSync(theirs, { recursive: true }); recordHubWorktree(runDir, mine);
  const archived = [];
  const run = async (a) => (a[1] === "ls" ? [{ workspaceId: "mine", cwd: mine, isolation: "worktree" }, { workspaceId: "theirs", cwd: theirs, isolation: "worktree" }] : a[0] === "ls" ? [] : (archived.push(a[2]), { status: "archived" }));
  const r = await sweepIdleWorkspaces({ run, runDir, touched: () => false, paseoRoot: fwd(root).toLowerCase() + "/" });
  assert.deepEqual(archived, ["mine"]); assert.ok(r.skipped.some((x) => x.id === "theirs" && /not created by this hub/.test(x.why)));
});

test("(sec) fail closed: an agent list that is null, an error object or throws archives NOTHING", async () => {
  for (const bad of [() => null, () => ({ error: "busy" }), () => { throw new Error("daemon down"); }]) {
    const archived = []; const run = async (a) => (a[1] === "ls" ? ws(5) : a[0] === "ls" ? bad() : (archived.push(a[2]), {}));
    const r = await sweepIdleWorkspaces({ run, exists: () => true, touched: () => false, paseoRoot: "c:/nowhere/" });
    assert.deepEqual(archived, []); assert.match(r.failed, /fail closed/);
  }
});

test("(sec) a running agent whose cwd is written ~\... (Windows) or ~/... keeps its workspace", async () => {
  const home = (process.env.USERPROFILE || process.env.HOME).split("\\").join("/");
  const rows = [{ workspaceId: "w_back", cwd: `${home}/Desktop/code/worktree/a`, isolation: "worktree" }, { workspaceId: "w_fwd", cwd: `${home}/Desktop/code/worktree/b`, isolation: "worktree" }, { workspaceId: "w_idle", cwd: `${home}/Desktop/code/worktree/c`, isolation: "worktree" }];
  const archived = []; const run = async (a) => (a[1] === "ls" ? rows : a[0] === "ls" ? [{ status: "running", cwd: "~\\Desktop\\code\\worktree\\a" }, { status: "running", cwd: "~/Desktop/code/worktree/b" }] : (archived.push(a[2]), {}));
  await sweepIdleWorkspaces({ run, exists: () => true, touched: () => false, paseoRoot: "c:/nowhere/" });
  assert.deepEqual(archived, ["w_idle"]);
});

test("(2) runRoute with deferCleanup: the answer comes back with NO archive call; the archive is spooled for the off-slot worker", () => {
  const dir = tmp(), calls = [];
  const paseo = (a) => { calls.push(a); return a[0] === "ls" ? [] : a[0] === "logs" ? { text: "[User] q\nans" } : a[0] === "run" ? { status: "completed", agentId: "A9" } : {}; };
  const routes = { readOnlyEnforced: ["qwen"], readOnlyModes: { qwen: "read-only" }, slots: { qwen: 2 }, routes: { edit: ["qwen/b"] } };
  const r = runRoute({ type: "edit", prompt: "p", cwd: "/r", session: "S1", dev: "d", client: "claude", answerRetryMs: 0, provider: "qwen/b", deferCleanup: true, ledgerDir: dir }, paseo, routes);
  assert.equal(r.answer, "ans");
  assert.ok(!calls.some((c) => c[0] === "archive" || c[0] === "stop"), "no archive in line");
  assert.deepEqual(readdirSync(join(dir, "cleanup")), ["A9.json"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "cleanup", "A9.json"), "utf8")).agentId, "A9");
});

test("(boot) offline registry sweep: idle records get archivedAt (backup kept), permanent/recent/local ones stay, nothing on disk is touched", async () => {
  const base = tmp(), mk = (n, age) => { const d = join(base, n); mkdirSync(d); const f = join(d, "f.txt"); writeFileSync(f, "x"); const t = new Date(Date.now() - age); utimesSync(f, t, t); utimesSync(d, t, t); return d; };
  const idle = mk("idle", 3 * 3600_000), fresh = mk("fresh", 1000);
  const file = join(base, "workspaces.json");
  const rec = (id, cwd, kind, extra = {}) => ({ workspaceId: id, cwd, kind, archivedAt: null, ...extra });
  writeFileSync(file, JSON.stringify([rec("i", idle, "worktree"), rec("i2", idle, "directory"), rec("f", fresh, "worktree"), rec("l", idle, "local_checkout"), rec("old", idle, "worktree", { archivedAt: "2026-01-01T00:00:00Z" })]));
  const r = await sweepRegistryOffline({ file, paseoRoot: "c:/nowhere/" });
  const after = JSON.parse(readFileSync(file, "utf8")); const by = (id) => after.find((x) => x.workspaceId === id);
  assert.ok(by("i").archivedAt && by("i2").archivedAt); assert.equal(by("f").archivedAt, null); assert.equal(by("l").archivedAt, null); assert.equal(by("old").archivedAt, "2026-01-01T00:00:00Z");
  assert.ok(readdirSync(base).some((n) => n.startsWith("workspaces.json.bak-sweep-")));
  assert.ok(existsSync(idle) && existsSync(join(idle, "f.txt")));
  assert.equal(r.archived.length, 2);
});

test("HUB-HEALTH FAILs on a route stuck creating its worktree", async () => {
  const { stuckCreating } = await import("../guards.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "hh-")); mkdirSync(join(d, "inflight"));
  writeFileSync(join(d, "inflight", "slot-1.json"), JSON.stringify({ pid: 4242, at: 1000 })); // no agents-4242.json: never got an agent
  assert.equal(stuckCreating(d, { now: () => 1000 + 26 * 60_000, isAlive: () => true }), 1);
  assert.equal(stuckCreating(d, { now: () => 1000 + 5 * 60_000, isAlive: () => true }), 0);
  assert.equal(stuckCreating(d, { now: () => 1000 + 26 * 60_000, isAlive: () => false }), 0);
  const h = healthLine({ inflight: 1, max: 8, done30m: 9, workspaces: 2, creating: 1 }); assert.equal(h.ok, false); assert.match(h.line, /stuck creating/);
});

test("pruneArchivedOffline keeps active, pinned and the newest archived; backs up first; deletes nothing else", async () => {
  const { pruneArchivedOffline } = await import("../guards.mjs");
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "pr-")), file = join(d, "workspaces.json");
  const recs = [{ workspaceId: "a" }, { workspaceId: "p", archivedAt: "2026-01-01", pinnedAt: "x" }, ...[1, 2, 3, 4].map((i) => ({ workspaceId: "z" + i, archivedAt: `2026-02-0${i}` }))];
  writeFileSync(file, JSON.stringify(recs));
  const r = pruneArchivedOffline({ file, keep: 2 });
  assert.deepEqual(r, { before: 6, after: 4 });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).map((x) => x.workspaceId), ["a", "p", "z3", "z4"].sort((x, y) => recs.findIndex((q) => q.workspaceId === x) - recs.findIndex((q) => q.workspaceId === y)));
  assert.ok(readdirSync(d).some((f) => f.includes(".bak-prune-")));
});
