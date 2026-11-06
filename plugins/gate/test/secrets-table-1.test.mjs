// Table: every secret form x every shape must block (shard 1 of 3, split so node --test runs the process-spawning scans in parallel).
import test from "node:test";
import assert from "node:assert/strict";
import { hasSecret } from "../server/gate.mjs";
import { SECRETS, shapes } from "./secrets-cases.mjs";

for (const name of ["jwt","bearer","pwdUnquoted","skOr","apiKeyPadded","pgp"]) for (const [shape, f] of Object.entries(shapes)) {
  test(`blocked: ${name} x ${shape}`, () => {
    const t = f(SECRETS[name]);
    assert.ok(hasSecret(t), JSON.stringify(t).slice(0, 80));
  });
}
