// HUBFIX3 (rev 3, after two security reviews): caller-opt-in MCP servers for a route, by NAME only. NOT wired to any launcher yet.
// The caller (never the agent's task text) passes `--mcp swing[,other]`. Each name must be on the hub's own allowlist
// (config/hub.local.json "mcpAllow": [{name, command, args, env?, url?, headers?}]); command, args, env, url and headers ALL come from
// that entry, so the caller can set nothing but which allowlisted servers it wants. Never read from the task folder or any caller file.
// Never for read-only route types (decide read-only first, load after).

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
