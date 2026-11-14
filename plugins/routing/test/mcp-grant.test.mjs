import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantMcp } from "../mcp-grant.mjs";

const cfg = (servers) => JSON.stringify({ mcpServers: servers });
const ALLOW = [{ name: "swing", command: "node", args: ["swing.js"] }];
const setup = () => { const root = mkdtempSync(join(tmpdir(), "mcpg-")); const cwd = join(root, "task"), out = join(root, "cfg"); mkdirSync(cwd); mkdirSync(out); mkdirSync(join(cwd, ".git")); return { cwd, out }; };

test("no flag = nothing loaded, even with a .mcp.json in the task folder (default is only the hub's own MCP)", () => {
  const { cwd } = setup(); writeFileSync(join(cwd, ".mcp.json"), cfg({ evil: { command: "calc.exe" } }));
  assert.deepEqual(grantMcp({ cwd, allow: ALLOW }), { servers: [] });
});
test("flag with a file inside the task folder is refused", () => {
  const { cwd } = setup(); const f = join(cwd, "m.json"); writeFileSync(f, cfg({ swing: { command: "node", args: ["swing.js"] } }));
  assert.match(grantMcp({ flag: f, cwd, allow: ALLOW }).refused, /inside the task folder/);
});
test("flag with a file inside any git tree is refused", () => {
  const { cwd } = setup(); const other = mkdtempSync(join(tmpdir(), "mcpg-git-")); mkdirSync(join(other, ".git")); const f = join(other, "m.json"); writeFileSync(f, cfg({ swing: { command: "node", args: ["swing.js"] } }));
  assert.match(grantMcp({ flag: f, cwd, allow: ALLOW }).refused, /git/);
});
test("a server not on the allowlist, or with a changed command or args, is refused", () => {
  const { cwd, out } = setup(); const f = join(out, "m.json");
  writeFileSync(f, cfg({ other: { command: "node", args: ["swing.js"] } })); assert.match(grantMcp({ flag: f, cwd, allow: ALLOW }).refused, /not on the hub allowlist/);
  writeFileSync(f, cfg({ swing: { command: "calc.exe", args: ["swing.js"] } })); assert.match(grantMcp({ flag: f, cwd, allow: ALLOW }).refused, /not on the hub allowlist/);
  writeFileSync(f, cfg({ swing: { command: "node", args: ["swing.js", "--x"] } })); assert.match(grantMcp({ flag: f, cwd, allow: ALLOW }).refused, /not on the hub allowlist/);
});
test("the flag on a read-only type is refused before the file is even read", () => {
  const { cwd, out } = setup(); const f = join(out, "m.json"); writeFileSync(f, cfg({ swing: { command: "node", args: ["swing.js"] } }));
  assert.match(grantMcp({ flag: f, cwd, allow: ALLOW, readOnly: true, readFile: () => { throw new Error("read"); } }).refused, /read-only/);
});
test("allowlisted swing via the flag on an edit-capable type is loaded", () => {
  const { cwd, out } = setup(); const f = join(out, "m.json"); writeFileSync(f, cfg({ swing: { command: "node", args: ["swing.js"], env: { A: "1" } } }));
  assert.deepEqual(grantMcp({ flag: f, cwd, allow: ALLOW }), { servers: [{ name: "swing", command: "node", args: ["swing.js"], env: [{ name: "A", value: "1" }] }] });
});
