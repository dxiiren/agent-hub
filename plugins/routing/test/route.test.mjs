import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { grantReads, lastAnswer, runRoute, withRetry, transient, readOnlyType, READ_ONLY_MODES, readOnlyMode, cliPaseo, toSeconds, markActive } from "../route.mjs";

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
  const p = (a) => (a[2] === "claude-clean" ? [{ id: "claude-sonnet-5" }, { id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }] : [{ id: "efficient", model: "Efficient" }, { id: "fast", model: "Fast" }]);
  assert.equal(resolveEntry("claude/latest-sonnet", p, env), "claude-clean/claude-sonnet-5-5");
  assert.equal(parseClaude(["claude-opus-5-5"])[0].ver.join("."), "5.5");
  assert.equal(resolveEntry("qoder/efficient@latest", p, env), "qoder/efficient");
});
test("doctor warns on a pinned older model", () => {
  writeFileSync(cacheFile, JSON.stringify({ models: slugs.map((slug) => ({ slug })) }));
  assert.equal(stalePins({ routes: { a: ["codex/latest-sol", "codex/gpt-6-sol"] } }, env).length, 1);
});

import { parseQoder } from "../resolve.mjs";
import { servedModel, firstId, modelsUrl, syncOpencode } from "../office.mjs";
import { compareVersions, parseVersion, verdict } from "../../../scripts/tools.mjs";
import { readFileSync } from "node:fs";

const qlist = [["fast", "Fast (default)"], ["efficient", "Efficient"], ["q38", "Qwen3.8-Max"], ["q39", "Qwen3.9-Max"], ["qf", "Qwen3.8-Flash"], ["k", "Kimi-K3.1-Pro"], ["d4", "DeepSeek-V4-Pro"], ["d5", "DeepSeek-V5-Pro"], ["df", "DeepSeek-Flash"]].map(([id, model]) => ({ id, model }));
test("qoder: newest version within a family; unversioned tiers are checked for presence", () => {
  const p = () => qlist;
  assert.equal(parseQoder([{ id: "x", model: "Qwen3.9-Max" }])[0].family, "qwen-max");
  assert.equal(resolveEntry("qoder/latest-qwen-max", p, env), "qoder/q39");
  assert.equal(resolveEntry("qoder/latest-deepseek-pro", p, env), "qoder/d5");
  assert.equal(resolveEntry("qoder/q38@latest", p, env), "qoder/q39"); // an old pin moves up
  assert.equal(resolveEntry("qoder/Qwen3.8-Flash@latest", p, env), "qoder/qf"); // no newer Flash
  assert.equal(resolveEntry("qoder/efficient@latest", p, env), "qoder/efficient");
  assert.throws(() => resolveEntry("qoder/latest-nope-max", p, env));
});
test("office model id comes from a fake /v1/models, cached, with fallback", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "of-")), "c.json");
  let n = 0; const f = async () => ({ json: async () => { n++; return { data: [{ id: n === 1 ? "Qwen3.8-27B" : "Qwen3.9-27B" }] }; } });
  assert.equal(modelsUrl("http://h:1/v1/"), "http://h:1/v1/models");
  assert.equal(firstId({ data: [{ id: "m" }] }), "m");
  assert.equal(await servedModel("http://h:1/v1", { f, file, now: 0 }), "Qwen3.8-27B");
  assert.equal(await servedModel("http://h:1/v1", { f, file, now: 1000 }), "Qwen3.8-27B"); // cached
  assert.equal(await servedModel("http://h:1/v1", { f, file, now: 11 * 60_000 }), "Qwen3.9-27B"); // expired -> upgraded model picked up
  const down = async () => { throw new Error("refused"); };
  assert.equal(await servedModel("http://h:1/v1", { f: down, file, now: 99 * 60_000 }), "Qwen3.9-27B"); // stale cache beats failure
  assert.equal(await servedModel("http://other/v1", { f: down, file, now: 0, fallback: "fb" }), "fb");
});
test("opencode config follows the served model", () => {
  const f = join(mkdtempSync(join(tmpdir(), "oc-")), "opencode.json");
  writeFileSync(f, JSON.stringify({ model: "office/A", provider: { office: { models: { A: { name: "A", tool_call: true } } } } }));
  assert.equal(syncOpencode(f, "B"), true); assert.equal(syncOpencode(f, "B"), false);
  const j = JSON.parse(readFileSync(f, "utf8")); assert.equal(j.model, "office/B"); assert.deepEqual(Object.keys(j.provider.office.models), ["B"]); assert.equal(j.provider.office.models.B.tool_call, true);
});
test("doctor version comparison", () => {
  assert.equal(parseVersion("codex-cli 0.166.0"), "0.166.0"); assert.equal(parseVersion("2.1.318 (Claude Code)"), "2.1.318");
  assert.equal(compareVersions("1.18.29", "1.19.5"), -1); assert.equal(compareVersions("0.10.0", "0.9.9"), 1); assert.equal(compareVersions("1.2", "1.2.0"), 0); assert.equal(compareVersions("", "1"), null);
  assert.deepEqual(["1.0", "2.0", "2.0", ""].map((v, i) => verdict(i === 3 ? "" : v, "2.0")), ["UPDATE", "current", "current", "NOT INSTALLED"]);
});

