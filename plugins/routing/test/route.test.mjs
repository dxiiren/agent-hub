import "./isolate-run-dir.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { withAnswer, grantReads, lastAnswer, stopReason, unusableAnswer, READ_FIRST, runRoute as runRouteReal, withRetry, transient, readOnlyType, READ_ONLY_MODES, readOnlyMode, cliPaseo, toSeconds, markActive } from "../route.mjs";
const runRoute = (o, ...a) => runRouteReal({ scan: () => false, ...o }, ...a); // the secret scan has its own test; gitleaks per route call would slow every case

const ALL = ["codex", "qwen", "claude", "claude-clean", "qwen-code", "qwen-code-2", "qwen-laptop", "opencode", "qoder"]; // fake providers in tests: enforcement is tested separately
const routes = { readOnlyEnforced: ALL, readOnlyModes: { codex: "auto", qwen: "read-only" }, slots: { codex: 1, qwen: 2 }, routes: { edit: ["codex/a", "qwen/b", "qwen/c"] } };
const fake = (script) => {
  const calls = [];
  const f = (args) => { calls.push(args); return args[0] === "worktree" && args[1] === "create" ? { name: "wt-x", worktreePath: "/wt/x" } : args[0] === "ls" ? (script.ls ?? []) : args[0] === "stop" ? {} : args[0] === "provider" ? (script.providers ?? {}) : script.run(args); };
  f.calls = calls; return f;
};
const o = { type: "edit", prompt: "p", cwd: "/r", session: "S1", dev: "d", client: "claude", answerRetryMs: 0 };

test("default wins when healthy; labels carry session, dev, client", () => {
  const p = fake({ run: () => ({ status: "completed", agentId: "A1" }) });
  const r = runRoute(o, p, routes);
  assert.equal(r.used, "codex/a");
  const run = p.calls.find((c) => c[0] === "run");
  assert.ok(run.includes("session=S1") && run.includes("caller=claude") && run.includes("dev=d"));
});
test("failed or down default moves to the next entry and archives the dead agent", () => {
  const p = fake({ run: (a) => (a.includes("codex/a") ? { status: "timeout", agentId: "X" } : { status: "completed", agentId: "A2" }) });
  const r = runRoute(o, p, routes);
  assert.equal(r.used, "qwen/b");
  assert.deepEqual(r.trace.map((t) => t.provider), ["codex/a", "qwen/b"]);
  assert.ok(p.calls.some((c) => c[0] === "archive" && c[1] === "X"));
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
  p = mk(); runRoute({ ...o, worktree: true, base: "a".repeat(40) }, p, r2);
  const run = p.calls.find((c) => c[0] === "run");
  assert.ok(run.includes("full-access") && run.includes("/wt/x") && !run.includes("--new-workspace"), "runs in the route-created worktree");
  p = mk(); runRoute({ ...o, provider: "qwen/x" }, p, r2);
  assert.ok(p.calls.find((c) => c[0] === "run").includes("plan"));
});

