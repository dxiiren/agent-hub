// `npm test`: runs EVERY suite, never stops at the first failure (a red node suite must not hide the python ones), and exits 1 if any failed.
// Each suite gets a hermetic environment (scripts/test-env.mjs).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hermeticEnv, NEEDS_GITLEAKS, violationsFile } from "./test-env.mjs";
import { checkScanner } from "../plugins/gate/server/gate.mjs";

const py = process.env.AGENT_HUB_PYTHON ?? "python";
const steps = [
  ["config check", process.execPath, ["scripts/check-config.mjs"]],
  ["node tests", process.execPath, ["scripts/node-tests.mjs"]],
  ["python usage tests", py, ["-m", "unittest", "discover", "-s", "plugins/usage-otel/test", "-p", "*_test.py"]],
  ["python security hooks", py, [".claude/hooks/test_security_hooks.py"]],
  ["python no-force-push hook", py, [".claude/hooks/test_no_force_push.py"]],
];
const failed = [];
const violations = violationsFile();
for (const [name, cmd, args] of steps) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env: hermeticEnv() });
  if (r.status !== 0) failed.push(`${name} (${r.error ? r.error.message : `exit ${r.status}`})`);
}
// A test that read the developer's real local config passes on a bare clone and fails for everyone who set the hub up: fail it here.
const touched = readFileSync(violations, "utf8").trim();
if (touched) { console.log(`
TESTS TOUCHED THE REAL LOCAL CONFIG (they must use the hermetic env):
${touched}`); failed.push("hermetic guard"); }
// A clone without gitleaks skips the gate/secret suites. The exit code stays 0 (a fresh clone must be able to run `npm test`)
// unless AGENT_HUB_REQUIRE_FULL=1 (CI), but the end of the output says so loudly: a skip is never read as a full pass.
let skipped = "";
try { checkScanner(); } catch { skipped = `${NEEDS_GITLEAKS.size} suites skipped: gitleaks not found`; }
const strict = process.env.AGENT_HUB_REQUIRE_FULL === "1";
const NL = "\n";
if (skipped && !failed.length) {
  const bar = "!".repeat(78);
  console.log([NL + bar, `!!! NOT A FULL RUN: ${skipped}. Install gitleaks 8.30.1 or set AGENT_HUB_GITLEAKS.`, "!!! Set AGENT_HUB_REQUIRE_FULL=1 to make this a failure.", bar].join(NL));
}
console.log(NL + (failed.length ? `FAILED: ${failed.join("; ")}` : skipped ? `PASSED WITH SKIPS (${skipped})` : "ALL SUITES PASSED"));
process.exit(failed.length || (skipped && strict) ? 1 : 0);
