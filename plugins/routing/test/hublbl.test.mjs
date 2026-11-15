// HUBLBL: any agent can rewrite any agent's labels (Paseo update_agent has no caller check), so no label may decide who the hub stops, archives or keeps.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markOwned, readOwned, ghostOf, markPending, readPending, clearPending, PENDING_MAX_MS } from "../owned.mjs";
import { reapFinished, reapDeadRoutes } from "../reaper.mjs";
import { cleanup } from "../cleanup.mjs";
import { toRecord } from "../../usage-otel/server/usage.mjs";

const routes = { routes: { review: {}, edit: {} } };
const dir = () => mkdtempSync(join(tmpdir(), "hublbl-"));
// a daemon whose agents carry whatever labels they like: label queries return the forged rows, a plain ls returns all of them
const daemon = (agents, log = []) => async (a) => { log.push(a); if (a[0] === "ls") return a.includes("--label") ? agents.filter((x) => x.labels?.[a[2].split("=")[0]] === a[2].split("=").slice(1).join("=")) : agents; return {}; };
const archived = (log) => log.filter((c) => c[0] === "archive").map((c) => c[1]);

test("reaper: a forged route/type label on another session's agent archives nothing; only a hub record counts", async () => {
  const o = dir(); markOwned("mine-0001", { kind: "route", type: "review", keep: false }, o);
  const agents = [
    { id: "victim-running", status: "running", created: "5 hours ago", labels: { "route/type": "review" } }, // running victim, label forged to look like a hub route
    { id: "victim-idle", status: "idle", created: "5 hours ago", labels: { "route/type": "edit", "caller": "agent-hub-doctor" } },
    { id: "mine-0001", status: "idle", created: "5 hours ago", labels: {} }, // real hub agent whose label was erased
  ];
  const log = []; const r = await reapFinished({ run: daemon(agents, log), routes, owned: o });
  assert.deepEqual(r.archived, ["mine-0001"]); assert.deepEqual(archived(log), ["mine-0001"]);
});

test("reaper: route/keep and route=direct labels decide nothing; the record's keep and kind do", async () => {
  const o = dir();
  markOwned("kept-0001", { kind: "route", type: "edit", keep: true }, o);
  markOwned("drv-00001", { kind: "direct" }, o);
  const agents = [
    { id: "forged-keep", status: "idle", created: "5 hours ago", labels: { "route/keep": "1" } }, // no record: untouched either way
    { id: "mine-nokeep", status: "idle", created: "5 hours ago", labels: { "route/keep": "1" } }, // forged keep on a hub agent without keep... record absent => untouched
    { id: "kept-0001", status: "idle", created: "5 hours ago", labels: {} },
    { id: "drv-00001", status: "running", created: "5 hours ago", labels: {} },
    { id: "victim-direct", status: "running", created: "5 hours ago", labels: { route: "direct" } },
  ];
  const r = await reapFinished({ run: daemon(agents), routes, owned: o });
  assert.deepEqual(r.archived, ["drv-00001"]);
});

test("reaper: a hub agent immune only by a forged keep label is still reaped (the record says keep=false)", async () => {
  const o = dir(); markOwned("mine-0002", { kind: "route", type: "edit", keep: false }, o);
  const r = await reapFinished({ run: daemon([{ id: "mine-0002", status: "idle", created: "5 hours ago", labels: { "route/keep": "1" } }]), routes, owned: o });
  assert.deepEqual(r.archived, ["mine-0002"]);
});

test("reaper: no record directory at all fails closed (nothing is mine)", async () => {
  const r = await reapFinished({ run: daemon([{ id: "x-00000001", status: "idle", created: "5 hours ago", labels: { "route/type": "edit" } }]), routes, owned: join(dir(), "missing") });
  assert.deepEqual(r.archived, []);
});

test("cleanup --mine: forged route/type or doctor label archives nothing; --all is the owner's explicit switch", () => {
  const o = dir(); markOwned("mine-0003", { kind: "route", type: "edit" }, o);
  const rows = [{ id: "victim-0001", status: "idle", created: "9 hours ago", labels: { "route/type": "edit", caller: "agent-hub-doctor" } }, { id: "mine-0003", status: "idle", created: "9 hours ago" }];
  const calls = []; const p = (a) => { calls.push(a); return a[0] === "ls" ? rows : {}; };
  assert.deepEqual(cleanup({ paseo: p, routes, owned: o }).archived, ["mine-0003"]);
  assert.deepEqual(cleanup({ paseo: p, routes, owned: o, all: true }).archived.sort(), ["mine-0003", "victim-0001"]);
});

