import "./isolate-run-dir.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createWorktree, withRetry } from "../route.mjs";

const o = { base: "abc", cwd: "C:/r" };
const quiet = { log: () => {}, sleep: () => {} };
const clock = () => { let t = 0; return () => (t += 3000); };

test("a timed-out create is sent once, never retried, and the worktree is found on disk", () => {
  const calls = []; let polls = 0;
  const p = withRetry((a, opts) => { calls.push([a, opts]); return { error: "exit=1 Error: Timeout waiting for message (60000ms)" }; }, { sleep: () => {} });
  const c = createWorktree(p, o, { ...quiet, now: clock(), find: () => (++polls < 3 ? null : "C:/home/worktrees/h/route-x") });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].noRetry, true);
  assert.equal(c.worktreePath, "C:/home/worktrees/h/route-x");
});

test("a daemon that never finishes the create: daemonBusy after the limit, still one request", () => {
  let n = 0;
  const c = createWorktree(() => { n++; return { error: "no answer in 120 s: the call was stopped" }; }, o, { ...quiet, now: clock(), find: () => null, limitS: 30 });
  assert.equal(n, 1);
  assert.equal(c.daemonBusy, true);
  assert.match(c.error, /WORKTREE_CREATE_TIMEOUT/);
});

test("a real git failure is returned as is (the provider loop reports it)", () => {
  const c = createWorktree(() => ({ error: "exit=1 fatal: not a git repository" }), o, { ...quiet, find: () => { throw new Error("must not poll"); } });
  assert.match(c.error, /not a git repository/);
  assert.ok(!c.daemonBusy);
});
