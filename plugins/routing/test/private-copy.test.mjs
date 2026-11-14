import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateCopy, snapshot } from "../route.mjs";

const mkSrc = () => { const d = mkdtempSync(join(tmpdir(), "pc-src-")); writeFileSync(join(d, "a.txt"), "a"); mkdirSync(join(d, "node_modules")); writeFileSync(join(d, "node_modules", "x.js"), "x"); return d; };

test("private copy for read-only routes: another writer in the original does not change the copy's fingerprint (HUBFIX3 a)", () => {
  const src = mkSrc(), pc = privateCopy(src);
  try {
    assert.ok(pc && existsSync(join(pc, "a.txt")) && !existsSync(join(pc, "node_modules")), "copy made, node_modules skipped");
    const before = snapshot(pc);
    writeFileSync(join(src, "other-writer.txt"), "x"); writeFileSync(join(src, "a.txt"), "changed");
    assert.equal(snapshot(pc), before, "the guard fingerprint of the copy ignores the original");
  } finally { rmSync(src, { recursive: true, force: true }); if (pc) rmSync(pc, { recursive: true, force: true }); }
});
test("a write inside the private copy still changes its fingerprint, so the route still fails (HUBFIX3 b)", () => {
  const src = mkSrc(), pc = privateCopy(src);
  try { const before = snapshot(pc); writeFileSync(join(pc, "agent-wrote.txt"), "x"); assert.notEqual(snapshot(pc), before); assert.equal(existsSync(join(src, "agent-wrote.txt")), false, "the original is untouched"); }
  finally { rmSync(src, { recursive: true, force: true }); if (pc) rmSync(pc, { recursive: true, force: true }); }
});
test("a folder over the cap is not copied (route runs in place as before)", () => {
  const src = mkSrc();
  try { assert.equal(privateCopy(src, { maxFiles: 0 }), null); } finally { rmSync(src, { recursive: true, force: true }); }
});

import { symlinkSync, readdirSync, lstatSync } from "node:fs";
test("a link pointing outside the copy is not followed: it is removed from the copy (security review)", (t) => {
  const src = mkSrc(), outside = mkdtempSync(join(tmpdir(), "pc-out-")); writeFileSync(join(outside, "secret.txt"), "s");
  try { symlinkSync(outside, join(src, "escape"), "junction"); } catch { rmSync(src, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); return t.skip("cannot create links here"); }
  const pc = privateCopy(src);
  try {
    assert.ok(pc, "copy made"); assert.equal(existsSync(join(pc, "escape")), false, "the escaping link is gone from the copy");
    assert.equal(existsSync(join(pc, "escape", "secret.txt")), false); assert.ok(existsSync(join(outside, "secret.txt")), "the target is untouched");
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); if (pc) rmSync(pc, { recursive: true, force: true }); }
});
