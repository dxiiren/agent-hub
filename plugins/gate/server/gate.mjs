// Gate core: pure functions, no Paseo imports, so the unit tests run under plain node.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Key names holding a secret (with any prefix/suffix: DB_PASSWORD, aws_secret_access_key, password_field), then : or =, then a value.
const SECRET_KEY = String.raw`(?:secret|passw(?:or)?d|pwd|token|api[_-]?key|private[_-]?key|access[_-]?key|credential)\w*`;
// value: quoted 8+ non-space chars holding a digit or punctuation (or 16+ plain chars) | unquoted 8+ with a digit/punctuation and no brackets/parens, so `token = tokens[i]`, `password_field = input` and `token = parse_the_user_token` stay clean
const PUNCT = String.raw`[\d!@#$%^&*+]`;
export const SECRET_RE = new RegExp(
  String.raw`(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9\-._~+/]{20,}|aws\w*secret\w*['"]?\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}|` + SECRET_KEY +
  String.raw`['"]?\s*[:=]\s*(?:['"](?=[^'"\s]*` + PUNCT + String.raw`)[^'"\s]{8,}['"]|['"][A-Za-z0-9_\-\/+]{16,}['"]|['"]?(?=[^\s'"\[\]()<>{},;]*` + PUNCT + String.raw`)[^\s'"\[\]()<>{},;]{8,}))`, "i");

// The worktree is untrusted: its .git/config must not run code (fsmonitor, hooks, external diff, textconv) and no user/system config is read.
const EMPTY_DIR = mkdtempSync(join(tmpdir(), "agent-hub-nohooks-"));
const EMPTY_CFG = join(EMPTY_DIR, "empty.gitconfig");
writeFileSync(EMPTY_CFG, "");
// core.autocrlf=input: a worktree checked out with the user's autocrlf=true holds CRLF files; the empty gate config would diff every one of them
export const GIT_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + EMPTY_DIR, "-c", "diff.external=", "-c", "core.pager=cat", "-c", "core.longpaths=true", "-c", "core.autocrlf=input"];
export const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: EMPTY_CFG, GIT_TERMINAL_PROMPT: "0" };
const git = (cwd, args) => execFileSync("git", [...GIT_FLAGS, ...args], { cwd, env: GIT_ENV, encoding: "utf8", maxBuffer: 32 << 20, stdio: ["ignore", "pipe", "ignore"] });

/** Patterns come only from the trusted routes file; cap the length so a bad config cannot build a huge regex. */
export function rx(src) {
  if (typeof src !== "string" || src.length > 200) throw new Error("pattern too long or not a string");
  return new RegExp(src);
}