import { cmpVer, newest, parseCodex, parseClaude, resolveEntry, stalePins } from "../resolve.mjs";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
const privDir = () => mkdtempSync(join(tmpdir(), "rt-")); // a private empty cwd: the read-only snapshot walks the cwd, and a shared %TEMP% full of other tools files made these tests slow and order-dependent
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
  const raw = (args) => (args[0] === "ls" ? [] : ["logs", "stop", "archive", "project", "provider", "workspace"].includes(args[0]) ? {} : ++n < 3 ? { error: "DAEMON_UNREACHABLE: status probe" } : { status: "completed", agentId: "R1" });
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
test("route records the task's start commit as the gate base (committed work is judged)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process"); const { claimRequest } = await import("../../gate/server/store.mjs");
  const d = mkdtempSync(join(tmpdir(), "gb-")); const gd = mkdtempSync(join(tmpdir(), "gd-"));
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", ...a], { cwd: d, encoding: "utf8" });
  g("init", "-q"); writeFileSync(join(d, "a"), "1"); g("add", "."); g("commit", "-qm", "i");
  const sha = g("rev-parse", "HEAD").trim();
  runRoute({ ...o, cwd: d, gate: "x", gateDir: gd }, fake({ run: () => ({ status: "completed", agentId: "A9" }) }), routes, () => ({ status: "PASS", reasons: [] }));
  assert.equal(claimRequest(gd, d).base, sha);
});
test("caller gate uses the same options as the hook: repo row maxLines, forbid, allow, cmd fallback", () => {
  let opts;
  const p = (a) => (a[0] === "ls" ? [{ id: "A9", cwd: "/r" }] : { status: "completed", agentId: "A9" });
  const rt = { ...routes, gates: [{ match: "^/r$", cmd: "rowcmd", maxLines: 7, forbid: "^[.]github/", allow: "^src/" }] };
  runRoute({ ...o }, p, rt, () => ({ status: "PASS", reasons: [] })); // no caller gate: nothing to run
  runRoute({ ...o, gate: "mine" }, p, rt, (cwd, x) => { opts = x; return { status: "PASS", reasons: [] }; });
  assert.ok(opts.deadlineMs > Date.now(), "the secret scan carries the attempt deadline"); delete opts.deadlineMs;
  assert.deepEqual(opts, { base: null, requireBase: true, cmd: "mine", maxLines: 7, forbid: "^[.]github/", allow: "^src/" });
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
  const r2 = { ...routes, modes: { codex: "full-access", qwen: "yolo" }, routes: { summarise: ["claude-clean/a"], review: ["qwen/b"] } };
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
  const r2 = { ...routes, routes: { summarise: ["claude-clean/a"] } };
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

test("permission hint gives the real reason: worktree run never says the flag is missing; a secret in the tree is named; outside a worktree it names the flag", async () => {
  const { permissionHint } = await import("../route.mjs");
  const mk = (extra) => ({ o: { type: "code-edit", worktree: true, base: "a".repeat(40) }, mode: "yolo", ro: false, wt: { path: "/wt/x" }, agentId: "A", routes: {}, paseo: () => [], ...extra });
  const withSecret = permissionHint(mk({ gate: () => ({ reasons: ["secret pattern in diff", "gate cmd exit 1"] }) }));
  assert.match(withSecret, /secret pattern in diff/); assert.doesNotMatch(withSecret, /need --new-workspace|pass --new-workspace/); assert.doesNotMatch(withSecret, /gate cmd/);
  const pending = permissionHint(mk({ gate: () => ({ reasons: [] }), paseo: () => [{ agentId: "A", name: "write", paths: ["/wt/x/c.py"] }, { agentId: "B", name: "x" }] }));
  assert.match(pending, /pending write on \/wt\/x\/c\.py/); assert.doesNotMatch(pending, /pending x/);
  assert.match(permissionHint(mk({ gate: () => { throw new Error("boom"); } })), /no secret pattern found/);
  assert.match(permissionHint(mk({ o: { type: "code-edit", worktree: false } })), /pass --new-workspace worktree/);
  assert.match(permissionHint(mk({ ro: true, o: { type: "summarise" } })), /read-only task summarise/);
});

test("worktree run: create is --no-wait, then a separate bounded wait; idle becomes completed", () => {
  const calls = [];
  const p = (args) => { calls.push(args); return args[0] === "worktree" ? { name: "wt-x", worktreePath: "/wt/x" } : args[0] === "ls" ? [] : args[0] === "run" ? { agentId: "W1", status: "created" } : args[0] === "wait" ? { status: "idle" } : {}; };
  const r = runRoute({ ...o, worktree: true, base: "a".repeat(40), waitTimeout: "2m" }, p, routes);
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
  const prov = { claude: "plan", "claude-clean": "plan", "qwen-code": "read-only", "qwen-code-2": "read-only", "qwen-laptop": "read-only", opencode: "plan", qoder: "dontAsk" };
  assert.deepEqual(Object.fromEntries(Object.entries(prov).map(([k]) => [k, READ_ONLY_MODES[k]])), prov);
  assert.equal(READ_ONLY_MODES.codex, undefined);
  for (const [p, m] of Object.entries(prov)) for (const worktree of [false, true]) {
    const r2 = { readOnlyEnforced: ALL, slots: {}, modes: { [p]: "yolo" }, routes: { summarise: [p] } };
    const f = fake({ run: () => ({ status: "completed", agentId: "A" }) });
    runRoute({ ...o, type: "summarise", mode: "bypassPermissions", worktree, base: "a".repeat(40) }, f, r2);
    const run = f.calls.find((c) => c[0] === "run");
    assert.equal(run[run.indexOf("--mode") + 1], m, p);
  }
  assert.equal(readOnlyMode("x", { readOnlyModes: { x: "ro" } }), undefined, "unknown kind: only the proxy mode counts"); assert.equal(readOnlyMode("x", { readOnlyModes: { x: "read-only" } }), "read-only");
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
  assert.equal(runRoute({ ...o, provider: "qwen/b" }, (a) => (a[0] === "ls" ? [] : a[0] === "logs" ? { error: "x" } : { status: "completed", agentId: "A1" }), routes).answer, "");
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
test("readguard: grep/glob/ls/list/read_many_files and pattern fields are denied, even on a clean cwd; directories are not files", () => {
  const { cwd } = sandbox();
  for (const n of ["grep", "glob", "ls", "list", "list_directory", "read_many_files"]) assert.equal(batchAllowed([{ name: n, kind: "search", paths: [cwd] }], [cwd]).ok, false, n);
  assert.equal(batchAllowed([{ name: "read", kind: "read", paths: [cwd] }], [cwd]).ok, false); // a directory
  assert.equal(batchAllowed([{ name: "read", kind: "read", paths: [j2(cwd, "app.log")], extras: true }], [cwd]).ok, false);
  assert.equal(normalise({ permissions: [{ agentId: "A", request: { id: "R", name: "read", metadata: { rawRequest: { toolCall: { rawInput: { path: "/a", pattern: "*" } } } } } }] })[0].extras, true);
});
test("readguard: a relative path resolves against the task cwd (not the daemon cwd); a ../ escape is denied", () => {
  const { cwd } = sandbox();
  assert.ok(pathAllowed("app.log", [cwd]).ok);
  assert.equal(pathAllowed(j2("..", "outside", "data.txt"), [cwd]).ok, false);
  assert.equal(pathAllowed(j2("..", "cwd", ".env"), [cwd]).ok, false);
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
  assert.deepEqual(r, [{ agentId: "A", id: "R", name: "read", kind: "read", paths: ["/a/b", "/c"], extras: false }]);
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
  const r2 = { readOnlyEnforced: ALL, readOnlyModes: { qwen: "read-only" }, slots: {}, routes: { summarise: ["qwen/a", "qwen/b"] } };
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

test("a finished route stops and archives its agent after the answer is read; --keep (o.keep) leaves it; fallen-back attempts are retired too", () => {
  const mk = (script) => { const calls = []; const f = (a) => { calls.push(a); return script(a); }; f.calls = calls; return f; };
  const order = (p) => p.calls.map((c) => c[0]);
  const ok = mk((a) => (a[0] === "ls" ? [] : a[0] === "logs" ? { text: "[User] q\nans" } : a[0] === "run" ? { status: "completed", agentId: "A1" } : {}));
  const r = runRoute({ ...o, provider: "qwen/b" }, ok, routes);
  assert.equal(r.answer, "ans");
  assert.ok(order(ok).indexOf("logs") < order(ok).indexOf("archive"), "answer is read before the agent is archived");
  assert.deepEqual(ok.calls.filter((c) => c[0] === "stop" || c[0] === "archive"), [["archive", "A1", "--force"]]); // archive --force ends the CLI process tree, one call
  const keep = mk((a) => (a[0] === "ls" ? [] : a[0] === "run" ? { status: "completed", agentId: "A2" } : {}));
  runRoute({ ...o, provider: "qwen/b", keep: true }, keep, routes);
  assert.ok(!keep.calls.some((c) => c[0] === "stop" || c[0] === "archive"));
  const fb = mk((a) => (a[0] === "ls" ? [] : a[0] === "run" ? (a.includes("codex/a") ? { status: "timeout", agentId: "X" } : { status: "completed", agentId: "Y" }) : {}));
  runRoute(o, fb, { ...routes, routes: { edit: ["codex/a", "qwen/b"] } });
  assert.ok(fb.calls.some((c) => c[0] === "archive" && c[1] === "X") && fb.calls.some((c) => c[0] === "archive" && c[1] === "Y"));
});
test("a route-created worktree is removed after the agent is archived; --keep and non-worktree routes leave it", () => {
  const mk = (script) => { const calls = []; const f = (a) => { calls.push(a); return script(a); }; f.calls = calls; return f; };
  const sc = (a) => (a[0] === "ls" ? [] : a[0] === "worktree" ? (a[1] === "create" ? { name: "wt-1", worktreePath: "/wt/1" } : {}) : a[0] === "run" ? { status: "completed", agentId: "A1xxxxx-full" } : {});
  const w = mk(sc);
  runRoute({ ...o, provider: "qwen/b", worktree: true, base: "a".repeat(40) }, w, routes);
  assert.deepEqual(w.calls.filter((c) => c[0] === "worktree" && c[1] === "archive"), [["worktree", "archive", "wt-1", "--cwd", o.cwd]]);
  const k = mk(sc);
  runRoute({ ...o, provider: "qwen/b", worktree: true, keep: true, base: "a".repeat(40) }, k, routes);
  assert.ok(!k.calls.some((c) => c[0] === "worktree" && c[1] === "archive"));
  const n = mk(sc);
  runRoute({ ...o, provider: "qwen/b" }, n, routes);
  assert.ok(!n.calls.some((c) => c[0] === "worktree"));
});
test("claude-wrap merges the hub rules into the --settings Paseo passes, so they cannot be overridden", async () => {
  const { mergeSettings } = await import("../../../scripts/claude-wrap.mjs");
  const rules = { permissions: { allow: ["Read(./**)"], deny: ["Read(.env)"] } };
  const a = mergeSettings(["--x", "1", "--settings", JSON.stringify({ fastMode: false }), "--y"], rules);
  assert.deepEqual(a.slice(0, 3), ["--x", "1", "--y"]);
  assert.equal(a.filter((v) => v === "--settings").length, 1);
  const m = JSON.parse(a.at(-1));
  assert.equal(m.fastMode, false); assert.deepEqual(m.permissions.deny, ["Read(.env)"]);
});

import { readFileSync as rfsR5 } from "node:fs";
import { SENSITIVE_GLOBS } from "../readguard.mjs";
const tpl = JSON.parse(rfsR5(new URL("../../../config/claude-clean/readonly-settings.template.json", import.meta.url), "utf8"));
test("claude read-only mode is plan or default, and the read-only settings deny every tool that writes or reaches out", async () => {
  for (const k of ["claude", "claude-clean"]) assert.ok(["plan", "default"].includes(READ_ONLY_MODES[k]), k);
  for (const t of ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "mcp__*"]) assert.ok(tpl.permissions.deny.includes(t), t);
  assert.equal(tpl.permissions.allow, undefined, "no allow rule: every non-native read goes through readguard");
  const { buildArgs } = await import("../../../scripts/claude-wrap.mjs");
  const ro = buildArgs(["--permission-mode", "plan", "--setting-sources=user,project,local", "--settings", '{"fastMode":false}'], tpl, "m.json");
  const m = JSON.parse(ro[ro.lastIndexOf("--settings") + 1]);
  assert.ok(["Bash", "Edit", "Write"].every((t) => m.permissions.deny.includes(t)));
  assert.deepEqual(ro.slice(-2), ["--setting-sources", "user"]); assert.ok(!ro.some((a) => /project|local/.test(String(a)) && String(a).startsWith("--setting-sources")));
  const edit = buildArgs(["--permission-mode", "bypassPermissions", "--setting-sources=user,project,local"], tpl, "m.json");
  assert.ok(!edit.includes("--settings") && edit.includes("--setting-sources=user,project,local"), "edit tasks keep every tool");
});
test("the settings template denies at least everything readguard denies", () => {
  for (const g of SENSITIVE_GLOBS) for (const r of [`Read(${g})`, `Read(**/${g})`]) assert.ok(tpl.permissions.deny.includes(r), r);
  for (const d of ["~/.ssh", "~/.claude", "~/.codex", "~/.qoder"]) assert.ok(tpl.permissions.deny.some((x) => x.startsWith(`Read(${d}`)), d);
});

import { decide } from "../claude-readhook.mjs";
import { hookEntry } from "../../../scripts/claude-wrap.mjs";
import { mkdtempSync as mkd, mkdirSync as mkdr, writeFileSync as wf } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir as td } from "node:os";
import { join as jn } from "node:path";
const hookFix = () => { const d = mkd(jn(td(), "rh-")); const cwd = jn(d, "cwd"), out = jn(d, "outside"); mkdr(cwd); mkdr(out); mkdr(jn(cwd, "sub"));
  wf(jn(cwd, "a.log"), "x"); wf(jn(cwd, "sub", "b.txt"), "x"); wf(jn(cwd, ".env"), "k"); wf(jn(out, "section.md"), "96"); return { d, cwd, out, env: { PASEO_HOME: jn(d, "ph") }, home: jn(d, "home") }; };
test("claude read hook: Read inside cwd ok; outside, readAllow rules, sensitive and dot files", () => {
  const { cwd, out, env, home } = hookFix(); const rd = (f, allow = []) => decide({ cwd, tool_name: "Read", tool_input: { file_path: f } }, allow, env, home).ok;
  assert.equal(rd(jn(cwd, "a.log")), true); assert.equal(rd(jn(cwd, "sub", "b.txt")), true);
  assert.equal(rd(jn(out, "section.md")), false, "non-sensitive file outside cwd refused");
  assert.equal(rd(jn(out, "section.md"), [out]), true, "readAllow root opens it");
  assert.equal(rd(jn(cwd, ".env")), false); assert.equal(rd(jn(cwd, "..", "outside", "section.md")), false); assert.equal(rd(jn(cwd, "nope")), false);
  assert.equal(rd(jn(home, ".ssh", "config")), false);
});
test("claude read hook: Grep, Glob and LS are denied everywhere, even inside cwd (they reach .env and credentials); backslash and brace escapes denied", () => {
  const { cwd, out, env, home } = hookFix(); const d = (name, ti, c = cwd) => decide({ cwd: c, tool_name: name, tool_input: ti }, [], env, home).ok;
  for (const ti of [{ pattern: "x" }, { pattern: "x", path: jn(cwd, "sub") }, { pattern: "x", path: out }, { pattern: "**/*", glob: "..\outside\*" }, { pattern: "{..,.}/outside/*" }, { pattern: "@(..)/outside/*" }, { path: cwd }])
    for (const t of ["Grep", "Glob", "LS"]) assert.equal(d(t, ti), false, `${t} ${JSON.stringify(ti)}`);
  assert.equal(d("Bash", { command: "cat x" }), false); assert.equal(d("Read", { file_path: jn(cwd, "a.log") }, ""), false);
  assert.equal(d("Read", { file_path: cwd + "\..\outside\section.md" }), false, "backslash .. in a Read path");
  assert.equal(d("Read", { file_path: jn(cwd, "{a,b}.log") }), false);
});
test("claude read hook runs as a command: exit 0 inside, 2 outside and on garbage input", () => {
  const { cwd, out } = hookFix(); const js = new URL("../claude-readhook.mjs", import.meta.url).pathname.replace(/^\/([a-z]:)/i, "$1");
  const run = (inp) => spawnSync(process.execPath, [js], { input: inp, env: { ...process.env, AGENT_HUB_ROUTES: jn(cwd, "none.json") } }).status;
  assert.equal(run(JSON.stringify({ cwd, tool_name: "Read", tool_input: { file_path: jn(cwd, "a.log") } })), 0);
  assert.equal(run(JSON.stringify({ cwd, tool_name: "Read", tool_input: { file_path: jn(out, "section.md") } })), 2);
  assert.equal(run("not json"), 2);
});
test("claude read-only launch carries the hook; bypass (code-edit) does not; template and wrapper never allow Bash/Edit/Write", async () => {
  const { buildArgs } = await import("../../../scripts/claude-wrap.mjs");
  const he = hookEntry(); assert.match(he.hooks[0].command, /claude-readhook\.mjs/);
  for (const mode of ["plan", "default"]) {
    const args = buildArgs(["--permission-mode", mode, "--setting-sources", "user,project,local", "--settings", '{"disableAllHooks":true,"hooks":{"PreToolUse":[{"matcher":"X","hooks":[]}]}}'], tpl, "m.json");
    const mm = JSON.parse(args[args.lastIndexOf("--settings") + 1]);
    assert.equal(mm.disableAllHooks, false); assert.deepEqual(args.slice(-2), ["--setting-sources", "user"]); assert.equal(args.filter((x) => x.startsWith("--setting-sources")).length, 1, "two-argument form stripped");
    const m = mm;
    assert.equal(m.hooks.PreToolUse[0].matcher, he.matcher); assert.equal(m.hooks.PreToolUse.length, 2, "Paseo's own hooks kept");
    assert.equal(m.permissions.allow, undefined);
    for (const t of ["Bash", "Edit", "Write"]) assert.ok(m.permissions.deny.includes(t));
    assert.ok(!JSON.stringify(m).match(/"allow"/), "no allow anywhere");
  }
  const edit = buildArgs(["--permission-mode", "bypassPermissions"], tpl, "m.json"); assert.ok(!edit.includes("--settings"));
  assert.ok(!he.matcher.split("|").some((t) => ["Bash", "Edit", "Write"].includes(t)));
});

test("headSha: commit, unborn HEAD -> empty tree, non-repo -> null", async () => {
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process"); const { headSha } = await import("../route.mjs");
  const d = mkdtempSync(join(tmpdir(), "hs-")); execFileSync("git", ["init", "-q"], { cwd: d });
  assert.equal(headSha(d), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.equal(headSha(mkdtempSync(join(tmpdir(), "hs-np-"))), null);
});

test("normCwd: Git-Bash and Cygwin drive paths become C:/ on win32 only", async () => {
  const { normCwd } = await import("../route.mjs");
  assert.equal(normCwd("/c/Users/x/repo", "win32"), "C:/Users/x/repo");
  assert.equal(normCwd("/cygdrive/d/a", "win32"), "D:/a");
  assert.equal(normCwd("/c", "win32"), "C:/");
  assert.equal(normCwd("C:/Users/x", "win32"), "C:/Users/x");
  assert.equal(normCwd("/home/x", "win32"), "/home/x");
  assert.equal(normCwd("/c/Users/x", "linux"), "/c/Users/x");
});
test("route CLI with a missing --cwd fails fast with a clear message (no daemon call)", async () => {
  const { spawnSync } = await import("node:child_process"); const { fileURLToPath } = await import("node:url"); const { mkdtempSync } = await import("node:fs"); const { join } = await import("node:path");
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../route.mjs", import.meta.url)), "summarise", "x", "--cwd", "/c/definitely/not/here-xyz"], { encoding: "utf8", timeout: 20000, env: { ...process.env, PASEO_HOME: mkdtempSync(join(tmpdir(), "ph-")) } });
  assert.equal(r.status, 2); assert.match(r.stderr, /not an existing folder/); assert.ok(Date.now() - t0 < 10000);
});

test("read-only task refused a read: the partial answer is returned with status permission, not lost", () => {
  const rt = { ...routes, routes: { summarise: ["qwen/b"] } };
  const p = (a) => a[0] === "ls" ? [] : a[0] === "logs" ? { text: "[assistant]\nPartial: the file starts with X." } : a[0] === "run" ? { status: "permission", agentId: "A7" } : {};
  const r = runRoute({ ...o, type: "summarise" }, p, rt);
  assert.equal(r.used, null); assert.equal(r.status, "permission");
  assert.match(r.partial.answer, /Partial: the file starts with X/); assert.equal(r.partial.refusedRead, true);
  assert.ok(r.trace.some((t) => t.status === "permission"));
});

import { linkSync } from "node:fs";
test("readguard: a hardlink inside cwd to a file outside it is denied", (t) => {
  const d = mk2(j2(tmpdir(), "rg-hl-")); const cwd = j2(d, "cwd"); md2(cwd); md2(j2(d, "outside"));
  wf2(j2(d, "outside", "data.txt"), "outside"); wf2(j2(cwd, "own.txt"), "own");
  try { linkSync(j2(d, "outside", "data.txt"), j2(cwd, "hl.txt")); } catch { return t.skip("no hardlink right"); }
  assert.equal(pathAllowed(j2(cwd, "hl.txt"), [cwd]).ok, false);
  assert.ok(pathAllowed(j2(cwd, "own.txt"), [cwd]).ok);
});

import { runRoute as rr6Real } from "../route.mjs";
const rr6 = (o, ...a) => rr6Real({ scan: () => false, ...o }, ...a);
test("an unknown provider id fails fast, before any daemon call", () => {
  let calls = 0; const paseo = () => { calls++; return {}; };
  const r = rr6({ type: "code-edit-easy", prompt: "x", provider: "nosuchprovider", cwd: "." }, paseo, { routes: { "code-edit-easy": ["qwen-laptop"] }, slots: { "qwen-laptop": 1 } });
  assert.equal(r.used, null); assert.match(r.trace[0].error, /unknown provider id "nosuchprovider"/); assert.equal(calls, 0);
  const ok = rr6({ type: "code-edit-easy", prompt: "x", provider: "qwen-laptop", cwd: "." }, () => ({ status: "error", error: "stop" }), { routes: { "code-edit-easy": ["qwen-laptop"] }, slots: { "qwen-laptop": 1 } });
  assert.ok(!/unknown provider/.test(JSON.stringify(ok)));
});

test("codex has no read-only mode: a read-only type skips it, an edit type still uses it", () => {
  const rt = { slots: { codex: 1, qwen: 2 }, routes: { summarise: ["codex/a", "qwen-code/b"], edit: ["codex/a"] } };
  const runs = [];
  const p = (a) => { if (a[0] === "run") { runs.push(a[a.indexOf("--provider") + 1]); return { status: "completed", agentId: "Z" }; } return a[0] === "worktree" && a[1] === "create" ? { name: "wt-x", worktreePath: "/wt/x" } : a[0] === "ls" ? [] : {}; };
  const r = runRoute({ type: "summarise", prompt: "x", cwd: mkdtempSync(join(tmpdir(), "rt-cwd-")) }, p, rt);
  assert.deepEqual(runs, ["qwen-code/b"]); assert.match(JSON.stringify(r.trace), /no verified read-only mode/);
  runs.length = 0; runRoute({ type: "edit", prompt: "x", cwd: mkdtempSync(join(tmpdir(), "rt-cwd-")), worktree: true, base: "a".repeat(40) }, p, rt);
  assert.deepEqual(runs, ["codex/a"]);
});

// ---- round 5: read-only chains only on providers with an enforced sensitive-read guard ----
import { existsSync as exR5 } from "node:fs";
import { fileURLToPath as fupR5 } from "node:url";
import { READ_ONLY_ENFORCED, readOnlyEnforced } from "../route.mjs";
test("--provider qoder/efficient on a read-only type is refused fast, nothing is launched", () => {
  const p = fake({ run: () => ({ status: "completed", agentId: "A" }) });
  for (const type of ["review", "summarise"]) for (const prov of ["qoder/efficient", "opencode/x", "codex/a", "claude/not-clean-id-only"].slice(0, 3)) {
    const r = runRoute({ ...o, type, provider: prov }, p, { slots: {}, routes: { review: [], summarise: [] } });
    assert.equal(r.used, null); assert.match(r.trace[0].error, /refused on/);
  }
  assert.ok(!p.calls.some((c) => c[0] === "run"));
  assert.ok(readOnlyEnforced("qwen-laptop") && readOnlyEnforced("claude-clean") && !readOnlyEnforced("qoder") && !readOnlyEnforced("claude"));
});
test("no read-only chain in routes.template.json holds an unenforced provider", () => {
  const dir = fupR5(new URL("../../../config/routes/", import.meta.url));
  for (const f of ["routes.template.json"]) { // the shipped file only: a developer's routes.local.json is theirs, tests never read it
    const fp = dir + f; if (!exR5(fp)) continue;
    const r = JSON.parse(rfsR5(fp, "utf8"));
    for (const t of r.readOnlyTypes ?? ["summarise", "review"]) for (const e of r.routes[t] ?? []) {
      const b = e.split("/")[0];
      assert.ok(b === "claude" || READ_ONLY_ENFORCED.includes(b), `${f} ${t}: ${e}`);
    }
  }
});

import { qwenEnv, takeReadOnlyFlag, QWEN_SYSTEM_SETTINGS, QWEN_SYSTEM_SETTINGS_RO } from "../office.mjs";
test("read-only tasks run on the SAME Qwen provider in session mode read-only (no -ro twin); edit tasks use the routes mode; nothing is written under cwd", async () => {
  const { mkdtempSync, readdirSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "ro-")); const used = []; const modes = [];
  const p = fake({ run: (a) => { if (a[0] === "run") { used.push(a[a.indexOf("--provider") + 1]); modes.push(a.includes("--mode") ? a[a.indexOf("--mode") + 1] : null); } return { status: "completed", agentId: "A" }; } });
  runRoute({ ...o, type: "summarise", cwd: d, provider: "qwen-code" }, p, { slots: {}, routes: { summarise: [] } });
  runRoute({ ...o, type: "code-edit", cwd: d, provider: "qwen-code" }, p, { slots: {}, routes: { "code-edit": [] } });
  assert.deepEqual(used, ["qwen-code", "qwen-code"]); assert.deepEqual(modes, ["read-only", null]); assert.deepEqual(readdirSync(d), []);
});
test("the Qwen deny settings env var is set only for the read-only launcher", () => {
  const a = ["x", "--read-only", "y"]; assert.equal(takeReadOnlyFlag(a), true); assert.deepEqual(a, ["x", "y"]); assert.equal(takeReadOnlyFlag(a), false);
  assert.equal(qwenEnv({}, true).QWEN_CODE_SYSTEM_SETTINGS_PATH, QWEN_SYSTEM_SETTINGS_RO);
  assert.equal(qwenEnv({}, false).QWEN_CODE_SYSTEM_SETTINGS_PATH, QWEN_SYSTEM_SETTINGS);
  const dir = new URL("../../../config/", import.meta.url);
  const reads = JSON.parse(rfsR5(new URL("claude-clean/readonly-settings.template.json", dir), "utf8")).permissions.deny.filter((d) => d.startsWith("Read("));
  const q = JSON.parse(rfsR5(new URL("qwen/system-settings-readonly.json", dir), "utf8")).permissions.deny;
  for (const r of reads) assert.ok(q.includes(r), r);
  for (const t of ["Write", "Edit", "Task"]) assert.ok(q.includes(t), t); const qa = JSON.parse(rfsR5(new URL("qwen/system-settings-readonly.json", dir), "utf8")).permissions; assert.ok(!qa.deny.includes("run_shell_command") && qa.ask.includes("run_shell_command")); // shell is asked, the hub judges it (readguard commandAllowed)
  assert.equal(JSON.parse(rfsR5(new URL("qwen/system-settings.json", dir), "utf8")).permissions, undefined); // edit tasks keep full tools
});

test("RAM admission: waits with backoff until free RAM clears the floor, then starts; gives up on the entry at waitTimeout", () => {
  let gb = 0.5; const sleeps = []; const f = fake({ run: () => ({ status: "completed", agentId: "A" }) });
  const r = runRoute({ ...o, freeMem: () => gb, sleep: (ms) => { sleeps.push(ms); if (sleeps.length === 3) gb = 3; } }, f, { ...routes, routes: { edit: ["qwen/b"] } });
  assert.equal(r.used, "qwen/b"); assert.deepEqual(sleeps, [2000, 4000, 8000]);
  const f2 = fake({ run: () => ({ status: "completed", agentId: "B" }) });
  const r2 = runRoute({ ...o, waitTimeout: "10s", freeMem: () => 0.5, sleep: () => {} }, f2, { ...routes, routes: { edit: ["qwen/b"] } });
  assert.equal(r2.used, null); assert.match(r2.trace.find((t) => t.skip).skip, /low RAM/); assert.equal(f2.calls.filter((c) => c[0] === "run").length, 0);
  const f3 = fake({ run: () => ({ status: "completed", agentId: "C" }) }); // per-provider floor
  const r3 = runRoute({ ...o, waitTimeout: "2s", freeMem: () => 3, sleep: () => {} }, f3, { ...routes, minFreeRamGbByProvider: { qwen: 6 }, routes: { edit: ["qwen/b"] } });
  assert.equal(r3.used, null);
});

test("markActive sweeps markers older than 30 min and keeps fresh ones", async () => {
  const { mkdtempSync, writeFileSync, utimesSync, existsSync } = await import("node:fs"); const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "sweep-")); const old = join(d, "t-1-1.json"), fresh = join(d, "t-2-2.json");
  writeFileSync(old, "{}"); writeFileSync(fresh, "{}"); const t = (Date.now() - 31 * 60 * 1000) / 1000; utimesSync(old, t, t);
  markActive({ slots: {} }, "a/x", d)();
  assert.equal(existsSync(old), false); assert.equal(existsSync(fresh), true);
});

test("retire removes only the project this route created (not one that existed before, not one with another agent still running there); --keep removes nothing", () => {
  const mk = (before, after, ls = []) => { let n = 0; const calls = [];
    const f = (a) => { calls.push(a); if (a[0] === "project" && a[1] === "ls") return n++ === 0 ? before : after; if (a[0] === "ls") return ls; if (a[0] === "worktree" && a[1] === "create") return { name: "wt-x", worktreePath: "/wt/x" }; return a[0] === "run" ? { status: "completed", agentId: "A" } : {}; };
    f.calls = calls; return f; };
  const del = (f) => f.calls.filter((c) => c[0] === "project" && c[1] === "delete").map((c) => c[2]);
  const mine = { projectId: "P2", path: "c:/r/" }, wtp = { projectId: "P3", path: "/wt/x" }, old = { projectId: "P1", path: "/r" };
  const f1 = mk([old], [old, mine, wtp]); runRoute({ ...o, cwd: "C:/r", worktree: true, base: "a".repeat(40) }, f1, { ...routes, routes: { edit: ["qwen/b"] } });
  assert.deepEqual(del(f1).sort(), ["P2", "P3"]);
  const f2 = mk([{ projectId: "P2", path: "C:/r" }], [{ projectId: "P2", path: "C:/r" }]); runRoute({ ...o, cwd: "C:/r" }, f2, { ...routes, routes: { edit: ["qwen/b"] } });
  assert.deepEqual(del(f2), [], "existed before: kept");
  const f3 = mk([], [mine], [{ status: "running", cwd: "C:/r", id: "other" }]); runRoute({ ...o, cwd: "C:/r" }, f3, { ...routes, routes: { edit: ["qwen/b"] } });
  assert.deepEqual(del(f3), [], "another agent still runs there: kept");
  const f4 = mk([], [mine]); runRoute({ ...o, cwd: "C:/r", keep: true }, f4, { ...routes, routes: { edit: ["qwen/b"] } });
  assert.deepEqual(del(f4), [], "--keep");
});

test("round 7: a hung `paseo logs` is killed after the logs timeout, retried once, then reported unreadable", () => {
  const calls = [];
  const spawn = (_c, args, o) => { calls.push(o.timeout); return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }; };
  const r = cliPaseo(undefined, { PASEO_BIN: "paseo", AGENT_HUB_LOGS_TIMEOUT_S: "7" }, spawn)(["logs", "A"]);
  assert.deepEqual(calls, [7000, 7000]); assert.match(r.error, /hung and was killed/);
  assert.ok(!transient(r), "not retried by withRetry");
  const calls2 = []; const hang = (_c, a, o) => { calls2.push(o.timeout); return { status: 0, stdout: "{}" }; };
  cliPaseo(undefined, { PASEO_BIN: "paseo" }, hang)(["ls"]); cliPaseo(undefined, { PASEO_BIN: "paseo" }, hang)(["logs", "A"]);
  assert.deepEqual(calls2, [120000, 30000]);
  // first call hangs, retry answers: the text comes back
  let n = 0; const flaky = () => (++n === 1 ? { error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }), stdout: "" } : { status: 0, stdout: "hello" });
  assert.deepEqual(cliPaseo(undefined, { PASEO_BIN: "paseo" }, flaky)(["logs", "A"]), { text: "hello" });
  const w = withAnswer({ agentId: "A" }, cliPaseo(undefined, { PASEO_BIN: "paseo" }, spawn), 0);
  assert.equal(w.answer, ""); assert.match(w.answerReason, /logs unreadable/);
});

