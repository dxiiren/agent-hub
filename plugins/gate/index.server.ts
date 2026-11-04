import type { PluginServerContext } from "@getpaseo/plugin/server";
import { decide, loadRoutes, repoGate, runGate } from "./server/gate.mjs";
import { mcpCall } from "./server/mcp.mjs";

const MCP = process.env.AGENT_HUB_MCP ?? "http://127.0.0.1:6790/mcp/agents";

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.turn.after", async (event, context) => {
    if (event.outcome.kind !== "completed") return;
    const id = event.agent.id;
    const token = process.env.PASEO_PASSWORD ?? "";
    try {
      const st: any = await mcpCall(MCP, token, "get_agent_status", { agentId: id });
      const labels: Record<string, string> = st?.snapshot?.labels ?? {};
      if (labels["gate/skip"]) return;
      const row: any = repoGate(loadRoutes(), event.agent.cwd);
      const res = runGate(event.agent.cwd, {
        cmd: labels["gate/cmd"] ?? row.cmd,
        maxLines: Number(labels["gate/maxLines"] ?? row.maxLines ?? 400),
        forbid: labels["gate/forbid"] ?? row.forbid ?? null,
        allow: labels["gate/allow"] ?? row.allow ?? null,
      });
      // attempts live in the label, so a daemon restart does not reset the count
      const d = decide(Number(labels["gate/attempts"] ?? 0), res, labels["gate/retry"] === "off");
      await mcpCall(MCP, token, "update_agent", {
        agentId: id,
        labels: { "gate/status": d.status, "gate/reasons": res.reasons.join(" | ").slice(0, 400), "gate/attempts": String(d.attempts), "gate/diff": `${res.files} files, ${res.changed} lines` },
      });
      if (d.reprompt) await context.paseo.agents.ref(id).send("Your work failed the gate: " + res.reasons.join("; ") + "\nFix it and finish.");
    } catch (e) { console.error("agent-hub-gate", id, String(e)); }
  });
  return () => {};
}
