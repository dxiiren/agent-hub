import test from "node:test";
import assert from "node:assert/strict";
import { effectiveBudget, chainOrder, kindOf, laptopNow, dropWslCache, resetLaptopCache, resetDropClock, DEFAULT_COST_GB } from "../budget.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("kindOf classifies provider ids", () => {
  assert.equal(kindOf("claude-opus-4"), "claude");
  assert.equal(kindOf("claude-3-sonnet"), "claude");
  assert.equal(kindOf("codex-gpt5"), "codex");
  assert.equal(kindOf("qoder-fast"), "qoder");
  assert.equal(kindOf("qwen-coder"), "qwen");
  assert.equal(kindOf("laptop-llama"), "local");
  assert.equal(kindOf("local-server"), "local");
  assert.equal(kindOf("llama-local"), "local");
  assert.equal(kindOf("unknown-thing"), "other");
});

test("chainOrder returns provider ids in route priority, then slot keys", () => {
  const routes = {
    routes: {
      "code-edit": ["claude-opus", "codex-gpt5"],
      "summarise": ["qwen-coder", "claude-sonnet"],
    },
    slots: { "qoder-fast": 2, "local-llama": 1 },
  };
  const order = chainOrder(routes);
  assert.deepEqual(order, ["claude-opus", "codex-gpt5", "qwen-coder", "claude-sonnet", "qoder-fast", "local-llama"]);
});

test("chainOrder deduplicates and appends slot-only providers", () => {
  const routes = {
    routes: { "code-edit": ["claude-opus", "codex-gpt5"] },
    slots: { "claude-opus": 3, "qoder-fast": 2 },
  };
  const order = chainOrder(routes);
  assert.deepEqual(order, ["claude-opus", "codex-gpt5", "qoder-fast"]);
});

test("effectiveBudget: no freeGb returns configured slots sum with source configured-slots", () => {
  const slots = { "claude-opus": 3, "codex-gpt5": 2 };
  const enabled = { "claude-opus": true, "codex-gpt5": true };
  const r = effectiveBudget({ slots, enabled });
  assert.equal(r.source, "configured-slots");
  assert.equal(r.configured, 5);
  assert.equal(r.effective, 5);
  assert.equal(r.configEffective, 5);
  assert.equal(r.laptopCap, null);
  assert.deepEqual(r.perProvider, { "claude-opus": 3, "codex-gpt5": 2 });
});

test("effectiveBudget: free RAM below floor + one agent cost gives laptopCap == busy, effective 0 when busy 0", () => {
  const slots = { "claude-opus": 3 };
  const enabled = { "claude-opus": true };
  const freeGb = 1.5;
  const floorGb = 2;
  const costPerAgent = DEFAULT_COST_GB.claude;
  assert.ok(freeGb < floorGb + costPerAgent, "precondition: free RAM below floor + one agent");
  const r = effectiveBudget({ slots, enabled, freeGb, floorGb, busy: 0, cost: () => costPerAgent });
  assert.equal(r.laptopCap, 0);
  assert.equal(r.effective, 0);
  assert.equal(r.source, "laptop");
  assert.ok(r.reasons.some((x) => /nothing new starts/.test(x)));
});

test("effectiveBudget: disabled provider's slots move to next enabled provider by order, never above its cap", () => {
  const slots = { "claude-opus": 3, "codex-gpt5": 2 };
  const enabled = { "claude-opus": false, "codex-gpt5": true };
  const order = ["claude-opus", "codex-gpt5"];
  const caps = { "codex-gpt5": 4 };
  const r = effectiveBudget({ slots, enabled, order, caps });
  assert.equal(r.perProvider["claude-opus"], 0);
  assert.equal(r.perProvider["codex-gpt5"], 4);
  assert.equal(r.configEffective, 4);
  assert.equal(r.configured, 5);
  assert.ok(r.reasons.some((x) => /disabled in Paseo/.test(x) && /claude-opus/.test(x)));
  assert.ok(r.reasons.some((x) => /\+2 slots from disabled/.test(x) && /codex-gpt5/.test(x)));
});

test("effectiveBudget: caps default to provider's own slots so nothing moves when disabled", () => {
  const slots = { "claude-opus": 3, "codex-gpt5": 2 };
  const enabled = { "claude-opus": false, "codex-gpt5": true };
  const order = ["claude-opus", "codex-gpt5"];
  const r = effectiveBudget({ slots, enabled, order });
  assert.equal(r.perProvider["codex-gpt5"], 2, "codex stays at its own slots (cap defaults to slots)");
  assert.equal(r.configEffective, 2);
  assert.ok(r.reasons.some((x) => /unplaced/.test(x)));
});

