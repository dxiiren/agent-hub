// HUBFIX2: a read-only agent cannot Glob/Grep/LS or Read a folder, so the task carries the readable file list; "could not read" answers are unusable (route falls through / fails).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listReadable, withFileList, unusableAnswer } from "../route.mjs";

test("listReadable lists plain files, skips dotfiles and sensitive names", () => {
  const d = mkdtempSync(join(tmpdir(), "ro-")); mkdirSync(join(d, "sub"));
  writeFileSync(join(d, "a.txt"), "MARK-A"); writeFileSync(join(d, "sub", "b.txt"), "MARK-B"); writeFileSync(join(d, ".env"), "x"); writeFileSync(join(d, "credentials.json"), "{}");
  assert.deepEqual(listReadable(d), ["a.txt", "sub/b.txt"]);
  assert.match(withFileList("summarise", d), /a\.txt, sub\/b\.txt/);
  assert.equal(withFileList("summarise", null), "summarise");
});
test("unusableAnswer rejects 'could not read the folder' answers, keeps grounded ones", () => {
  assert.match(unusableAnswer("I couldn't read the folder, so I can't answer. The read tools are refused by a PreToolUse hook."), /could not read its inputs/);
  assert.equal(unusableAnswer("Add and Edit exist (page.svelte:12); no delete."), "");
});
