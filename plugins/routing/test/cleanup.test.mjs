import test from "node:test";
import assert from "node:assert/strict";
import { cleanup, parseAge, ageSeconds, DOCTOR_LABEL } from "../cleanup.mjs";

const fake = (byLabel, all = []) => { const calls = []; const p = (a) => { calls.push(a); if (a[0] === "ls") return a[1] === "--label" ? byLabel[a[2]] ?? [] : all; return {}; }; return { p, calls }; };

test("parseAge and ageSeconds", () => {
  assert.equal(parseAge("30m"), 1800); assert.equal(parseAge("2h"), 7200); assert.equal(parseAge("x"), null);
  assert.equal(ageSeconds("3 minutes ago"), 180); assert.equal(ageSeconds("1 hours ago"), 3600); assert.equal(ageSeconds("???"), Infinity);
});

test("--mine archives only finished agents with an agent-hub label, never running ones", () => {
  const { p, calls } = fake({ "route/type=code-edit": [{ id: "a1", status: "idle", created: "1 hours ago" }, { id: "a2", status: "running", created: "1 hours ago" }], [DOCTOR_LABEL]: [{ id: "d1", status: "error", created: "2 minutes ago" }] }, [{ id: "other", status: "idle", created: "9 days ago" }]);
  const r = cleanup({ paseo: p, routes: { routes: { "code-edit": [] } } });
  assert.deepEqual(r.archived.sort(), ["a1", "d1"]);
  assert.ok(calls.some((c) => c[0] === "archive" && c[1] === "a1"));
  assert.ok(!calls.some((c) => c[1] === "other" || c[1] === "a2"));
});

test("--older-than keeps young agents; --all includes other users' finished agents; --dry-run archives nothing", () => {
  const rows = [{ id: "old", status: "idle", created: "2 hours ago" }, { id: "new", status: "idle", created: "1 minutes ago" }];
  assert.deepEqual(cleanup({ paseo: fake({}, rows).p, all: true, olderThan: 1800 }).archived, ["old"]);
  const { p, calls } = fake({}, rows);
  assert.equal(cleanup({ paseo: p, all: true, dry: true }).archived.length, 2);
  assert.ok(!calls.some((c) => c[0] === "archive"));
});
