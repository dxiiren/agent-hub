import test from "node:test";
import assert from "node:assert/strict";
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
