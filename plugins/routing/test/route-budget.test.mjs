import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRoute as runRouteReal, markActive, claimSlot, budgetFor } from "../route.mjs";
import { heldIn } from "../budget.mjs";

const runRoute = (o, ...a) => runRouteReal({ scan: () => false, ...o }, ...a);

const fake = (script) => {
  const calls = [];
  const f = (args) => {
    calls.push(args);
    return args[0] === "worktree" && args[1] === "create"
      ? { name: "wt-x", worktreePath: "/wt/x" }
      : args[0] === "ls"
        ? (script.ls ?? [])
        : args[0] === "stop"
          ? {}
          : args[0] === "provider"
            ? (script.providers ?? {})
            : script.run(args);
  };
  f.calls = calls;
  return f;
};

const o = { type: "edit", prompt: "p", cwd: "/r", session: "S1", dev: "d", client: "claude", answerRetryMs: 0 };

test("laptop budget 0: waitTimeout expires, zero run calls, trace has wait note and laptop-budget skip", () => {
  const routes = { slots: { foo: 1 }, routes: { edit: ["foo/x"] }, minFreeRamGb: 2 };
  const p = fake({ run: () => ({ status: "completed", agentId: "A1" }) });
  const r = runRoute(
    { ...o, freeMem: () => 2.2, waitTimeout: "2s", sleep: () => {} },
    p,
    routes,
  );
  assert.equal(r.used, null);
  const noteEntry = r.trace.find((t) => typeof t.note === "string" && t.note.startsWith("waiting, nothing started"));
  assert.ok(noteEntry, "trace has a note starting with 'waiting, nothing started'");
  const skipEntry = r.trace.find((t) => typeof t.skip === "string" && t.skip.includes("laptop budget"));
  assert.ok(skipEntry, "trace has a skip containing 'laptop budget'");
  const runCalls = p.calls.filter((c) => c[0] === "run");
  assert.equal(runCalls.length, 0, "fake paseo received ZERO 'run' calls");
});

test("laptop budget has room: freeMem 8 GB lets the same route run", () => {
  const routes = { slots: { foo: 1 }, routes: { edit: ["foo/x"] }, minFreeRamGb: 2 };
  const p = fake({ run: () => ({ status: "completed", agentId: "A2" }) });
  const r = runRoute(
    { ...o, freeMem: () => 8, waitTimeout: "2s", sleep: () => {} },
    p,
    routes,
  );
  assert.equal(r.used, "foo/x");
  const runCalls = p.calls.filter((c) => c[0] === "run");
  assert.ok(runCalls.length >= 1, "route ran");
});

test("route waits while other live markers hold the laptop budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-"));
  try {
    const routes = { slots: { codex: 4 }, routes: { edit: ["codex/x"] }, minFreeRamGb: 2, agentCostGb: { codex: 1.0 } };
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(dir, `t-${process.pid}-${Date.now() + i}.json`), JSON.stringify({ provider: "codex", state: "run" }));
    }
    const held = heldIn(dir);
    assert.equal(held.length, 3, "3 live markers for codex");

    const marker = markActive(routes, null, dir);
    const p = fake({ run: () => ({ status: "completed", agentId: "A3" }) });
    const r = runRoute(
      { ...o, freeMem: () => 2.5, waitTimeout: "2s", sleep: () => {}, marker },
      p,
      routes,
    );
    assert.equal(r.used, null);
    const skipEntry = r.trace.find((t) => typeof t.skip === "string" && t.skip.includes("laptop budget"));
    assert.ok(skipEntry, "skipped because other live routes hold the budget");
    const runCalls = p.calls.filter((c) => c[0] === "run");
    assert.equal(runCalls.length, 0, "no run call while budget is held");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disabled provider slots move: qwen accepts up to 2 concurrent holders", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-slots-"));
  try {
    const routes = { slots: { codex: 1, qwen: 1 }, slotCaps: { qwen: 3 }, routes: { edit: ["qwen/x"] } };
    const state = new Map([["codex", false], ["qwen", true]]);
    const b = budgetFor(routes, state, {}, 0);
    assert.equal(b.perProvider.qwen, 2, "qwen gets 2 effective slots after codex disabled");

    const m1 = markActive(routes, "qwen", dir);
    assert.ok(claimSlot(m1, "qwen", b.perProvider.qwen), "first qwen claim succeeds");
    const m2 = markActive(routes, "qwen", dir);
    assert.ok(claimSlot(m2, "qwen", b.perProvider.qwen), "second qwen claim succeeds");
    const m3 = markActive(routes, "qwen", dir);
    assert.equal(claimSlot(m3, "qwen", b.perProvider.qwen), false, "third qwen claim refused (cap 2)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dropWslCache flag: trace note when true, never called when false/absent", () => {
  const routesOn = { slots: { foo: 1 }, routes: { edit: ["foo/x"] }, minFreeRamGb: 2, dropWslCache: true };
  const routesOff = { slots: { foo: 1 }, routes: { edit: ["foo/x"] }, minFreeRamGb: 2 };

  {
    let dropCalls = 0;
    const p = fake({ run: () => ({ status: "completed", agentId: "A4" }) });
    const r = runRoute(
      {
        ...o,
        freeMem: () => 2.2,
        waitTimeout: "2s",
        sleep: () => {},
        dropCache: () => { dropCalls++; return "dropped"; },
      },
      p,
      routesOn,
    );
    assert.ok(dropCalls >= 1, "dropCache called when routes.dropWslCache is true");
    const noteEntry = r.trace.find((t) => t.note === "dropped");
    assert.ok(noteEntry, "trace has note 'dropped'");
  }

  {
    let dropCalls = 0;
    const p = fake({ run: () => ({ status: "completed", agentId: "A5" }) });
    runRoute(
      {
        ...o,
        freeMem: () => 2.2,
        waitTimeout: "2s",
        sleep: () => {},
        dropCache: () => { dropCalls++; return "dropped"; },
      },
      p,
      routesOff,
    );
    assert.equal(dropCalls, 0, "dropCache never called when routes.dropWslCache is absent");
  }
});
