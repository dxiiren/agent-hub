import "./isolate-run-dir.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRoute as runRouteReal, ACTIVE } from "../route.mjs";
import { reapFinished, reapDeadRoutes } from "../reaper.mjs";
const runRoute = (o, ...a) => runRouteReal({ scan: () => false, ...o }, ...a);

const routes = { slots: { codex: 5 }, routes: { edit: ["codex/a", "codex/b"], summarise: ["codex/a"] } };
const base = { type: "edit", prompt: "p", cwd: "/r", answerRetryMs: 0, noAsk: true, limitsDir: mkdtempSync(join(tmpdir(), "lim-")) }; // limitsDir: a usage-limit answer must not leak into the real run dir
// fake paseo: `run` answers per call from `runs`; every archived id is recorded
const fake = (runs, extra = {}) => {
  let n = 0; const archived = [], calls = [];
  const f = (args) => {
    calls.push(args);
    if (args[0] === "run") return typeof runs === "function" ? runs(n++, args) : runs[n++] ?? runs.at(-1);
    if (args[0] === "archive") { archived.push(args[1]); return extra.archiveError?.(args[1], archived) ?? {}; }
    if (args[0] === "ls") return extra.ls?.(args) ?? [];
    return {};
  };
  f.archived = archived; f.calls = calls; return f;
};
const archivesOf = (p) => [...new Set(p.archived)];

test("ok exit archives its agent", () => {
  const p = fake([{ status: "completed", agentId: "A1" }]);
  assert.equal(runRoute(base, p, routes).status, "completed");
  assert.deepEqual(archivesOf(p), ["A1"]);
});
test("--keep archives nothing", () => {
  const p = fake([{ status: "completed", agentId: "A1" }]);
  runRoute({ ...base, keep: true }, p, routes);
  assert.deepEqual(p.archived, []);
});
test("gate fail archives its agent", () => {
  const p = fake([{ status: "completed", agentId: "A1" }]);
  const r = runRoute({ ...base, gate: "x" }, p, routes, () => ({ status: "FAIL", reasons: ["nope"] }));
  assert.notEqual(r.status, "completed");
  assert.ok(archivesOf(p).includes("A1"));
});
test("error, usage limit and timeout each archive the failed agent, and the fall-through entry's agent too", () => {
  for (const bad of [{ status: "error", agentId: "E", error: "boom" }, { status: "error", agentId: "E", error: "You've hit your usage limit. Try again at 11:59 PM" }, { status: "timeout", agentId: "E" }]) {
    const p = fake([bad, { status: "completed", agentId: "OK" }]);
    const r = runRoute({ ...base, limitsDir: mkdtempSync(join(tmpdir(), "lim-")) }, p, routes);
    assert.ok(archivesOf(p).includes("E"), JSON.stringify(bad));
    assert.ok(archivesOf(p).includes("OK") || r.used === null);
  }
});
test("a thrown exception mid-route still archives the agent (finally)", () => {
  const p = fake([{ status: "completed", agentId: "A1" }]); let ls = 0;
  const boom = (args) => { if (args[0] === "ls" && ++ls >= 2) throw new Error("daemon gone"); return p(args); };
  assert.throws(() => runRoute(base, boom, routes), /daemon gone/);
  assert.ok(p.archived.includes("A1"));
  assert.equal(ACTIVE.size, 0, "drain deregistered");
});
test("a create call with no agent id is found again by its route/run label and archived", () => {
  const p = fake([{ error: "CREATE_TIMEOUT: x" }], { ls: (a) => (a.includes("--label") && /^route\/run=/.test(a[2]) ? [{ id: "GHOST" }] : []) });
  runRoute({ ...base, provider: "codex/a" }, p, routes);
  assert.ok(archivesOf(p).includes("GHOST"));
});
test("a failed archive is retried, then falls back to stop + archive", () => {
  let k = 0; const p = fake([{ status: "completed", agentId: "A1" }], { archiveError: () => (k++ < 2 ? { error: "DAEMON_UNREACHABLE" } : {}) });
  runRoute(base, p, routes);
  assert.ok(p.calls.some((c) => c[0] === "stop" && c[1] === "A1"));
  assert.ok(k >= 3);
});
test("the exit handler's drain archives agents of a route still running", () => {
  const p = fake([{ status: "completed", agentId: "A1" }], { ls: () => { for (const d of [...ACTIVE]) d(); return []; } });
  runRoute(base, p, routes); // the ls call inside the route fires the same drain main() runs on SIGINT/exit
  assert.ok(archivesOf(p).includes("A1"));
});