test("DAEMON_UNREACHABLE on start is retried up to 3 times with backoff, then succeeds", () => {
  let n = 0; const waits = [];
  const raw = (args) => (args[0] === "ls" ? [] : args[0] === "logs" ? {} : ++n < 3 ? { error: "DAEMON_UNREACHABLE: status probe" } : { status: "completed", agentId: "R1" });
  const r = runRoute(o, withRetry(raw, { sleep: (ms) => waits.push(ms), jitter: () => 0 }), routes);
  assert.equal(r.used, "codex/a"); assert.equal(n, 3); assert.deepEqual(waits, [2000, 4000]);
});
test("a real failure with an agentId is not retried; retries stop after 3", () => {
  let n = 0;
  const f = withRetry((a) => { n++; return { status: "error", agentId: "Z", error: "unreachable" }; }, { sleep() {} });
  f(["run"]); assert.equal(n, 1);
  n = 0; const g = withRetry(() => { n++; return { error: "DAEMON_UNREACHABLE" }; }, { sleep() {} });
  g(["run"]); assert.equal(n, 6);
});

test("caller gate runs in the agent's real cwd: PASS completes, two FAILs return gate-failed after one re-prompt", () => {
  const ls = [{ id: "A9", cwd: "/wt/x", status: "idle", provider: "codex" }];
  const mk = () => { const calls = []; const f = (a) => { calls.push(a); return a[0] === "ls" ? ls : a[0] === "send" ? {} : { status: "completed", agentId: "A9" }; }; f.calls = calls; return f; };
  const seen = [];
  let p = mk();
  let r = runRoute({ ...o, gate: "g" }, p, routes, (cwd, x) => { seen.push([cwd, x.cmd]); return { status: "PASS", reasons: [] }; });
  assert.equal(r.status, "completed"); assert.deepEqual(seen, [["/wt/x", "g"]]); assert.ok(!p.calls.some((c) => c[0] === "send"));
  p = mk();
  r = runRoute({ ...o, gate: "g" }, p, routes, () => ({ status: "FAIL", reasons: ["bad"] }));
  assert.equal(r.status, "gate-failed"); assert.equal(r.gate.attempts, 1); assert.equal(p.calls.filter((c) => c[0] === "send").length, 1);
});

