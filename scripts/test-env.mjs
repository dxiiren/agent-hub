// Hermetic environment for every test run: the developer's own home, Paseo home and config/*.local.json are never read.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSyncSafe } from "../plugins/routing/spawn-safe.mjs";

// npm finds the global root from %APPDATA%\npm, so a redirected APPDATA made `npm root -g` miss the real global bcryptjs (4 hub configure tests failed in every full run): pin the prefix first.
const npmPrefix = (base) => { const r = spawnSyncSafe("npm", ["config", "get", "prefix"], { encoding: "utf8", env: base }); return r.status === 0 ? r.stdout.trim() : ""; };
export function hermeticEnv(base = process.env) {
  const h = mkdtempSync(join(tmpdir(), "agent-hub-test-home-"));
  const prefix = npmPrefix(base);
  return { ...base, ...(prefix ? { npm_config_prefix: prefix } : {}), HOME: h, USERPROFILE: h, APPDATA: join(h, "AppData", "Roaming"), LOCALAPPDATA: join(h, "AppData", "Local"), XDG_CONFIG_HOME: join(h, ".config"), XDG_DATA_HOME: join(h, ".local", "share"), XDG_CACHE_HOME: join(h, ".cache"),
    PASEO_HOME: join(h, ".paseo"), AGENT_HUB_HOME: join(h, ".paseo"), AGENT_HUB_NO_LOCAL: "1",
    // scripts/test-guard.mjs refuses (and records) any read of the real config/*.local.* or the real ~/.paseo
    AGENT_HUB_TEST_REAL_HOME: base.AGENT_HUB_TEST_REAL_HOME ?? homedir(), AGENT_HUB_TEST_VIOLATIONS: violationsFile(base),
    NODE_OPTIONS: (base.NODE_OPTIONS ?? "").includes("test-guard") ? base.NODE_OPTIONS : `${base.NODE_OPTIONS ?? ""} --import ${pathToFileURL(GUARD).href}`.trim() };
}
const GUARD = join(dirname(fileURLToPath(import.meta.url)), "test-guard.mjs");
/** One violations file per top-level run (inherited by nested runs), created empty so test-all can read it afterwards. */
export function violationsFile(base = process.env) {
  if (base.AGENT_HUB_TEST_VIOLATIONS) return base.AGENT_HUB_TEST_VIOLATIONS;
  const f = join(mkdtempSync(join(tmpdir(), "agent-hub-violations-")), "violations.txt"); writeFileSync(f, ""); process.env.AGENT_HUB_TEST_VIOLATIONS = f; return f;
}
// Test files that need the gitleaks binary; `npm test` skips them (loudly) when none is found.
export const NEEDS_GITLEAKS = new Set(["gate.test.mjs", "secrets-table.test.mjs", "secrets-table-0.test.mjs", "secrets-table-1.test.mjs", "secrets-table-2.test.mjs", "argv.test.mjs", "talkback.test.mjs"]);
