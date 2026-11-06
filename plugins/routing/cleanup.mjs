// agent-hub cleanup [--older-than 30m] [--mine|--all] [--dry-run] [--home H] [--fix-model-ids]
// Archives finished/idle agents so none lingers "running"/"idle" after a test, doctor or fix job.
// --mine (default): only agents agent-hub itself created = labelled route/type=<a route type> (set by route.mjs) or caller=agent-hub-doctor (doctor --deep).
// --all: every finished agent of the daemon, including other users' (never the default). Running agents are never touched.
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { cliPaseo, withRetry, loadRoutes } from "./route.mjs";
import { cleanModelId } from "./acp-proxy.mjs";

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

/** hub-doctor-XXXXXX temp folders (and the Paseo project the daemon registers for each) are ours only when BOTH the project name and the folder name match and the folder sits in the temp dir. */
const DOCTOR_DIR = /^hub-doctor-[A-Za-z0-9]{6}$/;
const same = (a, b) => { try { return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase(); } catch { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); } };
const ours = (path) => DOCTOR_DIR.test(basename(String(path))) && same(dirname(String(path)), tmpdir());
/** Delete the Paseo project(s) registered for one doctor folder, then the folder (retried: the daemon may still hold it as a cwd for a moment). `paseo(args)` -> parsed JSON. */
export function removeDoctorDir(dir, paseo, { rm = rmSync, tries = 5, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  if (!ours(dir)) return { projects: 0, removed: false };
  let projects = 0;
  const rows = paseo(["project", "ls"]);
  for (const p of Array.isArray(rows) ? rows : []) if (p.projectId && p.path && same(p.path, dir)) { paseo(["project", "delete", p.projectId]); projects++; }
  for (let i = 0; i < tries; i++) { try { rm(dir, { recursive: true, force: true }); if (!existsSync(dir)) return { projects, removed: true }; } catch { /* held: retry */ } if (i < tries - 1) sleep(1000); }
  return { projects, removed: !existsSync(dir) };
}
/** Leftovers of earlier doctor runs: every temp hub-doctor-XXXXXX folder and its project (dry: only counted). */
export function cleanDoctorLeftovers({ paseo, dry = false, tmp = tmpdir(), rm = rmSync }) {
  let dirs = 0, projects = 0;
  const rows = paseo(["project", "ls"]);
  for (const p of Array.isArray(rows) ? rows : []) if (p.projectId && ours(p.path) && p.name === basename(p.path)) { if (!dry) paseo(["project", "delete", p.projectId]); projects++; }
  let names = []; try { names = readdirSync(tmp).filter((n) => DOCTOR_DIR.test(n)); } catch { /* no temp dir */ }
  for (const n of names) { if (!dry) { try { rm(join(tmp, n), { recursive: true, force: true }); } catch { continue; } } dirs++; }
  return { dirs, projects };
}

/** Agent records written before the plain-model-id fix keep qwen's runtime id (`$runtime|openai|<id>(openai)` / `<id>(openai)`) in three model fields. Rewrites those fields to the plain served id, only where the value ends in "(openai)" (qwen's own suffix) and the agent is not running. Run with the daemon stopped (`just down`): a running daemon keeps its records in memory. Returns the number of records changed. */
const MODEL_FIELDS = [["config", "model"], ["runtimeInfo", "model"], ["persistence", "metadata", "model"]];
export function cleanAgentModelIds({ home = process.env.PASEO_HOME ?? join(homedir(), ".paseo"), dry = false } = {}) {
  const root = join(home, "agents"); let changed = 0;
  let dirs = []; try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return 0; }
  for (const d of dirs) {
    let files = []; try { files = readdirSync(join(root, d.name)).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      const file = join(root, d.name, f);
      try {
        const text = readFileSync(file, "utf8"); if (!text.includes("(openai)")) continue;
        const rec = JSON.parse(text); if (/^running$/i.test(String(rec.lastStatus ?? ""))) continue;
        let hit = false;
        for (const path of MODEL_FIELDS) {
          const holder = path.slice(0, -1).reduce((o, k) => o?.[k], rec), key = path.at(-1);
          if (holder && typeof holder[key] === "string" && /\(openai\)$/.test(holder[key]) && cleanModelId(holder[key]) !== holder[key]) { holder[key] = cleanModelId(holder[key]); hit = true; }
        }
        if (!hit) continue;
        changed++;
        if (!dry) { const tmp = file + ".tmp-" + process.pid; writeFileSync(tmp, JSON.stringify(rec, null, 2) + (text.endsWith(String.fromCharCode(10)) ? String.fromCharCode(10) : "")); renameSync(tmp, file); }
      } catch { /* an unreadable record is left alone */ }
    }
  }
  return changed;
}

const guard = await import("../../deploy/laptop/gpu-guard.mjs").catch(() => null); // optional in a trimmed install
import { reapAgentOrphans } from "./orphans.mjs";

export function main(argv, env = process.env) {
  if (argv.includes("--fix-model-ids")) { const n = cleanAgentModelIds({ home: argv.includes("--home") ? argv[argv.indexOf("--home") + 1] : env.PASEO_HOME, dry: argv.includes("--dry-run") }); console.log(`${argv.includes("--dry-run") ? "would rewrite" : "rewrote"} the model id in ${n} old agent record(s) (stop the daemon first: it keeps records in memory)`); return 0; }
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  if (argv.includes("--all") && argv.includes("--mine")) { console.error("cleanup: --mine and --all exclude each other"); return 2; }
  const olderThan = opt("--older-than") === undefined ? 0 : parseAge(opt("--older-than"));
  if (olderThan === null) { console.error("cleanup: --older-than takes a number and s|m|h|d, e.g. 30m"); return 2; }
  const home = opt("--home") ?? env.PASEO_HOME;
  const r = cleanup({ paseo: withRetry(cliPaseo(home, env)), olderThan, all: argv.includes("--all"), routes: loadRoutes(env), dry: argv.includes("--dry-run") });
  console.log(`${argv.includes("--dry-run") ? "would archive" : "archived"} ${r.archived.length} agent(s), ${r.skipped} left (running, too new or not finished)${r.archived.length ? ": " + r.archived.map((i) => i.slice(0, 8)).join(" ") : ""}`);
  try { const d = cleanDoctorLeftovers({ paseo: withRetry(cliPaseo(home, env)), dry: argv.includes("--dry-run") }); if (d.dirs || d.projects) console.log(`${argv.includes("--dry-run") ? "would remove" : "removed"} ${d.dirs} leftover hub-doctor temp folder(s) and ${d.projects} of their Paseo project(s)`); } catch { /* the daemon may be down: the folders go next time */ }
  if (!argv.includes("--dry-run") && guard) { try { for (const x of guard.reapOrphans({ idleMs: Number(env.LAPTOP_IDLE_MIN || 15) * 60_000 })) console.log(`stopped an idle orphaned laptop llama-server (pid ${x.pid}, port ${x.port})`); } catch { /* best effort */ } }
  if (!argv.includes("--dry-run")) { const o = reapAgentOrphans(); if (o.length) console.log(`stopped ${o.length} orphaned agent shell snapshot process(es)`); }
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
