import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadRoutes } from "./server/gate.mjs";
import { evaluate } from "./server/hook.mjs";
import { mcpCall, hubPassword } from "./server/mcp.mjs";
import { gateDir, peekRequest } from "./server/store.mjs";

const MCP = process.env.AGENT_HUB_MCP ?? "http://127.0.0.1:6790/mcp/agents";

export default function contribute(server: PluginServerContext) {
  // Returns at once: the gate runs git and the caller's command (up to 120 s), Paseo cuts a hook off after 30 s.
  server.addHook("agent.turn.after", (event, context) => {
    if (event.outcome.kind !== "completed") return;
    void gate(event, context).catch((e) => console.error("agent-hub-gate", String(e)));
  });
  return () => {};
}

async function gate(event: any, context: any) {
  {
    const id = event.agent.id;
    let mirror: Record<string, string>;
    try {
      // No agent label is read here: cmd, limits and patterns come from the routes file or the caller's request,
      // attempts and status from the plugin store. Labels are written for display only.
      // a direct run (label route/type=direct from `agent-hub direct paseo`) with no route request is never gated; unreadable labels = gated as before (fail closed)
      let direct = false;
      if (!peekRequest(gateDir(), event.agent.cwd)) {
        const st: any = await mcpCall(MCP, hubPassword(), "get_agent_status", { agentId: id }).catch(() => null);
        direct = st?.snapshot?.labels?.["route/type"] === "direct";
      }
      const { d, res, mirror: m } = evaluate({ dir: gateDir(), id, cwd: event.agent.cwd, routes: loadRoutes(), direct });
      mirror = m;
      if (d.reprompt) await context.paseo.agents.ref(id).send("Your work failed the gate: " + res.reasons.join("; ") + "\nFix it and finish.");
    } catch (e) {
      if (/Agent not found/.test(String(e))) return; // agent was archived or killed while the gate ran: nothing to label
      console.error("agent-hub-gate", id, String(e));
      mirror = { "gate/status": "ERROR", "gate/reasons": "gate could not run: " + String(e).slice(0, 200) }; // fail closed: never shown as PASS
    }
    await mcpCall(MCP, hubPassword(), "update_agent", { agentId: id, labels: mirror }).catch((e) => console.error("agent-hub-gate mirror", String(e)));
  }
}
