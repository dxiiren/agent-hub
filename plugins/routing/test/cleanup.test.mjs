import test from "node:test";
import assert from "node:assert/strict";
import { cleanup, parseAge, ageSeconds, DOCTOR_LABEL, cleanAgentModelIds } from "../cleanup.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("cleanup with an age limit leaves an agent whose age is unreadable; without a limit it is archived", () => {
  const rows = [{ id: "aaaa1111", status: "idle", created: "???" }];
  const mk = () => { const calls = []; return { calls, paseo: (a) => { calls.push(a.join(" ")); return a[0] === "ls" ? rows : {}; } }; };
  const a = mk(); assert.deepEqual(cleanup({ paseo: a.paseo, olderThan: 1800, all: true }).archived, []);
  const b = mk(); assert.deepEqual(cleanup({ paseo: b.paseo, olderThan: 0, all: true }).archived, ["aaaa1111"]);
});

test("cleanAgentModelIds rewrites only qwen's (openai) runtime ids in closed records; running agents and other models are untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "ah-models-")); const dir = join(home, "agents", "proj"); mkdirSync(dir, { recursive: true });
  const rec = (model, lastStatus = "closed") => JSON.stringify({ id: "x", lastStatus, config: { model, mode: "yolo" }, runtimeInfo: { model }, persistence: { metadata: { model } } });
  writeFileSync(join(dir, "a.json"), rec("$runtime|openai|qwen35-9b(openai)")); writeFileSync(join(dir, "b.json"), rec("Qwen3.8-27B(openai)"));
  writeFileSync(join(dir, "c.json"), rec("claude-opus-4")); writeFileSync(join(dir, "d.json"), rec("m(openai)", "running")); writeFileSync(join(dir, "e.json"), "{not json (openai)");
  assert.equal(cleanAgentModelIds({ home, dry: true }), 2); assert.match(readFileSync(join(dir, "a.json"), "utf8"), /\(openai\)/, "dry run writes nothing");
  assert.equal(cleanAgentModelIds({ home }), 2);
  const a = JSON.parse(readFileSync(join(dir, "a.json"), "utf8"));
  assert.deepEqual([a.config.model, a.runtimeInfo.model, a.persistence.metadata.model, a.config.mode], ["qwen35-9b", "qwen35-9b", "qwen35-9b", "yolo"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "b.json"), "utf8")).config.model, "Qwen3.8-27B");
  assert.equal(JSON.parse(readFileSync(join(dir, "c.json"), "utf8")).config.model, "claude-opus-4");
  assert.equal(JSON.parse(readFileSync(join(dir, "d.json"), "utf8")).config.model, "m(openai)");
  assert.equal(cleanAgentModelIds({ home }), 0, "idempotent");
});
