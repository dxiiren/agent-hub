import test from "node:test";
import assert from "node:assert/strict";
import { hasSecret } from "../server/gate.mjs";

test("a code property read (res?.tokens) is not a credential, a real-looking value still is (HUBFIX3)", () => {
  assert.equal(hasSecret("const row = { tokens: res?.tokens, token: usage?.session?.value };"), false);
  assert.equal(hasSecret("token: sk_live_abcdef1234567890xyz"), true);
  assert.equal(hasSecret('password = "hunter2hunter2"'), true);
  assert.equal(hasSecret("api_key = Abcd1234?.efgh5678"), true, "a value that merely contains ?. but is not an identifier chain");
  assert.equal(hasSecret("password = hunter2.prodpass"), true, "a dotted value without ?. is not exempt");
});
