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
const READ_CMDS = new Set(["grep", "egrep", "fgrep", "rg", "sed", "head", "tail", "cat", "ls", "wc", "find", "type", "dir"]); // sort/uniq/cut/nl dropped: sort -o/--compress-program/-T and uniq write files
const STDIN_CMDS = new Set(["head", "tail", "wc"]); // after a pipe: flags and numbers only, no file
const GREP_CMDS = new Set(["grep", "egrep", "fgrep", "rg"]);
const META = /[;&<>`$(){}*?\[\]~!\\\n\r"']/; // no chaining, redirects, substitution, globs, quotes (a pattern needing them is refused, never guessed)
// Strict flag allowlist per command (a denylist was bypassed by `grep -d recurse`): short flags only, so any other letter, any --long flag and `--` are refused. bool = letters with no value, val = letters taking a number.
const FLAGS = { grep: { bool: "nicEFwvhHsIq", val: "ABCm", num: true }, rg: { bool: "nicFwvsNlHh", val: "ABCm", num: true }, head: { bool: "", val: "n", num: true }, tail: { bool: "", val: "n", num: true }, wc: { bool: "lwc", val: "" }, ls: { bool: "l1hF", val: "" }, cat: { bool: "", val: "" }, type: { bool: "", val: "" }, dir: { bool: "", val: "" } };
FLAGS.egrep = FLAGS.fgrep = FLAGS.grep;
function parseFlags(c, args) {
  const { bool, val, num } = FLAGS[c], rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-") || a === "-") { rest.push(a); continue; }
    if (a.startsWith("--") || (num && /^-\d+$/.test(a))) { if (a.startsWith("--")) return { bad: a }; continue; }
    const cl = a.slice(1);
    for (let k = 0; k < cl.length; k++) {
      const ch = cl[k];
      if (bool.includes(ch)) continue;
      if (val.includes(ch)) { const att = cl.slice(k + 1); if (att ? !/^\d+$/.test(att) : !/^\d+$/.test(args[++i] ?? "")) return { bad: a }; break; }
      return { bad: a };
    }
  }
  return { rest };
}
const FIND_VAL = { "-name": /./, "-iname": /./, "-path": /./, "-type": /^[fdl]$/, "-maxdepth": /^\d+$/ };
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
/** One read-only shell command line -> { ok, why }. Allowed: grep/rg PATTERN FILE..., `sed -n Np FILE` (exact form), head/tail -n N, wc -l/-w/-c, cat/type, ls/dir, find with -name/-iname/-path/-type/-maxdepth, joined by | with stdin-only filters (grep, head, tail, wc). Only flags on the per-command allowlist pass. Every file argument must pass pathAllowed (a regular file inside the task folder, nothing sensitive); relative names resolve against `cwd` (the request's working directory, default roots[0]). */
export function commandAllowed(cmd, roots, env, home, cwd) {
  if (typeof cmd !== "string" || !cmd.trim() || cmd.length > 600) return { ok: false, why: "empty or too long command" };
  const segs = tokenize(cmd); if (!segs) return { ok: false, why: "shell metacharacter in command: " + cmd.slice(0, 160) };
  const base = cwd ?? roots[0] ?? "", abs = (p) => (isAbsolute(p) ? p : resolve(base, p));
  for (let i = 0; i < segs.length; i++) {
    const [c, ...args] = segs[i]; if (!c) return { ok: false, why: "empty pipe segment" };
    if (!READ_CMDS.has(c)) return { ok: false, why: `command ${c} is not a read command` };
    if (i > 0 && !STDIN_CMDS.has(c) && !GREP_CMDS.has(c)) return { ok: false, why: `${c} after a pipe` };
    let rest;
    if (c === "sed") {
      if (!(args.length === 3 && args[0] === "-n" && /^\d+(,\d+)?p$/.test(args[1]))) return { ok: false, why: "sed only as: sed -n Np FILE" };
      rest = [args[2]];
    } else if (c === "find") {
      let k = 0; const paths = []; while (k < args.length && !args[k].startsWith("-")) paths.push(args[k++]);
      for (; k < args.length; k += 2) { const re = FIND_VAL[args[k]]; if (!re || args[k + 1] === undefined || !re.test(args[k + 1])) return { ok: false, why: `find expression ${args[k]} is not allowed` }; }
      for (const d of paths.length ? paths : ["."]) { const r = pathAllowedDirOrFile(abs(d), roots, env, home); if (!r.ok) return { ok: false, why: `${d}: ${r.why}` }; }
      continue;
    } else {
      const p = parseFlags(c, args); if (p.bad) return { ok: false, why: `flag ${p.bad} is not allowed` };
      rest = p.rest;
      if (GREP_CMDS.has(c)) rest = rest.slice(1); // the pattern
    }
    if (i > 0) { if (rest.length) return { ok: false, why: "file argument after a pipe" }; continue; }
    if (c === "ls" || c === "dir") { for (const d of rest.length ? rest : ["."]) { const r = pathAllowedDirOrFile(abs(d), roots, env, home); if (!r.ok) return { ok: false, why: `${d}: ${r.why}` }; } continue; }
    if (!rest.length) return { ok: false, why: `${c} has no file argument` };
    for (const p of rest) { const r = pathAllowed(abs(p), roots, env, home); if (!r.ok) return { ok: false, why: `${p}: ${r.why}` }; }
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
  if (SHELL_TOOLS.test(String(req?.name ?? "").trim()) || req?.kind === "execute") {
    if (!req.command) return { ok: false, why: "shell request carries no command" };
    // every directory field the request names (cwds; legacy single cwd) resolves to an absolute realpath against the task cwd; each must be the task cwd or inside it, and all must be the same place
    const base = real(resolve(roots[0] ?? ""));
    if (!base) return { ok: false, why: "task cwd does not resolve" };
    const named = req.cwds ?? (req.cwd != null ? [req.cwd] : []), dirs = [];
    for (const n of named) {
      const d = typeof n === "string" && n ? real(resolve(base, n)) : null;
      if (!d) return { ok: false, why: "bad working directory " + String(n) };
      const v = pathAllowedDirOrFile(d, [base], env, home); if (!v.ok) return { ok: false, why: "working directory " + n + ": " + v.why };
      dirs.push(d);
    }
    if (new Set(dirs.map(norm)).size > 1) return { ok: false, why: "request names different working directories" };
    return commandAllowed(req.command, roots, env, home, dirs[0] ?? base);
  }
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