import { inputError, AGENT_ID_RE } from "../route.mjs";
import { writeJsonKeepEol } from "../jsonfile.mjs";
test("round 9: every CLI value that becomes a path, label or paseo argument is allow-listed", () => {
  const ok = { type: "summarise", provider: "qwen-code-2/x", cwd: "C:/work/a", home: "C:/Users/me/.paseo", mode: "plan", session: "fix-r7", dev: "me@pc", client: "claude" };
  assert.equal(inputError(ok), null); assert.equal(inputError({}), null);
  const BSL = String.fromCharCode(92), NL = String.fromCharCode(10);
  for (const [k, vals] of Object.entries({ type: ["", "A b", "x;y", "--help", "a/b"], provider: ["--x", "a b", "a" + NL + "b", "../x", ""], mode: ["--x", "a b", "x" + NL], session: ["--x", "a b", "a/../b", "x" + NL, "a".repeat(65)], dev: ["-x", "a b", "a=b"], client: ["-x", "a;b"], cwd: ["-x", "a" + NL + "b", ""], home: ["-x", "a" + String.fromCharCode(0)] }))
    for (const v of vals) assert.match(inputError({ ...ok, [k]: v }) ?? "", new RegExp("invalid " + k), k + " " + JSON.stringify(v));
  assert.ok(AGENT_ID_RE.test("0a1b2c3d-4e5f-6789-abcd-ef0123456789")); assert.ok(!AGENT_ID_RE.test(".." + BSL + "x"));
  const r = runRoute({ type: "summarise", prompt: "p", session: "bad id", cwd: "/r" }, () => { throw new Error("must not be called"); }, { routes: { summarise: ["qwen"] } });
  assert.equal(r.status, "error"); assert.match(r.trace[0].error, /invalid session/);
});
test("round 9: grantReads answers only the route's own agent, only reads inside scope, never another agent's request", () => {
  const { d, cwd } = sandbox(); const inC = j2(cwd, "app.log");
  const log = []; const pend = [{ id: "1", agentId: "OTHER", name: "read", kind: "read", paths: [inC] }, { id: "2", agentId: "A", name: "read", kind: "read", paths: [inC] }];
  grantReads(permFake(pend, log), { agentId: "A", status: "permission" }, 60, { cwd });
  const permits = log.filter((c) => c[0] === "permit");
  assert.deepEqual(permits, [["permit", "allow", "A", "2"]]);
});
test("round 9: JSON config writes keep the file's line endings", () => {
  const CR = String.fromCharCode(13, 10), t = mk2(j2(tmpdir(), "eol-"));
  const f = j2(t, "c.json"); wf2(f, "{" + CR + '  "a": 1' + CR + "}" + CR);
  writeJsonKeepEol(f, { a: 2 }); assert.equal(readFileSync(f, "utf8"), "{" + CR + '  "a": 2' + CR + "}" + CR);
  const g = j2(t, "n.json"); writeJsonKeepEol(g, { a: 1 }); assert.ok(!readFileSync(g, "utf8").includes(CR));
  const oc = j2(t, "oc.json"); wf2(oc, JSON.stringify({ model: "office/A", provider: { office: { models: { A: { name: "A" } } } } }, null, 2).split(String.fromCharCode(10)).join(CR) + CR);
  assert.equal(syncOpencode(oc, "B"), true); assert.ok(readFileSync(oc, "utf8").includes(CR));
});

