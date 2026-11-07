import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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

test("after writing untracked file, run args do NOT include full-access and trace has note matching /uncommitted changes/", () => {
  const repo = makeTmpRepo();
  writeFileSync(join(repo, "untracked.txt"), "content");
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

  const runCall = paseo.calls.find(c => c[0] === "run");
  assert.ok(runCall, "run call should exist");
  assert.ok(!runCall.includes("full-access"), "args should NOT include full-access");

  const traceNote = result.trace.find(t => t.note && /uncommitted changes/.test(t.note));
  assert.ok(traceNote, "trace should have a note about uncommitted changes");
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
