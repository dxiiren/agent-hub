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

/**
 * Env for an agent process and its tool subprocesses: the hub's endpoint-key variables and anything that looks like a credential
 * (names ending in API_KEY, TOKEN, PAT, SECRET, PASSWORD, CREDENTIALS) never reach it. An agent can run `env`; the daemon's own secrets must not be in it.
 */
export const SECRET_ENV = /(^|_)(API_?KEY|APIKEY|TOKEN|PAT|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;
export const scrubKeyEnv = (env) => { const e = {}; for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) e[k] = v; return e; };

/**
 * Local auth proxy: the agent talks to 127.0.0.1:<port> with a random per-launch secret as its "key"; this launcher swaps in the real
 * Bearer key and forwards to the one upstream origin and base path. The real key lives only in this process. Requests are refused unless
 * Host is this proxy (DNS rebinding), Authorization is exactly the secret, and the path stays under the upstream base; redirects are never followed.
 * Returns { base, secret, close }.
 */
const ENDPOINTS = new Set(["POST /chat/completions", "POST /completions", "POST /embeddings", "GET /models"]);
export async function startAuthProxy(upstreamBase, key, f = fetch) {
  const { createServer } = await import("node:http");
  const { randomBytes } = await import("node:crypto");
  const u = new URL(upstreamBase);
  const basePath = u.pathname.replace(/\/+$/, "");
  const secret = randomBytes(24).toString("hex");
  let port = 0;
  const deny = (res, code, msg) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(msg); };
  const srv = createServer(async (req, res) => {
    try {
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return deny(res, 403, "bad host");
      if (req.headers.authorization !== `Bearer ${secret}`) return deny(res, 401, "bad credentials");
      // Structural allow-list on the RAW path: only these OpenAI-compatible endpoints under the upstream base, and the outgoing URL is built here, never from req.url.
      const [rawPath, query] = [req.url.split("?")[0], req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : ""];
      if (/[%\\]/.test(rawPath) || rawPath.includes("//") || rawPath.split("/").some((x) => x === "." || x === "..")) return deny(res, 400, "bad path");
      if (!rawPath.startsWith(basePath + "/") || !ENDPOINTS.has(`${req.method} ${rawPath.slice(basePath.length)}`)) return deny(res, 404, "endpoint not allowed");
      const target = `${u.origin}${basePath}${rawPath.slice(basePath.length)}${query ? "?" + query : ""}`;
      const chunks = []; for await (const c of req) chunks.push(c);
      const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!["host", "authorization", "content-length", "connection"].includes(k)) headers[k] = v;
      headers.authorization = `Bearer ${key}`;
      const r = await f(target, { method: req.method, headers, redirect: "manual", body: ["GET", "HEAD"].includes(req.method) || !chunks.length ? undefined : Buffer.concat(chunks) });
      const out = {}; r.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
      res.writeHead(r.status, out);
      if (r.body) for await (const c of r.body) res.write(c);
      res.end();
    } catch (e) { if (!res.headersSent) res.writeHead(502); res.end(String(e?.message ?? e).split(key).join("***")); }
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  port = srv.address().port;
  return { base: `http://127.0.0.1:${port}${basePath}`, secret, close: () => srv.close() };
}

/** A provider base URL: http(s) only, a plain host[:port]/path (letters, digits and . _ ~ : / [ ] -), no credentials, query or fragment, none of & | < > ^ " ' ` % \ space or control characters. Returns the canonical form (no trailing slash) or "". */
export const SAFE_URL = /^https?:\/\/[A-Za-z0-9._~:/[\]-]+$/;
export function safeUrl(raw) {
  if (typeof raw !== "string" || !SAFE_URL.test(raw)) return "";
  let u; try { u = new URL(raw); } catch { return ""; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || !u.hostname) return "";
  return u.origin + u.pathname.replace(/\/+$/, "");
}
