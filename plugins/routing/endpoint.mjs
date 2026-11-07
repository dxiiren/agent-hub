// Fail fast on a provider whose HTTP endpoint is known to be down: the daemon would otherwise start an agent that exits at once and the route retried it for ~2 minutes.
import { selfHostedProviders } from "../usage-otel/server/selfhosted-usage.mjs";
import { endpointDownCached } from "./office.mjs";

/** @returns {string|null} a plain one-line reason when provider `id` has an endpoint (Qwen Code, OpenCode ...) that does not answer, else null. The hub's own on-demand laptop model is never checked (it starts itself). */
export function endpointSkip(id, cfg, probe = endpointDownCached) {
  const e = selfHostedProviders(cfg, {}).find((x) => x.name === id && !x.onDemand);
  if (!e) return null;
  const why = probe(e.base);
  return why ? `${why.replace(/^Not answering/, "endpoint not answering")}; skipped, the next provider is tried` : null;
}
