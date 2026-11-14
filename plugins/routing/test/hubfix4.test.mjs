import "./isolate-run-dir.mjs";
// HUBFIX4 (15-11-2026): smoke-test defects D1 (read-only answers that were not the answer) and D2 (gate by-products reaching the caller's folder / patch).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { lastAnswer, unusableAnswer, harvestPatch } from "../route.mjs";

test("D1: a footer-only, a status-only and a plan-only answer are unusable (the three real strings); a real summary is usable", () => {
  assert.match(unusableAnswer("Skipped: I did not check for hidden characters or trailing whitespace. Risk: none for a summary of this file."), /status footer/);
  assert.match(unusableAnswer("Plan mode is on, so I only read the file and made no changes. Lazy note: I didn't check anything beyond the file itself, and the summary covers only the content I read."), /status footer/);
  assert.match(unusableAnswer("I'll review the diff…"), /plan sentence/);
  assert.match(unusableAnswer("I'll review the diff and look for problems."), /plan sentence/);
  assert.equal(unusableAnswer("- sample.txt holds 20 records.\n- Each value is 7 times its number.\n\nSkipped: hidden characters."), "", "a footer after a real summary is not a failure");
  assert.equal(unusableAnswer("I'll flag one thing: `add` returns a - b, so test_add fails (calc.py:2)."), "", "a finding that starts with I'll is kept");
  assert.equal(unusableAnswer("No findings: the diff only renames a variable."), "");
});

test("D1: the real smoke log (answer, then a cross-talk re-prompt, then tool lines only) yields the full 2-bullet answer, not its last paragraph", () => {
  const bullets = "- **Content:** `sample.txt` has 20 placeholder records.\n- **Pattern:** Record N's value is 7 x N.";
  const full = `[User] Summarise sample.txt in 2 bullets\n\n(Files you can open ...)\n[Read] C:/x/sample.txt\n${bullets}\n\nSkipped: hidden characters.\n[User] Your work failed the gate: gate cmd exit 1: ____\n\n    def test_add():\nFAILED test_calc.py::test_add\nFix it and finish.\n[Read] C:/x/calc.py\n[Read] C:/x/test_calc.py\n[Write] C:/plans/p.md\n[Exitplanmode]\n`;
  const assistant = `${bullets}\n\nSkipped: hidden characters.`;
  const a = lastAnswer(full, 4096, assistant).answer;
  assert.ok(a.includes("**Content:**") && a.includes("**Pattern:**"), a);
  assert.ok(!/Fix it and finish|failed the gate/.test(a));
});

