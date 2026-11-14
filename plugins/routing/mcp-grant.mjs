// HUBFIX3 (rev 2, after the security review): caller-opt-in MCP servers for a route. NOT wired to any launcher yet.
// Rules: never read from the task folder; the caller names an absolute file OUTSIDE the task cwd and outside any git worktree;
// every server in it must be on the hub's own allowlist (config/hub.local.json "mcpAllow": [{name, command, args}]) by name AND exact command+args;
// never for read-only route types. Decide read-only first, load after.
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { isAbsolute, resolve, sep, dirname, join } from "node:path";

const inside = (child, parent) => { const c = resolve(child).toLowerCase(), p = resolve(parent).toLowerCase(); return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep); };
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
/** true when `file` sits in a git worktree or repo (a .git entry in it or any parent): an agent that can write there could rewrite the file. */
export const inGitTree = (file) => { for (let d = dirname(resolve(file)); ; d = dirname(d)) { if (existsSync(join(d, ".git"))) return true; if (dirname(d) === d) return false; } };

/**
 * -> { servers: [ACP mcpServers entries] } or { refused: "one clear line" }.
 * flag = the caller's --mcp-config value; allow = hub.local.json mcpAllow; readOnly = the route type is read-only.
 */
export function grantMcp({ flag, cwd, allow = [], readOnly = false, readFile = (f) => readFileSync(f, "utf8") }) {
  if (flag === undefined || flag === null || flag === "") return { servers: [] }; // default: only the hub's own MCP
  if (readOnly) return { refused: "--mcp-config is refused on a read-only route (summarise/review get no extra tools): use an edit-capable route type" };
  if (!isAbsolute(String(flag))) return { refused: "--mcp-config needs an absolute file path" };
  const f = real(flag), c = real(cwd ?? ".");
  if (inside(f, c)) return { refused: "--mcp-config file is inside the task folder: the agent could write it; keep it outside the task folder and outside any git worktree" };
  if (inGitTree(f)) return { refused: "--mcp-config file is inside a git worktree/repo: keep it outside any git tree" };
  let j; try { j = JSON.parse(readFile(f).replace(/^﻿/, "")); } catch (e) { return { refused: "--mcp-config file unreadable or not JSON: " + String(e.message).slice(0, 80) }; }
  const servers = [];
  for (const [name, s] of Object.entries(j?.mcpServers ?? {})) {
    const ok = (allow ?? []).find((a) => a?.name === name && (a.command ?? null) === (s?.command ?? null) && JSON.stringify(a.args ?? []) === JSON.stringify(s?.args ?? []) && (a.url ?? null) === (s?.url ?? null));
    if (!ok) return { refused: `MCP server "${name}" is not on the hub allowlist (config/hub.local.json mcpAllow) with exactly this command and args: ask akmal to add it` };
    const kv = (o) => Object.entries(o ?? {}).map(([k, v]) => ({ name: k, value: String(v) }));
    servers.push(s.command ? { name, command: s.command, args: s.args ?? [], env: kv(s.env) } : { type: s.type === "sse" ? "sse" : "http", name, url: s.url, headers: kv(s.headers) });
  }
  return { servers };
}
