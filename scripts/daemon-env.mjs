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
/** The hub's and Paseo's own variables, by EXACT name (found by grepping this repo and the Paseo CLI for what the daemon reads; no prefix wildcard, so a new or foreign PASEO_* / AGENT_HUB_* name is dropped until listed here). */
const OWN = `PASEO_HOME PASEO_LISTEN PASEO_LOG_LEVEL PASEO_LOG_FORMAT PASEO_PRIMARY_LAN_IP PASEO_CLI PASEO_OPENCODE_BRIDGE_URL PASEO_GIT_TRACE_FILE
  AGENT_HUB_HOME AGENT_HUB_PORT AGENT_HUB_REPO AGENT_HUB_MCP AGENT_HUB_ROUTES AGENT_HUB_OTLP AGENT_HUB_POLLER_DIR AGENT_HUB_DEV AGENT_HUB_CLIENT
  AGENT_HUB_CLIENT_ROOT AGENT_HUB_SESSION AGENT_HUB_GATE_DIR AGENT_HUB_GITLEAKS AGENT_HUB_PYTHON AGENT_HUB_USAGE_DIR AGENT_HUB_USAGE_HOME
  AGENT_HUB_CREATE_TIMEOUT_S AGENT_HUB_LOGS_TIMEOUT_S AGENT_HUB_HEALTH_MS AGENT_HUB_RESOLVE_CACHE AGENT_HUB_RESOLVE_CACHE_OFFICE AGENT_HUB_QCREDITS_CMD
  AGENT_HUB_QODER_PIN AGENT_HUB_OC_XDG_CACHE AGENT_HUB_OC_XDG_CONFIG AGENT_HUB_OC_XDG_DATA AGENT_HUB_KINDS AGENT_HUB_LOCAL AGENT_HUB_ONLY
  AGENT_HUB_WRAP_DRYRUN AGENT_HUB_NO_USAGE_STACK AGENT_HUB_PASEO AGENT_HUB_TASK`.split(/\s+/);
for (const n of OWN) BASE.add(n);
/** OS families that are not secrets and have many members. */
const PREFIX = ["LC_", "XDG_", "PROCESSOR_", "PROGRAMFILES", "COMMONPROGRAMFILES", "COMMONPROGRAMW6432"];
/** Second guard, for the explicit extras: a credential-looking name or a value with user:pass@ is dropped unless the owner named it exactly. PWD alone (the cwd) is not a password. */
export const SECRETISH = /TOKEN|SECRET|PASS|PWD|CRED|JWT|COOKIE|DSN|CONN|(^|_)(API_?)?KEY|KEY$|(^|_)PAT($|_)|AUTH|PRIVATE|SESSION_ID/i;
const URLCRED = /:\/\/[^\/\s:@]*:[^\/\s@]*@/;
const bad = (u, v) => (u !== "PWD" && SECRETISH.test(u)) || URLCRED.test(String(v));

const wanted = (k, v, extras) => {
  const u = k.toUpperCase();
  if (URLCRED.test(String(v))) return false;
  if (extras.some((e) => u === e)) return true;
  if (bad(u, v)) return false;
  if (extras.some((e) => e.endsWith("*") && u.startsWith(e.slice(0, -1)))) return true;
  return BASE.has(u) || PREFIX.some((p) => u.startsWith(p));
};

/** Parse an extra allow-list: array or comma string; names are upper-cased, a trailing * is a prefix. */
export const parseExtras = (v) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((s) => String(s).trim().toUpperCase()).filter(Boolean);

/** Allow-listed copy of `env` (original key spelling kept). */
export function buildDaemonEnv(env, extras = []) {
  const ex = parseExtras(extras);
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && wanted(k, v, ex)) out[k] = v;
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
