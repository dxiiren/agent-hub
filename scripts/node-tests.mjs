// Runs the node test suites. The files that need the gitleaks binary are skipped, with the install step named, when none is found
// (AGENT_HUB_GITLEAKS, then tools/gitleaks, then PATH). The gate itself stays fail-closed at runtime; only this test run skips.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { hermeticEnv, NEEDS_GITLEAKS } from "./test-env.mjs";
import { checkScanner } from "../plugins/gate/server/gate.mjs";

const dirs = ["plugins/gate/test", "plugins/routing/test", "plugins/usage-otel/test", "scripts/test"];
let scanner = true;
try { checkScanner(); } catch (e) { scanner = false; console.log(`SKIP: ${[...NEEDS_GITLEAKS].join(", ")} need gitleaks 8.30.1 (${e.message}). Install it: see README, Prerequisites (set AGENT_HUB_GITLEAKS, or unzip into tools/gitleaks/, or put it on PATH).`); }
const files = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".test.mjs") && (scanner || !NEEDS_GITLEAKS.has(f))).map((f) => join(d, f)));
process.exit(spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", env: hermeticEnv() }).status ?? 1);