test("effectiveBudget: configured total may exceed 19 (e.g. slots 10+10, caps 30)", () => {
  const slots = { "claude-opus": 10, "codex-gpt5": 10 };
  const enabled = { "claude-opus": true, "codex-gpt5": true };
  const caps = { "claude-opus": 15, "codex-gpt5": 15 };
  const r = effectiveBudget({ slots, enabled, caps });
  assert.equal(r.configured, 20);
  assert.equal(r.configEffective, 20);
  assert.equal(r.effective, 20);
  assert.deepEqual(r.perProvider, { "claude-opus": 10, "codex-gpt5": 10 });
});

test("effectiveBudget: CPU above cpuMaxPct caps at busy", () => {
  const slots = { "claude-opus": 3 };
  const enabled = { "claude-opus": true };
  const freeGb = 16;
  const floorGb = 2;
  const busy = 1;
  const cpuPct = 90;
  const cpuMaxPct = 85;
  const r = effectiveBudget({ slots, enabled, freeGb, floorGb, busy, cpuPct, cpuMaxPct });
  assert.equal(r.laptopCap, busy);
  assert.equal(r.effective, Math.min(r.configEffective, busy));
  assert.ok(r.reasons.some((x) => /CPU.*above/.test(x)));
});

test("laptopNow caches for ttl and resetLaptopCache clears it", () => {
  resetLaptopCache();
  let callCount = 0;
  const freeMem = () => {
    callCount++;
    return 16;
  };
  const cpu = () => ({ idle: 100, total: 200 });
  const now1 = 1000000;
  const r1 = laptopNow({ now: now1, freeMem, cpu, ttl: 10000 });
  assert.equal(r1.freeGb, 16);
  assert.equal(callCount, 1);
  const r2 = laptopNow({ now: now1 + 5000, freeMem, cpu, ttl: 10000 });
  assert.equal(r2.freeGb, 16);
  assert.equal(callCount, 1, "cached within ttl");
  assert.equal(r1, r2, "same object returned from cache");
  const r3 = laptopNow({ now: now1 + 15000, freeMem, cpu, ttl: 10000 });
  assert.equal(callCount, 2, "cache expired after ttl");
  assert.notEqual(r3, r1);
  resetLaptopCache();
  const r4 = laptopNow({ now: now1 + 15000, freeMem, cpu, ttl: 10000 });
  assert.equal(callCount, 3, "resetLaptopCache cleared the cache");
  assert.notEqual(r4, r3);
});

test("dropWslCache returns null off win32", () => {
  resetDropClock();
  const r = dropWslCache({ platform: "linux", now: Date.now() });
  assert.equal(r, null);
});

test("dropWslCache runs once per minute and logs to logDir/budget.log", () => {
  resetDropClock();
  const logDir = mkdtempSync(join(tmpdir(), "budget-log-"));
  try {
    let runCount = 0;
    const run = () => {
      runCount++;
      return { status: 0 };
    };
    const now1 = 1000000000000;
    const r1 = dropWslCache({ run, logDir, now: now1, platform: "win32" });
    assert.ok(r1);
    assert.match(r1, /drop WSL page cache: ok/);
    assert.equal(runCount, 1);
    const log1 = readFileSync(join(logDir, "budget.log"), "utf8");
    assert.ok(log1.includes("drop WSL page cache: ok"));
    const r2 = dropWslCache({ run, logDir, now: now1 + 30000, platform: "win32" });
    assert.equal(r2, null, "within 60s, skipped");
    assert.equal(runCount, 1, "run not called again within 60s");
    const r3 = dropWslCache({ run, logDir, now: now1 + 61000, platform: "win32" });
    assert.ok(r3);
    assert.equal(runCount, 2, "run called again after 60s");
    const log2 = readFileSync(join(logDir, "budget.log"), "utf8");
    assert.equal(log2.split("\n").filter(Boolean).length, 2, "two log lines");
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("dropWslCache logs failure status", () => {
  resetDropClock();
  const logDir = mkdtempSync(join(tmpdir(), "budget-log-"));
  try {
    const run = () => ({ status: 1, stderr: "access denied" });
    const now1 = 2000000000000;
    const r = dropWslCache({ run, logDir, now: now1, platform: "win32" });
    assert.ok(r);
    assert.match(r, /failed \(status 1/);
    const log = readFileSync(join(logDir, "budget.log"), "utf8");
    assert.ok(log.includes("failed (status 1"));
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