const BS = String.fromCharCode(92);
test("caller gate expands the ~ that paseo ls prints for the home folder", () => {
  const p = (a) => (a[0] === "ls" ? [{ id: "A9", cwd: "~" + BS + ".paseo" + BS + "w" }] : { status: "completed", agentId: "A9" });
  let seen; runRoute({ ...o, gate: "g" }, p, routes, (cwd) => { seen = cwd; return { status: "PASS", reasons: [] }; });
  assert.ok(!seen.startsWith("~") && seen.endsWith(".paseo" + BS + "w"), seen);
});
test("caller gate uses the same options as the hook: repo row maxLines, forbid, allow, cmd fallback", () => {
  let opts;
  const p = (a) => (a[0] === "ls" ? [{ id: "A9", cwd: "/r" }] : { status: "completed", agentId: "A9" });
  const rt = { ...routes, gates: [{ match: "^/r$", cmd: "rowcmd", maxLines: 7, forbid: "^[.]github/", allow: "^src/" }] };
  runRoute({ ...o }, p, rt, () => ({ status: "PASS", reasons: [] })); // no caller gate: nothing to run
  runRoute({ ...o, gate: "mine" }, p, rt, (cwd, x) => { opts = x; return { status: "PASS", reasons: [] }; });
  assert.deepEqual(opts, { cmd: "mine", maxLines: 7, forbid: "^[.]github/", allow: "^src/" });
});
test("forbidden-path edit FAILs through the CLI path with the real gate", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs"); const { tmpdir } = await import("node:os");
  const { join } = await import("node:path"); const { execFileSync } = await import("node:child_process");
  const d = mkdtempSync(join(tmpdir(), "cg-")); const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", ...a], { cwd: d, stdio: "ignore" });
  g("init", "-q"); mkdirSync(join(d, ".github")); writeFileSync(join(d, ".github", "w.yml"), "a: 1\n"); g("add", "."); g("commit", "-qm", "i");
  writeFileSync(join(d, ".github", "w.yml"), "a: 2\n");
  const p = (a) => (a[0] === "ls" ? [{ id: "A9", cwd: d }] : { status: "completed", agentId: "A9" });
  const rt = { ...routes, gates: [{ match: ".*", forbid: "^[.]github/" }] };
  const r = runRoute({ ...o, gate: 'node -e "process.exit(0)"' }, p, rt);
  assert.equal(r.status, "gate-failed"); assert.match(r.gate.reasons.join(), /path not allowed: \.github\/w\.yml/);
});
test("re-prompt blocks (send, wait), freezes the agent (stop) and only then runs the final gate; send or wait errors FAIL", () => {
  const order = [];
  const mkp = (bad) => (a) => { order.push(a[0]); return a[0] === "ls" ? [{ id: "A9", cwd: "/r" }] : a[0] === "run" ? { status: "completed", agentId: "A9" } : a[0] === bad ? { error: "boom" } : {}; };
  let n = 0;
  let r = runRoute({ ...o, gate: "g" }, mkp(null), routes, () => { order.push("gate"); return ++n === 1 ? { status: "FAIL", reasons: ["x"] } : { status: "PASS", reasons: [] }; });
  assert.equal(r.status, "completed");
  assert.deepEqual(order.filter((x) => ["gate", "send", "wait", "stop"].includes(x)), ["gate", "send", "wait", "stop", "gate"]);
  for (const bad of ["send", "wait"]) {
    r = runRoute({ ...o, gate: "g" }, mkp(bad), routes, () => ({ status: "FAIL", reasons: ["x"] }));
    assert.equal(r.status, "gate-failed"); assert.match(r.gate.reasons.join(), /failed: boom/);
  }
});
test("a failed freeze (stop) is FAIL, but 'already stopped' is fine", () => {
  const mk = (stopErr) => (a) => a[0] === "ls" ? [{ id: "A9", cwd: "/r" }] : a[0] === "run" ? { status: "completed", agentId: "A9" } : a[0] === "stop" && stopErr ? { error: stopErr } : {};
  let n = 0; const g = () => (++n % 2 ? { status: "FAIL", reasons: ["x"] } : { status: "PASS", reasons: [] });
  assert.equal(runRoute({ ...o, gate: "g" }, mk("daemon exploded"), routes, g).status, "gate-failed");
  assert.equal(runRoute({ ...o, gate: "g" }, mk("AGENT_NOT_FOUND: No agent found matching: A9"), routes, g).status, "completed");
});
test("paseo CLI crash text (top-level await, no agentId, non-zero exit) is transient and retried", () => {
  const crash = "exit=1 ed top-level await at file:///C:/x/@getpaseo/cli/dist/index.js:2\r\nconst exitCode = await runCli(process.argv.slice(2), {\r\n ^\r\n";
  assert.equal(transient({ error: crash }), true);
  assert.equal(transient({ error: "exit=1 some other crash" }), true);
  assert.equal(transient({ error: "WORKSPACE_CREATE_FAILED" }), false);
  let n = 0; const f = withRetry(() => (++n < 3 ? { error: crash } : { status: "completed", agentId: "R" }), { sleep() {} });
  assert.equal(f(["run"]).agentId, "R"); assert.equal(n, 3);
  assert.equal(transient({ error: "Cannot connect to daemon: Connection timed out" }), true);
  const w = []; n = 0; withRetry(() => { n++; return { error: "DAEMON_UNREACHABLE" }; }, { sleep: (ms) => w.push(ms), jitter: () => 7 })(["ls"]);
  assert.equal(n, 6); assert.deepEqual(w, [2007, 4007, 8007, 16007, 32007]);
});

