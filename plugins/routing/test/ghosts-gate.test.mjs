// Hang fix 08-11: ghost workspaces are archived (a few per pass, stop on a busy daemon); the hub entry cap queues the rest; the gate no longer needs `paseo ls`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapGhostWorkspaces } from "../reaper.mjs";
import { acquireEntry, maxInFlight } from "../entry-gate.mjs";
import { callerGate } from "../route.mjs";

const HOME = "C:/Users/x/.paseo";
const ws = (id, cwd) => ({ workspaceId: id, cwd });
const fakeRun = (rows, agents = [], archiveErr = null) => { const calls = []; const f = async (a) => { calls.push(a); if (a[0] === "workspace" && a[1] === "ls") return rows; if (a[0] === "ls") return agents; if (a[1] === "archive") return archiveErr?.(a[2]) ?? {}; return {}; }; f.calls = calls; return f; };
const dirs = new Set(["C:/Users/x/Desktop/code/worktree", HOME + "/worktrees/h1", "C:/Users/x/Desktop/code/worktree/keep", HOME + "/worktrees/h1/route-aaaa11-1", HOME + "/worktrees/h1/route-live22", HOME + "/worktrees/h1/route-young33"]);
const exists = (f) => dirs.has(String(f).split("\\").join("/"));
const old = 0, young = Date.now();
const mtime = (f) => (/young33/.test(f) ? young : old);

test("ghosts: missing folder with an existing parent and an idle route-* worktree are archived; live, young, foreign and unmounted ones are not", async () => {
  const rows = [ws("w1", "C:/Users/x/Desktop/code/worktree/gone"), ws("w2", HOME + "/worktrees/h1/route-aaaa11-1"), ws("w3", HOME + "/worktrees/h1/route-live22"), ws("w4", HOME + "/worktrees/h1/route-young33"),
    ws("w5", "C:/Users/x/Desktop/code/worktree/keep"), ws("w6", "Z:/unmounted/volume/proj")];
  const run = fakeRun(rows, [{ status: "running", cwd: HOME + "/worktrees/h1/route-live22" }]);
  const r = await reapGhostWorkspaces({ run, home: HOME, exists, mtimeMs: mtime, now: () => Date.now() });
  assert.deepEqual(r.archived, ["w1", "w2"]);
  assert.deepEqual(run.calls.filter((c) => c[1] === "archive").map((c) => c[2]), ["w1", "w2"]);
});

test("ghosts: dry run archives nothing; a failing archive stops the pass; the pass is capped", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ws("g" + i, `C:/Users/x/Desktop/code/worktree/gone${i}`));
  const dry = fakeRun(many); const d = await reapGhostWorkspaces({ run: dry, home: HOME, exists, dry: true, max: 15 });
  assert.equal(d.archived.length, 15); assert.equal(dry.calls.filter((c) => c[1] === "archive").length, 0);
  const busy = fakeRun(many, [], (id) => (id === "g1" ? { error: { code: "DAEMON_REQUEST_TIMEOUT" } } : {}));
  const b = await reapGhostWorkspaces({ run: busy, home: HOME, exists });
  assert.deepEqual(b.archived, ["g0"]); assert.match(b.failed, /TIMEOUT/); assert.equal(busy.calls.filter((c) => c[1] === "archive").length, 2);
});

test("entry cap: max slots at once, the next caller waits (no daemon call) until one is released; dead owners are taken over; 0 = no cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const a = acquireEntry({ dir, max: 2, waitMs: 0 }), b = acquireEntry({ dir, max: 2, waitMs: 0, pid: process.pid });
  assert.ok(a && b);
  assert.equal(acquireEntry({ dir, max: 2, waitMs: 0 }), null, "third caller is refused at once when it may not wait");
  let slept = 0; const c = acquireEntry({ dir, max: 2, waitMs: 60000, sleep: () => { if (++slept === 2) a.release(); }, jitter: () => 1 });
  assert.ok(c && slept === 2 && c.slot === a.slot, "the waiter got the freed slot");
  assert.deepEqual(readdirSync(join(dir, "inflight")).sort(), ["slot-0.json", "slot-1.json"]);
  const dead = mkdtempSync(join(tmpdir(), "gate-")); mkdirSync(join(dead, "inflight"));
  const k = acquireEntry({ dir: dead, max: 1, waitMs: 0, pid: 999999 }); assert.ok(k); // a crashed route's slot (pid not alive) ...
  assert.ok(acquireEntry({ dir: dead, max: 1, waitMs: 0 }), "... is taken over");
  assert.equal(acquireEntry({ dir, max: 0 }).slot, null);
});

test("entry cap config: default 8, routes.maxInFlight, env wins, junk falls back", () => {
  assert.equal(maxInFlight({}, {}), 8); assert.equal(maxInFlight({ maxInFlight: 3 }, {}), 3); assert.equal(maxInFlight({ maxInFlight: 3 }, { AGENT_HUB_MAX_INFLIGHT: "5" }), 5);
  assert.equal(maxInFlight({ maxInFlight: "x" }, {}), 8); assert.equal(maxInFlight({ maxInFlight: 0 }, {}), 0);
});

test("gate: a `paseo ls` that misses the agent costs ONE ls call, then the cwd the route started it in is used", () => {
  const calls = []; const paseo = (a) => { calls.push(a[0]); return []; };
  const r = callerGate({ gate: "x", knownCwd: process.cwd() }, "A1", paseo, () => ({ status: "PASS", reasons: [] }), {});
  assert.equal(r.status, "PASS"); assert.equal(calls.filter((c) => c === "ls").length, 1);
});