const asyncRun = (rows, log = []) => async (a) => { log.push(a); if (a[0] === "ls") return a.includes("--label") ? (rows[a[2]] ?? []) : rows.all ?? []; return {}; };
test("reaper archives old idle/error agents, never running, young, parked or --keep ones", async () => {
  const rows = { "route/type=edit": [{ id: "old-idle", status: "idle", created: "2 hours ago" }, { id: "old-err", status: "error", created: "30 minutes ago" }, { id: "young", status: "error", created: "3 minutes ago" }, { id: "run-new", status: "running", created: "2 minutes ago" }, { id: "kept", status: "idle", created: "3 hours ago" }, { id: "parked", status: "idle", created: "3 hours ago" }], "route/keep=1": [{ id: "kept" }] };
  const log = []; const r = await reapFinished({ run: asyncRun(rows, log), routes, parked: (id) => id === "parked" });
  assert.deepEqual(r.archived.sort(), ["old-err", "old-idle"]);
  assert.ok(log.filter((c) => c[0] === "archive").every((c) => c.includes("--force")));
});
test("reaper stops a route agent still running past the route's time limit + margin (its route died)", async () => {
  const rows = { "route/type=edit": [{ id: "stuck", status: "running", created: "1 hours ago" }, { id: "working", status: "running", created: "9 minutes ago" }] };
  const r = await reapFinished({ run: asyncRun(rows), routes });
  assert.deepEqual(r.archived, ["stuck"]);
});
test("reaper archives the agents of a dead route pid from its ledger and leaves a live pid's alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  writeFileSync(join(dir, "agents-111.json"), JSON.stringify({ pid: 111, cwd: "/r", agents: [{ id: "D1", wt: { name: "w" } }] }));
  writeFileSync(join(dir, "agents-222.json"), JSON.stringify({ pid: 222, cwd: "/r", agents: [{ id: "L1" }] }));
  const log = []; const done = await reapDeadRoutes({ run: asyncRun({}, log), dir, dead: (p) => p === 111 });
  assert.deepEqual(done, ["D1"]);
  assert.ok(log.some((c) => c[0] === "worktree" && c[1] === "archive"));
  assert.ok(!existsSync(join(dir, "agents-111.json")) && existsSync(join(dir, "agents-222.json")));
});

test("a tagged --session also carries the Claude session id as a label (for the statusline); same id adds nothing", () => {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    process.env.CLAUDE_CODE_SESSION_ID = "CLAUDE-1";
    const p = fake([{ status: "completed", agentId: "A1" }]); runRoute({ ...base, session: "hdad-w3b" }, p, routes);
    const run = p.calls.find((c) => c[0] === "run"); assert.ok(run.includes("session=hdad-w3b") && run.includes("claude_session=CLAUDE-1"));
    const q = fake([{ status: "completed", agentId: "A2" }]); runRoute({ ...base, session: "CLAUDE-1" }, q, routes);
    assert.ok(!q.calls.find((c) => c[0] === "run").some((x) => String(x).startsWith("claude_session=")));
  } finally { if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev; }
});

test("hard kill while `paseo run` still waits (agent id unknown): the ledger names the run label and the reaper archives what carries it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  let seen = null;
  const p = fake([{ status: "completed", agentId: "A1" }]);
  const spy = (a) => { if (a[0] === "run") seen = JSON.parse(readFileSync(join(dir, `agents-${process.pid}.json`), "utf8")); return p(a); };
  runRoute({ ...base, ledgerDir: dir }, spy, routes);
  assert.equal(seen.runs.length, 1, "ledger written before the create call");
  assert.ok(!existsSync(join(dir, `agents-${process.pid}.json`)), "ledger removed once everything is archived");
  writeFileSync(join(dir, "agents-111.json"), JSON.stringify({ pid: 111, cwd: "/r", agents: [], runs: ["abc123"] }));
  const log = []; const run = async (a) => { log.push(a); return a[0] === "ls" && a[2] === "route/run=abc123" ? [{ id: "GHOST" }] : {}; };
  assert.deepEqual(await reapDeadRoutes({ run, dir, dead: () => true }), ["GHOST"]);
  assert.ok(log.some((c) => c[0] === "archive" && c[1] === "GHOST"));
});

test("reaper stops a driver's direct agent (route=direct) running past 3 h, not a younger one or a --keep one", async () => {
  const rows = { "route=direct": [{ id: "stuck-direct", status: "running", created: "4 hours ago" }, { id: "working-direct", status: "running", created: "40 minutes ago" }, { id: "kept", status: "running", created: "5 hours ago" }], "route/keep=1": [{ id: "kept" }] };
  const r = await reapFinished({ run: asyncRun(rows), routes });
  assert.deepEqual(r.archived, ["stuck-direct"]);
});
