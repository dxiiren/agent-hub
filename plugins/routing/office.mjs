// Office / laptop model ids come from the server's own GET <base>/v1/models, never from config (owner 05-11: always the latest served model).
// Cached 10 min per base URL in a temp file because route.mjs and the launchers are new processes per task.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TTL = 10 * 60_000;
export const modelsUrl = (base) => base.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/models";
/** First served model id from an OpenAI-style /v1/models body, or "". */
// A served id flows into a spawned command line (shell on Windows .cmd), so only plain model-id characters are accepted.
export const SAFE_ID = /^[A-Za-z0-9._:\/-]{1,128}$/;
export const safeId = (id) => (typeof id === "string" && SAFE_ID.test(id) ? id : "");
export const firstId = (body) => (Array.isArray(body?.data) ? safeId(body.data.find((m) => m?.id)?.id ?? "") : "");

/** Async: served id of `base`; a fetch failure falls back to the last cached id, else to `fallback`. `f` is injectable for tests. */
export async function servedModel(base, { fallback = "", f = fetch, file = process.env.AGENT_HUB_RESOLVE_CACHE_OFFICE ?? join(tmpdir(), "agent-hub-office-models.json"), now = Date.now() } = {}) {
  let c = {}; try { c = JSON.parse(readFileSync(file, "utf8")); } catch { /* none */ }
  if (c[base] && safeId(c[base].id) && now - c[base].at < TTL) return c[base].id;
  try {
    const id = firstId(await (await f(modelsUrl(base), { signal: AbortSignal.timeout(4000) })).json());
    if (!id) throw new Error("no model listed");
    c[base] = { id, at: now }; try { writeFileSync(file, JSON.stringify(c)); } catch { /* cache is optional */ }
    return id;
  } catch (e) { if (c[base] && safeId(c[base].id)) return c[base].id; if (safeId(fallback)) return fallback; throw e; }
}

/** Sync wrapper for the sync resolver: runs this file as `--id <base> [fallback]` in a child. */
export function servedModelSync(base, fallback = "") {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--id", base, fallback], { encoding: "utf8", timeout: 8000 });
  const id = (r.stdout || "").trim();
  if (!id) throw new Error(`no served model at ${base}/v1/models`);
  return id;
}

/** Point the opencode office config at the served model id (rewritten only when it changed). */
export function syncOpencode(file, id) {
  if (!existsSync(file)) return false;
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (j.model === `office/${id}`) return false;
  const o = j.provider.office; const old = Object.values(o.models)[0] ?? {};
  o.models = { [id]: { ...old, name: id } }; j.model = `office/${id}`;
  writeFileSync(file, JSON.stringify(j, null, 2) + "\n"); return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === "--id") {
  try { console.log(await servedModel(process.argv[3], { fallback: process.argv[4] || "" })); } catch (e) { console.error(e.message); process.exit(1); }
}

/** Environment for every hub-launched Qwen Code (office, office 2, laptop): a system-settings file that turns its global auto-memory off, so ~/.qwen/memories (written by earlier, unrelated tasks) is never read into a new task and no new memory is extracted. Always forced: the user's own value would let the leak back in. */
export const QWEN_SYSTEM_SETTINGS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "qwen", "system-settings.json");
export const qwenEnv = (env = process.env) => ({ ...env, QWEN_CODE_SYSTEM_SETTINGS_PATH: QWEN_SYSTEM_SETTINGS });
