import type { PluginServerContext } from "@getpaseo/plugin/server";
import { appendUsage, emitOtlp, toRecord, usageDir } from "./server/usage.mjs";
import { mcpCall, hubPassword } from "./server/mcp.mjs";
import { fillRecord, qoderCredits, qoderSession, qwenSession } from "./server/sidecar.mjs";
import { join } from "node:path";
import { z } from "zod";
import { qoderSummary, toReport } from "./server/qoder-usage.mjs";
import { paseoHome, selfHostedProviders, selfHostedReport, kindId } from "./server/selfhosted-usage.mjs";
import { readFileSync } from "node:fs";
import { accountGroups, groupReport } from "./server/accounts-usage.mjs";

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
  const localPaths = [process.env.AGENT_HUB_LOCAL, process.env.AGENT_HUB_REPO && join(process.env.AGENT_HUB_REPO, "config", "hub.local.json")];
  try { const cfg = JSON.parse(readFileSync(join(paseoHome(), "config.json"), "utf8").replace(/^﻿/, "")); for (const p of Object.values<any>(cfg.plugins ?? {})) if (p?.path) localPaths.push(join(p.path, "..", "..", "config", "hub.local.json")); } catch { /* no config */ }
  let local: any = {};
  for (const lp of localPaths) { if (!lp) continue; try { local = JSON.parse(readFileSync(lp, "utf8").replace(/^﻿/, "")); break; } catch { /* next */ } }
  // One usage source (one card) per self-hosted provider KIND, e.g. "Qwen Code": totals first, then a row per endpoint.
  // Read from the Paseo config at plugin load: a provider added later shows up after the plugin is reloaded.
  let cfg: any = {};
  try { cfg = JSON.parse(readFileSync(join(paseoHome(), "config.json"), "utf8").replace(/^﻿/, "")); } catch { /* no config: no cards */ }
  const kinds = new Map<string, string>();
  for (const p of selfHostedProviders(cfg, local)) kinds.set(kindId(p.kind), p.kind);
  for (const [id, kind] of kinds) {
    server.registerUsageSource({
      id: `selfhosted-${id}`,
      label: kind,
      input: z.object({ id: z.string() }),
      discover: async () => [{ key: id, label: kind, harness: "Self-hosted", input: { id } }],
      fetch: async (input: { id: string }) => { try { return await selfHostedReport(input.id); } catch (e) { return { status: "error", error: String(e?.message ?? e).slice(0, 200) }; } },
    });
  }
  // One card per CLI kind that has extra accounts (Claude Code, Codex, Qoder): Total + a line per account. Read from hub.local.json at plugin load.
  for (const [kind, g] of Object.entries<any>(accountGroups(local))) {
    server.registerUsageSource({
      id: `accounts-${kind}`,
      label: `${g.label} accounts`,
      input: z.object({ kind: z.string() }),
      discover: async () => [{ key: kind, label: g.label, harness: g.label, input: { kind } }],
      fetch: async (input: { kind: string }) => {
        try { let feed = ""; try { feed = readFileSync(join(usageDir(), "usage.jsonl"), "utf8"); } catch { /* none yet */ } return await groupReport(input.kind, { local, feed }); }
        catch (e) { return { status: "error", error: String(e?.message ?? e).slice(0, 200) }; }
      },
    });
  }
  qoderSummary().catch(() => {}); // warm the cache: the poller takes 3-60 s, so the first panel open already has a number
  return () => {};
}
