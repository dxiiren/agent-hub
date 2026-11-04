import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { appendUsage, otlpBody, toRecord, usageDir } from "../server/usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const snap = (labels, usage = {}) => ({ id: "a1", provider: "codex", model: "m", labels, lastUsage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, totalCostUsd: 0.5, ...usage } });

test("record carries provider, model, dev, client, session and the numbers", () => {
  const r = toRecord(snap({ session: "S1", dev: "d", caller: "claude", "route/type": "code-edit" }));
  assert.deepEqual([r.provider, r.model, r.dev, r.client, r.session, r.task, r.in, r.out, r.cached, r.cost_usd], ["codex", "m", "d", "claude", "S1", "code-edit", 10, 5, 3, 0.5]);
});
test("subagents roll up to the parent session", () => {
  const r = toRecord(snap({ session: "SUB", parent_session: "PARENT" }));
  assert.equal(r.session, "PARENT"); assert.equal(r.sub, "SUB");
});
test("OTLP body: counts only, no session id, no prompt fields", () => {
  const b = JSON.stringify(otlpBody(toRecord(snap({ session: "S-SECRET-ID", dev: "d", caller: "c" }))));
  assert.ok(b.includes("agent_hub.tokens.input") && b.includes('"provider"'));
  assert.ok(!b.includes("S-SECRET-ID"));
});
test("usage dir resolution", () => {
  assert.equal(usageDir({ AGENT_HUB_USAGE_DIR: "/x" }), "/x");
  assert.equal(usageDir({ PASEO_HOME: "/h" }), join("/h", "usage"));
});
test("append writes the global log and the per-session file; python CLI sums per provider", () => {
  const d = mkdtempSync(join(tmpdir(), "usage-"));
  appendUsage(d, toRecord(snap({ session: "S1" })));
  appendUsage(d, toRecord({ ...snap({ session: "SUB", parent_session: "S1" }), provider: "qoder", lastUsage: { credits: 1.5 } }));
  appendUsage(d, toRecord(snap({ session: "OTHER" })));
  assert.equal(readFileSync(join(d, "usage.jsonl"), "utf8").trim().split("\n").length, 3);
  const r = spawnSync("python", [join(here, "..", "bin", "agent_hub_usage.py"), "usage", "--session", "S1", "--json"], { encoding: "utf8", env: { ...process.env, AGENT_HUB_USAGE_DIR: d } });
  const j = JSON.parse(r.stdout);
  assert.equal(j.total.n, 2); assert.equal(j.providers.codex.in, 10); assert.equal(j.providers.qoder.credits, 1.5);
  unlinkSync(join(d, "sessions", "S1.sum.json")); // no summary: the python reader falls back to scanning the log
  const scan = JSON.parse(spawnSync("python", [join(here, "..", "bin", "agent_hub_usage.py"), "usage", "--session", "S1", "--json"], { encoding: "utf8", env: { ...process.env, AGENT_HUB_USAGE_DIR: d } }).stdout);
  assert.equal(scan.total.n, 2); assert.equal(scan.providers.qoder.credits, 1.5);
  const none = JSON.parse(spawnSync("python", [join(here, "..", "bin", "agent_hub_usage.py"), "usage", "--session", "nope", "--json"], { encoding: "utf8", env: { ...process.env, AGENT_HUB_USAGE_DIR: d } }).stdout);
  assert.equal(none.total.n, 0);
});
