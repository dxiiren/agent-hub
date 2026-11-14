import test from "node:test";
import assert from "node:assert/strict";
import { alive as guardsAlive } from "../guards.mjs";
import { alive as gateAlive } from "../entry-gate.mjs";
import { alive as lockAlive } from "../lock.mjs";

const k = (code) => () => { if (code) throw Object.assign(new Error(code), { code }); };
const OLD = (pid, kill) => { try { kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } }; // the pre-fix one-liner

test("proof the old check fails: EPERM -> old says alive, new says dead", () => {
  assert.equal(OLD(1, k("EPERM")), true);
  assert.equal(guardsAlive(1, k("EPERM")), false);
});
for (const [name, fn] of [["guards", guardsAlive], ["entry-gate", gateAlive], ["lock", lockAlive]]) {
  test(`${name}.alive: EPERM (reused system pid) and ESRCH are dead, success is alive`, () => {
    assert.equal(fn(1, k("EPERM")), false);
    assert.equal(fn(1, k("ESRCH")), false);
    assert.equal(fn(1, k(null)), true);
  });
}
