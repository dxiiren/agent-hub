import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRoute, cleanGitReason, gitInfo } from "../route.mjs";

const makeTmpRepo = () => {
  const d = mkdtempSync(join(tmpdir(), "repo-"));
  spawnSync("git", ["init"], { cwd: d, encoding: "utf8" });
  spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", "commit", "--allow-empty", "-m", "x"], { cwd: d, encoding: "utf8" });
  return d;
};

const makePaseo = () => {
  const calls = [];
  const p = (args) => {
    calls.push(args);
    if (args[0] === "ls") return [];
    if (args[0] === "stop" || args[0] === "archive" || args[0] === "project") return {};
    if (args[0] === "run") return { status: "completed", agentId: "A1" };
    return {};
  };
  p.calls = calls;
  return p;
};

const makeOpts = (cwd, limitsDir) => ({
  type: "code-edit",
  prompt: "p",
  cwd,
  session: "S",
  dev: "d",
  client: "c",
  answerRetryMs: 0,
  scan: () => false,
  inPlace: true,
  limitsDir
});

test("result has headSha equal to git rev-parse HEAD and branch non-empty", () => {
  const repo = makeTmpRepo();
  const limitsDir = mkdtempSync(join(tmpdir(), "limits-"));
  const routes = {
    readOnlyEnforced: [],
    slots: { codex: 1 },
    routes: { "code-edit": ["codex/a"] },
    modes: { codex: "full-access" }
  };
  const paseo = makePaseo();
  const o = makeOpts(repo, limitsDir);
  const result = runRoute(o, paseo, routes);

  const expected = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  assert.equal(result.headSha, expected);
  assert.ok(result.branch && result.branch.length > 0);
});

test("run args include --mode and full-access when cwd is clean repo", () => {
  const repo = makeTmpRepo();
  const limitsDir = mkdtempSync(join(tmpdir(), "limits-"));
  const routes = {
    readOnlyEnforced: [],
    slots: { codex: 1 },
    routes: { "code-edit": ["codex/a"] },
    modes: { codex: "full-access" }
  };
  const paseo = makePaseo();
  const o = makeOpts(repo, limitsDir);
  runRoute(o, paseo, routes);

  const runCall = paseo.calls.find(c => c[0] === "run");
  assert.ok(runCall, "run call should exist");
  assert.ok(runCall.includes("--mode"), "args should include --mode");
  assert.ok(runCall.includes("full-access"), "args should include full-access");
});

test("--in-place on a dirty work tree is refused at once: no agent starts, the trace names the uncommitted changes", () => {
  const repo = makeTmpRepo();
  writeFileSync(join(repo, "untracked.txt"), "content");
  const limitsDir = mkdtempSync(join(tmpdir(), "limits-"));
  const routes = {
    readOnlyEnforced: [],
    slots: { codex: 1 },
    routes: { "code-edit": ["codex/a", "codex/b"] },
    modes: { codex: "full-access" }
  };
  const paseo = makePaseo();
  const o = makeOpts(repo, limitsDir);
  const result = runRoute(o, paseo, routes);

  assert.ok(!paseo.calls.find(c => c[0] === "run"), "no agent may start on a dirty tree");
  const err = result.trace.find(t => t.error && /--in-place refused/.test(t.error) && /uncommitted changes/.test(t.error));
  assert.ok(err, "trace should refuse with the uncommitted-changes reason");
  assert.equal(result.trace.length, 1, "the refusal stops the chain (every provider would hit the same tree)");
});

test("cleanGitReason of non-repo folder returns 'not a git work tree'", () => {
  const nonRepo = mkdtempSync(join(tmpdir(), "nonrepo-"));
  const reason = cleanGitReason(nonRepo);
  assert.equal(reason, "not a git work tree");
});

test("summarise-type route result has no headSha key", () => {
  const repo = makeTmpRepo();
  const limitsDir = mkdtempSync(join(tmpdir(), "limits-"));
  const routes = {
    readOnlyEnforced: ["codex"],
    slots: { codex: 1 },
    routes: { "code-edit": ["codex/a"], "summarise": ["codex/a"] },
    modes: { codex: "full-access" },
    readOnlyModes: { codex: "auto" }
  };
  const paseo = makePaseo();
  const o = { ...makeOpts(repo, limitsDir), type: "summarise" };
  const result = runRoute(o, paseo, routes);

  assert.ok(!("headSha" in result), "result should not have headSha key for summarise type");
});

test("without --in-place the unsafe mode is dropped on a clean repo and the trace says how to opt in", () => {
  const repo = makeTmpRepo();
  const routes = { readOnlyEnforced: [], slots: { codex: 1 }, routes: { "code-edit": ["codex/a"] }, modes: { codex: "full-access" } };
  const paseo = makePaseo();
  const result = runRoute({ ...makeOpts(repo, mkdtempSync(join(tmpdir(), "limits-"))), inPlace: false }, paseo, routes);
  assert.ok(!paseo.calls.find(c => c[0] === "run").includes("full-access"));
  assert.ok(result.trace.some(t => /use --in-place to edit this worktree directly, or --new-workspace worktree/.test(t.note ?? "")));
});

test("cleanGitReason ignores a repo's core.fsmonitor program (no code runs from the agent-writable repo)", () => {
  const repo = makeTmpRepo();
  const marker = join(repo, "..", "fsmon-ran-" + Date.now());
  const hook = join(repo, "fsmon.sh");
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker.split("\\").join("/")}"\n`, { mode: 0o755 });
  spawnSync("git", ["config", "core.fsmonitor", hook.split("\\").join("/")], { cwd: repo });
  spawnSync("git", ["config", "core.hooksPath", join(repo, "hooks").split("\\").join("/")], { cwd: repo });
  cleanGitReason(repo); gitInfo(repo);
  assert.equal(existsSync(marker), false, "fsmonitor program must not run");
});

test("ignored files do not count as dirty (a normal repo has node_modules), untracked ones do", () => {
  const repo = makeTmpRepo();
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  spawnSync("git", ["add", ".gitignore"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", "commit", "-m", "ign"], { cwd: repo });
  writeFileSync(join(repo, "ignored.txt"), "x");
  assert.equal(cleanGitReason(repo), "");
  writeFileSync(join(repo, "new.txt"), "x");
  assert.match(cleanGitReason(repo), /uncommitted/);
});
