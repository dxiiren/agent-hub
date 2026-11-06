// Entries for Paseo's Settings > Providers > "Add provider" list, generated from the provider-kinds schema (scripts/provider-kinds.mjs).
// Picking one opens the Agent Hub provider form with that kind preselected (the web patch in scripts/paseo-web-patch.mjs does the wiring).
import { KINDS } from './provider-kinds.mjs';

const ENDPOINT_WORDS = ['openai', 'openai-compatible', 'ollama', 'vllm', 'sglang', 'lm studio', 'lmstudio', 'llama.cpp', 'localai', 'endpoint', 'local model', 'self-hosted'];

export function catalogEntries(kinds = KINDS) {
  return Object.entries(kinds).map(([type, k]) => {
    const words = [type, ...(k.aliases ?? []), k.base, ...String(k.label).toLowerCase().split(/[^a-z0-9.]+/), ...(k.modelsFrom === 'endpoint' ? ENDPOINT_WORDS : ['model', 'tier'])].filter(Boolean);
    return {
      id: `agent-hub-${type}`,
      title: k.label,
      description: `Add a ${k.label} provider to Agent Hub (opens the Agent Hub provider form).`,
      keywords: [...new Set(words)],
      agentHub: { kind: type, plugin: 'agent-hub-providers', screen: 'providers' },
    };
  });
}
