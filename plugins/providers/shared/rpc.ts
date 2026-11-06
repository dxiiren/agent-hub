import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// One RPC: the server hands {verb, args} to `scripts/provider.mjs api`, the same code the `agent-hub provider` CLI runs.
export const providersRpc = defineRpc({
  name: "agent-hub-providers.call",
  input: z.object({ verb: z.enum(["describe", "models", "provider-models", "list", "add", "edit", "remove"]), args: z.record(z.string(), z.any()).optional() }),
  output: z.record(z.string(), z.any()),
});
