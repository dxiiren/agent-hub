// `npm test`: runs EVERY suite, never stops at the first failure (a red node suite must not hide the python ones), and exits 1 if any failed.
// Each suite gets a hermetic environment (scripts/test-env.mjs).
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./test-env.mjs";

const py = process.env.AGENT_HUB_PYTHON ?? "python";
const steps = [
  ["config check", process.execPath, ["scripts/check-config.mjs"]],
  ["node tests", process.execPath, ["scripts/node-tests.mjs"]],
  ["python usage tests", py, ["-m", "unittest", "discover", "-s", "plugins/usage-otel/test", "-p", "*_test.py"]],
  ["python security hooks", py, [".claude/hooks/test_security_hooks.py"]],
  ["python no-force-push hook", py, [".claude/hooks/test_no_force_push.py"]],
];
const failed = [];
for (const [name, cmd, args] of steps) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env: hermeticEnv() });
  if (r.status !== 0) failed.push(`${name} (${r.error ? r.error.message : `exit ${r.status}`})`);
}
console.log(failed.length ? `\nFAILED: ${failed.join("; ")}` : "\nALL SUITES PASSED");
process.exit(failed.length ? 1 : 0);
