// HUBFIX2: dead slot files are swept wherever they sit, and held() counts only live ones.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepDead, held, acquireEntry } from "../entry-gate.mjs";

test("sweepDead removes dead and expired slots, keeps live ones; held counts live only", () => {
  const d = mkdtempSync(join(tmpdir(), "slots-")); const now = Date.now();
  writeFileSync(join(d, "slot-0.json"), JSON.stringify({ pid: process.pid, at: now }));
  writeFileSync(join(d, "slot-5.json"), JSON.stringify({ pid: 2147483000, at: now }));
  writeFileSync(join(d, "slot-6.json"), JSON.stringify({ pid: process.pid, at: now - 4 * 3600_000 }));
  assert.equal(held(d), 1);
  assert.equal(existsSync(join(d, "slot-5.json")), false);
  assert.equal(existsSync(join(d, "slot-0.json")), true);
});
test("acquireEntry sweeps dead slots beyond the first free one", () => {
  const run = mkdtempSync(join(tmpdir(), "run-")); const d = join(run, "inflight"); mkdirSync(d);
  writeFileSync(join(d, "slot-7.json"), JSON.stringify({ pid: 2147483000, at: Date.now() }));
  const g = acquireEntry({ dir: run, max: 8, waitMs: 1000 }); assert.equal(g.slot, 0);
  assert.equal(existsSync(join(d, "slot-7.json")), false); g.release();
});