const quiet = () => {};
const H = 3600_000, T0 = 1_000_000_000_000;
test("ghost lookup: a forged route/run on a record-less victim in the SAME cwd is not archived (no record never means ours)", () => {
  const o = dir(); markPending("aaaaaaaa", "C:/work/repo", o, T0);
  const rows = [{ id: "victim-0001", cwd: "C:/work/repo", created: "5 hours ago" }, { id: "victim-0002", cwd: "C:/work/repo", created: "2 days ago" }]; // forged route/run labels, no hub record, started long before this attempt
  assert.deepEqual(ghostOf(rows, { rid: "aaaaaaaa", dir: o, now: T0 + 5 * H, log: quiet }), []);
});
test("ghost lookup: no pending record at all fails closed", () => {
  assert.deepEqual(ghostOf([{ id: "g-0000001", cwd: "C:/work/repo", created: "1 minutes ago" }], { rid: "bbbbbbbb", dir: dir(), now: T0, log: quiet }), []);
});
test("ghost lookup: an agent created before the attempt started is not archived; one provably after is", () => {
  const o = dir(); markPending("cccccccc", "C:/work/repo", o, T0);
  const now = T0 + 2 * H;
  const rows = [{ id: "old-00001", cwd: "C:/work/repo", created: "3 hours ago" }, { id: "edge-0001", cwd: "C:/work/repo", created: "2 hours ago" }, { id: "ghost-0001", cwd: "C:/work/repo", created: "10 minutes ago" }];
  assert.deepEqual(ghostOf(rows, { rid: "cccccccc", dir: o, now, log: quiet }).map((a) => a.id), ["ghost-0001"]);
});
test("ghost lookup: cwd must equal the route's cwd exactly; empty and drive-root cwds are rejected", () => {
  const o = dir(), now = T0 + H; const g = (cwd, rowCwd) => { markPending("dddddddd", cwd, o, T0); return ghostOf([{ id: "g-0000002", cwd: rowCwd, created: "1 minutes ago" }], { rid: "dddddddd", dir: o, now, log: quiet }).length; };
  assert.equal(g("C:/work/repo", "C:/work/repo/sub"), 0); assert.equal(g("C:/work/repo", "C:/work"), 0); assert.equal(g("C:/work/repo", "C:/work/repo"), 1);
  assert.equal(g("", ""), 0); assert.equal(g("C:/", "C:/"), 0); assert.equal(g("C:", "C:"), 0); assert.equal(g("/", "/"), 0);
});
test("ghost lookup: a record that binds the agent id to another route (or to a direct/doctor agent) blocks it", () => {
  const o = dir(); markPending("eeeeeeee", "C:/work/repo", o, T0); markOwned("other-0001", { kind: "route", rid: "ffffffff" }, o); markOwned("drv-00001", { kind: "direct" }, o); markOwned("same-0001", { kind: "route", rid: "eeeeeeee" }, o);
  const rows = ["other-0001", "drv-00001", "same-0001"].map((id) => ({ id, cwd: "C:/work/repo", created: "1 minutes ago" }));
  assert.deepEqual(ghostOf(rows, { rid: "eeeeeeee", dir: o, now: T0 + H, log: quiet }).map((a) => a.id), ["same-0001"]);
});
test("pending records: cleared when the route ends, expired ones are purged on the next write", () => {
  const o = dir(); markPending("11111111", "C:/a/b", o, T0); assert.ok(readPending("11111111", o));
  clearPending("11111111", o); assert.equal(readPending("11111111", o), null);
  markPending("22222222", "C:/a/b", o, T0); markPending("33333333", "C:/a/b", o, T0 + PENDING_MAX_MS + 1);
  assert.equal(readPending("22222222", o), null); assert.ok(readPending("33333333", o));
});
test("dead-route reaper archives a ghost only with a pending record; a forged route/run on a foreign agent is left alone", async () => {
  const state = dir(), o = dir(); const { writeFileSync } = await import("node:fs");
  writeFileSync(join(state, "agents-1.json"), JSON.stringify({ pid: 1, cwd: "C:/work/repo", agents: [], workspaces: [], runs: ["aaaaaaaa"] }));
  const ls = [{ id: "foreign-01", cwd: "C:/elsewhere", created: "1 minutes ago" }, { id: "recordless-1", cwd: "C:/work/repo", created: "9 days ago" }, { id: "ghost-0001", cwd: "C:/work/repo", created: "1 minutes ago" }];
  const log = []; const run = async (a) => { log.push(a); return a[0] === "ls" ? ls : {}; };
  assert.deepEqual(await reapDeadRoutes({ run, dir: state, dead: () => true, owned: o }), []); // no pending record: nothing
  writeFileSync(join(state, "agents-1.json"), JSON.stringify({ pid: 1, cwd: "C:/work/repo", agents: [], workspaces: [], runs: ["aaaaaaaa"] }));
  markPending("aaaaaaaa", "C:/work/repo", o, Date.now() - 2 * H);
  assert.deepEqual(await reapDeadRoutes({ run, dir: state, dead: () => true, owned: o }), ["ghost-0001"]);
});

test("usage: attribution follows the hub record, a forged label cannot move usage to another session; without a record labels are display-only attribution", () => {
  const snap = { id: "a-0000001", provider: "codex", labels: { session: "FORGED-VICTIM", dev: "evil", caller: "x", "route/type": "review", "usage/credits": "999" }, lastUsage: { inputTokens: 1 } };
  const r = toRecord(snap, new Date(), { kind: "route", type: "code-edit", session: "real", dev: "akmal", caller: "claude" });
  assert.equal(r.session, "real"); assert.equal(r.dev, "akmal"); assert.equal(r.task, "code-edit"); assert.equal(r.credits, 0);
  assert.equal(toRecord(snap).session, "FORGED-VICTIM"); // no record yet: the agent's own usage only, never a decision
});

test("markOwned refuses an id that is not a plain agent id", () => {
  const o = dir(); assert.equal(markOwned("../evil", { kind: "route" }, o), false); assert.equal(readOwned("../evil", o), null);
  assert.equal(markOwned("ok-000001", { kind: "route", type: "x" }, o), true); assert.equal(readOwned("ok-000001", o).type, "x");
});
