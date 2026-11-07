import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfHostedProviders, tally, parseMetrics, groupReport, kindOfProvider, kindId, probe, selfHostedReport, _resetForTest } from "../server/selfhosted-usage.mjs";

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
const T = (i, o, n) => ({ in: i, out: o, n });
const item = (label, probe, today = T(0, 0, 0), week = today) => ({ label, probe, t: { today, week } });
test("groupReport: totals across endpoints, one row per endpoint, tone ok / warning / danger", () => {
  const up = item("Qwen Code a", { up: true, model: "M", metrics: { running: 1, queued: 0 } }, T(1500, 20, 2), T(3000, 40, 5));
  const dn = item("Qwen Code b", { up: false, error: "ECONNREFUSED" }, T(500, 5, 1), T(500, 5, 1));
  const r = groupReport([up, dn]), d = Object.fromEntries(r.details.map((x) => [x.id, x]));
  assert.equal(r.planLabel, "2 endpoints, 1 up"); assert.deepEqual(r.windows, []);
  assert.deepEqual([d.status.value, d.status.tone], ["1 of 2 up", "warning"]);
  assert.equal(d["total-today"].value, "2.0k in / 25 out, 3 tasks");
  assert.equal(d["total-week"].value, "3.5k in / 45 out, 6 tasks");
  assert.deepEqual([d["ep-0"].tone, d["ep-1"].tone], ["ok", "danger"]);
  assert.ok(d["ep-0"].value.includes("M") && d["ep-0"].value.includes("1 running") && d["ep-1"].value.startsWith("down (ECONNREFUSED)"));
  assert.equal(groupReport([dn]).details[0].tone, "danger");
  assert.equal(groupReport([up, up]).details[0].tone, "ok");
});
test("groupReport: a single endpoint still gets a full card", () => {
  const r = groupReport([item("Solo", { up: true }, T(1, 1, 1))]);
  assert.equal(r.planLabel, "1 endpoint, 1 up"); assert.equal(r.details.length, 4);
});
test("kind: local config override, else label minus its trailing where-it-runs word", () => {
  assert.equal(kindOfProvider("a", "Qwen Code 10.0.0.5", "http://10.0.0.5:1/v1"), "Qwen Code");
  assert.equal(kindOfProvider("a", "Qwen Code box.lan", "http://box.lan:1/v1"), "Qwen Code");
  assert.equal(kindOfProvider("a", "Qwen Code laptop", "http://127.0.0.1:8080/v1"), "Qwen Code");
  assert.equal(kindOfProvider("a", "Qwen Code", "http://h:1/v1"), "Qwen Code");
  assert.equal(kindOfProvider("a", "Whatever x", "http://h:1/v1", { kinds: { a: "My Kind" } }), "My Kind");
  assert.equal(kindId("Qwen Code"), "qwen-code");
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
  assert.ok(!JSON.stringify(r1).includes("SECRET")); assert.ok(r1.details.some((d) => d.id === "total-today" && d.value.startsWith("1.5k in")));
  await new Promise((r) => srv.close(r));
  _resetForTest();
  const down = await selfHostedReport("qwen-s", { env, readFeed: feed });
  assert.equal(down.details[0].tone, "danger"); assert.equal(down.planLabel, "1 endpoint, 0 up");
});

