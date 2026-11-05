import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
// Minimal MCP-over-HTTP client for the daemon's own /mcp/agents endpoint.
export async function mcpCall(url, token, tool, args) {
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + token };
  const post = async (body, sid) => {
    const r = await fetch(url, { method: "POST", headers: sid ? { ...h, "mcp-session-id": sid } : h, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); // a stuck daemon must not hold the plugin hook past Paseo's 30 s RPC limit
    const t = await r.text();
    const line = t.split("\n").find((l) => l.startsWith("data:"));
    const raw = (line ? line.slice(5) : t).trim();
    return { sid: r.headers.get("mcp-session-id") ?? sid, json: raw ? JSON.parse(raw) : null };
  };
  const i = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agent-hub", version: "1" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, i.sid);
  const r = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }, i.sid);
  return r.json?.result?.structuredContent ?? r.json;
}

/** Daemon password: env override, else the owner-only secret file (so the daemon never has to export it to the agents it spawns). */
export function hubPassword(env = process.env) {
  if (env.PASEO_PASSWORD) return env.PASEO_PASSWORD;
  try { return readFileSync(join(env.PASEO_HOME || join(os.homedir(), ".paseo"), "agent-hub-secret"), "utf8").trim(); } catch { return ""; }
}
