// "Latest" aliases (owner 05-11): codex/latest[-sol|-terra|-luna], claude/latest-opus|sonnet|haiku, qoder/<tier>@latest and qoder/latest-<family>
// (newest version within a family, e.g. latest-qwen-max), opencode/office@latest (served office model).
// Resolved at dispatch to the highest version the provider lists; results are cached 10 min in a temp file (route.mjs is a new process per task).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { servedModelSync, syncOpencode } from "./office.mjs";

export const EXCLUDED = ["astra"]; // owner-excluded Codex family, never resolved to
const TTL = 10 * 60_000;

/** "6.1" -> [6,1]; compares numerically per part, so 6.1 > 6 > 5.6. */
export const cmpVer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };

/** Newest of [{id, ver, family}] for a family (or any), highest version first; ties keep list order. */
export function newest(models, family) {
  const pool = models.filter((m) => !family || m.family === family);
  return pool.reduce((best, m) => (!best || cmpVer(m.ver, best.ver) > 0 ? m : best), null);
}

export function parseCodex(slugs, excluded = EXCLUDED) {
  return slugs.map((id) => { const m = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(id); return m && !excluded.includes(m[2]) ? { id, ver: m[1].split(".").map(Number), family: m[2] } : null; }).filter(Boolean);
}
export function parseClaude(ids) {
  return ids.map((id) => { const m = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(id); return m ? { id, ver: m[2].split("-").map(Number), family: m[1] } : null; }).filter(Boolean);
}

/** Qoder models are {id, model}: the id is opaque (qmodel_38max), the display name carries the version ("Qwen3.8-Max", "Kimi-K3.1-Pro", "DeepSeek-V4-Pro").
 * family = brand-suffix (qwen-max), ver = the number. Unversioned names (Fast, DeepSeek-Flash) have no family. */
export function parseQoder(items) {
  return items.map(({ id, model }) => { const m = /^([A-Za-z]+?)-?[A-Z]?(\d+(?:\.\d+)*)(?:-(.+))?$/.exec(String(model ?? "").replace(/ \(default\)$/, "")); return m ? { id, ver: m[2].split(".").map(Number), family: `${m[1]}-${m[3] ?? "base"}`.toLowerCase() } : null; }).filter(Boolean);
}

export function codexSlugs(env = process.env) {
  const f = env.CODEX_MODELS_CACHE ?? join(homedir(), ".codex", "models_cache.json");
  if (!existsSync(f)) return [];
  return (JSON.parse(readFileSync(f, "utf8")).models ?? []).filter((m) => (m.visibility ?? "list") === "list").map((m) => m.slug);
}

const ALIAS = /^(codex|claude|qoder|opencode)\/(?:latest(?:-([a-z][a-z-]*))?|([\w.-]+)@latest)$/;
export const isAlias = (p) => ALIAS.test(p);

/** Resolve one entry; non-aliases pass through. Throws when nothing matches. `paseo(args)` lists claude/qoder models. */
export function resolveEntry(entry, paseo, env = process.env) {
  const m = ALIAS.exec(entry);
  if (!m) return entry;
  const [, kind, fam, tier] = m;
  const ids = (prov) => { const r = paseo(["provider", "models", prov]); return (Array.isArray(r) ? r : []).map((x) => x.id); };
  if (kind === "codex") {
    const hit = newest(parseCodex(codexSlugs(env), (env.CODEX_EXCLUDE ?? EXCLUDED.join(",")).split(",")), fam); // no such family -> undefined -> null -> falls through to overall newest
    const pick = hit ?? (fam ? null : newest(parseCodex(codexSlugs(env))));
    if (!pick) throw new Error(`no codex model for ${entry}`);
    return `codex/${pick.id}`;
  }
  if (kind === "claude") {
    const pick = newest(parseClaude(ids("claude-clean")), fam);
    if (!pick) throw new Error(`no claude model for ${entry}`);
    return `claude-clean/${pick.id}`;
  }
  if (kind === "opencode") { // the office server's own model id; opencode.json is pointed at it before the task starts
    const base = env.OFFICE_QWEN_URL ?? localCfg().officeQwenUrl;
    if (tier !== "office" || !base) throw new Error("opencode/office@latest needs OFFICE_QWEN_URL");
    const id = servedModelSync(base); const f = env.OPENCODE_CONFIG ?? join(homedir(), ".paseo", "hub", "opencode.json");
    syncOpencode(f, id); return `opencode/office/${id}`;
  }
  const lst = paseo(["provider", "models", "qoder"]); const have = Array.isArray(lst) ? lst : []; const all = parseQoder(have);
  if (fam) { const pick = newest(all, fam); if (!pick) throw new Error(`no qoder model family ${fam}`); return `qoder/${pick.id}`; }
  const t = tier.toLowerCase(); const is = (x) => x.id.toLowerCase() === t || String(x.model).toLowerCase() === t; // tier = id or display name
  const own = all.find(is); // a versioned tier moves to the newest version of its family
  if (own) return `qoder/${newest(all, own.family).id}`;
  const hit = have.find(is); // unversioned tiers (fast, efficient): confirm it is still listed
  if (!hit) throw new Error(`qoder tier ${tier} not listed`);
  return `qoder/${hit.id}`;
}

const localCfg = () => { try { return JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "config", "hub.local.json"), "utf8")); } catch { return {}; } };

/** Cached resolve: a failure (provider list down) falls back to the last cached value, else the alias fails the entry. */
export function resolveCached(entry, paseo, env = process.env, now = Date.now()) {
  if (!isAlias(entry)) return entry;
  const file = env.AGENT_HUB_RESOLVE_CACHE ?? join(tmpdir(), "agent-hub-resolve-cache.json");
  let c = {}; try { c = JSON.parse(readFileSync(file, "utf8")); } catch { /* none */ }
  if (c[entry] && now - c[entry].at < TTL) return c[entry].v;
  try {
    const v = resolveEntry(entry, paseo, env);
    c[entry] = { v, at: now }; try { writeFileSync(file, JSON.stringify(c)); } catch { /* cache is optional */ }
    return v;
  } catch (e) { if (c[entry]) return c[entry].v; throw e; }
}

/** Doctor helper: routes that pin a model older than the newest of its family. Returns warning strings. */
export function stalePins(routes, env = process.env) {
  const codex = parseCodex(codexSlugs(env));
  const out = [];
  for (const [type, chain] of Object.entries(routes.routes ?? {})) for (const e of chain) {
    const m = /^codex\/(gpt-\d+(?:\.\d+)*-([a-z]+))$/.exec(e);
    if (!m) continue;
    const top = newest(codex, m[2]), overall = newest(codex);
    if (!top || (cmpVer(top.ver, parseCodex([m[1]])[0]?.ver ?? []) > 0)) out.push(`${type}: ${e} pins an older model (newest ${m[2]}: ${top?.id})`);
    else if (cmpVer(overall.ver, top.ver) > 0) out.push(`${type}: ${e} family ${m[2]} is behind the newest overall (${overall.id}); use codex/latest-<family>`);
  }
  return out;
}
