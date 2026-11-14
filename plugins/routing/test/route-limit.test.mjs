import "./isolate-run-dir.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRoute, limitUntil, LIMIT_RE } from "../route.mjs";

const routes = { readOnlyEnforced: [], slots: { codex: 1, qwen: 1 }, routes: { "code-edit": ["codex/a", "qwen/b"] } };
const mkOpts = (limitsDir, nowMs) => ({
  type: "code-edit", prompt: "p", cwd: "/nonexistent", session: "S", dev: "d", client: "c",
  answerRetryMs: 0, scan: () => false, limitsDir, now: () => nowMs,
});
const mkPaseo = (codexErr) => {
  const calls = [];
  const f = (args) => {
    calls.push(args);
    if (args[0] === "ls") return [];
    if (["stop", "archive", "project", "provider"].includes(args[0])) return {};
    if (args[0] === "run") {
      if (args.includes("codex/a")) return { status: "error", agentId: "X", error: codexErr };
      return { status: "completed", agentId: "A2" };
    }
    return {};
  };
  f.calls = calls;
  return f;
};

test("first route: codex errors with usage limit, fallback to qwen/b with trace entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "lim1-"));
  const p = mkPaseo("You have hit your usage limit. Try again at Nov 11th, 2026 9:00 AM");
  const r = runRoute(mkOpts(dir, Date.parse("2026-11-07T00:00:00Z")), p, routes);
  assert.equal(r.used, "qwen/b");
  const codexTrace = r.trace.find((t) => t.provider === "codex/a");
  assert.ok(codexTrace, "trace has codex/a entry");
  assert.match(codexTrace.error, /usage limit/);
});

test("second route with same limitsDir: codex/a is skipped entirely", () => {
  const dir = mkdtempSync(join(tmpdir(), "lim2-"));
  const p1 = mkPaseo("You have hit your usage limit. Try again at Nov 11th, 2026 9:00 AM");
  runRoute(mkOpts(dir, Date.parse("2026-11-07T00:00:00Z")), p1, routes);

  const p2 = mkPaseo("You have hit your usage limit. Try again at Nov 11th, 2026 9:00 AM");
  const r = runRoute(mkOpts(dir, Date.parse("2026-11-07T00:00:00Z")), p2, routes);
  assert.equal(r.used, "qwen/b");
  assert.ok(!p2.calls.some((c) => c[0] === "run" && c.includes("codex/a")), "no run call includes codex/a");
  assert.match(r.trace[0].skip, /^codex: usage limit until 2026-11-11T.*, skipped$/);
});

test("third route after limit expires: codex/a is tried again", () => {
  const dir = mkdtempSync(join(tmpdir(), "lim3-"));
  const p1 = mkPaseo("You have hit your usage limit. Try again at Nov 11th, 2026 9:00 AM");
  runRoute(mkOpts(dir, Date.parse("2026-11-07T00:00:00Z")), p1, routes);

  const p2 = mkPaseo("You have hit your usage limit. Try again at Nov 11th, 2026 9:00 AM");
  runRoute(mkOpts(dir, Date.parse("2026-11-07T00:00:00Z")), p2, routes);

  const p3 = mkPaseo("You have hit your usage limit. Try again at Nov 11th, 2026 9:00 AM");
  runRoute(mkOpts(dir, Date.parse("2026-11-12T00:00:00Z")), p3, routes);
  assert.ok(p3.calls.some((c) => c[0] === "run" && c.includes("codex/a")), "a run call includes codex/a after limit expires");
});

test("limitUntil parses relative and absolute time references", () => {
  assert.equal(limitUntil("usage limit", 1000), 1000 + 3600000);
  assert.equal(limitUntil("retry in 3 hours", 0), 3 * 3600000);
});

test("LIMIT_RE matches quota messages but not timeouts", () => {
  assert.equal(LIMIT_RE.test("timeout"), false);
  assert.ok(LIMIT_RE.test("quota exceeded"));
});
