import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadRoutes } from "./server/gate.mjs";
import { evaluate } from "./server/hook.mjs";
import { mcpCall, hubPassword } from "./server/mcp.mjs";
import { gateDir } from "./server/store.mjs";

const MCP = process.env.AGENT_HUB_MCP ?? "http://127.0.0.1:6790/mcp/agents";

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.turn.after", async (event, context) => {
    if (event.outcome.kind !== "completed") return;
    const id = event.agent.id;
    let mirror: Record<string, string>;
    try {
      // No agent label is read here: cmd, limits and patterns come from the routes file or the caller's request,
      // attempts and status from the plugin store. Labels are written for display only.
      const { d, res, mirror: m } = evaluate({ dir: gateDir(), id, cwd: event.agent.cwd, routes: loadRoutes() });
      mirror = m;
      if (d.reprompt) await context.paseo.agents.ref(id).send("Your work failed the gate: " + res.reasons.join("; ") + "\nFix it and finish.");
    } catch (e) {
      console.error("agent-hub-gate", id, String(e));
      mirror = { "gate/status": "ERROR", "gate/reasons": "gate could not run: " + String(e).slice(0, 200) }; // fail closed: never shown as PASS
    }
    await mcpCall(MCP, hubPassword(), "update_agent", { agentId: id, labels: mirror }).catch((e) => console.error("agent-hub-gate mirror", String(e)));
  });
  return () => {};
}