test("read-only types never get an unsafe mode outside a worktree; a caller mode override is ignored too", () => {
  const r2 = { ...routes, modes: { codex: "full-access", qwen: "yolo" }, routes: { summarise: ["codex/a"], review: ["qwen/b"] } };
  const mk = () => fake({ run: () => ({ status: "completed", agentId: "A" }) });
  for (const [type, mode] of [["summarise", undefined], ["review", undefined], ["summarise", "yolo"], ["review", "bypassPermissions"]]) {
    const p = mk(); runRoute({ ...o, type, mode }, p, r2);
    const run = p.calls.find((c) => c[0] === "run");
    assert.ok(!run.some((a) => /full-access|yolo|bypass/i.test(String(a))), type + " " + mode);
  }
  assert.ok(readOnlyType("review") && !readOnlyType("test-scaffold"));
});
test("a read-only task that changed files in its folder is failed", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "ro-"));
  const r2 = { ...routes, routes: { summarise: ["codex/a"] } };
  const bad = fake({ run: () => { writeFileSync(join(d, "new.txt"), "x"); return { status: "completed", agentId: "A" }; } });
  const r = runRoute({ ...o, type: "summarise", cwd: d }, bad, r2);
  assert.equal(r.status, "failed-readonly-changed");
  const ok = fake({ run: () => ({ status: "completed", agentId: "A" }) });
  assert.equal(runRoute({ ...o, type: "summarise", cwd: d }, ok, r2).status, "completed");
});
test("an edit type that ends in `permission` outside a worktree returns a clear error, not a bare status", () => {
  const p = fake({ run: () => ({ status: "permission", agentId: "P" }) });
  const r = runRoute({ ...o, provider: "codex/a" }, p, { ...routes, modes: { codex: "full-access" } });
  assert.equal(r.used, null);
  assert.match(r.trace.at(-1).error, /--new-workspace worktree/);
  assert.match(r.trace.at(-1).error, /code-edit|edit/);
});

