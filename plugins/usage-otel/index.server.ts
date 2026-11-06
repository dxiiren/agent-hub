import type { PluginServerContext } from "@getpaseo/plugin/server";
import { appendUsage, emitOtlp, toRecord, usageDir } from "./server/usage.mjs";
import { mcpCall, hubPassword } from "./server/mcp.mjs";
import { fillRecord, qoderCredits, qoderSession, qwenSession } from "./server/sidecar.mjs";
import { join } from "node:path";
import { z } from "zod";
import { qoderSummary, toReport } from "./server/qoder-usage.mjs";

const MCP = process.env.AGENT_HUB_MCP ?? "http://127.0.0.1:6790/mcp/agents";

const preCredits = new Map<string, Promise<number | null>>();
let otlpDown = false; // log an OTLP outage once, not once per turn

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.turn.before", async (event) => {
    if (event.agent.provider.startsWith("qoder")) preCredits.set(event.agent.id, qoderCredits()); // not awaited: the python poller takes 3 s idle and over 30 s on a loaded laptop, past Paseo's hook RPC limit
  });
  server.addHook("agent.turn.after", async (event) => {
    if (event.outcome.kind !== "completed") return;
    try {
      const st: any = await mcpCall(MCP, hubPassword(), "get_agent_status", { agentId: event.agent.id });
      const rec = toRecord({ ...st?.snapshot, id: event.agent.id, provider: st?.snapshot?.provider ?? event.agent.provider });
      const sid = st?.snapshot?.runtimeInfo?.sessionId;
      if (rec.provider.startsWith("qwen")) fillRecord(rec, join(usageDir(), "cursor.json"), { tokens: qwenSession(sid) });
      else if (rec.provider.startsWith("qoder")) {
        const sc = qoderSession(sid), b = await preCredits.get(event.agent.id), a = sc == null ? await qoderCredits() : null; // account poll only when the session transcript has no credits
        fillRecord(rec, join(usageDir(), "cursor.json"), { sessionCredits: sc, credits: a != null && b != null ? a - b : null });
        preCredits.delete(event.agent.id);
      }
      appendUsage(usageDir(), rec);
      await emitOtlp(process.env.AGENT_HUB_OTLP, rec).then(() => { otlpDown = false; }, (e) => { if (!otlpDown) console.error("agent-hub-usage otlp down", String(e)); otlpDown = true; });
    } catch (e) { console.error("agent-hub-usage", event.agent.id, String(e)); }
  });
  // Paseo web UI Usage panel: one Qoder account row beside Codex and Claude (Paseo caches a fetch for 5 min)
  server.registerUsageSource({
    id: "qoder",
    label: "Qoder",
    input: z.object({}),
    discover: async () => [{ key: "account", label: "Qoder", harness: "Qoder", input: {} }],
    fetch: async () => { try { return toReport(await qoderSummary()); } catch (e) { return { status: "error", error: String(e?.message ?? e).slice(0, 200) }; } },
  });
  qoderSummary().catch(() => {}); // warm the cache: the poller takes 3-60 s, so the first panel open already has a number
  return () => {};
}
