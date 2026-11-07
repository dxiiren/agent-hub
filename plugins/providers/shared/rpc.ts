import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// One RPC: the server hands {verb, args} to `scripts/provider.mjs api`, the same code the `agent-hub provider` CLI runs.
export const providersRpc = defineRpc({
  name: "agent-hub-providers.call",
  input: z.object({ verb: z.enum(["describe", "models", "provider-models", "list", "add", "edit", "remove"]), args: z.record(z.string(), z.any()).optional() }),
  output: z.record(z.string(), z.any()),
});

// Routing & slots screen: the server hands {verb, args} to `scripts/routes.mjs api` (same code as `agent-hub routes`); "enabled" changes are applied to the daemon through its config API.
export const routingRpc = defineRpc({
  name: "agent-hub-providers.routing",
  input: z.object({ verb: z.enum(["show", "models", "set", "undo", "probe"]), args: z.record(z.string(), z.any()).optional() }),
  output: z.record(z.string(), z.any()),
});