import { providerState, slotInfo } from "../route.mjs";
import { mkdtempSync as mkdSt, readFileSync as rdSt } from "node:fs";
import { join as joSt } from "node:path";
test("a disabled provider is skipped with a trace entry and drops out of total.json", () => {
  const rows = [{ provider: "codex", status: "available", enabled: "Disabled" }, { provider: "qwen", status: "available", enabled: "Enabled" }];
  const p = fake({ run: () => ({ status: "completed", agentId: "A9" }) });
  const q = (a) => (a[0] === "provider" && a[1] === "ls" ? rows : p(a));
  const rt = { ...routes, slots: { codex: 2, qwen: 3 } };
  const r = runRoute(o, q, rt);
  assert.equal(r.used, "qwen/b");
  assert.match(r.trace[0].skip, /disabled or unavailable/);
  assert.ok(!p.calls.some((c) => c[0] === "run" && c.includes("codex/a")));
  const st = providerState(q);
  assert.equal(st.get("codex"), false);
  assert.equal(slotInfo(rt, st).total, 3);
  assert.equal(slotInfo(rt, null).total, 5);
  const dir = mkdSt(joSt(tmpdir(), "ahub-active-")); markActive(rt, null, dir, st);
  assert.deepEqual(JSON.parse(rdSt(joSt(dir, "total.json"), "utf8")).providers.codex, { slots: 2, enabled: false, effective: 0 });
});

