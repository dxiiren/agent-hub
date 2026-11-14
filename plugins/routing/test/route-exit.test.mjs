import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { routeExitCode, noRunLine } from "../route.mjs";

test("a route that ran on no provider exits 1 and says which were tried and why (HUBFIX3, T031)", () => {
  const res = { status: "failed", trace: [{ provider: "qwen-code-laptop", skip: "LAPTOP-REFUSED: free RAM 2.6 GB < 3" }, { provider: "claude-clean", skip: "slots full 2/2" }] };
  assert.equal(routeExitCode(res), 1);
  const l = noRunLine(res); assert.match(l, /no provider ran/); assert.match(l, /LAPTOP-REFUSED/); assert.match(l, /slots full/);
});
test("completed with an empty answer is not success; a real answer is 0; parked is 3", () => {
  assert.equal(routeExitCode({ used: "p", status: "completed", answer: "  " }), 1);
  assert.match(noRunLine({ used: "p", status: "completed", answer: "" }), /empty answer on p/);
  assert.equal(routeExitCode({ used: "p", status: "completed", answer: "ok" }), 0);
  assert.equal(noRunLine({ used: "p", status: "completed", answer: "ok" }), null);
  assert.equal(routeExitCode({ used: "p", status: "completed", answer: "", gate: { status: "PASS" } }), 0, "a gated edit may end with no prose");
  assert.equal(routeExitCode({ status: "asking" }), 3);
});

import { inlineFiles } from "../route.mjs";
test("read-only --file inputs are inlined into the prompt (no shell needed); over the cap the rest is named and shell is said to be refused (HUBFIX3)", () => {
  const read = (p) => ({ a: "alpha line\nneedle 42\n", b: "x".repeat(50) }[p]);
  const p = inlineFiles("Where is the needle?", [{ name: "a.txt", path: "a" }], 1000, read);
  assert.match(p, /=== FILE a\.txt ===\nalpha line\nneedle 42/); assert.match(p, /shell commands are refused/);
  const q = inlineFiles("q", [{ name: "a.txt", path: "a" }, { name: "b.txt", path: "b" }], 30, read);
  assert.match(q, /Not inlined \(over the size cap\): b\.txt/); assert.ok(!q.includes("xxxx"));
  assert.equal(inlineFiles("plain", [], 10, read), "plain");
});

import { grantReads } from "../route.mjs";
test("a refused shell command does not end the route: the agent carries on; the 3rd refusal ends it with a reason (HUBFIX3)", () => {
  const mk = (waits) => { const log = []; let w = 0; return { log, paseo: (a) => { log.push(a[0]); if (a[0] === "pending") return [{ agentId: "A", id: "p" + log.length, name: "run_shell_command", kind: "execute", command: "grep x f" }]; if (a[0] === "wait") return waits[w++]; return {}; } }; };
  const a = mk([{ status: "idle" }]); assert.equal(grantReads(a.paseo, { agentId: "A", status: "permission" }, 60, { cwd: "C:/x" }).status, "completed");
  assert.ok(a.log.includes("permit"), "the refusal was sent");
  const b = mk([{ status: "permission" }, { status: "permission" }, { status: "permission" }]); const r = grantReads(b.paseo, { agentId: "A", status: "permission" }, 60, { cwd: "C:/x" });
  assert.match(r.denied, /refused 3 times/);
});

test("a permission whose request is not listed yet is looked up again before the route gives up (HUBFIX3, big-input read)", () => {
  let looks = 0; const log = [];
  const paseo = (a) => { log.push(a[0]); if (a[0] === "pending") { looks++; return looks < 3 ? [] : [{ agentId: "A", id: "p1", name: "read_file", kind: "read", paths: [fileURLToPath(import.meta.url)] }]; } if (a[0] === "wait") return { status: "idle" }; return {}; };
  const r = grantReads(paseo, { agentId: "A", status: "permission" }, 60, { cwd: dirname(fileURLToPath(import.meta.url)), sleep: () => {} });
  assert.equal(r.status, "completed"); assert.equal(looks, 3); assert.ok(log.includes("permit"));
  const none = grantReads((a) => (a[0] === "pending" ? [] : {}), { agentId: "A", status: "permission" }, 60, { cwd: dirname(fileURLToPath(import.meta.url)), sleep: () => {} });
  assert.equal(none.status, "permission", "still nothing pending: the route ends as before");
});
