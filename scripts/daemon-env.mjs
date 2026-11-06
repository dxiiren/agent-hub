#!/usr/bin/env node
// The one launcher for `paseo daemon ...`: the daemon (and so every agent Paseo starts) gets an allow-listed environment, never the
// caller's whole one. An agent can run `env`; tokens, API keys and passwords in the shell that started the hub must not be in it.
// Agent CLIs keep their own logins in their config dirs (~/.codex, ~/.claude, qodercli login ...), which need no environment variable.
// Usage: node scripts/daemon-env.mjs <paseo-binary> <paseo args...>     Extras: AGENT_HUB_ENV_ALLOW (comma list) or "daemonEnvAllow" in config/hub.local.json.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Exact names (compared upper-case: Windows variable names are case-insensitive). */
const BASE = new Set(`PATH PATHEXT SYSTEMROOT SYSTEMDRIVE WINDIR COMSPEC TEMP TMP TMPDIR HOME USERPROFILE HOMEDRIVE HOMEPATH APPDATA LOCALAPPDATA
  PROGRAMDATA ALLUSERSPROFILE PUBLIC PSMODULEPATH USERNAME USER LOGNAME USERDOMAIN USERDOMAIN_ROAMINGPROFILE COMPUTERNAME LOGONSERVER SESSIONNAME OS
  NUMBER_OF_PROCESSORS LANG LANGUAGE TERM COLORTERM SHELL TZ DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS PWD
  CODEX_HOME CLAUDE_CONFIG_DIR`.split(/\s+/));
/** Prefixes: OS families and the hub's own variables. */
const PREFIX = ["LC_", "XDG_", "PROCESSOR_", "PROGRAMFILES", "COMMONPROGRAMFILES", "COMMONPROGRAMW6432", "PASEO_", "AGENT_HUB_"];
/** A credential-looking name is dropped even under the hub prefixes (PASEO_PASSWORD, AGENT_HUB_SECRET_FILE ...). Explicit extras are the only way back in. */
export const SECRETISH = /TOKEN|SECRET|PASS|CRED|(^|_)(API_?)?KEY|KEY$|(^|_)PAT($|_)|AUTH|PRIVATE|SESSION_ID/i;

const wanted = (k, extras) => {
  const u = k.toUpperCase();
  if (extras.some((e) => (e.endsWith("*") ? u.startsWith(e.slice(0, -1)) : u === e))) return true;
  if (u === "SESSIONNAME") return true;
  if (SECRETISH.test(u)) return false;
  return BASE.has(u) || PREFIX.some((p) => u.startsWith(p));
};

/** Parse an extra allow-list: array or comma string; names are upper-cased, a trailing * is a prefix. */
export const parseExtras = (v) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((s) => String(s).trim().toUpperCase()).filter(Boolean);

/** Allow-listed copy of `env` (original key spelling kept). */
export function buildDaemonEnv(env, extras = []) {
  const ex = parseExtras(extras);
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && wanted(k, ex)) out[k] = v;
  return out;
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
export function localExtras(env = process.env) {
  let cfg = [];
  try { cfg = JSON.parse(readFileSync(join(REPO, "config", "hub.local.json"), "utf8")).daemonEnvAllow ?? []; } catch { /* no local config */ }
  return [...parseExtras(cfg), ...parseExtras(env.AGENT_HUB_ENV_ALLOW)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [bin, ...args] = process.argv.slice(2);
  if (!bin) { console.error("usage: daemon-env.mjs <paseo-binary> <args...>"); process.exit(2); }
  const env = buildDaemonEnv(process.env, localExtras());
  const q = (s) => `"${s}"`; // .cmd shims on Windows need a shell; every part is quoted
  const child = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)
    ? spawn(`${q(bin)} ${args.map(q).join(" ")}`, { env, stdio: "inherit", shell: true })
    : spawn(bin, args, { env, stdio: "inherit" });
  child.on("exit", (c, s) => process.exit(c ?? (s ? 1 : 0)));
  child.on("error", (e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
}
