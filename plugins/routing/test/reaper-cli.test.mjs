import test from "node:test";
import assert from "node:assert/strict";
import { parseCliResult } from "../reaper.mjs";

test("a JSON error on stderr (non-zero exit) is parsed, so 'not found' counts as already cleaned (HUBFIX3)", () => {
  const err = JSON.stringify({ error: { code: "AGENT_NOT_FOUND", message: "Agent not found: x" } }, null, 2);
  const r = parseCliResult(new Error("Command failed"), "", err);
  assert.match(r.error, /not found/i);
});
test("stdout JSON wins; garbage everywhere gives a plain error line", () => {
  assert.deepEqual(parseCliResult(null, '{"ok":1}', ""), { ok: 1 });
  assert.match(parseCliResult(new Error("boom"), "", "").error, /boom/);
});
