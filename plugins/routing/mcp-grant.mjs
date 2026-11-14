// HUBFIX3 (rev 3, after two security reviews): caller-opt-in MCP servers for a route, by NAME only. HUBLANE: wired to route.mjs (--mcp) and the ACP launchers (HUB_MCP env = names only).
// The caller (never the agent's task text) passes `--mcp swing[,other]`. Each name must be on the hub's own allowlist
// (config/hub.local.json "mcpAllow": [{name, command, args, env?, url?, headers?}]); command, args, env, url and headers ALL come from
// that entry, so the caller can set nothing but which allowlisted servers it wants. Never read from the task folder or any caller file.
// Never for read-only route types (decide read-only first, load after).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** -> { servers: [ACP mcpServers entries] } or { refused: "one clear line" }. */
export function grantMcp({ names, allow = [], readOnly = false }) {
  const want = (Array.isArray(names) ? names : String(names ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean);
  if (!want.length) return { servers: [] }; // default: only the hub's own MCP
  if (readOnly) return { refused: "--mcp is refused on a read-only route (summarise/review get no extra tools): use an edit-capable route type" };
  const kv = (o) => Object.entries(o ?? {}).map(([k, v]) => ({ name: k, value: String(v) }));
  const servers = [];
  for (const name of [...new Set(want)]) {
    const a = (allow ?? []).find((x) => x?.name === name);
    if (!a) return { refused: `MCP server "${name}" is not on the hub allowlist (config/hub.local.json mcpAllow): ask akmal to add it` };
    servers.push(a.command ? { name, command: a.command, args: a.args ?? [], env: kv(a.env) } : { type: a.type === "sse" ? "sse" : "http", name, url: a.url, headers: kv(a.headers) });
  }
  return { servers };
}

/** The ONLY thing a caller hands a launcher: the env var HUB_MCP holding server NAMES. The launcher re-resolves them against the hub's own allowlist, so nothing else in the caller's env or files is ever read. */
export const MCP_ENV = "HUB_MCP";
/** Hub-owned allowlist: config/hub.local.json "mcpAllow" (git-ignored). [] when absent or unreadable. */
export function loadMcpAllow(file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "hub.local.json")) {
  try { const a = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")).mcpAllow; return Array.isArray(a) ? a : []; } catch { return []; }
}
/** Launcher side: names from env -> { servers, preamble } or { refused }. */
export function grantFromEnv(env = process.env, allow = loadMcpAllow()) {
  const names = String(env[MCP_ENV] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!names.length) return { servers: [], preamble: "" };
  const g = grantMcp({ names, allow }); if (g.refused) return g;
  return { servers: g.servers, preamble: mcpPreamble(g.servers.map((x) => x.name)) };
}
/** The hub's own instruction for a granted MCP (the caller's prompt stays clean). Some providers (Qoder) list a granted server's tools as deferred and use them only after they are loaded. */
export const mcpPreamble = (names) => `[hub] MCP server${names.length > 1 ? "s" : ""} ${names.map((n) => `"${n}"`).join(", ")} ${names.length > 1 ? "are" : "is"} granted to this task and its tools are named mcp__<server>__<tool>. If those tools are not in your tool list yet, they are deferred: load them first (use your tool-search / "select" tool with the server name, e.g. "select:mcp__${names[0]}__*" or a keyword search for "${names[0]}") before saying they are missing. Use only the tools the task needs.

`;
