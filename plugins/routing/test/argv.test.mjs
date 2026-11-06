// Caller/agent text must reach paseo verbatim as a positional: options go before "--", text after it, for every paseo call that carries text.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPaseo, cliArgs, runReply, runRoute, park, parkFile, inputError, AGENT_ID_RE } from "../route.mjs";
import { safe } from "../../usage-otel/server/usage.mjs";

const TEXTS = ["--help", "-x", "--provider x", "--cwd C:\\", "-v", "--", "--json", "--home /tmp/x", "plain text", "multi\nline --flag"];
test("cliArgs: --home and --json go before the marker, text after it", () => {
  assert.deepEqual(cliArgs(["send", "id1", "--", "--help"], "H", true), ["send", "id1", "--home", "H", "--json", "--", "--help"]);
  assert.deepEqual(cliArgs(["ls"], undefined, true), ["ls", "--json"]);
  assert.deepEqual(cliArgs(["logs", "id1"], "H", false), ["logs", "id1", "--home", "H"]);
});
for (const text of TEXTS) {
  test(`cliPaseo argv: ${JSON.stringify(text)} arrives verbatim after "--" (send and run)`, () => {
    const seen = [];
    const spawn = (cmd, argv) => { seen.push(argv); return { status: 0, stdout: "{}" }; };
    const p = cliPaseo("H", { PASEO_BIN: "paseo" }, spawn);
    p(["send", "abc123", "--", text]); p(["run", "--cwd", "C:/x", "--provider", "codex", "--", text]);
    for (const a of seen) { const i = a.indexOf("--"); assert.deepEqual(a.slice(i + 1), [text]); assert.ok(a.slice(0, i).includes("--home") && a.slice(0, i).includes("--json")); }
  });
  test(`runReply and runRoute pass ${JSON.stringify(text)} after "--"`, () => {
    const d = mkdtempSync(join(tmpdir(), "argv-"));
    park({ agentId: "abc123", provider: "codex", type: "code-edit", asks: 1 }, { dir: d, reaper: false });
    const calls = [];
    runReply("abc123", text, (a) => { calls.push(a); return a[0] === "wait" ? { status: "idle" } : a[0] === "logs" ? { text: "done" } : {}; }, {}, { dir: d, reaper: false });
    const send = calls.find((a) => a[0] === "send"); assert.ok(send, "send called");
    assert.deepEqual(send.slice(0, 3), ["send", "abc123", "--"]); assert.ok(send[3].startsWith(text));
    const runs = [];
    runRoute({ type: "summarise", prompt: text, cwd: tmpdir(), session: "s1" }, (a) => { runs.push(a); return a[0] === "run" ? { agentId: "zz9", status: "completed" } : a[0] === "logs" ? { text: "x" } : {}; }, { routes: { summarise: ["codex"] }, readOnlyEnforced: ["codex"], readOnlyModes: { codex: "plan" } });
    const run = runs.find((a) => a[0] === "run"); if (run) { const i = run.indexOf("--"); assert.equal(run[i + 1], text); assert.equal(run.length, i + 2); }
  });
}
test("no paseo call site puts text before a marker: every send/run in route.mjs uses the marker", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../route.mjs", import.meta.url), "utf8");
  for (const m of src.matchAll(/paseo\(\[("send"|\.\.\.args)[^\]]*\]\)/g)) assert.match(m[0], /"--"/, m[0].slice(0, 60));
});

const RESERVED = ["CON", "PRN", "AUX", "NUL", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => ["COM" + n, "LPT" + n])];
const forms = (n) => [n, n.toLowerCase(), n[0] + n.slice(1).toLowerCase(), n + ".json", n.toLowerCase() + ".x.y"];
test("Windows device names are refused as ids, labels and usage file names (any case, with or without extension)", () => {
  const d = mkdtempSync(join(tmpdir(), "res-"));
  for (const n of RESERVED) for (const f of forms(n)) {
    assert.equal(parkFile(d, f), null, "parkFile " + f);
    for (const k of ["session", "dev", "client"]) assert.match(inputError({ [k]: f }) ?? "", /invalid/, k + " " + f);
    assert.ok(safe(f).startsWith("_"), "usage safe " + f);
  }
  for (const ok of ["CONSOLE", "com10", "lpt0", "nullable", "aux-1", "abc123", "COM"]) { assert.ok(parkFile(d, ok), ok); assert.equal(inputError({ session: ok }), null, ok); assert.equal(safe(ok), ok); }
});
