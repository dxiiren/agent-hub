// Paseo's Settings switches write the default value back into ~/.paseo/config.json (Voice mode, Dictation, Resume agents, Release idle agents), so a toggled-and-restored
// switch leaves an explicit key that changes nothing. The daemon's patch merge cannot delete a key (daemon-config-store.js deepMerge skips undefined), so the web bundle cannot
// stop it; this tool removes such keys afterwards. Only keys whose default is READ from the installed Paseo server files are touched (a changed or unreadable source skips that key).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SPEECH = "speech/speech-config-resolver.js", CONFIG = "config.js";
/** [config path, file, regex whose group 1 is the default] ; the default is parsed, never typed in here. */
const SOURCES = [
  ["features.dictation.enabled", SPEECH, /DICTATION_ENABLED_BY_DEFAULT\s*=\s*(true|false)/],
  ["features.voiceMode.enabled", SPEECH, /VOICE_MODE_ENABLED_BY_DEFAULT\s*=\s*(true|false)/],
  ["agents.resumeOnStartup", CONFIG, /resumeOnStartup:\s*agents\?\.resumeOnStartup\s*\?\?\s*(true|false)/],
  ["agents.idleRuntimeCleanup", CONFIG, /idleRuntimeCleanup:\s*persisted\.agents\?\.idleRuntimeCleanup\s*\?\?\s*(true|false)/],
];
/** serverDir = <@getpaseo/server>/dist/server/server. Returns { path: boolean } for every default that could be read. */
export function readDefaults(serverDir) {
  const out = {};
  for (const [p, f, re] of SOURCES) { try { const m = re.exec(readFileSync(join(serverDir, f), "utf8")); if (m) out[p] = m[1] === "true"; } catch { /* source moved: skip the key */ } }
  return out;
}
const isRec = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** Pure. Returns { cfg, removed:[paths] }: a copy of cfg without the keys equal to their default, and without the objects that became empty by it. */
export function dropDefaults(cfg, defaults) {
  const next = structuredClone(cfg), removed = [];
  for (const [path, def] of Object.entries(defaults)) {
    const seg = path.split("."), chain = [next]; let ok = true;
    for (const s of seg.slice(0, -1)) { const c = chain.at(-1)[s]; if (!isRec(c)) { ok = false; break; } chain.push(c); }
    const last = seg.at(-1);
    if (!ok || chain.at(-1)[last] !== def) continue;
    delete chain.at(-1)[last]; removed.push(path);
    for (let i = chain.length - 1; i > 0; i--) if (!Object.keys(chain[i]).length) delete chain[i - 1][seg[i - 1]]; // prune parents the removal emptied
  }
  return { cfg: next, removed };
}
/** Apply to a config file (daemon stopped). dry: report only. Atomic temp + rename, keeps the file's line endings. */
export function normalizeConfigFile(file, serverDir, { dry = false } = {}) {
  if (!existsSync(file)) return { removed: [], note: "no config file" };
  const text = readFileSync(file, "utf8"), bom = text.startsWith(String.fromCharCode(0xfeff)), crlf = text.includes("\r\n");
  const { cfg, removed } = dropDefaults(JSON.parse(bom ? text.slice(1) : text), readDefaults(serverDir));
  if (removed.length && !dry) {
    let t = JSON.stringify(cfg, null, 2) + "\n"; if (crlf) t = t.replaceAll("\n", "\r\n"); if (bom) t = String.fromCharCode(0xfeff) + t;
    const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, t); renameSync(tmp, file);
  }
  return { removed };
}
