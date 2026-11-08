#!/usr/bin/env node
// The one launcher for `paseo daemon ...`: the daemon (and so every agent Paseo starts) gets an allow-listed environment, never the
// caller's whole one. An agent can run `env`; tokens, API keys and passwords in the shell that started the hub must not be in it.
// Agent CLIs keep their own logins in their config dirs (~/.codex, ~/.claude, qodercli login ...), which need no environment variable.
// Usage: node scripts/daemon-env.mjs <paseo-binary> <paseo args...>     Extras: AGENT_HUB_ENV_ALLOW (comma list) or "daemonEnvAllow" in config/hub.local.json.
import { spawnSafe } from "./../plugins/routing/spawn-safe.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
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
  AGENT_HUB_WRAP_DRYRUN AGENT_HUB_NO_USAGE_STACK AGENT_HUB_PASEO AGENT_HUB_TASK UV_THREADPOOL_SIZE`.split(/\s+/);
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

/** Names (never values) of the environment the launcher gave the daemon, recorded at each start so `doctor` can audit what the daemon really received. */
export const envNamesFile = (env = process.env) => join(env.AGENT_HUB_HOME || env.PASEO_HOME || join(homedir(), ".paseo"), "agent-hub-daemon-env.json");
/** Names in a recorded list that the allow-list would NOT have passed (a credential-looking or unlisted name = the launcher was bypassed or is broken). */
export const auditNames = (names, extras = []) => names.filter((n) => buildDaemonEnv({ [n]: "x" }, extras)[n] === undefined);

/** Credential-looking names among `names` (the SECRETISH rule; PWD alone is the cwd). */
export const credentialNames = (names) => names.filter((n) => n.toUpperCase() !== "PWD" && SECRETISH.test(n));
/** Names (never values) of the environment of the RUNNING process `pid`, read from the process itself: Windows via scripts/live-env.ps1 (its PEB), Linux /proc/<pid>/environ, macOS `ps eww`.
 *  Returns { names } or { error }. Only same-user processes can be read. */
export function liveEnvNames(pid, { run = spawnSync } = {}) {
  const n = Number(pid); if (!Number.isInteger(n) || n <= 0) return { error: "no pid" };
  try {
    if (process.platform === "win32") {
      const r = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(dirname(fileURLToPath(import.meta.url)), "live-env.ps1"), "-ProcessId", String(n)], { encoding: "utf8", timeout: 30000, windowsHide: true });
      if (r.status !== 0) return { error: String(r.stderr || "powershell failed").trim().split(/\r?\n/)[0].slice(0, 160) };
      return { names: String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };
    }
    try { return { names: readFileSync(`/proc/${n}/environ`, "utf8").split(String.fromCharCode(0)).map((kv) => kv.split("=")[0]).filter(Boolean) }; } catch { /* not Linux */ }
    const r = run("ps", ["eww", "-o", "command=", "-p", String(n)], { encoding: "utf8", timeout: 8000 });
    const names = [...String(r.stdout).matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]);
    return names.length ? { names: [...new Set(names)] } : { error: "environment not readable" };
  } catch (e) { return { error: String(e.message ?? e).slice(0, 160) }; }
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
export function localExtras(env = process.env) {
  let cfg = [];
  if (env.AGENT_HUB_NO_LOCAL !== "1") try { cfg = JSON.parse(readFileSync(join(REPO, "config", "hub.local.json"), "utf8")).daemonEnvAllow ?? []; } catch { /* no local config */ }
  return [...parseExtras(cfg), ...parseExtras(env.AGENT_HUB_ENV_ALLOW)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [bin, ...args] = process.argv.slice(2);
  if (!bin) { console.error("usage: daemon-env.mjs <paseo-binary> <args...>"); process.exit(2); }
  const env = buildDaemonEnv(process.env, localExtras());
  let child; try { child = spawnSafe(bin, args, { env, stdio: "inherit" }); } catch (e) { console.error(`[FAIL] ${e.message}`); process.exit(1); } // .cmd shims run as node <entry>, never through a shell
  try { const f = envNamesFile(process.env); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify({ at: Date.now(), launcherPid: process.pid, args: args.slice(0, 2), names: Object.keys(env).sort() })); } catch { /* diagnostics only */ }
  child.on("exit", (c, s) => process.exit(c ?? (s ? 1 : 0)));
  child.on("error", (e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
}
