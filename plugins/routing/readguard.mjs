// Which pending permission requests of a read-only task may be auto-approved.
// A request is allowed only when it is a plain local file read (strict tool-name list), carries at least one path, and every path
// resolves (realpath) inside the task's cwd or an explicit routes.readAllow root without touching a sensitive file.
import { realpathSync, statSync } from "node:fs";
import { join, relative, resolve, basename, sep, isAbsolute } from "node:path";
import os from "node:os";

// shortcut: tool names differ per provider; this list is the ones seen live (read_file, glob, grep, ls). Add a name only after seeing its pending request carry a path.
export const READ_TOOLS = /^(read|read_?file)$/i; // single-file reads only: grep, glob, ls, list, read_many_files recurse into dot-folders and credentials
/** The same rules as globs: config/claude-clean/readonly-settings.template.json must deny every one (a test checks). */
export const SENSITIVE_GLOBS = [".env", ".env.*", "credentials*", "creds*", "*secret*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*", ".*", ".*/**"];
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
  const rr = roots.map((r) => real(resolve(r))).filter(Boolean);
  const abs = real(isAbsolute(path) ? path : resolve(roots[0] ?? "", path)); // a relative path is the agent's, so it resolves against the task cwd
  if (!abs) return { ok: false, why: "path does not resolve" };
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { ok: false, why: "not a regular file" };
    // a hardlink inside cwd to a file outside shares the inode and passes the realpath check: a file with more than one name is never auto-readable
    if (st.nlink > 1) return { ok: false, why: "hardlinked file (more than one name)" };
  } catch { return { ok: false, why: "not a regular file" }; }
  const root = rr.find((r) => inside(r, abs));
  if (!root) return { ok: false, why: "outside cwd and readAllow" };
  if (deniedRoots(env, home).some((d) => inside(d, abs) && !inside(d, root))) return { ok: false, why: "protected folder" };
  const rel = relative(norm(root), norm(abs)).split(sep).filter(Boolean);
  const origRel = relative(root, abs).split(sep).filter(Boolean);
  if (origRel.some((s) => s.startsWith("."))) return { ok: false, why: "dotfile or dot-folder" };
  if (SENSITIVE_NAME.test(basename(abs)) || rel.some((s) => SENSITIVE_NAME.test(s))) return { ok: false, why: "sensitive file name" };
  return { ok: true };
}