test("card label is the provider's configured display name, falling back to the id", () => {
  const l = selfHostedProviders({ agents: { providers: { a: { label: "Qwen Code A", command: ["x", "http://h:1/v1"] }, b: { command: ["x", "http://h:2/v1"] } } } });
  assert.deepEqual(l.map((x) => x.label), ["Qwen Code A", "b"]);
});
test("the module loads when import.meta.url is undefined (Paseo bundles plugins that way; a load failure silently stops every usage record)", async () => {
  const { readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
  const src = new URL("../server/selfhosted-usage.mjs", import.meta.url);
  const tmp = new URL(`../server/_nourl.${process.pid}.tmp.mjs`, import.meta.url);
  writeFileSync(tmp, readFileSync(src, "utf8").replaceAll("import.meta.url", "undefined"));
  try {
    const m = await import(tmp.href + "?" + Date.now());
    assert.equal(typeof m.selfHostedProviders, "function");
    await m.selfHostedReport("none", { env: { PASEO_HOME: tmpdir() } }).catch(() => {}); // must not throw a TypeError from fileURLToPath
  } finally { // Windows: another test (Paseo's compiler reading this plugin folder) may hold the file for a moment
    for (let i = 0; ; i++) { try { unlinkSync(tmp); break; } catch (e) { if (e.code === "ENOENT") break; if (i >= 20) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } }
  }
});

test('kindOfProvider: the provider record kind (hub.local.json extraProviders[name].type) wins over the label guess', async () => {
  const { kindOfProvider } = await import('../server/selfhosted-usage.mjs');
  const local = { extraProviders: { 'qwen-lab': { type: 'qwen-code' }, 'mine-x': { type: 'mine' } } };
  assert.equal(kindOfProvider('qwen-lab', 'Lab box', 'http://10.0.0.1:8000/v1', local), 'Qwen Code');
  assert.equal(kindOfProvider('mine-x', 'Whatever 10.0.0.2', 'http://10.0.0.2/v1', local), 'mine');
  assert.equal(kindOfProvider('old', 'Qwen Code 10.0.0.3', 'http://10.0.0.3/v1', {}), 'Qwen Code', 'legacy label fallback');
});

test('two endpoints with the same display name show their provider ids on the card', async () => {
  _resetForTest();
  const home = mkdtempSync(join(tmpdir(), "ahub-dup-"));
  const mk = (n) => ({ extends: "acp", label: "Qwen Code 10.0.0.9", command: ["node", "x.mjs", "q", `http://10.0.0.9:${n}/v1`, "m"] });
  writeFileSync(join(home, "config.json"), JSON.stringify({ agents: { providers: { "qwen-one": mk(8000), "qwen-two": mk(8001) } } }));
  const r = await selfHostedReport("qwen-code", { env: { PASEO_HOME: home, AGENT_HUB_USAGE_DIR: home }, f: async () => ({ ok: true, json: async () => ({ data: [{ id: "m" }] }) }), readFeed: () => "" });
  const labels = r.details.filter((d) => d.id.startsWith("ep-")).map((d) => d.label);
  assert.deepEqual(labels, ["Qwen Code 10.0.0.9 (qwen-one)", "Qwen Code 10.0.0.9 (qwen-two)"]);
});

test("on-demand laptop server that refuses the connection is idle (ready), not down; a real endpoint stays down with a reason", async () => {
  const refuse = async () => { throw Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }); };
  const idle = await probe({ base: "http://127.0.0.1:1/v1", onDemand: true }, { f: refuse });
  assert.deepEqual(idle, { up: false, idle: true });
  assert.deepEqual(await probe({ base: "http://127.0.0.1:1/v1" }, { f: refuse }), { up: false, error: "ECONNREFUSED" });
  assert.equal(selfHostedProviders(cfg, {}).find((x) => x.name === "qwen-lap").onDemand, true);
  const r = groupReport([item("Laptop", idle), item("Office", { up: false, error: "ECONNREFUSED" })]), d = Object.fromEntries(r.details.map((x) => [x.id, x]));
  assert.equal(d["ep-0"].value.startsWith("idle"), true); assert.equal(d["ep-0"].tone, "ok");
  assert.match(d["ep-1"].value, /nothing is listening there/);
  assert.equal(d.status.value, "1 of 2 ready");
});

test("a disabled provider is not listed on the usage card", () => {
  const c = { agents: { providers: { a: { command: ["n", "x", "q", "http://h:1/v1", "m"] }, b: { enabled: false, command: ["n", "x", "q", "http://h:2/v1", "m"] } } } };
  assert.deepEqual(selfHostedProviders(c, {}).map((x) => x.name), ["a"]);
});