test("worktree run: create is --no-wait, then a separate bounded wait; idle becomes completed", () => {
  const calls = [];
  const p = (args) => { calls.push(args); return args[0] === "ls" ? [] : args[0] === "run" ? { agentId: "W1", status: "created" } : args[0] === "wait" ? { status: "idle" } : {}; };
  const r = runRoute({ ...o, worktree: true, waitTimeout: "2m" }, p, routes);
  assert.equal(r.status, "completed"); assert.equal(r.agentId, "W1");
  assert.ok(calls.find((c) => c[0] === "run").includes("--no-wait"));
  assert.deepEqual(calls.find((c) => c[0] === "wait"), ["wait", "W1", "--timeout", "120"]);
});
test("a create call that hangs is cut off with a clear CREATE_TIMEOUT error that is not retried", () => {
  let n = 0;
  const spawn = (_c, args, opts) => { n++; assert.equal(opts.timeout, 5000); return { error: { code: "ETIMEDOUT" }, status: null, stdout: "", stderr: "" }; };
  const p = cliPaseo(undefined, { PASEO_BIN: "paseo", AGENT_HUB_CREATE_TIMEOUT_S: "5" }, spawn);
  const j = withRetry(p, { sleep: () => {} })(["run", "--new-workspace", "worktree", "--no-wait", "x"]);
  assert.match(j.error, /^CREATE_TIMEOUT: .*AGENT_HUB_CREATE_TIMEOUT_S/); assert.equal(n, 1); assert.equal(transient(j), false);
  assert.equal(toSeconds("15m"), 900); assert.equal(toSeconds("30s"), 30);
});

test("markActive writes a per-route marker and the slot total; the returned fn removes the marker", async () => {
  const { mkdtempSync, readdirSync, readFileSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "act-"));
  const done = markActive({ slots: { a: 2, b: 3 } }, "a/x", d);
  assert.equal(JSON.parse(readFileSync(join(d, "total.json"), "utf8")).total, 5);
  assert.equal(readdirSync(d).filter((n) => n.startsWith("t-")).length, 1);
  done();
  assert.equal(readdirSync(d).filter((n) => n.startsWith("t-")).length, 0);
});

test("read-only types use each provider's read-only mode, in or out of a worktree, ignoring caller and routes modes", () => {
  const prov = { claude: "plan", "claude-clean": "plan", "qwen-code": "plan", "qwen-code-2": "plan", "qwen-laptop": "plan", opencode: "plan", qoder: "dontAsk", codex: "auto" };
  assert.deepEqual(Object.fromEntries(Object.entries(prov).map(([k]) => [k, READ_ONLY_MODES[k]])), prov);
  for (const [p, m] of Object.entries(prov)) for (const worktree of [false, true]) {
    const r2 = { slots: {}, modes: { [p]: "yolo" }, routes: { summarise: [p] } };
    const f = fake({ run: () => ({ status: "completed", agentId: "A" }) });
    runRoute({ ...o, type: "summarise", mode: "bypassPermissions", worktree }, f, r2);
    const run = f.calls.find((c) => c[0] === "run");
    assert.equal(run[run.indexOf("--mode") + 1], m, p);
  }
  assert.equal(readOnlyMode("x", { readOnlyModes: { x: "ro" } }), "ro");
});

