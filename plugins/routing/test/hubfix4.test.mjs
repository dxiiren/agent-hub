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