import { claimSlot, setMarker } from "../route.mjs";
test("claimSlot: simultaneous routes cannot all take one provider; the rest stay queued (provider null)", () => {
  const dir = mkdSt(joSt(tmpdir(), "ahub-claim-"));
  const rt = { slots: { codex: 2 } };
  const ms = [1, 2, 3].map((i) => { const un = markActive(rt, null, dir, null); return un; });
  // markers are created in one ms: make their stamps distinct and ordered
  const ordered = ms.map((u, i) => { const f = joSt(dir, `t-${process.pid}-${1000 + i}.json`); u(); writeFileSync(f, JSON.stringify({ provider: null, state: "queued" })); const un = () => {}; un.file = f; un.dir = dir; return un; });
  assert.deepEqual(ordered.map((u) => claimSlot(u, "codex", 2)), [true, true, false]);
  assert.equal(JSON.parse(rdSt(ordered[2].file, "utf8")).provider, null);
  assert.equal(JSON.parse(rdSt(ordered[0].file, "utf8")).provider, "codex");
  setMarker(ordered[0], null); // a route that gave its slot back lets the queued one in
  assert.equal(claimSlot(ordered[2], "codex", 2), true);
});

test("claimSlot: a marker of a dead route holds no slot", () => {
  const dir = mkdSt(joSt(tmpdir(), "ahub-claim-dead-"));
  const dead = joSt(dir, "t-2147483646-1000.json"); writeFileSync(dead, JSON.stringify({ provider: "laptop", state: "run" }));
  const mine = joSt(dir, `t-${process.pid}-2000.json`); writeFileSync(mine, JSON.stringify({ provider: null, state: "queued" }));
  const un = () => {}; un.file = mine; un.dir = dir;
  assert.equal(claimSlot(un, "laptop", 1), true);
});

import { sessionFromEnv } from "../route.mjs";
test("session falls back from AGENT_HUB_SESSION to CLAUDE_CODE_SESSION_ID, else none", () => {
  assert.equal(sessionFromEnv({ AGENT_HUB_SESSION: "a", CLAUDE_CODE_SESSION_ID: "b" }), "a");
  assert.equal(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: "b" }), "b");
  assert.equal(sessionFromEnv({}), undefined);
});

test("stopReason: a launcher refusal in the agent log becomes the trace reason; no log gives an honest fallback", () => {
  const log = "[User] q\n[System Error] ACP agent exited unexpectedly (3)\n\nWarning: MCP server(s) failed to start: agent-hub. Continuing.\nLAPTOP-REFUSED: free RAM 2.7 GB < 3\n";
  assert.equal(stopReason({ status: "error", agentId: "A" }, () => ({ text: log })), "agent stopped (error): LAPTOP-REFUSED: free RAM 2.7 GB < 3");
  assert.match(stopReason({ status: "error", agentId: "A" }, () => ({ error: "x" })), /no reason: see `paseo logs A`/);
  assert.match(stopReason({ status: "error" }, () => ({})), /no reason/);
});
test("a trace entry of a failed run always carries an error reason (status error from the daemon, reason only in the log)", () => {
  const p = fake({ run: () => ({ status: "error", agentId: "E" }), logs: "[System Error] ACP agent exited unexpectedly (3)\nLAPTOP-REFUSED: heavy-run lock present\n" });
  const r = runRoute({ ...o, provider: "qwen/b" }, (a) => (a[0] === "logs" ? { text: "[System Error] x\nLAPTOP-REFUSED: heavy-run lock present\n" } : p(a)), routes);
  assert.equal(r.used, null);
  assert.equal(r.trace[0].error, "agent stopped (error): LAPTOP-REFUSED: heavy-run lock present");
});
test("unusableAnswer: empty and short refusals are unusable, a real answer and a long text are not", () => {
  assert.match(unusableAnswer(""), /empty/);
  assert.match(unusableAnswer("I cannot complete this task. I am Qwen Code, an interactive CLI agent"), /refused/);
  assert.equal(unusableAnswer("epsilon"), "");
  assert.equal(unusableAnswer("I cannot stress enough " + "x".repeat(700)), "");
});
test("read-only route: an empty or refusing answer falls through to the next entry; the next entry's answer wins; edit types are not judged", () => {
  const r2 = { readOnlyEnforced: ALL, readOnlyModes: { qwen: "read-only" }, slots: {}, routes: { summarise: ["qwen/a", "qwen/b"], edit: ["qwen/a", "qwen/b"] } };
  for (const bad of ["", "I cannot complete this task. I am Qwen Code."]) {
    const texts = { A1: bad, A2: "epsilon" }; let n = 0;
    const p = (a) => a[0] === "ls" ? [] : a[0] === "run" ? { status: "completed", agentId: "A" + ++n } : a[0] === "logs" ? { text: (a.includes("--filter") ? "" : "[User] q\n") + texts[a[1]] + "\n" } : {};
    const r = runRoute({ ...o, type: "summarise", cwd: privDir() }, p, r2);
    assert.equal(r.used, "qwen/b"); assert.equal(r.answer, "epsilon");
    assert.match(r.trace.find((t) => t.error).error, /next provider tried/);
  }
  let n = 0; const p = (a) => a[0] === "ls" ? [] : a[0] === "run" ? { status: "completed", agentId: "E" + ++n } : a[0] === "logs" ? { text: "" } : {};
  assert.equal(runRoute({ ...o, type: "edit", cwd: privDir(), noAsk: true }, p, r2).used, "qwen/a", "an edit with no answer text is still a result");
});
test("read-only task on a Qwen-style provider gets the open-the-file reminder; an edit task and a Claude provider get the prompt unchanged", () => {
  const r2 = { readOnlyEnforced: ALL, readOnlyModes: { qwen: "read-only" }, slots: {}, routes: { summarise: ["qwen/a"] } };
  const p = fake({ run: () => ({ status: "completed", agentId: "A" }), logs: "" });
  runRoute({ ...o, type: "summarise", prompt: "read x", cwd: privDir(), provider: "qwen-code" }, p, r2);
  const run = p.calls.find((c) => c[0] === "run"); assert.equal(run.at(-1), "read x" + READ_FIRST);
  const q = fake({ run: () => ({ status: "completed", agentId: "A" }) });
  runRoute({ ...o, prompt: "edit y" }, q, routes);
  assert.equal(q.calls.find((c) => c[0] === "run").at(-1), "edit y");
});

