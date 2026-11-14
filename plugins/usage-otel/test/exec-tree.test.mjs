import test from "node:test";
import assert from "node:assert/strict";
import { execFileTree } from "../server/exec-tree.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// parent prints its grandchild's pid, then both sleep
const PARENT = `const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});console.log(c.pid);setTimeout(()=>{},60000)`;

test("timeout kills the whole child tree, not just the direct child", async (t) => {
  // The timeout is measured from spawn, but node's own startup under load can exceed any fixed value, so a real 1.5 s timer raced the
  // parent printing the grandchild pid. Fake only the exec-tree timer: fire it the moment the pid is read, so the kill always has a live tree.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let child;
  const result = new Promise((res) => { child = execFileTree(process.execPath, ["-e", PARENT], { timeout: 60000 }, (err, out) => res({ err, out })); });
  const gc = await new Promise((res) => { let buf = ""; child.stdout.on("data", (d) => { buf += d; if (buf.includes("\n")) res(Number(buf.trim())); }); });
  assert.ok(gc > 0);
  t.mock.timers.tick(60000);
  t.mock.timers.reset();
  const { err } = await result;
  assert.equal(err?.killed, true);
  const deadline = Date.now() + 10000; // condition wait, not a fixed sleep: Windows reaps the tree asynchronously under load
  while (alive(gc) && Date.now() < deadline) await wait(25);
  assert.equal(alive(gc), false, "grandchild still running");
});

test("normal exit returns stdout with no error", async () => {
  const { err, out } = await new Promise((res) => execFileTree(process.execPath, ["-e", 'console.log("{}")'], { timeout: 5000 }, (err, out) => res({ err, out })));
  assert.equal(err, null);
  assert.equal(out.trim(), "{}");
});
