import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfHostedProviders, tally, parseMetrics, toReport, probe, selfHostedReport, _resetForTest } from "../server/selfhosted-usage.mjs";

const cfg = { agents: { providers: {
  "qwen-a": { command: ["node", "x.mjs", "qwen", "http://h:1/v1", "m"], env: { HUB_OPENAI_API_KEY: "SECRET" } },
  "qwen-a-ro": { command: ["node", "x.mjs", "qwen", "http://h:1/v1", "m", "--read-only"] },
  "qwen-lap": { command: ["node", "l.mjs"], env: { LAPTOP_PORT: "8080" } },
  codex: {}, qoder: { command: ["q.exe", "--acp"] },
} } };

test("provider list comes from config: endpoints only, twins folded, metrics url from local config", () => {
  const l = selfHostedProviders(cfg, { metricsUrls: { "qwen-a": "http://h:1/metrics" } });
  assert.deepEqual(l.map((x) => x.name), ["qwen-a", "qwen-lap"]);
  assert.equal(l[0].metricsUrl, "http://h:1/metrics");
  assert.equal(l[1].base, "http://127.0.0.1:8080/v1");
});
test("tally folds -ro twins and splits today / 7 days", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  const j = [
    { ts: "2026-11-06T01:00:00Z", provider: "qwen-a-ro", in: 10, out: 2 },
    { ts: "2026-11-03T01:00:00Z", provider: "qwen-a", in: 5, out: 1 },
    { ts: "2026-10-01T01:00:00Z", provider: "qwen-a", in: 99, out: 99 },
    { ts: "2026-11-06T01:00:00Z", provider: "codex", in: 7, out: 7 },
  ].map((x) => JSON.stringify(x)).join("\n") + "\nnot json\n";
  const t = tally(j, "qwen-a", now);
  assert.deepEqual([t.today.in, t.today.n, t.week.in, t.week.out, t.week.n], [10, 1, 15, 3, 2]);
});
test("metrics parsed for vllm, sglang, llama.cpp; null when absent", () => {
  assert.deepEqual(parseMetrics('vllm:num_requests_running{m="x"} 2\nvllm:num_requests_waiting 3'), { running: 2, queued: 3 });
  assert.deepEqual(parseMetrics("sglang:num_running_reqs 1\nsglang:num_queue_reqs 0"), { running: 1, queued: 0 });
  assert.equal(parseMetrics("foo 1"), null);
});
test("toReport: up is ok, down is danger, no plan windows", () => {
  const t = tally("", "x");
  const up = toReport({ up: true, model: "M", metrics: { running: 1, queued: 0 } }, t);
  assert.equal(up.details[0].tone, "ok"); assert.deepEqual(up.windows, []);
  assert.ok(up.details.some((d) => d.id === "load") && up.details.some((d) => d.value === "M"));
  const dn = toReport({ up: false, error: "ECONNREFUSED" }, t);
  assert.equal(dn.details[0].tone, "danger"); assert.ok(!dn.details.some((d) => d.id === "model"));
});
test("probe + cache against a local stub; key is sent but never in the report", async () => {
  let hits = 0, auth;
  const srv = createServer((q, r) => { hits++; auth = q.headers.authorization; if (q.url === "/v1/models") r.end(JSON.stringify({ data: [{ id: "stub-model" }] })); else { r.statusCode = 404; r.end(); } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const p = await probe({ base, key: "SECRET" });
  assert.deepEqual([p.up, p.model, auth], [true, "stub-model", "Bearer SECRET"]);
  const dir = mkdtempSync(join(tmpdir(), "sh-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ agents: { providers: { "qwen-s": { command: ["n", base], env: { HUB_OPENAI_API_KEY: "SECRET" } } } } }));
  _resetForTest(); hits = 0;
  const env = { PASEO_HOME: dir, AGENT_HUB_LOCAL: join(dir, "none.json") };
  const feed = () => JSON.stringify({ ts: new Date().toISOString(), provider: "qwen-s", in: 1500, out: 20 });
  const r1 = await selfHostedReport("qwen-s", { env, readFeed: feed });
  await selfHostedReport("qwen-s", { env, readFeed: feed });
  assert.equal(hits, 1, "second call served from cache");
  assert.ok(!JSON.stringify(r1).includes("SECRET")); assert.ok(r1.details.some((d) => d.value.startsWith("1.5k in")));
  await new Promise((r) => srv.close(r));
  _resetForTest();
  const down = await selfHostedReport("qwen-s", { env, readFeed: feed });
  assert.equal(down.details[0].tone, "danger");
});

test("card label is the provider's configured display name, falling back to the id", () => {
  const l = selfHostedProviders({ agents: { providers: { a: { label: "Qwen Code A", command: ["x", "http://h:1/v1"] }, b: { command: ["x", "http://h:2/v1"] } } } });
  assert.deepEqual(l.map((x) => x.label), ["Qwen Code A", "b"]);
});
test("the module loads when import.meta.url is undefined (Paseo bundles plugins that way; a load failure silently stops every usage record)", async () => {
  const { readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
  const src = new URL("../server/selfhosted-usage.mjs", import.meta.url);
  const tmp = new URL("../server/_nourl.tmp.mjs", import.meta.url);
  writeFileSync(tmp, readFileSync(src, "utf8").replaceAll("import.meta.url", "undefined"));
  try {
    const m = await import(tmp.href + "?" + Date.now());
    assert.equal(typeof m.selfHostedProviders, "function");
    await m.selfHostedReport("none", { env: { PASEO_HOME: tmpdir() } }).catch(() => {}); // must not throw a TypeError from fileURLToPath
  } finally { unlinkSync(tmp); }
});
