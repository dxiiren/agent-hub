// agent-hub cleanup [--older-than 30m] [--mine|--all] [--dry-run] [--home H]
// Archives finished/idle agents so none lingers "running"/"idle" after a test, doctor or fix job.
// --mine (default): only agents agent-hub itself created = labelled route/type=<a route type> (set by route.mjs) or caller=agent-hub-doctor (doctor --deep).
// --all: every finished agent of the daemon, including other users' (never the default). Running agents are never touched.
import { fileURLToPath } from "node:url";
import { cliPaseo, withRetry, loadRoutes } from "./route.mjs";

export const DOCTOR_LABEL = "caller=agent-hub-doctor";
const FINISHED = /^(idle|closed|error|completed|stopped|failed)$/i;
const UNIT = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };

/** "30m" / "2h" / "45s" / "1d" -> seconds; null when unreadable. */
export function parseAge(s) { const m = /^(\d+)\s*([smhd])$/i.exec(String(s ?? "")); return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()] : null; }
/** `paseo ls` says "3 minutes ago"; -> seconds, Infinity when unreadable (cleanup then archives it only when no age limit was asked for). */
export function ageSeconds(created) { const m = /^(\d+)\s+(second|minute|hour|day|week)s?\s+ago$/i.exec(String(created ?? "").trim()); return m ? Number(m[1]) * UNIT[m[2].toLowerCase()] : /^(just now|now)$/i.test(String(created ?? "").trim()) ? 0 : Infinity; }

/** paseo(args) -> parsed JSON. Returns { archived: [ids], skipped: n }. */
export function cleanup({ paseo, olderThan = 0, all = false, routes = {}, dry = false }) {
  const rows = (a) => { const r = paseo(a); return Array.isArray(r) ? r : []; };
  const labels = all ? [] : [...Object.keys(routes.routes ?? {}).map((t) => `route/type=${t}`), DOCTOR_LABEL];
  const pool = new Map();
  if (all) for (const a of rows(["ls"])) pool.set(a.id, a);
  else for (const l of labels) for (const a of rows(["ls", "--label", l])) pool.set(a.id, a);
  const archived = []; let skipped = 0;
  for (const a of pool.values()) {
    const age = ageSeconds(a.created); // an unreadable age is never "old enough": a cleanup that asked for an age limit leaves such an agent alone
    if (!FINISHED.test(String(a.status ?? "")) || (age === Infinity ? olderThan > 0 : age < olderThan)) { skipped++; continue; }
    if (!dry) { paseo(["stop", a.id]); paseo(["archive", a.id]); }
    archived.push(a.id);
  }
  return { archived, skipped };
}

const guard = await import("../../deploy/laptop/gpu-guard.mjs").catch(() => null); // optional in a trimmed install
import { reapAgentOrphans } from "./orphans.mjs";

export function main(argv, env = process.env) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  if (argv.includes("--all") && argv.includes("--mine")) { console.error("cleanup: --mine and --all exclude each other"); return 2; }
  const olderThan = opt("--older-than") === undefined ? 0 : parseAge(opt("--older-than"));
  if (olderThan === null) { console.error("cleanup: --older-than takes a number and s|m|h|d, e.g. 30m"); return 2; }
  const home = opt("--home") ?? env.PASEO_HOME;
  const r = cleanup({ paseo: withRetry(cliPaseo(home, env)), olderThan, all: argv.includes("--all"), routes: loadRoutes(env), dry: argv.includes("--dry-run") });
  console.log(`${argv.includes("--dry-run") ? "would archive" : "archived"} ${r.archived.length} agent(s), ${r.skipped} left (running, too new or not finished)${r.archived.length ? ": " + r.archived.map((i) => i.slice(0, 8)).join(" ") : ""}`);
  if (!argv.includes("--dry-run") && guard) { try { for (const x of guard.reapOrphans({ idleMs: Number(env.LAPTOP_IDLE_MIN || 15) * 60_000 })) console.log(`stopped an idle orphaned laptop llama-server (pid ${x.pid}, port ${x.port})`); } catch { /* best effort */ } }
  if (!argv.includes("--dry-run")) { const o = reapAgentOrphans(); if (o.length) console.log(`stopped ${o.length} orphaned agent shell snapshot process(es)`); }
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
