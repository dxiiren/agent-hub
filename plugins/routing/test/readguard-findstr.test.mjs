import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandAllowed } from "../readguard.mjs";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rg-"))); writeFileSync(join(root, "a.txt"), "x\n"); writeFileSync(join(root, ".env"), "k=v\n");
const ok = (c) => commandAllowed(c, [root], {}, root, root);

test("a read-only Qwen agent can SEARCH with findstr and read with a Windows path (HUBFIX3, qwenbench 3b)", () => {
  assert.equal(ok('findstr /n /i "x" a.txt').ok, true);
  assert.equal(ok('findstr /c:"hello world" a.txt').ok, true);
  assert.equal(ok("findstr /n x " + join(root, "a.txt")).ok, true, "absolute Windows path with backslashes");
  assert.equal(ok("cat a.txt | findstr /n x").ok, true, "findstr as a stdin filter");
});
test("findstr and backslashes still cannot write, chain, list files from a file, or reach sensitive files", () => {
  for (const c of ['findstr /f:list.txt x a.txt', 'findstr /s x a.txt', 'findstr /d:C:\\ x a.txt', "findstr x .env", 'findstr x a.txt > out.txt', 'findstr x a.txt & del a.txt', 'findstr x a.txt | findstr y b.txt', "findstr x " + join(root, ".env")]) assert.equal(ok(c).ok, false, c);
  for (const c of ['cat a.txt\\" ; rm a.txt ; "', 'cat a.txt\\ b', 'cat a.txt\\']) assert.equal(ok(c).ok, false, "backslash before a quote, a space or the end: " + c);
  assert.equal(ok("rm a.txt").ok, false);
});
