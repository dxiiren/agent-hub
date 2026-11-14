import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantMcp } from "../mcp-grant.mjs";

const ALLOW = [{ name: "swing", command: "node", args: ["swing.js"], env: { JAVA_HOME: "C:/jdk" } }];

test("no names = nothing loaded, even with a .mcp.json in a task folder (the grant never reads any file)", () => {
  const d = mkdtempSync(join(tmpdir(), "mcpg-")); writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "calc.exe" } } }));
  assert.deepEqual(grantMcp({ allow: ALLOW }), { servers: [] });
  assert.deepEqual(grantMcp({ names: "", allow: ALLOW }), { servers: [] });
});
test("a name that is not on the allowlist is refused", () => {
  assert.match(grantMcp({ names: "evil", allow: ALLOW }).refused, /not on the hub allowlist/);
  assert.match(grantMcp({ names: "swing,evil", allow: ALLOW }).refused, /"evil"/);
});
test("the flag on a read-only type is refused", () => {
  assert.match(grantMcp({ names: "swing", allow: ALLOW, readOnly: true }).refused, /read-only/);
});
test("allowlisted swing on an edit-capable type is loaded with the ALLOWLIST's command, args and env; the caller cannot add loader variables", () => {
  const g = grantMcp({ names: "swing", allow: ALLOW, NODE_OPTIONS: "--require evil.js", env: { NODE_OPTIONS: "--require evil.js" }, command: "calc.exe" });
  assert.deepEqual(g, { servers: [{ name: "swing", command: "node", args: ["swing.js"], env: [{ name: "JAVA_HOME", value: "C:/jdk" }] }] });
  assert.ok(!JSON.stringify(g).includes("evil"));
});

import { grantFromEnv, mcpPreamble, loadMcpAllow } from "../mcp-grant.mjs";
test("launcher: HUB_MCP names resolve against the hub allowlist only; unknown name refused; preamble is the hub's", () => {
  const g = grantFromEnv({ HUB_MCP: "swing", HUB_MCP_COMMAND: "calc.exe", NODE_OPTIONS: "--require evil.js" }, ALLOW);
  assert.equal(g.servers[0].command, "node"); assert.ok(!JSON.stringify(g).includes("evil") && !JSON.stringify(g).includes("calc"));
  assert.match(g.preamble, /mcp__swing__/); assert.match(g.preamble, /deferred/);
  assert.match(grantFromEnv({ HUB_MCP: "nope" }, ALLOW).refused, /not on the hub allowlist/);
  assert.deepEqual(grantFromEnv({}, ALLOW), { servers: [], preamble: "" });
  assert.deepEqual(loadMcpAllow(join(tmpdir(), "does-not-exist.json")), []);
});
test("launcher never reads a task-folder .mcp.json or copies env/headers from a caller file", () => {
  const d = mkdtempSync(join(tmpdir(), "mcpg2-")); writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { swing: { command: "evil", env: { K: "v" }, headers: { A: "b" } } } }));
  const g = grantFromEnv({ HUB_MCP: "swing" }, [{ name: "swing", url: "http://127.0.0.1:1/mcp", headers: { H: "own" } }]);
  assert.deepEqual(g.servers, [{ type: "http", name: "swing", url: "http://127.0.0.1:1/mcp", headers: [{ name: "H", value: "own" }] }]);
  assert.ok(mcpPreamble(["a", "b"]).includes('"a", "b"'));
});
