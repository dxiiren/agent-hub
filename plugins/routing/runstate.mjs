// Hub runtime state (ownership records, reaper/in-flight markers, locks, model-id caches): ONE per-user directory, never the shared temp folder.
// Anything in here can decide a kill, a route or a write, so every read and write is hardened: the directory is private (0700 where the OS supports it),
// files are written atomically (temp + rename), a symlink is never followed, and on POSIX a file owned by another user is ignored.
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const posix = process.platform !== "win32";
const uid = () => (posix && typeof process.getuid === "function" ? process.getuid() : null);

/** <AGENT_HUB_RUN_DIR> or <PASEO_HOME>/run or ~/.agent-hub/run. Created private on first use; refused when it is a symlink or not ours. */
export function runDir(env = process.env) {
  const dir = env.AGENT_HUB_RUN_DIR || join(env.PASEO_HOME || join(homedir(), ".agent-hub"), "run");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || (uid() !== null && st.uid !== uid())) throw new Error("not a private directory");
    if (posix) chmodSync(dir, 0o700);
  } catch (e) { throw new Error(`hub run directory ${dir} is not usable: ${e.message}`); }
  return dir;
}

/** A file we may trust: a regular file (no symlink) owned by the current user (POSIX). */
export function trusted(file) {
  try { const st = lstatSync(file); return st.isFile() && !st.isSymbolicLink() && (uid() === null || st.uid === uid()); } catch { return false; }
}
const exists = (f) => { try { lstatSync(f); return true; } catch { return false; } };
export const readState = (file) => { try { return trusted(file) ? readFileSync(file, "utf8") : null; } catch { return null; } };
export const readStateJson = (file) => { try { const t = readState(file); return t == null ? null : JSON.parse(t); } catch { return null; } };

/** Atomic write: temp file (exclusive, 0600) then rename. Refuses when the target is a symlink or someone else's file. Throws on refusal. */
export function writeState(file, data) {
  if (exists(file) && !trusted(file)) throw new Error(`refusing to write ${basename(file)}: not our regular file`);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, typeof data === "string" ? data : JSON.stringify(data)); } finally { closeSync(fd); }
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}
/** Best-effort writer for caches and markers: a refusal or failure is silent. */
export const tryWriteState = (file, data) => { try { writeState(file, data); return true; } catch { return false; } };

/** Names in `dir` matching `re` that are trusted files. */
export function listState(dir, re) {
  try { return readdirSync(dir).filter((f) => re.test(f) && trusted(join(dir, f))); } catch { return []; }
}

/** Start time of a pid as a stable string (ISO UTC on Windows, `ps lstart` on POSIX), or null when unreadable. Paired with the pid it defeats pid reuse. */
export function procStart(pid) {
  const n = Number(pid); if (!Number.isInteger(n) || n <= 0) return null;
  const r = posix
    ? spawnSync("ps", ["-o", "lstart=", "-p", String(n)], { encoding: "utf8", timeout: 8000 })
    : spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${n} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", timeout: 15000, windowsHide: true });
  return (r.stdout || "").trim().replace(/\s+/g, " ") || null;
}
