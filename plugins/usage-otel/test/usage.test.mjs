import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { appendUsage, emitOtlp, otlpBody, toRecord, usageDir } from "../server/usage.mjs";

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

import { mkdirSync, writeFileSync } from "node:fs";
import { fillRecord, qwenSession, qoderSession } from "../server/sidecar.mjs";
test("Qwen Code chat file is summed and booked as a delta per turn", () => {
  const home = mkdtempSync(join(tmpdir(), "qh-")); mkdirSync(join(home, "projects", "p", "chats"), { recursive: true });
  const f = join(home, "projects", "p", "chats", "S9.jsonl");
  const line = (p, c, o) => JSON.stringify({ usageMetadata: { promptTokenCount: p, cachedContentTokenCount: c, candidatesTokenCount: o, thoughtsTokenCount: 1 } }) + "\n";
  writeFileSync(f, line(100, 0, 10) + line(120, 90, 5));
  const t = qwenSession("S9", home);
  assert.deepEqual(t, { in: 130, out: 17, cached: 90 });
  const cur = join(home, "cursor.json"); const base = { agent: "a", in: 0, out: 0, cached: 0, credits: 0 };
  assert.equal(fillRecord({ ...base }, cur, { tokens: t }).in, 130);
  assert.equal(fillRecord({ ...base }, cur, { tokens: t }).in, 0, "second turn with no new requests books nothing");
  assert.equal(fillRecord({ ...base, in: 5 }, cur, { tokens: t }).in, 5, "a provider that reports its own numbers is untouched");
  assert.equal(fillRecord({ ...base, agent: "q" }, cur, { credits: 1.23456 }).credits, 1.235);
});

test("Qoder session transcript credits are fractional, deduped by message id, booked as a delta", () => {
  const home = mkdtempSync(join(tmpdir(), "qo-")); mkdirSync(join(home, "projects", "p"), { recursive: true });
  const f = join(home, "projects", "p", "Q1.jsonl");
  const line = (id, c) => JSON.stringify({ message: { id, usage: { credits: c } } }) + "\n";
  writeFileSync(f, line("a", 0.25) + line("a", 0.25) + line("b", 0.125));
  assert.equal(qoderSession("Q1", home), 0.375);
  assert.equal(qoderSession("nope", home), null);
  const hub = mkdtempSync(join(tmpdir(), "qh-")); mkdirSync(join(hub, "projects", "p"), { recursive: true });
  writeFileSync(join(hub, "projects", "p", "Q2.jsonl"), line("c", 0.5));
  assert.equal(qoderSession("Q2", [home, hub]), 0.5); // session written under the private config dir
  assert.equal(qoderSession("Q1", [home, hub]), 0.375);
  const cur = join(home, "cursor.json"); const base = { agent: "q", in: 0, out: 0, cached: 0, credits: 0 };
  assert.equal(fillRecord({ ...base }, cur, { sessionCredits: 0.375 }).credits, 0.375);
  assert.equal(fillRecord({ ...base }, cur, { sessionCredits: 0.5 }).credits, 0.125);
});

test("OTLP export gives up on a hung collector instead of holding the hook", async () => {
  const srv = createServer(() => { /* never answers */ });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const t = Date.now();
  await assert.rejects(emitOtlp("http://127.0.0.1:" + srv.address().port, toRecord(snap({})), 300));
  srv.closeAllConnections(); srv.close();
  assert.ok(Date.now() - t < 3000);
});
