import test from "node:test";
import assert from "node:assert/strict";
import { runRoute } from "../route.mjs";

const routes = { slots: { codex: 1, qwen: 2 }, routes: { edit: ["codex/a", "qwen/b", "qwen/c"] } };
const fake = (script) => {
  const calls = [];
  const f = (args) => { calls.push(args); return args[0] === "ls" ? (script.ls ?? []) : args[0] === "stop" ? {} : script.run(args); };
  f.calls = calls; return f;
};
const o = { type: "edit", prompt: "p", cwd: "/r", session: "S1", dev: "d", client: "claude" };

test("default wins when healthy; labels carry session, dev, client", () => {
  const p = fake({ run: () => ({ status: "completed", agentId: "A1" }) });
  const r = runRoute(o, p, routes);
  assert.equal(r.used, "codex/a");
  const run = p.calls.find((c) => c[0] === "run");
  assert.ok(run.includes("session=S1") && run.includes("caller=claude") && run.includes("dev=d"));
});
test("failed or down default moves to the next entry and stops the dead agent", () => {
  const p = fake({ run: (a) => (a.includes("codex/a") ? { status: "timeout", agentId: "X" } : { status: "completed", agentId: "A2" }) });
  const r = runRoute(o, p, routes);
  assert.equal(r.used, "qwen/b");
  assert.deepEqual(r.trace.map((t) => t.provider), ["codex/a", "qwen/b"]);
  assert.ok(p.calls.some((c) => c[0] === "stop" && c[1] === "X"));
});
test("busy provider is skipped", () => {
  const p = fake({ ls: [{ status: "running", provider: "codex" }], run: () => ({ status: "completed", agentId: "A3" }) });
  const r = runRoute(o, p, routes);
  assert.equal(r.trace[0].skip, "busy 1/1"); assert.equal(r.used, "qwen/b");
});
test("caller override wins and has no fallback", () => {
  const p = fake({ run: () => ({ status: "error", error: "x" }) });
  const r = runRoute({ ...o, provider: "qwen/z" }, p, routes);
  assert.equal(r.used, null); assert.equal(r.trace.length, 1); assert.equal(r.trace[0].provider, "qwen/z");
});
test("unknown type and all-fail return used:null", () => {
  assert.equal(runRoute({ ...o, type: "nope" }, fake({ run: () => ({}) }), routes).used, null);
  assert.equal(runRoute(o, fake({ run: () => ({ status: "error" }) }), routes).used, null);
});

test("caller gate goes to the plugin-side store, never into labels", async () => {
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { claimRequest } = await import("../../gate/server/store.mjs");
  const d = mkdtempSync(join(tmpdir(), "gd-"));
  const p = fake({ run: () => ({ status: "completed", agentId: "A9" }) });
  runRoute({ ...o, gate: "npm test", gateDir: d }, p, routes);
  assert.ok(!p.calls.find((c) => c[0] === "run").some((a) => String(a).startsWith("gate/")));
  assert.equal(claimRequest(d, "/r").cmd, "npm test");
  assert.equal(claimRequest(d, "/r"), null);
});
test("unsafe mode is dropped outside a worktree and kept (with --new-workspace worktree) inside one", () => {
  const r2 = { ...routes, modes: { codex: "full-access", qwen: "plan" } };
  const mk = () => fake({ run: () => ({ status: "completed", agentId: "A" }) });
  let p = mk(); runRoute(o, p, r2);
  assert.ok(!p.calls.find((c) => c[0] === "run").includes("--mode"));
  p = mk(); runRoute({ ...o, mode: "yolo" }, p, r2);
  assert.ok(!p.calls.find((c) => c[0] === "run").includes("yolo"));
  p = mk(); runRoute({ ...o, worktree: true }, p, r2);
  const run = p.calls.find((c) => c[0] === "run");
  assert.ok(run.includes("full-access") && run.includes("--new-workspace") && run.includes("worktree"));
  p = mk(); runRoute({ ...o, provider: "qwen/x" }, p, r2);
  assert.ok(p.calls.find((c) => c[0] === "run").includes("plan"));
});

import { cmpVer, newest, parseCodex, parseClaude, resolveEntry, stalePins } from "../resolve.mjs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cacheFile = join(mkdtempSync(join(tmpdir(), "rs-")), "models.json");
const slugs = ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6.2-astra"];
writeFileSync(cacheFile, JSON.stringify({ models: slugs.map((slug) => ({ slug, visibility: "list" })) }));
const env = { CODEX_MODELS_CACHE: cacheFile };

test("version sort: 6.1 > 6 > 5.6", () => {
  assert.ok(cmpVer([6, 1], [6]) > 0 && cmpVer([6], [5, 6]) > 0);
  assert.equal(newest(parseCodex(slugs), "sol").id, "gpt-6.1-sol");
});
test("astra is excluded even when it has the highest version", () => {
  assert.equal(parseCodex(slugs).some((m) => m.family === "astra"), false);
  assert.notEqual(resolveEntry("codex/latest", null, env), "codex/gpt-6.2-astra");
});
test("aliases resolve; a family without the newest version falls back to the newest overall", () => {
  assert.match(resolveEntry("codex/latest", null, env), /^codex\/gpt-6\.1-/);
  assert.equal(resolveEntry("codex/latest-terra", null, env), "codex/gpt-6.1-terra");
  assert.equal(resolveEntry("codex/gpt-6-luna", null, env), "codex/gpt-6-luna"); // pins pass through
  const only = writeFileSync(cacheFile, JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6-luna" }] }));
  assert.equal(resolveEntry("codex/latest-luna", null, env), "codex/gpt-6-luna");
  assert.throws(() => resolveEntry("codex/latest-terra", null, env));
});
test("claude and qoder aliases use the provider model list", () => {
  const p = (a) => (a[2] === "claude-clean" ? [{ id: "claude-sonnet-5" }, { id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }] : [{ id: "efficient" }, { id: "fast" }]);
  assert.equal(resolveEntry("claude/latest-sonnet", p, env), "claude-clean/claude-sonnet-5-5");
  assert.equal(parseClaude(["claude-opus-5-5"])[0].ver.join("."), "5.5");
  assert.equal(resolveEntry("qoder/efficient@latest", p, env), "qoder/efficient");
});
test("doctor warns on a pinned older model", () => {
  writeFileSync(cacheFile, JSON.stringify({ models: slugs.map((slug) => ({ slug })) }));
  assert.equal(stalePins({ routes: { a: ["codex/latest-sol", "codex/gpt-6-sol"] } }, env).length, 1);
});