/** Routing file: AGENT_HUB_ROUTES, else config/routes/routes.local.json, else the template (when import.meta.url is available; a bundled plugin loader may not set it). */
export function loadRoutes(env = process.env) {
  let root = null;
  try { root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "routes"); } catch { /* bundled: env only */ }
  for (const p of [env.AGENT_HUB_ROUTES, root && join(root, "routes.local.json"), root && join(root, "routes.template.json")]) {
    if (p && existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  return {};
}

/** Repo default gate: first `gates` row whose `match` regex hits the cwd, else `gateDefault` unless it is a <PLACEHOLDER>. */
export function repoGate(routes, cwd) {
  const row = (routes.gates ?? []).find((r) => rx(r.match).test(cwd.replaceAll(String.fromCharCode(92), "/")));
  if (row) return row;
  const d = routes.gateDefault;
  return d && !d.startsWith("<") ? { cmd: d } : {};
}

// Scan limits: past them the gate FAILS CLOSED (a scan that cannot cover everything is not a PASS).
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // the base of a repo with no commits yet
const MAX_FILE = 16 << 20, MAX_TOTAL = 128 << 20, MAX_DEPTH = 16;

/** True when the bytes hold a secret as UTF-8/latin1 text (binary files too) or as UTF-16 text, little or big endian, at either byte alignment (odd-length buffers included). */
export function bufHasSecret(buf) {
  if (SECRET_RE.test(buf.toString("latin1"))) return true;
  for (const b of [buf, buf.subarray(1)]) {
    const even = b.subarray(0, b.length & ~1);
    if (SECRET_RE.test(even.toString("utf16le")) || SECRET_RE.test(Buffer.from(even).swap16().toString("utf16le"))) return true;
  }
  return false;
}

/** Scan one file into `out`; the budget is shared so a repo of many files cannot pass unscanned. */
function scanFile(f, label, budget, out, deleted = new Set()) {
  try {
    const st = statSync(f);
    if (st.size > MAX_FILE || st.size > budget.left) { out.push("scan incomplete: " + label + " is too large to scan (" + st.size + " bytes)"); return; }
    budget.left -= st.size;
    if (bufHasSecret(readFileSync(f))) out.push("secret pattern in " + label);
  } catch (e) { if (!(e?.code === "ENOENT" && deleted.has(label))) out.push("scan incomplete: cannot read " + label); /* only a file git lists as deleted has nothing to scan */ }
}

/** Secret scan of a plain folder: every file (binary and UTF-16 included) up to depth 16, 16 MB per file, 128 MB total; scans .git and node_modules too (the shared budget makes a huge one fail closed); reports what it could not cover. */
export function scanFolder(root, budget = { left: MAX_TOTAL }, depth = 0, rel = "") {
  const out = [];
  let ents = [];
  try { ents = readdirSync(root, { withFileTypes: true }); } catch { return ["scan incomplete: cannot read folder " + (rel || ".")]; }
  for (const e of ents) {
    const f = join(root, e.name), label = rel + e.name;
    if (e.isDirectory()) {
      if (depth >= MAX_DEPTH) { out.push("scan incomplete: " + label + " is deeper than " + MAX_DEPTH + " levels"); continue; }
      out.push(...scanFolder(f, budget, depth + 1, label + "/")); continue;
    }
    if (e.isFile()) scanFile(f, label, budget, out);
  }
  return out;
}

const isPyc = (f) => f.includes("__pycache__") || f.endsWith(".pyc"); // exempt only from the allow-list; forbid applies to every path

/** Paths git status lists (changed, intent-to-add, untracked), NUL-separated, no rename pairing. */
function statusPaths(cwd) {
  return git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]).split(String.fromCharCode(0)).filter(Boolean).map((e) => e.slice(3));
}

/** Folders below the repo root that hold their own .git (git lists a nested repo as one entry, so its files are never diffed): walk the tree for them, bounded. */
function nestedGit(cwd, reasons) {
  const found = []; let n = 0;
  const walk = (dir, rel, depth) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { reasons.push("scan incomplete: cannot read folder " + (rel || ".")); return; }
    if (rel && ents.some((e) => e.name === ".git")) { found.push(rel); return; }
    for (const e of ents) {
      if (++n > 200000) { if (n === 200001) reasons.push("scan incomplete: more than 200000 entries while looking for nested repos"); return; }
      if (!e.isDirectory() || (!rel && e.name === ".git")) continue;
      if (depth >= MAX_DEPTH) { reasons.push("scan incomplete: " + rel + e.name + " is deeper than " + MAX_DEPTH + " levels"); continue; }
      walk(join(dir, e.name), rel + e.name + "/", depth + 1);
    }
  };
  walk(cwd, "", 0);
  return found.map((r) => r.replace(/\/$/, ""));
}

/** The one place the gate options are built, shared by the plugin hook and the route CLI so the two paths cannot drift. */
export function gateOpts(routes, cwd, cmd, base = null) {
  const row = repoGate(routes, cwd);
  return { base, requireBase: true, cmd: cmd ?? row.cmd, maxLines: Number(row.maxLines ?? 400), forbid: row.forbid ?? null, allow: row.allow ?? null };
}

/**
 * Run the gate in `cwd`.
 * opts: { cmd, maxLines = 400, forbid (RegExp source or null), allow (RegExp source or null) }
 * `base`: the commit the task started from; the diff and a log scan run against it, so work the agent COMMITTED is judged too (default HEAD).
 * `allow`: when set, every changed file must match it (the allowed-path check); `forbid`: no changed file may match.
 */