test("timeouts: review and summarise get an 8 min attempt limit by default, routes.timeouts.<type> overrides, an explicit waitTimeout wins", async () => {
  const { attemptLimit } = await import("../route.mjs");
  assert.equal(attemptLimit({ type: "review" }, {}), 480); assert.equal(attemptLimit({ type: "summarise" }, { waitTimeout: "30m" }), 480);
  assert.equal(attemptLimit({ type: "code-edit" }, {}), 600); assert.equal(attemptLimit({ type: "code-edit" }, { waitTimeout: "30m" }), 1800);
  assert.equal(attemptLimit({ type: "review" }, { timeouts: { review: "3m" } }), 180); assert.equal(attemptLimit({ type: "review", waitTimeout: "90s" }, { timeouts: { review: "3m" } }), 90);
});
test("a read-only attempt that gets no answer in its limit fails with a plain reason and the chain moves on; the run call is bounded", () => {
  let clock = 0; const calls = []; const runs = [];
  const paseo = (a, opts) => { calls.push([a, opts]); if (a[0] === "run") { runs.push(a[a.indexOf("--provider") + 1]); clock += runs.length === 1 ? 481_000 : 5_000; return runs.length === 1 ? { agentId: "H1", status: "running" } : { agentId: "H2", status: "completed" }; } if (a[0] === "wait") return { status: "timeout" }; if (a[0] === "logs") return { text: "answer text" }; if (a[0] === "provider") return [{ provider: "qwen-code" }, { provider: "claude-clean" }]; return a[0] === "ls" ? [] : {}; };
  const r = runRoute({ type: "review", prompt: "p", cwd: privDir(), session: "s", now: () => clock, providerState: new Map([["qwen-code", true], ["claude-clean", true]]) }, paseo, { readOnlyModes: {}, routes: { review: ["qwen-code", "claude-clean"] } });
  assert.match(r.trace[0].error, /^no answer in 8 min/); assert.equal(runs.length, 2); assert.equal(r.used, "claude-clean");
  const run1 = calls.find(([a]) => a[0] === "run"); assert.equal(run1[0][run1[0].indexOf("--wait-timeout") + 1], "480s"); assert.equal(run1[1].timeoutMs, 90_000, "the create call is bounded by the start limit (90 s), not by the 8 min attempt limit");
});
test("a create call that times out is retried with backoff (HUBFIX3): fails twice, works on the third, the trace says how many tries and seconds each", async () => {
  const { startLimitS, createRetries } = await import("../route.mjs");
  assert.equal(startLimitS({}), 90); assert.equal(startLimitS({ startTimeout: "20s" }), 20); assert.equal(startLimitS({ startTimeout: "20s" }, { AGENT_HUB_START_TIMEOUT: "5s" }), 5);
  assert.equal(createRetries({}, {}), 2); assert.equal(createRetries({ createRetries: 0 }, {}), 0);
  let clock = 0; const runs = [], sleeps = [], archived = [];
  const paseo = (a, opts) => { if (a[0] === "run") { runs.push(opts?.timeoutMs); clock += 20_000; return runs.length < 3 ? { error: "no answer in 20 s: the call was stopped" } : { agentId: "H3", status: "completed" }; } if (a[0] === "ls") return a.includes("--label") ? [{ id: "GHOST" + runs.length }] : []; if (a[0] === "archive") { archived.push(a[1]); return {}; } if (a[0] === "logs") return { text: "answer text" }; if (a[0] === "provider") return [{ provider: "qwen-code" }, { provider: "claude-clean" }]; return {}; };
  const r = runRoute({ type: "review", prompt: "p", cwd: privDir(), session: "s", now: () => clock, sleep: (ms) => sleeps.push(ms), providerState: new Map([["qwen-code", true], ["claude-clean", true]]) }, paseo, { startTimeout: "20s", readOnlyModes: {}, routes: { review: ["qwen-code", "claude-clean"] } });
  assert.equal(r.used, "qwen-code"); assert.equal(runs.length, 3); assert.equal(runs[0], 20_000, "start-bound call");
  assert.deepEqual(sleeps, [5000, 10000], "backoff doubles");
  assert.ok(archived.includes("GHOST1") && archived.includes("GHOST2"), "the half-made agent of each failed try is archived before the next");
});
test("a create that keeps timing out is tried 3 times, then the NEXT provider is tried (HUBFIX3), and the trace carries createTries", () => {
  let clock = 0; const runs = [];
  const paseo = (a) => { if (a[0] === "run") { const p = a[a.indexOf("--provider") + 1]; runs.push(p); clock += 5_000; return p === "qwen-code" ? { error: "no answer in 20 s: the call was stopped" } : { agentId: "H2", status: "completed" }; } if (a[0] === "logs") return { text: "answer text" }; if (a[0] === "provider") return [{ provider: "qwen-code" }, { provider: "claude-clean" }]; return a[0] === "ls" ? [] : {}; };
  const r = runRoute({ type: "review", prompt: "p", cwd: privDir(), session: "s", now: () => clock, sleep: () => {}, providerState: new Map([["qwen-code", true], ["claude-clean", true]]) }, paseo, { startTimeout: "20s", readOnlyModes: {}, routes: { review: ["qwen-code", "claude-clean"] } });
  assert.deepEqual(runs, ["qwen-code", "qwen-code", "qwen-code", "claude-clean"]); assert.equal(r.used, "claude-clean");
  assert.match(r.trace[0].error, /^CREATE_TIMEOUT.*3 time/); assert.equal(r.trace[0].createTries.length, 3); assert.equal(r.trace[0].createTries[0].seconds, 5);
});
test("a provider paseo reports as disabled, unavailable or error is skipped in under 2 s, never claims a slot and never starts a CLI", () => {
  const rows = [{ provider: "qwen-code", status: "unavailable", enabled: "Disabled" }, { provider: "qwen-code-2", status: "unavailable", enabled: "Enabled" }, { provider: "qwen-code-3", status: "error", enabled: "Enabled" }, { provider: "claude-clean", status: "available", enabled: "Enabled" }];
  const calls = []; const paseo = (a) => { calls.push(a); if (a[0] === "run") return { agentId: "H2", status: "completed" }; if (a[0] === "logs") return { text: "answer text" }; if (a[0] === "provider") return rows; return a[0] === "ls" ? [] : {}; };
  const mdir = mkdtempSync(join(tmpdir(), "mk-")); const marker = { file: join(mdir, "t-" + process.pid + "-1.json"), dir: mdir }; const t = Date.now();
  // the config file says every one of them is enabled: the daemon's report still wins
  const state = providerState(paseo, { agents: { providers: { "qwen-code": { enabled: true }, "qwen-code-2": { enabled: true }, "qwen-code-3": { enabled: true } } } });
  const r = runRoute({ type: "review", prompt: "p", cwd: privDir(), session: "s", marker, providerState: state }, paseo, { slots: { "qwen-code": 1, "qwen-code-2": 1, "qwen-code-3": 1, "claude-clean": 1 }, readOnlyModes: {}, routes: { review: ["qwen-code", "qwen-code-2", "qwen-code-3", "claude-clean"] } });
  assert.ok(Date.now() - t < 2000); assert.equal(r.used, "claude-clean", JSON.stringify(r.trace));
  assert.deepEqual(r.trace.slice(0, 3).map((x) => /disabled or unavailable/.test(x.skip)), [true, true, true]);
  assert.deepEqual(calls.filter((c) => c[0] === "run").map((c) => c[c.indexOf("--provider") + 1]), ["claude-clean"], "only the healthy provider was ever started");
});
test("providerState cache: one `provider ls` per 15 s across processes, a failed read is never cached", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pc-")), "c.json"); let n = 0; let t = 1000; const ls = () => { n++; return [{ provider: "a", status: "available", enabled: "Enabled" }]; };
  providerState(ls, {}, { file, now: () => t }); providerState(ls, {}, { file, now: () => t + 14_000 }); assert.equal(n, 1);
  providerState(ls, {}, { file, now: () => t + 16_000 }); assert.equal(n, 2);
  const f2 = join(mkdtempSync(join(tmpdir(), "pc-")), "c.json"); let m = 0; const bad = () => { m++; return { error: "daemon down" }; };
  assert.equal(providerState(bad, {}, { file: f2 }), null); providerState(bad, {}, { file: f2 }); assert.equal(m, 2);
});
test("a laptop-hosted model that is refused for low RAM is skipped at once, not waited for", () => {
  let slept = 0; const runs = [];
  const paseo = (a) => { if (a[0] === "run") { runs.push(a[a.indexOf("--provider") + 1]); return { agentId: "A", status: "completed" }; } return a[0] === "logs" ? { text: "ok" } : a[0] === "ls" ? [] : {}; };
  const r = runRoute({ type: "review", prompt: "p", cwd: privDir(), session: "s", freeMem: () => 1, laptop: () => ({ freeGb: 8, cpuPct: 0 }), sleep: () => { slept++; }, providerState: new Map([["qwen-laptop", true], ["claude-clean", true]]) }, paseo, { slots: { "qwen-laptop": 1, "claude-clean": 2 }, minFreeRamGbByProvider: { "claude-clean": 0.5 }, routes: { review: ["qwen-laptop", "claude-clean"] } });
  assert.equal(slept, 0); assert.match(r.trace[0].skip, /^low RAM.*skipped at once/); assert.deepEqual(runs, ["claude-clean"]);
});

test('a known-down endpoint is skipped at once with a one-line reason, and a failed create reads as one plain line', async () => {
  const { endpointSkip } = await import('../endpoint.mjs');
  const { plainError, providerState, transient } = await import('../route.mjs');
  const cfg = { agents: { providers: { 'q-a': { command: ['node', 'x.mjs', 'http://127.0.0.1:1/v1', 'm'] } } } };
  assert.equal(endpointSkip('q-a', cfg, () => null), null);
  assert.match(endpointSkip('q-a', cfg, () => 'Not answering (checked 20:33): nothing is listening there'), /^endpoint not answering \(checked 20:33\): nothing is listening there; skipped/);
  assert.equal(endpointSkip('codex', cfg, () => 'down'), null, 'a provider with no endpoint is never probed');
  const raw = 'exit=1 Created workspace wks_a1 - master\nTip: pass --workspace <id>\n{ "error": { "code": "AGENT_CREATE_FAILED", "message": "Failed to create agent: ACP agent process exited before initialization completed (exit code 75)\nNot answering (checked 20:33): nothing is listening there" } }';
  assert.equal(plainError(raw), 'could not start: endpoint not answering (checked 20:33): nothing is listening there');
  assert.equal(transient({ error: raw }), false, 'a process that exited at start is not retried for two minutes');
  const calls = []; const r = runRoute({ type: 'summarise', prompt: 'p', cwd: '/r', session: 's', endpointDown: (id) => (id === 'dead' ? 'endpoint not answering: x' : null), providerState: new Map([['dead', true], ['live', true]]) },
    (a) => { calls.push(a[0]); if (a[0] === 'run') return { status: 'completed', agentId: 'A1' }; return a[0] === 'ls' ? [] : a[0] === 'logs' ? 'answer text here' : {}; }, { slots: { dead: 1, live: 1 }, routes: { summarise: ['dead/m', 'live/m'] }, readOnlyEnforced: ['dead', 'live'], readOnlyModes: { dead: 'read-only', live: 'read-only' } });
  assert.match(r.trace[0].skip, /endpoint not answering/); assert.equal(r.trace[0].provider, 'dead/m');
  // the config file's switch can only turn a provider OFF; what the daemon reports (disabled, unavailable, error) is never overridden by it (13-11: laptop Qwen, config enabled, paseo unavailable, held a route 8 min)
  const ls = () => [{ provider: 'a', enabled: 'Enabled', status: 'available' }, { provider: 'b', enabled: 'Enabled', status: 'available' }, { provider: 'c', enabled: 'Disabled', status: 'unavailable' }, { provider: 'd', enabled: 'Enabled', status: 'unavailable' }, { provider: 'e', enabled: 'Enabled', status: 'error' }];
  assert.deepEqual([...providerState(ls, { agents: { providers: { a: { enabled: false }, c: { enabled: true } } } })], [['a', false], ['b', true], ['c', false], ['d', false], ['e', false]]);
  assert.deepEqual([...providerState(ls)], [['a', true], ['b', true], ['c', false], ['d', false], ['e', false]]);
});

test('the per-attempt time limit covers the RAM wait: what is left of it is all the agent gets', () => {
  let t = 0; const waits = [];
  const p = (a) => { if (a[0] === "run") { waits.push(a[a.indexOf("--wait-timeout") + 1]); return { status: "completed", agentId: "A1" }; } return a[0] === "ls" ? [] : a[0] === "logs" ? "an answer" : {}; };
  const r = runRoute({ type: "summarise", prompt: "p", cwd: "/r", session: "s", waitTimeout: "20s", now: () => t, sleep: (ms) => { t += ms; }, freeMem: () => (t < 9000 ? 0.1 : 8), providerState: new Map([["qwen-code", true]]) },
    p, { slots: { "qwen-code": 1 }, routes: { summarise: ["qwen-code/m"] }, minFreeRamGb: 1, readOnlyEnforced: ["qwen-code"], readOnlyModes: { "qwen-code": "read-only" } });
  assert.equal(r.used, "qwen-code/m");
  assert.ok(t >= 9000 && Number(waits[0].replace("s", "")) <= 11, `waited ${t} ms for RAM, then the agent got ${waits[0]} of the 20 s`);
});

