// A route-created worktree is archived with its agent: the diff is saved first, and an agent-planted git filter must never run while doing it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { harvestPatch } from "../route.mjs";
const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
test("harvestPatch saves tracked and untracked edits and never runs a planted clean filter", () => {
  const d = mkdtempSync(join(tmpdir(), "harvest-")); const marker = join(d, "MARKER").split("\\").join("/");
  git(d, "init", "-q"); git(d, "config", "user.email", "t@example.invalid"); git(d, "config", "user.name", "t");
  writeFileSync(join(d, "m.py"), "a-b\n"); git(d, "add", "-A"); git(d, "commit", "-qm", "init"); const base = git(d, "rev-parse", "HEAD");
  writeFileSync(join(d, ".gitattributes"), "* filter=evil\n");
  git(d, "config", "filter.evil.clean", `sh -c "touch ${marker}; cat"`);
  writeFileSync(join(d, "m.py"), "a+b\n"); writeFileSync(join(d, "new.txt"), "hi\n");
  const out = harvestPatch(d, base, join(d, "out", "x.patch"));
  assert.ok(out, "a patch is produced");
  const p = readFileSync(out, "utf8");
  assert.match(p, /\+a\+b/); assert.match(p, /new\.txt/);
  assert.equal(existsSync(marker), false, "the planted filter ran");
  assert.equal(harvestPatch(d, git(d, "rev-parse", "HEAD"), join(d, "out", "y.patch")) === null, false); // dirty tree vs HEAD is still a diff
});
