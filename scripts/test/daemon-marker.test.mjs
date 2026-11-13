import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "..", "daemon-main.mjs"), "utf8");
const env = readFileSync(join(here, "..", "daemon-env.mjs"), "utf8");
const oldFilter = (cmd) => /node(\.exe)?/i.test(cmd) && cmd.includes("@getpaseo") && cmd.includes(" run ");

test("old driver kill filter matches the pre-marker daemon command line but not the marked one", () => {
  const before = '"node.exe" --disable-warning=DEP0040 C:\npm\node_modules\@getpaseo\cli\bin\paseo daemon run --home C:\h';
  const after = '"node.exe" --disable-warning=DEP0040 C:\hub\scripts\daemon-main.mjs --title=agent-hub-daemon --home C:\h';
  assert.equal(oldFilter(before), true);
  assert.equal(oldFilter(after), false);
});

test("daemon-main keeps the CLI path in env, rewrites argv to daemon run, and daemon-env launches it for daemon run only", () => {
  assert.match(main, /AGENT_HUB_PASEO_ENTRY/);
  assert.match(main, /"daemon", "run"/);
  assert.match(env, /args\[0\] === "daemon" && args\[1\] === "run"/);
  assert.match(env, /daemon-main\.mjs/);
});