export function runGate(cwd, opts = {}) {
  const { cmd, maxLines = 400, forbid = null, allow = null, base = null, requireBase = false } = opts;
  const reasons = [];
  let diff = "", hist = "", files = [], raw = [], deleted = new Set();
  // not a git work tree: the diff rules cannot run, so fail closed unless a cmd gate exists and no path rules were asked for
  let inRepo = true;
  try { git(cwd, ["rev-parse", "--is-inside-work-tree"]); } catch { inRepo = false; }
  if (!inRepo) {
    if (forbid || allow) reasons.push("not a git work tree: diff-based rules cannot be evaluated");
    else if (!cmd) reasons.push("nothing to verify");
    else reasons.push(...scanFolder(cwd)); // cmd-only PASS still gets a bounded secret scan of the folder
  }
  const budget = { left: MAX_TOTAL };
  if (inRepo) try {
    let ref = "HEAD";
    if (base) {
      if (!/^[0-9a-f]{7,64}$/i.test(base)) throw new Error("bad base");
      git(cwd, ["cat-file", "-e", base + (base === EMPTY_TREE ? "^{tree}" : "^{commit}")]); ref = base;
    } else if (requireBase) { reasons.push("no base commit recorded for this task: gate cannot judge committed work"); }
    git(cwd, ["add", "-N", "."]); // intent-to-add so new files show in the diff
    diff = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", ref]);
    // NUL-separated: quoted or non-ASCII paths must not slip past the path rules or the byte scan
    const nul = String.fromCharCode(0);
    const names = (extra) => git(cwd, ["diff", "--no-ext-diff", "--no-textconv", ...extra, "--name-only", "-z", ref]).split(nul).filter(Boolean);
    raw = names([]);
    files = raw.filter((f) => !isPyc(f));
    // second view: git status must not list a path the diff does not (a path git cannot handle, e.g. too long, would otherwise PASS with files:0)
    const seen = new Set(raw);
    for (const p of statusPaths(cwd)) if (!seen.has(p) && !p.endsWith("/")) reasons.push("scan incomplete: git status lists " + p + " but git diff does not (git views disagree)");
    deleted = new Set(names(["--diff-filter=D"]));
    // a secret committed and then removed is gone from the net diff but still in history; -m covers merge commits, --text "binary" text files
    if (base) hist = git(cwd, ["log", "--no-ext-diff", "--no-textconv", "-m", "--text", "-p", "--format=", base === EMPTY_TREE ? "HEAD" : base + "..HEAD"]);
  } catch { reasons.push("git diff failed (not a repo, no HEAD, or the task's base commit is missing)"); }
  const lines = diff.split("\n");
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
  if (added.some((l) => SECRET_RE.test(l)) || hist.split("\n").some((l) => l.startsWith("+") && SECRET_RE.test(l))) reasons.push("secret pattern in diff");
  if (added.length + removed.length > maxLines) reasons.push(`diff larger than ${maxLines} lines`);
  // binary and UTF-16 files show no text in a diff: scan every changed file's bytes, and ignored files too (an agent can hide a file with .gitignore)
  if (inRepo) {
    for (const f of raw) scanFile(join(cwd, f), f, budget, reasons, deleted);
    for (const d of nestedGit(cwd, reasons)) reasons.push(...scanFolder(join(cwd, d), budget, 0, d + "/"));
    try {
      for (const f of git(cwd, ["ls-files", "-o", "-i", "--exclude-standard", "-z"]).split(String.fromCharCode(0)).filter(Boolean)) {
        if (f.startsWith(".git/")) continue;
        const r = []; scanFile(join(cwd, f), f, budget, r);
        reasons.push(...r.map((x) => x.replace("secret pattern in ", "secret pattern in ignored file ")));
      }
    } catch { reasons.push("scan incomplete: could not list ignored files"); }
  }
  if (files.includes(".gitignore")) reasons.push(".gitignore changed");
  const bad = [...raw.filter((f) => forbid && rx(forbid).test(f)), ...files.filter((f) => allow && !rx(allow).test(f))];
  if (bad.length) reasons.push("path not allowed: " + bad.join(","));
  if (cmd) {
    const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) reasons.push(`gate cmd exit ${r.status}: ` + (r.stderr || r.stdout || "").trim().slice(-300));
  }
  return { status: reasons.length ? "FAIL" : "PASS", noRepo: !inRepo, reasons, files: files.length, changed: added.length + removed.length, ranCmd: Boolean(cmd) };
}

/** Attempt logic (decision 47): first failure -> RETRY (re-prompt once), second -> FAIL (back to the caller). */
export function decide(prevAttempts, result, retryOff = false) {
  if (result.status === "PASS") return { status: "PASS", attempts: prevAttempts, reprompt: false };
  const attempts = prevAttempts + 1;
  if (attempts === 1 && !retryOff) return { status: "RETRY", attempts, reprompt: true };
  return { status: "FAIL", attempts, reprompt: false };
}
