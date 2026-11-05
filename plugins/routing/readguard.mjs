// Which pending permission requests of a read-only task may be auto-approved.
// A request is allowed only when it is a plain local file read (strict tool-name list), carries at least one path, and every path
// resolves (realpath) inside the task's cwd or an explicit routes.readAllow root without touching a sensitive file.
import { realpathSync } from "node:fs";
import { join, relative, resolve, basename, sep, isAbsolute } from "node:path";
import os from "node:os";

// shortcut: tool names differ per provider; this list is the ones seen live (read_file, glob, grep, ls). Add a name only after seeing its pending request carry a path.
export const READ_TOOLS = /^(read|read_?file|read_?many_?files|glob|grep|ls|list|list_?directory)$/i;
const SENSITIVE_NAME = /^(credentials|creds)|\.(pem|key|p12|pfx|jks|keystore)$|^\.env|^id_(rsa|ed25519|ecdsa|dsa)|secret/i;

const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const inside = (root, p) => { const r = relative(norm(root), norm(p)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

/** Absolute locations that are never readable unless the task's own cwd is inside them. */
export function deniedRoots(env = process.env, home = os.homedir()) {
  const paseo = env.PASEO_HOME || join(home, ".paseo");
  return [paseo, join(home, ".claude"), join(home, ".codex"), join(home, ".qoder"), join(home, ".ssh")].map((d) => real(d) ?? resolve(d));
}

/** { ok, why } for one path. `roots` = [cwd, ...readAllow]. */
export function pathAllowed(path, roots, env = process.env, home = os.homedir()) {
  if (!path || typeof path !== "string") return { ok: false, why: "no path" };
  const abs = real(resolve(path));
  if (!abs) return { ok: false, why: "path does not resolve" };
  const rr = roots.map((r) => real(resolve(r))).filter(Boolean);
  const root = rr.find((r) => inside(r, abs));
  if (!root) return { ok: false, why: "outside cwd and readAllow" };
  if (deniedRoots(env, home).some((d) => inside(d, abs) && !inside(d, root))) return { ok: false, why: "protected folder" };
  const rel = relative(norm(root), norm(abs)).split(sep).filter(Boolean);
  const origRel = relative(root, abs).split(sep).filter(Boolean);
  if (origRel.some((s) => s.startsWith("."))) return { ok: false, why: "dotfile or dot-folder" };
  if (SENSITIVE_NAME.test(basename(abs)) || rel.some((s) => SENSITIVE_NAME.test(s))) return { ok: false, why: "sensitive file name" };
  return { ok: true };
}

/** One normalised pending request ({name, kind, paths}) -> { ok, why }. */
export function requestAllowed(req, roots, env, home) {
  if (!READ_TOOLS.test(String(req?.name ?? "").trim()) || (req.kind && req.kind !== "read" && req.kind !== "search")) return { ok: false, why: `tool ${req?.name} is not a plain read` };
  if (!req.paths?.length) return { ok: false, why: "request carries no path" };
  for (const p of req.paths) { const r = pathAllowed(p, roots, env, home); if (!r.ok) return { ok: false, why: `${p}: ${r.why}` }; }
  return { ok: true };
}

/** The whole batch: all allowed, or none (first reason returned). */
export function batchAllowed(reqs, roots, env, home) {
  for (const r of reqs) { const v = requestAllowed(r, roots, env, home); if (!v.ok) return v; }
  return { ok: true };
}
