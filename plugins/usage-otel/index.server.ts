import type { PluginServerContext } from "@getpaseo/plugin/server";
import { appendUsage, emitOtlp, toRecord, usageDir } from "./server/usage.mjs";
import { mcpCall, hubPassword } from "./server/mcp.mjs";
import { fillRecord, qoderCredits, qoderSession, qwenSession } from "./server/sidecar.mjs";
import { join } from "node:path";

const MCP = process.env.AGENT_HUB_MCP ?? "http://127.0.0.1:6790/mcp/agents";

const preCredits = new Map<string, number | null>();

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.turn.before", async (event) => {
    if (event.agent.provider.startsWith("qoder")) preCredits.set(event.agent.id, await qoderCredits());
  });
  server.addHook("agent.turn.after", async (event) => {
    if (event.outcome.kind !== "completed") return;
    try {
      const st: any = await mcpCall(MCP, hubPassword(), "get_agent_status", { agentId: event.agent.id });
      const rec = toRecord({ ...st?.snapshot, id: event.agent.id, provider: st?.snapshot?.provider ?? event.agent.provider });
      const sid = st?.snapshot?.runtimeInfo?.sessionId;
      if (rec.provider.startsWith("qwen")) fillRecord(rec, join(usageDir(), "cursor.json"), { tokens: qwenSession(sid) });
      else if (rec.provider.startsWith("qoder")) {
        const a = await qoderCredits(), b = preCredits.get(event.agent.id);
        fillRecord(rec, join(usageDir(), "cursor.json"), { sessionCredits: qoderSession(sid), credits: a != null && b != null ? a - b : null });
        preCredits.delete(event.agent.id);
      }
      appendUsage(usageDir(), rec);
      await emitOtlp(process.env.AGENT_HUB_OTLP, rec).catch((e) => console.error("agent-hub-usage otlp", String(e)));
    } catch (e) { console.error("agent-hub-usage", event.agent.id, String(e)); }
  });
  return () => {};
}