test("lastAnswer: text after the last tagged line, capped at 4 KB with a flag", () => {
  assert.deepEqual(lastAnswer("[User] q\n[Read] f\nJob 61 failed.\nDisk full.\n"), { answer: "Job 61 failed.\nDisk full.", truncated: false });
  assert.equal(lastAnswer("[User] q\n[Read] f\n").answer, "");
  const big = lastAnswer("[User] q\n" + "x".repeat(5000));
  assert.equal(big.answer.length, 4096); assert.equal(big.truncated, true);
});
test("a completed route returns the agent's answer from `paseo logs`; truncation names the full-log command", () => {
  const mk = (text) => (a) => (a[0] === "ls" ? [] : a[0] === "logs" ? { text } : { status: "completed", agentId: "A1" });
  const r = runRoute({ ...o, provider: "qwen/b" }, mk("[User] q\nthe answer\n"), routes);
  assert.equal(r.answer, "the answer"); assert.equal(r.answerTruncated, undefined);
  const t = runRoute({ ...o, provider: "qwen/b" }, mk("[User] q\n" + "y".repeat(9000)), routes);
  assert.equal(t.answer.length, 4096); assert.equal(t.answerTruncated, true); assert.equal(t.answerFull, "paseo logs A1");
  assert.equal(runRoute({ ...o, provider: "qwen/b" }, (a) => (a[0] === "ls" ? [] : a[0] === "logs" ? { error: "x" } : { status: "completed", agentId: "A1" }), routes).answer, undefined);
});
test("cliPaseo returns `paseo logs` as raw text, without --json", () => {
  let seen;
  const spawn = (_c, args) => { seen = args; return { status: 0, stdout: "[User] q\nhi\n", stderr: "" }; };
  assert.deepEqual(cliPaseo(undefined, { PASEO_BIN: "paseo" }, spawn)(["logs", "A"]), { text: "[User] q\nhi\n" });
  assert.ok(!seen.includes("--json"));
});
import { mkdtempSync as mk2, mkdirSync as md2, writeFileSync as wf2, symlinkSync } from "node:fs";
import { join as j2 } from "node:path";
import { normalise } from "../pending.mjs";
import { pathAllowed, batchAllowed } from "../readguard.mjs";
const CRED = ["credentials", "json"].join(".");
const sandbox = () => { const d = mk2(j2(tmpdir(), "rg-")); const cwd = j2(d, "cwd"); md2(cwd); md2(j2(d, "outside"));
  wf2(j2(cwd, "app.log"), "x"); wf2(j2(cwd, ".env"), "x"); wf2(j2(cwd, CRED), "x"); wf2(j2(cwd, "server.pem"), "x"); md2(j2(cwd, ".hidden")); wf2(j2(cwd, ".hidden", "a.txt"), "x");
  wf2(j2(d, "outside", "data.txt"), "x"); return { d, cwd }; };