test("a plain run gets its own workspace (--workspace) and archives exactly that id after its agent", () => {
  const calls = [];
  const p = (args) => { calls.push(args); return args[0] === "workspace" && args[1] === "create" ? { workspaceId: "wks_mine" } : args[0] === "ls" ? [] : args[0] === "run" ? { status: "completed", agentId: "A9" } : {}; };
  const r = runRoute({ ...o, provider: "qwen/z" }, p, routes);
  assert.equal(r.used, "qwen/z");
  const run = calls.find((c) => c[0] === "run");
  assert.equal(run[run.indexOf("--workspace") + 1], "wks_mine");
  const ia = calls.findIndex((c) => c[0] === "archive" && c[1] === "A9"), iw = calls.findIndex((c) => c[0] === "workspace" && c[1] === "archive");
  assert.ok(ia >= 0 && iw > ia); assert.equal(calls[iw][2], "wks_mine");
});
test("a run that made no agent archives its workspace at once", () => {
  const calls = [];
  const p = (args) => { calls.push(args); return args[0] === "workspace" && args[1] === "create" ? { workspaceId: "wks_x" } : args[0] === "ls" ? [] : args[0] === "run" ? { status: "error", error: "boom" } : {}; };
  runRoute({ ...o, provider: "qwen/z" }, p, routes);
  assert.ok(calls.some((c) => c[0] === "workspace" && c[1] === "archive" && c[2] === "wks_x"));
});
test("readguard shell: grep/sed -n/head/tail/ls/find on in-cwd files pass; rm, redirects, curl, chaining, recursion, -exec/-delete and sensitive files are refused", () => {
  const { cwd } = sandbox();
  const sh = (command) => batchAllowed([{ name: "execute", kind: "execute", paths: [], command }], [cwd]).ok;
  for (const c of ["grep -n foo app.log", "grep -n foo app.log | head -20", "rg foo app.log", "sed -n 5,9p app.log", "head -n 5 app.log", "tail -20 app.log", "cat app.log", "wc -l app.log", "ls", "find . -name app.log"]) assert.equal(sh(c), true, c);
  for (const c of ["rm app.log", "cat app.log > out", "curl http://x", "grep x app.log; rm app.log", "grep -rn x .", "rg x", "find . -delete", "find . -exec cat {} +", "sed -i s/a/b/ app.log", "grep x app.log | tee o", "cat " + CRED, "cat .env", "cat server.pem", "cat ../x", "cat $(echo app.log)", "grep x app.log && ls"]) assert.equal(sh(c), false, c);
  assert.equal(batchAllowed([{ name: "execute", kind: "execute", paths: [] }], [cwd]).ok, false); // no command
  assert.equal(normalise({ permissions: [{ agentId: "A", request: { id: "R", name: "execute", metadata: { rawRequest: { toolCall: { kind: "execute", rawInput: { command: "grep a b" } } } } } }] })[0].command, "grep a b");
});
test("readguard shell: quoted grep patterns pass, quoted tricks are refused", () => {
  const { cwd } = sandbox();
  const sh = (command) => batchAllowed([{ name: "execute", kind: "execute", paths: [], command }], [cwd]).ok;
  for (const c of ["grep -n \"create-action/editor\" app.log", "grep -n 'a.*b' app.log | head -5", "grep -E \"a|b\" app.log", "grep -n \"foo\" \"app.log\""]) assert.equal(sh(c), true, c);
  for (const c of ["grep \"$(rm app.log)\" app.log", "grep \"`id`\" app.log", "grep \"a\" app.log \"; rm x\"", "cat \"" + CRED + "\"", "grep 'a' app.log | rm x", "grep \"a app.log", "grep a app.log ||"]) assert.equal(sh(c), false, c);
});
test("readguard shell: Windows type/dir on in-cwd files pass; findstr, /S, /G:, redirects and sensitive files are refused", () => {
  const { cwd } = sandbox();
  const sh = (command) => batchAllowed([{ name: "execute", kind: "execute", paths: [], command }], [cwd]).ok;
  for (const c of ["type app.log", "dir"]) assert.equal(sh(c), true, c);
  for (const c of ["findstr /N foo app.log", "findstr foo " + CRED, "type " + CRED, "dir /S", "findstr foo app.log > x", "findstr foo app.log 2>nul"]) assert.equal(sh(c), false, c);
});

// ---- readguard hardening (security review of a1a33c3): strict flag allowlist, no sort/uniq, exact sed, restricted find, request cwd ----
test("readguard hardening: good read-only commands still pass", () => {
  const { cwd } = sandbox(); md2(j2(cwd, "sub")); wf2(j2(cwd, "sub", "leaf.txt"), "x");
  const sh = (command, c) => batchAllowed([{ name: "execute", kind: "execute", paths: [], command, ...(c ? { cwd: c } : {}) }], [cwd]).ok;
  for (const c of ["grep -n foo app.log", "grep -niE foo app.log", "grep -A 2 -B2 -m 5 foo app.log", "grep -C3 foo app.log | head -n 5", "rg -n foo app.log", "sed -n 10,20p app.log", "sed -n 7p app.log", "head -n 50 app.log", "head -5 app.log", "tail -n 20 app.log | wc -l", "wc -lw app.log", "cat app.log", "type app.log", "ls", "ls -l", "dir", "find . -name app.log", "find . -type f -maxdepth 2 -iname app.log", "find . -path ./sub/leaf.txt"]) assert.equal(sh(c), true, c);
  assert.equal(sh("cat leaf.txt", j2(cwd, "sub")), true, "a relative file resolves against the request directory");
  assert.equal(sh("cat app.log", cwd), true);
});
test("readguard hardening 1: grep/rg/findstr/head/tail/wc/ls/cat flags are an allowlist (-d recurse, --directories=, --dereference*, -R/-r clusters, -f/-e/-o files, ls -R)", () => {
  const { cwd } = sandbox(); wf2(j2(cwd, "recurse"), "x");
  const sh = (command) => batchAllowed([{ name: "execute", kind: "execute", paths: [], command }], [cwd]).ok;
  for (const c of ["grep -d recurse recurse app.log", "grep --directories=recurse foo app.log", "grep --directories recurse foo app.log", "grep --dereference-recursive foo app.log", "grep --dereference foo app.log", "grep -nr foo app.log", "grep -nR foo app.log", "grep -nd foo app.log", "grep -D read foo app.log", "grep -f app.log foo app.log", "grep -e foo app.log", "grep -z foo app.log", "grep --include=x foo app.log", "grep -- foo app.log", "rg -L foo app.log", "rg --follow foo app.log", "rg --files app.log", "rg -z foo app.log", "rg -r x foo app.log", "head -c 5 app.log", "head -f app.log", "tail -f app.log", "tail --follow app.log", "head -n 5x app.log", "wc -L app.log", "wc --files0-from=app.log", "ls -R", "ls -lR", "ls --recursive", "dir /S", "cat -n app.log", "cat --help", "type /S app.log"]) assert.equal(sh(c), false, c);
});
test("readguard hardening 2: sort and uniq are not read commands (-o/--output/--compress-program/--files0-from/-T write or run things)", () => {
  const { cwd } = sandbox();
  const sh = (command) => batchAllowed([{ name: "execute", kind: "execute", paths: [], command }], [cwd]).ok;
  for (const c of ["sort app.log", "sort -o app.log app.log", "sort --output=app.log app.log", "sort --compress-program=x app.log", "sort --files0-from=app.log", "sort -T . app.log", "uniq app.log", "uniq app.log out", "grep foo app.log | sort", "grep foo app.log | sort -o x", "grep foo app.log | uniq", "cat app.log | cut -f1", "cat app.log | nl"]) assert.equal(sh(c), false, c);
});
test("readguard hardening 3: sed only as `sed -n N[,M]p FILE`; any other flag, -i*, --in-place*, -E, extra file or script is refused", () => {
  const { cwd } = sandbox();
  const sh = (command) => batchAllowed([{ name: "execute", kind: "execute", paths: [], command }], [cwd]).ok;
  for (const c of ["sed -n 5p -E app.log", "sed -n 5p app.log app.log", "sed -n 5p -i app.log", "sed -n 5p -ibak app.log", "sed -n 5p --in-place app.log", "sed -n 5p --in-place=.b app.log", "sed -n 5p -s app.log", "sed -n 5p --debug app.log", "sed -i 5p app.log", "sed -ni 5p app.log", "sed -n 5w app.log", "sed -n 5p", "sed 5p app.log", "grep foo app.log | sed -n 5p"]) assert.equal(sh(c), false, c);
});
test("readguard hardening 4: find refuses -H -L -P -follow and every action but -name/-iname/-type/-maxdepth/-path; paths before the expression are checked", () => {
  const { cwd, d } = sandbox();
  const sh = (command) => batchAllowed([{ name: "execute", kind: "execute", paths: [], command }], [cwd]).ok;
  for (const c of ["find -H . -name app.log", "find -L . -name app.log", "find -P . -name app.log", "find . -follow -name app.log", "find . -name app.log -follow", "find . -ls", "find . -name app.log -print0", "find . -name app.log -fprint o", "find . -fprintf o x", "find . -type f -newer app.log", "find . -name app.log -delete", "find . -name app.log -exec cat x", "find . -type x", "find . -maxdepth x", "find . -name", "find ../outside -name data.txt", "find " + j2(d, "outside") + " -name data.txt", "find . /etc -name x", "find . -name app.log -o -name x"]) assert.equal(sh(c), false, c);
});
test("readguard hardening 5: a shell request's own working directory must be the task cwd or inside it; relative files resolve against it and are path-checked", () => {
  const { cwd, d } = sandbox(); md2(j2(cwd, "sub")); wf2(j2(cwd, "sub", "leaf.txt"), "x"); wf2(j2(d, "outside", "app.log"), "x"); wf2(j2(d, "outside", "ok.txt"), "x");
  const sh = (command, c) => batchAllowed([{ name: "execute", kind: "execute", paths: [], command, cwd: c }], [cwd]).ok;
  assert.equal(sh("cat app.log", j2(d, "outside")), false, "cwd outside the task folder");
  assert.equal(sh("cat ok.txt", j2(d, "outside")), false);
  assert.equal(sh("ls", j2(d, "outside")), false);
  assert.equal(sh("find . -name app.log", j2(d, "outside")), false);
  assert.equal(sh("cat app.log", ".."), false, "relative cwd that escapes");
  assert.equal(sh("cat app.log", 5), false, "non-string cwd");
  assert.equal(sh("cat .env", cwd), false, "sensitive file still refused with an explicit cwd");
  assert.equal(sh("cat leaf.txt", j2(cwd, ".hidden")), false, "dot-folder cwd");
  assert.equal(sh("cat app.log", j2(cwd, "sub")), false, "app.log is not in sub");
  assert.equal(sh("cat leaf.txt", j2(cwd, "sub")), true);
  const n = (rawInput) => normalise({ permissions: [{ agentId: "A", request: { id: "R", name: "execute", metadata: { rawRequest: { toolCall: { kind: "execute", rawInput } } } } }] })[0];
  for (const k of ["directory", "dir_path", "cwd"]) assert.deepEqual(n({ command: "cat a", [k]: "/w/x" }).cwds, ["/w/x"], k);
  assert.equal(n({ command: "cat a" }).cwds, undefined);
});

