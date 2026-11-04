import type { PluginServerContext } from "@getpaseo/plugin/server";
import { appendUsage, emitOtlp, toRecord, usageDir } from "./server/usage.mjs";
import { mcpCall } from "./server/mcp.mjs";

const MCP = process.env.AGENT_HUB_MCP ?? "http://127.0.0.1:6790/mcp/agents";

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.turn.after", async (event) => {
    if (event.outcome.kind !== "completed") return;
    try {
      const st: any = await mcpCall(MCP, process.env.PASEO_PASSWORD ?? "", "get_agent_status", { agentId: event.agent.id });
      const rec = toRecord({ ...st?.snapshot, id: event.agent.id, provider: st?.snapshot?.provider ?? event.agent.provider });
      appendUsage(usageDir(), rec);
      await emitOtlp(process.env.AGENT_HUB_OTLP, rec).catch((e) => console.error("agent-hub-usage otlp", String(e)));
    } catch (e) { console.error("agent-hub-usage", event.agent.id, String(e)); }
  });
  return () => {};
}