test("D2: gate by-products (__pycache__, .pytest_cache, *.pyc) never enter a saved patch, even with no .gitignore", () => {
  const d = mkdtempSync(join(tmpdir(), "hf4-")); const git = (...a) => { const r = spawnSync("git", a, { cwd: d, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
  writeFileSync(join(d, "calc.py"), "a-b\n"); git("add", "-A"); git("commit", "-qm", "i"); const base = git("rev-parse", "HEAD");
  writeFileSync(join(d, "calc.py"), "a+b\n"); mkdirSync(join(d, "__pycache__")); writeFileSync(join(d, "__pycache__", "calc.cpython-313.pyc"), "x"); mkdirSync(join(d, ".pytest_cache")); writeFileSync(join(d, ".pytest_cache", "README.md"), "x"); mkdirSync(join(d, "sub", "__pycache__"), { recursive: true }); writeFileSync(join(d, "sub", "__pycache__", "s.pyc"), "x"); writeFileSync(join(d, "new.py"), "n\n");
  const p = readFileSync(harvestPatch(d, base, join(d, "out", "x.patch")), "utf8");
  assert.match(p, /\+a\+b/); assert.match(p, /new\.py/);
  assert.ok(!/__pycache__|\.pytest_cache|\.pyc/.test(p), p);
});

import { wantsAutoWorktree } from "../route.mjs";
test("D2: an edit task with no flag gets a worktree in a git repo; --in-place, --new-workspace, read-only types and non-git folders do not", () => {
  const d = mkdtempSync(join(tmpdir(), "hf4g-")); const nogit = mkdtempSync(join(tmpdir(), "hf4n-"));
  const git = (...a) => { const r = spawnSync("git", a, { cwd: d, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t"); writeFileSync(join(d, "a"), "1"); git("add", "-A"); git("commit", "-qm", "i");
  assert.equal(wantsAutoWorktree("code-edit", {}, [], d), true);
  assert.equal(wantsAutoWorktree("code-edit", {}, ["--in-place"], d), false);
  assert.equal(wantsAutoWorktree("code-edit", {}, ["--new-workspace", "worktree"], d), false);
  assert.equal(wantsAutoWorktree("summarise", {}, [], d), false);
  assert.equal(wantsAutoWorktree("code-edit", {}, [], nogit), false);
});

import { changedPaths } from "../route.mjs";
test("D1: a bare file or directory listing is not a prose answer; prose that mentions files is", () => {
  assert.match(unusableAnswer("calc.py\nsample.txt\ntest_calc.py"), /listing/);
  assert.match(unusableAnswer("- src/\n- README.md\n- package.json"), /listing/);
  assert.equal(unusableAnswer("The folder has calc.py and sample.txt.\ncalc.py adds numbers."), "");
  assert.equal(unusableAnswer("- sample.txt has 20 records.\n- Values are 7 x N."), "");
});
test("D3: the read-only change error names the changed paths", () => {
  const b = "C:/c/a.txt|1\nC:/c/b.txt|2", a = "C:/c/a.txt|1\nC:/c/b.txt|9\nC:/c/new.tmp|3";
  assert.deepEqual(changedPaths(b, a), ["C:/c/b.txt (modified)", "C:/c/new.tmp (added)"]);
  assert.deepEqual(changedPaths(b, "C:/c/a.txt|1"), ["C:/c/b.txt (removed)"]);
});

// ---- follow-ups (15-11-2026): apply-back to --cwd, per-run gate requests, read-only time cap ----
import { applyPatchToCwd, cwdFingerprint, attemptLimit, DEFAULT_TIMEOUTS } from "../route.mjs";
import { writeRequest, claimRequest, peekRequest } from "../../gate/server/store.mjs";

const git = (cwd, ...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });
function repo() {
  const d = mkdtempSync(join(tmpdir(), "hf4-apply-")); git(d, "init", "-q"); git(d, "config", "core.autocrlf", "false");
  writeFileSync(join(d, "calc.py"), "def add(a, b):\n    return a - b\n"); git(d, "add", "-A"); git(d, "commit", "-qm", "init"); return d;
}
const patchFor = (d) => { // a fixed copy of calc.py as a patch against the repo
  const f = join(mkdtempSync(join(tmpdir(), "hf4-p-")), "x.patch");
  writeFileSync(join(d, "calc.py"), "def add(a, b):\n    return a + b\n"); const p = git(d, "diff").stdout; git(d, "checkout", "--", "calc.py"); writeFileSync(f, p); return f;
};

test("apply-back: an unchanged --cwd gets the patch, the result lists the file; nothing else is touched", () => {
  const d = repo(), p = patchFor(d), sig = cwdFingerprint(d);
  const r = applyPatchToCwd(d, p, sig);
  assert.equal(r.ok, true); assert.deepEqual(r.files, ["calc.py"]);
  assert.match(readFileSync(join(d, "calc.py"), "utf8"), /a \+ b/);
  assert.equal(git(d, "status", "--short").stdout.trim(), "M calc.py");
});

test("apply-back: --cwd changed underneath (edit or new commit) => NOT applied, reason given, nothing overwritten", () => {
  const d = repo(), p = patchFor(d), sig = cwdFingerprint(d);
  writeFileSync(join(d, "calc.py"), "def add(a, b):\n    return 99\n"); // someone edits the same file while the route runs
  const r = applyPatchToCwd(d, p, sig);
  assert.equal(r.ok, false); assert.match(r.reason, /changed underneath/);
  assert.match(readFileSync(join(d, "calc.py"), "utf8"), /99/);
  const d2 = repo(), p2 = patchFor(d2), sig2 = cwdFingerprint(d2);
  writeFileSync(join(d2, "other.txt"), "x"); git(d2, "add", "-A"); git(d2, "commit", "-qm", "more");
  assert.equal(applyPatchToCwd(d2, p2, sig2).ok, false);
  assert.equal(applyPatchToCwd(d2, p2, null).ok, false, "no fingerprint (not a git tree at the start) never applies");
});

test("gate requests are bound to the agent id: concurrent routes on one cwd each get their own; a forged/missing label or another agent's id never selects a request", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf4-gate-"));
  writeRequest(dir, "agent-A-0001", "gate-A", "baseA"); writeRequest(dir, "agent-B-0002", "gate-B", "baseB");
  assert.equal(peekRequest(dir, "agent-B-0002").cmd, "gate-B");
  assert.equal(claimRequest(dir, "agent-B-0002").cmd, "gate-B");
  assert.equal(claimRequest(dir, "agent-B-0002"), null, "a request is taken once");
  assert.equal(claimRequest(dir, "agent-C-0003"), null, "an agent with no bound request gets none (never the oldest, never another agent's)");
  assert.equal(claimRequest(dir, "../agent-A-0001"), null, "a forged id cannot walk to another file");
  assert.equal(claimRequest(dir, ""), null); assert.equal(claimRequest(dir, undefined), null);
  assert.equal(claimRequest(dir, "agent-A-0001").cmd, "gate-A", "A's request was untouched by all of the above");
});
test("evaluate: an agent id with no bound request is FAILed closed with a clear reason, and a request for agent A is never evaluated for agent B", async () => {
  const { evaluate } = await import("../../gate/server/hook.mjs");
  const dir = mkdtempSync(join(tmpdir(), "hf4-ev-")), cwd = mkdtempSync(join(tmpdir(), "hf4-evc-"));
  writeRequest(dir, "agent-A-0001", "true", null, { readOnly: true });
  const b = evaluate({ dir, id: "agent-B-0002", cwd, routes: {}, labels: { "route/run": "agent-A-0001" }, run: "agent-A-0001" });
  assert.equal(b.d.status, "FAIL"); assert.equal(b.d.reprompt, false); assert.match(b.res.reasons.join(), /no gate request is bound to this agent id/);
  assert.ok(peekRequest(dir, "agent-A-0001"), "B's evaluation did not take A's request");
  assert.equal(evaluate({ dir, id: "agent-A-0001", cwd, routes: {} }).d.status, "N/A", "A still gets its own (read-only) request");
});

test("read-only time cap: summarise and review fail over after at most 10 minutes by default; routes.timeouts overrides", () => {
  for (const t of ["summarise", "review"]) assert.ok(attemptLimit({ type: t }, {}) <= 600, t);
  assert.equal(attemptLimit({ type: "summarise" }, { timeouts: { summarise: "5m" } }), 300);
  assert.deepEqual(DEFAULT_TIMEOUTS, { review: "8m", summarise: "8m" });
});

import { writeBack } from "../route.mjs";
test("writeBack: gate-failed leaves --cwd untouched; a pass on a CRLF (autocrlf=true) checkout applies cleanly", () => {
  const d = repo(), p = patchFor(d), sig = cwdFingerprint(d);
  const wt = { name: "x", path: d }, home = mkdtempSync(join(tmpdir(), "hf4-home-"));
  const base = git(d, "rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(d, "calc.py"), "def add(a, b):\n    return a + b\n"); // stand-in for the agent's worktree (here the same folder)
  const failed = writeBack({ status: "gate-failed", wt, base, home, cwd: d, sig0: sig });
  assert.equal(failed.writtenBackToCwd, false); assert.match(failed.applyNote, /--cwd untouched/);
  const c = repo(); git(c, "config", "core.autocrlf", "true"); // CRLF on disk, LF in the index
  writeFileSync(join(c, "calc.py"), "def add(a, b):\r\n    return a - b\r\n");
  const sigC = cwdFingerprint(c), pc = join(mkdtempSync(join(tmpdir(), "hf4-pc-")), "x.patch");
  writeFileSync(pc, "diff --git a/calc.py b/calc.py\n--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n");
  const r = applyPatchToCwd(c, pc, sigC); assert.equal(r.ok, true, JSON.stringify(r));
});