const SHELL_TOOLS = /^(execute|run_?shell_?command|bash|shell)$/i;
const READ_CMDS = new Set(["grep", "egrep", "fgrep", "rg", "sed", "head", "tail", "cat", "ls", "wc", "find", "sort", "uniq", "cut", "nl", "findstr", "type", "dir"]);
const STDIN_CMDS = new Set(["head", "tail", "wc", "sort", "uniq", "cut", "nl"]); // after a pipe: flags and numbers only, no file
const META = /[;&<>`$(){}*?\[\]~!\\\n\r"']/; // no chaining, redirects, substitution, globs, quotes (a pattern needing them is refused, never guessed)
const BAD_FLAG = /^(-[A-Za-z]*[rR]|--recursive|--dereference-recursive|--include|--exclude|--include-dir|--exclude-dir|-exec|-execdir|-ok|-okdir|-delete|-fprint\w*|-fls|-i|--in-place|-f|--file|-e|--pre|--follow|-L|--files|--type-list|-z|--search-zip)(=|$)/;
/** Split a command line into pipe segments of words. A word may be single- or double-quoted (a grep pattern usually is); inside quotes only $, backtick, backslash and newline are refused, outside quotes every META character is. null = refused. */
function tokenize(cmd) {
  const segs = [[]]; let w = null, q = null;
  const push = () => { if (w !== null) { segs[segs.length - 1].push(w); w = null; } };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; else if (/[$`\\\n\r]/.test(ch)) return null; else w += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; w = w ?? ""; continue; }
    if (ch === "|") { if (cmd[i + 1] === "|" || !segs[segs.length - 1].length && w === null) return null; push(); segs.push([]); continue; }
    if (/\s/.test(ch)) { push(); continue; }
    if (META.test(ch)) return null;
    w = (w ?? "") + ch;
  }
  if (q) return null; push(); return segs.every((x) => x.length) ? segs : null;
}
/** One read-only shell command line -> { ok, why }. Allowed: grep/rg PATTERN FILE..., sed -n 'Np' FILE (no quotes, so only the plain form), head/tail/cat/ls/wc/find on files, joined by | with stdin-only filters. Every file argument must pass pathAllowed (a regular file inside the task folder, nothing sensitive); no recursion, no -exec/-delete/-i, no network or other commands. */
export function commandAllowed(cmd, roots, env, home) {
  if (typeof cmd !== "string" || !cmd.trim() || cmd.length > 600) return { ok: false, why: "empty or too long command" };
  const segs = tokenize(cmd); if (!segs) return { ok: false, why: "shell metacharacter in command: " + cmd.slice(0, 160) };
  for (let i = 0; i < segs.length; i++) {
    const [c, ...args] = segs[i]; if (!c) return { ok: false, why: "empty pipe segment" };
    if (!READ_CMDS.has(c)) return { ok: false, why: `command ${c} is not a read command` };
    if (c === "sed" && !(args[0] === "-n" && /^\d+(,\d+)?p$/.test(args[1] ?? ""))) return { ok: false, why: "sed only as: sed -n Np FILE" };
    const WINF = /^\/[A-Za-z]+(:|$)/, isFlag = (a) => a.startsWith("-") || (["findstr", "dir"].includes(c) && WINF.test(a)); const flags = args.filter((a) => isFlag(a) && !/^-\d+$/.test(a)), bad = flags.find((a) => BAD_FLAG.test(a) || /^\/(s|f:|g:|d:|a:)/i.test(a)); if (bad) return { ok: false, why: `flag ${bad} is not allowed` };
    let rest = args.filter((a) => !isFlag(a));
    if (c === "sed") rest = rest.slice(1); // the Np script
    else if (c === "grep" || c === "egrep" || c === "fgrep" || c === "rg") rest = rest.slice(1); // the pattern
    else if (c === "findstr" && !args.some((x) => /^\/c:/i.test(x))) rest = rest.slice(1); // findstr PATTERN FILE (a /C:pattern flag is the pattern itself)
    if ((c === "head" || c === "tail") && flags.some((f) => f === "-n" || f === "-c")) rest = rest.filter((a) => !/^\d+$/.test(a));
    rest = rest.filter((a) => !(/^\d+$/.test(a) && (STDIN_CMDS.has(c) || c === "head" || c === "tail"))); // numeric option values
    if (i > 0) { if (!STDIN_CMDS.has(c) && !(["grep", "egrep", "fgrep", "rg"].includes(c) && rest.length === 0)) return { ok: false, why: `${c} after a pipe` }; if (rest.length) return { ok: false, why: "file argument after a pipe" }; continue; }
    if (c !== "ls" && c !== "find" && c !== "dir" && !rest.length) return { ok: false, why: `${c} has no file argument` };
    if (c === "ls" || c === "find" || c === "dir") { if (c === "find") rest = segs[i].slice(1).filter((x, k, arr) => !arr.slice(0, k + 1).some((y) => y.startsWith("-"))); if (!rest.length) rest.push("."); for (const d of rest) { const r = pathAllowedDirOrFile(d, roots, env, home); if (!r.ok) return { ok: false, why: `${d}: ${r.why}` }; } continue; }
    for (const p of rest) { const r = pathAllowed(p, roots, env, home); if (!r.ok) return { ok: false, why: `${p}: ${r.why}` }; }
  }
  return { ok: true };
}
/** ls/find list names, so a directory inside the task folder is fine (still no dot-folder, no protected folder, no sensitive name); find output of a sensitive name is only a name. */
function pathAllowedDirOrFile(path, roots, env, home) {
  const rr = roots.map((r) => real(resolve(r))).filter(Boolean);
  const abs = real(isAbsolute(path) ? path : resolve(roots[0] ?? "", path)); if (!abs) return { ok: false, why: "path does not resolve" };
  const root = rr.find((r) => inside(r, abs)); if (!root) return { ok: false, why: "outside cwd and readAllow" };
  if (deniedRoots(env, home).some((d) => inside(d, abs) && !inside(d, root))) return { ok: false, why: "protected folder" };
  if (relative(root, abs).split(sep).filter(Boolean).some((s) => s.startsWith("."))) return { ok: false, why: "dotfile or dot-folder" };
  return { ok: true };
}

/** One normalised pending request ({name, kind, paths, command}) -> { ok, why }. */
export function requestAllowed(req, roots, env, home) {
  if (SHELL_TOOLS.test(String(req?.name ?? "").trim()) || req?.kind === "execute") return req.command ? commandAllowed(req.command, roots, env, home) : { ok: false, why: "shell request carries no command" };
  if (!READ_TOOLS.test(String(req?.name ?? "").trim()) || (req.kind && req.kind !== "read" && req.kind !== "search")) return { ok: false, why: `tool ${req?.name} is not a plain read` };
  if (req.extras) return { ok: false, why: "request has a pattern/glob/include/recursive field" };
  if (!req.paths?.length) return { ok: false, why: "request carries no path" };
  for (const p of req.paths) { const r = pathAllowed(p, roots, env, home); if (!r.ok) return { ok: false, why: `${p}: ${r.why}` }; }
  return { ok: true };
}

/** The whole batch: all allowed, or none (first reason returned). */
export function batchAllowed(reqs, roots, env, home) {
  for (const r of reqs) { const v = requestAllowed(r, roots, env, home); if (!v.ok) return v; }
  return { ok: true };
}
