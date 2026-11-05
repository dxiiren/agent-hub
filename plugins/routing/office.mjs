// Office / laptop model ids come from the server's own GET <base>/v1/models, never from config (owner 05-11: always the latest served model).
// Cached 10 min per base URL in a temp file because route.mjs and the launchers are new processes per task.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TTL = 10 * 60_000;
export const modelsUrl = (base) => base.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/models";
/** First served model id from an OpenAI-style /v1/models body, or "". */
export const firstId = (body) => (Array.isArray(body?.data) ? body.data.find((m) => m?.id)?.id ?? "" : "");

/** Async: served id of `base`; a fetch failure falls back to the last cached id, else to `fallback`. `f` is injectable for tests. */
export async function servedModel(base, { fallback = "", f = fetch, file = process.env.AGENT_HUB_RESOLVE_CACHE_OFFICE ?? join(tmpdir(), "agent-hub-office-models.json"), now = Date.now() } = {}) {
  let c = {}; try { c = JSON.parse(readFileSync(file, "utf8")); } catch { /* none */ }
  if (c[base] && now - c[base].at < TTL) return c[base].id;
  try {
    const id = firstId(await (await f(modelsUrl(base), { signal: AbortSignal.timeout(4000) })).json());
    if (!id) throw new Error("no model listed");
    c[base] = { id, at: now }; try { writeFileSync(file, JSON.stringify(c)); } catch { /* cache is optional */ }
    return id;
  } catch (e) { if (c[base]) return c[base].id; if (fallback) return fallback; throw e; }
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