test("readguard: a read inside cwd is allowed", () => {
  const { cwd } = sandbox();
  assert.ok(pathAllowed(j2(cwd, "app.log"), [cwd]).ok);
  assert.ok(batchAllowed([{ name: "read", kind: "read", paths: [j2(cwd, "app.log")] }], [cwd]).ok);
});
test("readguard: outside path, sensitive files in cwd, dot-dirs, missing path and unresolvable path are denied", () => {
  const { d, cwd } = sandbox();
  for (const p of [j2(d, "outside", "data.txt"), j2(cwd, ".env"), j2(cwd, CRED), j2(cwd, "server.pem"), j2(cwd, ".hidden", "a.txt"), j2(cwd, "nope.log"), "", undefined])
    assert.equal(pathAllowed(p, [cwd]).ok, false, String(p));
  assert.equal(batchAllowed([{ name: "read", kind: "read", paths: [] }], [cwd]).ok, false); // no path
  assert.equal(pathAllowed(j2(d, "outside", "data.txt"), [cwd, j2(d, "outside")]).ok, true); // explicit readAllow root
});
test("readguard: ~/.ssh, ~/.claude and PASEO_HOME are denied even for a broad readAllow root", () => {
  const { d } = sandbox(); const home = j2(d, "home"); md2(home); for (const s of [".ssh", ".claude", "ph"]) { md2(j2(home, s)); wf2(j2(home, s, "k"), "x"); }
  const env = { PASEO_HOME: j2(home, "ph") };
  for (const s of [".ssh", ".claude", "ph"]) assert.equal(pathAllowed(j2(home, s, "k"), [home], env, home).ok, false, s);
});
test("readguard: a symlink inside cwd that escapes it is denied", (t) => {
  const { d, cwd } = sandbox();
  try { symlinkSync(j2(d, "outside"), j2(cwd, "link"), "junction"); } catch { return t.skip("no symlink right"); }
  assert.equal(pathAllowed(j2(cwd, "link", "data.txt"), [cwd]).ok, false);
});
test("readguard: mixed batch is all-or-nothing; vague tools (search, find) and writes are denied", () => {
  const { d, cwd } = sandbox();
  const good = { name: "read", kind: "read", paths: [j2(cwd, "app.log")] };
  assert.equal(batchAllowed([good, { name: "read", kind: "read", paths: [j2(d, "outside", "data.txt")] }], [cwd]).ok, false);
  for (const n of ["search", "find", "write", "edit", "run_shell_command"]) assert.equal(batchAllowed([{ ...good, name: n }], [cwd]).ok, false, n);
});
test("normalise: pending permission payload -> name, kind and every path", () => {
  const r = normalise({ permissions: [{ agentId: "A", request: { id: "R", name: "read", detail: { type: "read" }, metadata: { rawRequest: { toolCall: { kind: "read", locations: [{ path: "/a/b" }], rawInput: { file_path: "/a/b", path: "/c" } } } } } }] });
  assert.deepEqual(r, [{ agentId: "A", id: "R", name: "read", kind: "read", paths: ["/a/b", "/c"] }]);
  assert.deepEqual(normalise({ permissions: [{ agentId: "A", request: { id: "R", name: "read" } }] })[0].paths, []);
});
const permFake = (pending, log) => (a) => {
  log.push(a);
  if (a[0] === "pending") return pending;
  if (a[0] === "wait") return { status: "idle" };
  return {};
};
test("grantReads: in-cwd read is allowed and waits again; outside path, no path and a mixed batch are denied for ALL requests", () => {
  const { d, cwd } = sandbox(); const inC = j2(cwd, "app.log"), out = j2(d, "outside", "data.txt");
  const R = (id, paths, name = "read") => ({ id, agentId: "A", name, kind: "read", paths });
  const run = (pend) => { const log = []; const r = grantReads(permFake(pend, log), { agentId: "A", status: "permission" }, 60, { cwd }); return { r, log }; };
  const ok = run([R("1", [inC])]);
  assert.equal(ok.r.status, "completed"); assert.ok(ok.log.some((c) => c[1] === "allow" && c[3] === "1"));
  for (const pend of [[R("1", [out])], [R("1", [])], [R("1", [inC]), R("2", [out])], [R("1", [inC], "write")]]) {
    const x = run(pend);
    assert.equal(x.r.status, "permission");
    assert.ok(!x.log.some((c) => c[1] === "allow" || c[0] === "wait"), JSON.stringify(pend));
    assert.equal(x.log.filter((c) => c[1] === "deny").length, pend.length);
  }
});
test("a read-only route whose agent stops on a read of a cwd file completes without a fallback; a read outside cwd or a write still fails", () => {
  const { d, cwd } = sandbox();
  const r2 = { slots: {}, routes: { summarise: ["qwen/a", "qwen/b"] } };
  let path = j2(cwd, "app.log");
  const p = (a) => {
    if (a[0] === "ls") return [];
    if (a[0] === "run") return { status: "permission", agentId: "P" };
    if (a[0] === "pending") return [{ id: "R", agentId: "P", name: "read", kind: "read", paths: [path] }];
    if (a[0] === "wait") return { status: "idle" };
    return {}; };
  const good = runRoute({ ...o, type: "summarise", cwd }, p, r2);
  assert.equal(good.status, "completed"); assert.equal(good.trace.length, 1);
  path = j2(d, "outside", "data.txt");
  assert.equal(runRoute({ ...o, type: "summarise", cwd }, p, r2).used, null);
  assert.equal(runRoute({ ...o, type: "summarise", cwd }, p, { ...r2, readAllow: [j2(d, "outside")] }).status, "completed");
});
test("every spawned run carries an explicit --cwd (never the daemon default)", () => {
  const p = fake({ run: () => ({ status: "completed", agentId: "A" }) });
  runRoute({ ...o, provider: "qwen/b", cwd: "/r" }, p, routes);
  const run = p.calls.find((c) => c[0] === "run");
  assert.equal(run[run.indexOf("--cwd") + 1], "/r");
});
