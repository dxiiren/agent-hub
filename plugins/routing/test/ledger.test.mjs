import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyResult, ledgerLine, appendLedger, readLedger, reliability, formatReliability, backfillFromUsage } from "../ledger.mjs";

test("classifyResult: every non-pass is a visible class", () => {
  assert.equal(classifyResult({ used: "qoder/efficient", status: "completed" }), "pass");
  assert.equal(classifyResult({ used: "x", status: "gate-failed" }), "gate-fail");
  assert.equal(classifyResult({ used: null, trace: [{ provider: "p", error: "CREATE_TIMEOUT: the daemon did not create" }] }), "create-fail");
  assert.equal(classifyResult({ used: null, trace: [{ error: "DAEMON_NOT_RUNNING: down" }] }), "daemon-down");
  assert.equal(classifyResult({ used: null, status: "rejected", error: "reply rejected: it looks like a credential" }), "ungrounded");
  assert.equal(classifyResult({ used: null, trace: [{ skip: "slots full" }] }), "refused");
  assert.equal(classifyResult({ used: null, error: "no answer in 90 s" }), "timeout");
  assert.equal(classifyResult({ used: null, error: "weird" }), "error");
  assert.notEqual(classifyResult({ used: "x", status: "failed-readonly-changed" }), "pass");
});

test("ledger append, read, reliability numbers and backfill", () => {
  const d = mkdtempSync(join(tmpdir(), "ledger-")), f = join(d, "l.jsonl"), t0 = Date.now();
  for (const [res, s] of [[{ used: "qoder/efficient", status: "completed" }, 10], [{ used: "qoder/efficient", status: "completed" }, 30], [{ used: "qoder/efficient", status: "gate-failed" }, 20], [{ used: null, trace: [{ provider: "codex", skip: "x" }, { error: "CREATE_TIMEOUT" }] }, 5]])
    assert.ok(appendLedger(ledgerLine(res, { type: "code-edit", session: "s", startedMs: t0 - s * 1000, nowMs: t0 }), f));
  const rs = reliability(readLedger(f));
  const q = rs.find((r) => r.provider === "qoder/efficient");
  assert.equal(q.runs, 3); assert.equal(q.pass, 2); assert.equal(q.passPct, 66.7); assert.equal(q.medianS, 10); assert.equal(q.p90S, 30); assert.deepEqual(q.fails, { "gate-fail": 1 });
  assert.match(formatReliability(rs), /qoder\/efficient/);
  const u = join(d, "u.jsonl"); writeFileSync(u, JSON.stringify({ ts: "2026-11-14T00:00:00Z", agent: "a1", provider: "qoder", model: "efficient", task: "x" }) + "\n");
  assert.deepEqual(backfillFromUsage(u, f), { added: 1, seen: 1 }); assert.deepEqual(backfillFromUsage(u, f), { added: 0, seen: 1 });
  assert.equal(reliability(readLedger(f), { provider: "qoder/efficient" })[0].unknown, 1);
});