// ---- readguard hardening 2 (security review of 7826e17) ----
test("hardening2 1: pending collects EVERY directory field; the guard refuses when any is outside the task cwd or they differ", () => {
  const { cwd, d } = sandbox(); md2(j2(cwd, "sub")); wf2(j2(cwd, "sub", "leaf.txt"), "x"); wf2(j2(d, "outside", "ok.txt"), "x");
  const n = (rawInput, tcx = {}) => normalise({ permissions: [{ agentId: "A", request: { id: "R", name: "execute", metadata: { rawRequest: { toolCall: { kind: "execute", rawInput, ...tcx } } } } }] })[0];
  assert.deepEqual(n({ command: "cat a", directory: "/a", dir_path: "/b", cwd: "/c" }, { cwd: "/d" }).cwds, ["/a", "/b", "/c", "/d"]);
  const ok = (r) => batchAllowed([r], [cwd]).ok, req = (cwds) => ({ name: "execute", kind: "execute", paths: [], command: "cat leaf.txt", cwds });
  assert.equal(ok(req([j2(cwd, "sub")])), true);
  assert.equal(ok(req([j2(cwd, "sub"), j2(cwd, "sub")])), true, "same place twice");
  assert.equal(ok(req([j2(cwd, "sub"), j2(d, "outside")])), false, "one outside");
  assert.equal(ok(req([j2(d, "outside"), j2(cwd, "sub")])), false, "first outside");
  assert.equal(ok(req([cwd, j2(cwd, "sub")])), false, "both inside but different");
  assert.equal(ok(req([j2(cwd, "sub"), 5])), false, "non-string");
});
test("hardening2 2: a relative request cwd is resolved once against the task cwd; file arguments resolve against it", () => {
  const { cwd, d } = sandbox(); md2(j2(cwd, "sub")); wf2(j2(cwd, "sub", "leaf.txt"), "x");
  const ok = (command, c) => batchAllowed([{ name: "execute", kind: "execute", paths: [], command, cwd: c }], [cwd]).ok;
  assert.equal(ok("cat leaf.txt", "sub"), true, "relative cwd inside");
  assert.equal(ok("cat app.log", "sub"), false, "app.log is not in sub");
  assert.equal(ok("cat leaf.txt", ".."), false);
  assert.equal(ok("cat app.log", "sub/.."), true, "normalises to the task cwd");
  const prev = process.cwd(); process.chdir(d);
  try { assert.equal(ok("cat leaf.txt", "sub"), true, "independent of the process cwd"); } finally { process.chdir(prev); }
});
test("hardening2 3: findstr is not a read command at all", () => {
  const { cwd } = sandbox();
  const sh = (command) => batchAllowed([{ name: "execute", kind: "execute", paths: [], command }], [cwd]).ok;
  for (const c of ["findstr foo app.log", "findstr /N foo app.log", "findstr /C:foo app.log", "findstr foo app.log /S", "grep foo app.log | findstr x"]) assert.equal(sh(c), false, c);
  assert.equal(sh("grep foo app.log"), true);
});

// round 5 (14-11): an unavailable provider must never delay a route
const lapBusy = { freeGb: 8, cpuPct: 99 };
const mkPaseo = (runs, script = {}) => (a) => { if (a[0] === "run") { const p = a[a.indexOf("--provider") + 1]; runs.push(p); return script[p]?.() ?? { agentId: "A", status: "completed" }; } return a[0] === "logs" ? { text: "ok" } : a[0] === "ls" ? [] : {}; };
test("r5: high CPU never holds a route on a remote-model provider (claude) and a laptop-hosted one is skipped at once", () => {
  let slept = 0; const runs = [];
  const r = runRoute({ type: "review", prompt: "p", cwd: privDir(), session: "s", limitsDir: mkdtempSync(join(tmpdir(), "lim-")), freeMem: () => 8, laptop: () => lapBusy, sleep: () => { slept++; }, providerState: new Map([["qwen-code-laptop", true], ["claude-clean", true]]) }, mkPaseo(runs), { slots: { "qwen-code-laptop": 1, "claude-clean": 2 }, readOnlyEnforced: ALL.concat(["qwen-code-laptop"]), readOnlyModes: { "qwen-code-laptop": "read-only", "claude-clean": "plan" }, routes: { review: ["qwen-code-laptop", "claude-clean"] } });
  assert.equal(slept, 0, JSON.stringify(r.trace)); assert.match(r.trace[0].skip, /CPU 99%.*skipped at once/); assert.deepEqual(runs, ["claude-clean"]); assert.equal(r.used, "claude-clean");
});
test("r5: an ACP exit on one provider falls through to the next at once, drops the provider cache and the provider is skipped by the next route", () => {
  const limitsDir = mkdtempSync(join(tmpdir(), "lim-")); const cache = join(limitsDir, "provider-ls-cache.json"); writeFileSync(cache, "{}"); let slept = 0;
  const runs = []; const script = { "qwen-code-laptop": () => ({ status: "error", error: "ACP agent process exited (exit code 3)", agentId: "Z" }) };
  const base = { type: "review", prompt: "p", cwd: privDir(), session: "s", limitsDir, providerCache: cache, freeMem: () => 8, laptop: () => ({ freeGb: 8, cpuPct: 1 }), sleep: () => { slept++; }, providerState: new Map([["qwen-code-laptop", true], ["claude-clean", true]]) };
  const rt = { slots: { "qwen-code-laptop": 1, "claude-clean": 2 }, readOnlyEnforced: ALL.concat(["qwen-code-laptop"]), readOnlyModes: { "qwen-code-laptop": "read-only", "claude-clean": "plan" }, routes: { review: ["qwen-code-laptop", "claude-clean"] } };
  const r = runRoute(base, mkPaseo(runs, script), rt);
  assert.equal(r.used, "claude-clean", JSON.stringify(r.trace)); assert.equal(slept, 0); assert.deepEqual(runs, ["qwen-code-laptop", "claude-clean"]); assert.equal(existsSync(cache), false, "the cached provider list is dropped on a start failure");
  const runs2 = []; const r2 = runRoute(base, mkPaseo(runs2, script), rt);
  assert.match(r2.trace[0].skip, /failed to start a moment ago/); assert.deepEqual(runs2, ["claude-clean"], "the failing provider is not tried again");
});
test("r5: a non-local resource wait is bounded (resourceWait) and then the next provider is tried", () => {
  let slept = 0; const runs = [];
  const r = runRoute({ type: "review", prompt: "p", cwd: privDir(), session: "s", limitsDir: mkdtempSync(join(tmpdir(), "lim-")), freeMem: () => 0.1, laptop: () => ({ freeGb: 0.1, cpuPct: 1 }), sleep: (ms) => { slept += ms; }, providerState: new Map([["claude-clean", true], ["qwen", true]]) }, mkPaseo(runs), { resourceWait: "10s", slots: { "claude-clean": 2, qwen: 1 }, readOnlyEnforced: ALL, readOnlyModes: { "claude-clean": "plan", qwen: "read-only" }, routes: { review: ["claude-clean", "qwen"] } });
  assert.ok(slept <= 10_000, "slept " + slept); assert.equal(r.used, null); assert.equal(runs.length, 0);
});

test("a provider pin may carry @ (qoder/DeepSeek-Flash@latest) and still refuses shell characters (HUBFIX3)", async () => {
  const { runRoute } = await import("../route.mjs");
  const bad = runRoute({ type: "review", prompt: "p", cwd: privDir(), session: "s", provider: "qoder/x;rm" }, () => ({}), { routes: { review: ["qwen-code"] } });
  assert.match(String(bad.error ?? bad.trace?.[0]?.error ?? ""), /invalid provider/);
});

test("flattenError turns the CLI's {error:{code,message}} into one string so not-found/archived checks match (HUBFIX3)", async () => {
  const { flattenError } = await import("../route.mjs");
  const j = flattenError({ error: { code: "AGENT_NOT_FOUND", message: "Agent not found: x" } });
  assert.equal(j.error, "AGENT_NOT_FOUND: Agent not found: x"); assert.match(j.error, /not found|archived/i);
  assert.deepEqual(flattenError([1]), [1]); assert.deepEqual(flattenError({ id: 1 }), { id: 1 }); assert.equal(flattenError({ error: "plain" }).error, "plain");
});

test("a daemon that is down is a transient error with a retry line (HUBFIX3)", async () => {
  const { flattenError, transient } = await import("../route.mjs");
  const j = flattenError({ error: { code: "DAEMON_NOT_RUNNING", message: "Cannot connect to daemon" } });
  assert.equal(transient(j), true); assert.match(j.error, /retry the route in 1 min/);
});

test("--mcp: names go to the provider as HUB_MCP env only; lanes without a grant launcher are skipped; read-only types refused", () => {
  const allow = [{ name: "swing", command: "node", args: ["s.js"] }];
  const p = fake({ run: () => ({ status: "completed", agentId: "A1" }) });
  const r = runRoute({ ...o, mcp: "swing", mcpAllow: allow }, p, routes);
  assert.equal(r.used, "qwen/b"); // codex/a has no grant launcher
  const run = p.calls.find((c) => c[0] === "run"); assert.deepEqual(run.slice(run.indexOf("--env"), run.indexOf("--env") + 2), ["--env", "HUB_MCP=swing"]);
  const bad = runRoute({ ...o, mcp: "evil", mcpAllow: allow }, fake({ run: () => ({ status: "completed", agentId: "A2" }) }), routes);
  assert.ok(!bad.used && JSON.stringify(bad.trace).includes("not on the hub allowlist"));
});
