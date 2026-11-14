import "./isolate-run-dir.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRoute } from "../route.mjs";
import { validate } from "../../../scripts/routes.mjs";

const hours = { hours: "22:00-08:00", tz: "Asia/Kuala_Lumpur" };
const routes = { readOnlyEnforced: [], slots: { codex: 1, qoder: 1 }, routes: { "code-edit": ["qoder/qmodel_38max", "qoder/qfmodel", "codex/a"] }, hours: { "qoder/qmodel_38max": hours, "qoder/qfmodel": hours } };
const paseo = () => { const f = (args) => (args[0] === "ls" ? [] : args[0] === "run" ? { status: "completed", agentId: args.includes("codex/a") ? "C" : "Q" } : {}); return f; };
const run = (nowIso) => runRoute({ type: "code-edit", prompt: "p", cwd: "/nonexistent", session: "S", dev: "d", client: "c", answerRetryMs: 0, scan: () => false, limitsDir: mkdtempSync(join(tmpdir(), "hrs-")), now: () => Date.parse(nowIso) }, paseo(), routes);

test("outside the window both Qwen3.8 entries are skipped and codex runs", () => {
  const r = run("2026-11-08T04:00:00Z"); // 12:00 MYT
  assert.equal(r.used, "codex/a");
  assert.equal(r.trace.filter((t) => /outside its hours/.test(t.skip ?? "")).length, 2);
});
test("inside the window the first entry (Max) runs", () => {
  const r = run("2026-11-08T16:00:00Z"); // 00:00 MYT next day
  assert.equal(r.used, "qoder/qmodel_38max");
});
test("validate refuses a bad window and a bad zone, accepts null and a good one", () => {
  const ids = new Map([["qoder", {}]]);
  assert.equal(validate({ hours: { "qoder/qfmodel": hours, "qoder/x": null } }, routes, ids).length, 0);
  assert.equal(validate({ hours: { a: { hours: "8-22" } } }, routes, ids).length, 1);
  assert.equal(validate({ hours: { a: { hours: "08:00-22:00", tz: "Mars/Base" } } }, routes, ids).length, 1);
});
