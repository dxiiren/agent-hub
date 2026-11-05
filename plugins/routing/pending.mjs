#!/usr/bin/env node
// Prints the daemon's pending permission requests as JSON [{agentId, id, name, kind, paths}]. The paseo CLI's `permit ls` hides the path, so ask the daemon's MCP door (same one the plugins use).
import { mcpCall, hubPassword } from "../gate/server/mcp.mjs";

export function normalise(res) {
  return (res?.permissions ?? []).map((p) => {
    const tc = p.request?.metadata?.rawRequest?.toolCall ?? {};
    const raw = tc.rawInput ?? {};
    const paths = [...(tc.locations ?? []).map((l) => l.path), raw.file_path, raw.path, raw.absolute_path, raw.dir_path, ...(Array.isArray(raw.paths) ? raw.paths : [])].filter((x) => typeof x === "string" && x);
    return { agentId: p.agentId, id: p.request?.id, name: p.request?.name, kind: tc.kind ?? p.request?.detail?.type, paths: [...new Set(paths)], extras: ["pattern", "glob", "include", "recursive", "exclude"].some((k) => raw[k] != null) };
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const url = `http://127.0.0.1:${process.env.AGENT_HUB_PORT || "6767"}/mcp/agents`;
  mcpCall(url, hubPassword(), "list_pending_permissions", {}).then((r) => console.log(JSON.stringify(normalise(r)))).catch((e) => { console.log(JSON.stringify({ error: String(e) })); });
}
