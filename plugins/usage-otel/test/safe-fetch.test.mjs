import test from "node:test";
import assert from "node:assert/strict";
import { safeFetch } from "../server/safe-fetch.mjs";

test("a hanging usage.fetch returns within the timeout instead of blocking status", async () => {
  const f = safeFetch(() => new Promise(() => {}), { ms: 50 });
  const t = Date.now();
  const r = await f({});
  assert.ok(Date.now() - t < 1000);
  assert.equal(r.status, "error");
});

test("a slow fetch serves its last good value on the next call", async () => {
  let slow = false;
  const f = safeFetch(() => (slow ? new Promise(() => {}) : Promise.resolve({ status: "ok", n: 1 })), { ms: 50 });
  assert.equal((await f({})).n, 1);
  slow = true;
  assert.equal((await f({})).n, 1);
});
