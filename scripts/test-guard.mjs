// Preloaded into every test process (NODE_OPTIONS --import, set by test-env.mjs): a test that reads the developer's REAL local config
// (config/*.local.*, routes.local.json, the real ~/.paseo) is a bug, because it passes on a bare CI clone and fails for everyone who set the hub up.
// The read is refused AND recorded to AGENT_HUB_TEST_VIOLATIONS; test-all.mjs fails the run if that file is non-empty (a swallowed error cannot hide it).
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve, join, sep, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const log = process.env.AGENT_HUB_TEST_VIOLATIONS;
const realHome = process.env.AGENT_HUB_TEST_REAL_HOME;
if (log) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const norm = (p) => resolve(String(p)).toLowerCase();
  const localDirs = [join(repo, "config"), join(repo, "config", "routes")].map(norm);
  const paseo = realHome ? norm(join(realHome, ".paseo")) : null;
  const bad = (p) => {
    if (typeof p !== "string" && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
    let f; try { f = norm(p instanceof URL ? fileURLToPath(p) : p); } catch { return false; }
    if (localDirs.includes(dirname(f)) && /[.]local[.-]|[.]local$|migrated/.test(basename(f)) && !/template/.test(basename(f))) return true;
    return !!paseo && (f === paseo || f.startsWith(paseo + sep));
  };
  for (const name of ["readFileSync", "existsSync", "statSync", "readdirSync", "openSync", "writeFileSync", "copyFileSync"]) {
    const orig = fs[name];
    fs[name] = function (p, ...rest) {
      if (bad(p)) { try { fs.appendFileSync(log, `${name} ${resolve(String(p))} (${process.argv[1] ?? "?"}) ${(new Error().stack.split("\n")[2] ?? "").trim()}\n`); } catch { /* best effort */ } throw Object.assign(new Error(`test touched the real local config: ${p}`), { code: "EACCES" }); }
      return orig.call(this, p, ...rest);
    };
  }
  syncBuiltinESMExports();
}
