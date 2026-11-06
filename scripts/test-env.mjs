// Hermetic environment for every test run: the developer's own home, Paseo home and config/*.local.json are never read.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function hermeticEnv(base = process.env) {
  const h = mkdtempSync(join(tmpdir(), "agent-hub-test-home-"));
  return { ...base, HOME: h, USERPROFILE: h, APPDATA: join(h, "AppData", "Roaming"), LOCALAPPDATA: join(h, "AppData", "Local"), XDG_CONFIG_HOME: join(h, ".config"), XDG_DATA_HOME: join(h, ".local", "share"), XDG_CACHE_HOME: join(h, ".cache"),
    PASEO_HOME: join(h, ".paseo"), AGENT_HUB_HOME: join(h, ".paseo"), AGENT_HUB_NO_LOCAL: "1" };
}
