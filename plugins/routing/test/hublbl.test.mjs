// HUBLBL: any agent can rewrite any agent's labels (Paseo update_agent has no caller check), so no label may decide who the hub stops, archives or keeps.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markOwned, readOwned, ghostOf } from "../owned.mjs";
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

test("a route/run label alone never selects an agent: it must sit in the route's own folder and not belong to another route's record", () => {
  const o = dir(); markOwned("other-0001", { kind: "route", rid: "bbbb" }, o);
  const rows = [
    { id: "elsewhere-1", cwd: "C:/other/project" }, // forged label on an agent in someone else's folder
    { id: "other-0001", cwd: "C:/work/repo" }, // same folder, but the hub's record gives it to another route
    { id: "ghost-0001", cwd: "C:/work/repo" }, // the route's own half-made agent: no record, right folder
    { id: "ghost-0002", cwd: "C:/work/repo/sub" },
  ];
  assert.deepEqual(ghostOf(rows, { rid: "aaaa", cwds: ["C:/work/repo"], dir: o }).map((a) => a.id), ["ghost-0001", "ghost-0002"]);
  assert.deepEqual(ghostOf(rows, { rid: "aaaa", cwds: [], dir: o }), []);
});

test("dead-route reaper archives a ghost only through ghostOf (forged route/run on a foreign agent is left alone)", async () => {
  const state = dir(), o = dir(); const { writeFileSync } = await import("node:fs");
  writeFileSync(join(state, "agents-1.json"), JSON.stringify({ pid: 1, cwd: "C:/work/repo", agents: [], workspaces: [], runs: ["aaaa"] }));
  const log = []; const run = async (a) => { log.push(a); return a[0] === "ls" ? [{ id: "foreign-01", cwd: "C:/elsewhere" }, { id: "ghost-0001", cwd: "C:/work/repo" }] : {}; };
  assert.deepEqual(await reapDeadRoutes({ run, dir: state, dead: () => true, owned: o }), ["ghost-0001"]);
  assert.deepEqual(archived(log), ["ghost-0001"]);
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
