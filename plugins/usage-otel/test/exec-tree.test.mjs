import test from "node:test";
import assert from "node:assert/strict";
import { execFileTree } from "../server/exec-tree.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// parent prints its grandchild's pid, then both sleep
const PARENT = `const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});console.log(c.pid);setTimeout(()=>{},60000)`;

test("timeout kills the whole child tree, not just the direct child", async () => {
  const { err, out } = await new Promise((res) => execFileTree(process.execPath, ["-e", PARENT], { timeout: 1500 }, (err, out) => res({ err, out })));
  assert.equal(err?.killed, true);
  const gc = Number(out.trim());
  assert.ok(gc > 0);
  await wait(500);
  assert.equal(alive(gc), false, "grandchild still running");
});

test("normal exit returns stdout with no error", async () => {
  const { err, out } = await new Promise((res) => execFileTree(process.execPath, ["-e", 'console.log("{}")'], { timeout: 5000 }, (err, out) => res({ err, out })));
  assert.equal(err, null);
  assert.equal(out.trim(), "{}");
});
