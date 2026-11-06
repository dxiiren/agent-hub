// Office / laptop model ids come from the server's own GET <base>/v1/models, never from config (owner 05-11: always the latest served model).
// Cached 10 min per base URL in a temp file because route.mjs and the launchers are new processes per task.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { writeJsonKeepEol } from "./jsonfile.mjs";
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
  writeJsonKeepEol(file, j); return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === "--id") {
  try { console.log(await servedModel(process.argv[3], { fallback: process.argv[4] || "" })); } catch (e) { console.error(e.message); process.exit(1); }
}

/** Environment for every hub-launched Qwen Code (office, office 2, laptop): a system-settings file that turns its global auto-memory off, so ~/.qwen/memories (written by earlier, unrelated tasks) is never read into a new task and no new memory is extracted. Always forced: the user's own value would let the leak back in. */
export const QWEN_SYSTEM_SETTINGS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "qwen", "system-settings.json");
export const QWEN_SYSTEM_SETTINGS_RO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "qwen", "system-settings-readonly.json");
/** readOnly = the launcher was started as the "-ro" twin provider (--read-only): sensitive reads are denied by the CLI itself. */
export const qwenEnv = (env = process.env, readOnly = false) => ({ ...env, QWEN_CODE_SYSTEM_SETTINGS_PATH: readOnly ? QWEN_SYSTEM_SETTINGS_RO : QWEN_SYSTEM_SETTINGS });
export const takeReadOnlyFlag = (argv) => { const i = argv.indexOf("--read-only"); if (i < 0) return false; argv.splice(i, 1); return true; };

/** Env for an agent process and its tool subprocesses: the hub's endpoint-key variables never reach it. */
export const scrubKeyEnv = (env) => { const e = { ...env }; delete e.HUB_OPENAI_API_KEY; delete e.OPENAI_API_KEY; return e; };

/**
 * Local auth proxy: the agent talks to 127.0.0.1:<port>, this launcher adds the Bearer key and forwards to the one upstream origin.
 * The key lives only in this process, never in the agent's env, argv or any file the agent could read. Returns { base, close }.
 */
export async function startAuthProxy(upstreamBase, key, f = fetch) {
  const { createServer } = await import("node:http");
  const u = new URL(upstreamBase);
  const srv = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!["host", "authorization", "content-length", "connection"].includes(k)) headers[k] = v;
      headers.authorization = `Bearer ${key}`;
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await f(u.origin + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
      const out = {}; r.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
      res.writeHead(r.status, out);
      if (r.body) for await (const c of r.body) res.write(c);
      res.end();
    } catch (e) { if (!res.headersSent) res.writeHead(502); res.end(String(e?.message ?? e).replace(key, "***")); }
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${srv.address().port}${u.pathname.replace(/\/$/, "")}`, close: () => srv.close() };
}
