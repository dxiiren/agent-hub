// Gate core: pure functions, no Paseo imports, so the unit tests run under plain node.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SECRET_RE =
  /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,}|(api[_-]?key|token|secret|passw(or)?d)\s*[:=]\s*['"][A-Za-z0-9_\-\/+]{16,}['"])/i;

// The worktree is untrusted: its .git/config must not run code (fsmonitor, hooks, external diff, textconv) and no user/system config is read.
const EMPTY_DIR = mkdtempSync(join(tmpdir(), "agent-hub-nohooks-"));
const EMPTY_CFG = join(EMPTY_DIR, "empty.gitconfig");
writeFileSync(EMPTY_CFG, "");
export const GIT_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + EMPTY_DIR, "-c", "diff.external=", "-c", "core.pager=cat"];
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
const MAX_FILE = 16 << 20, MAX_TOTAL = 128 << 20, MAX_DEPTH = 16;

/** True when the bytes hold a secret as UTF-8/latin1 text (binary files too) or as UTF-16 text at either byte alignment. */
export function bufHasSecret(buf) {
  return SECRET_RE.test(buf.toString("latin1")) || SECRET_RE.test(buf.toString("utf16le")) || (buf.length > 1 && SECRET_RE.test(buf.subarray(1).toString("utf16le")));
}

/** Scan one file into `out`; the budget is shared so a repo of many files cannot pass unscanned. */
function scanFile(f, label, budget, out) {
  try {
    const st = statSync(f);
    if (st.size > MAX_FILE || st.size > budget.left) { out.push("scan incomplete: " + label + " is too large to scan (" + st.size + " bytes)"); return; }
    budget.left -= st.size;
    if (bufHasSecret(readFileSync(f))) out.push("secret pattern in " + label);
  } catch (e) { if (e?.code !== "ENOENT") out.push("scan incomplete: cannot read " + label); /* deleted files have nothing to scan */ }
}

/** Secret scan of a plain folder: every file (binary and UTF-16 included) up to depth 16, 16 MB per file, 128 MB total; skips .git and node_modules; reports what it could not cover. */
export function scanFolder(root, budget = { left: MAX_TOTAL }, depth = 0, rel = "") {
  const out = [];
  let ents = [];
  try { ents = readdirSync(root, { withFileTypes: true }); } catch { return ["scan incomplete: cannot read folder " + (rel || ".")]; }
  for (const e of ents) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const f = join(root, e.name), label = rel + e.name;
    if (e.isDirectory()) {
      if (depth >= MAX_DEPTH) { out.push("scan incomplete: " + label + " is deeper than " + MAX_DEPTH + " levels"); continue; }
      out.push(...scanFolder(f, budget, depth + 1, label + "/")); continue;
    }
    if (e.isFile()) scanFile(f, label, budget, out);
  }
  return out;
}

/** The one place the gate options are built, shared by the plugin hook and the route CLI so the two paths cannot drift. */
export function gateOpts(routes, cwd, cmd, base = null) {
  const row = repoGate(routes, cwd);
  return { base, cmd: cmd ?? row.cmd, maxLines: Number(row.maxLines ?? 400), forbid: row.forbid ?? null, allow: row.allow ?? null };
}

/**
 * Run the gate in `cwd`.
 * opts: { cmd, maxLines = 400, forbid (RegExp source or null), allow (RegExp source or null) }
 * `base`: the commit the task started from; the diff and a log scan run against it, so work the agent COMMITTED is judged too (default HEAD).
 * `allow`: when set, every changed file must match it (the allowed-path check); `forbid`: no changed file may match.
 */
export function runGate(cwd, opts = {}) {
  const { cmd, maxLines = 400, forbid = null, allow = null, base = null } = opts;
  const reasons = [];
  let diff = "", hist = "", files = [];
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
      git(cwd, ["cat-file", "-e", base + "^{commit}"]); ref = base;
    }
    git(cwd, ["add", "-N", "."]); // intent-to-add so new files show in the diff
    diff = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", ref]);
    files = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", ref, "--name-only"]).split("\n").filter((f) => f && !f.includes("__pycache__") && !f.endsWith(".pyc"));
    // a secret committed and then removed is gone from the net diff but still in history
    if (base) hist = git(cwd, ["log", "--no-ext-diff", "--no-textconv", "-p", "--format=", base + "..HEAD"]);
  } catch { reasons.push("git diff failed (not a repo, no HEAD, or the task's base commit is missing)"); }
  const lines = diff.split("\n");
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
  if (added.some((l) => SECRET_RE.test(l)) || hist.split("\n").some((l) => l.startsWith("+") && SECRET_RE.test(l))) reasons.push("secret pattern in diff");
  if (added.length + removed.length > maxLines) reasons.push(`diff larger than ${maxLines} lines`);
  // binary and UTF-16 files show no text in a diff: scan every changed file's bytes, and ignored files too (an agent can hide a file with .gitignore)
  if (inRepo) {
    for (const f of files) scanFile(join(cwd, f), f, budget, reasons);
    try {
      for (const f of git(cwd, ["ls-files", "-o", "-i", "--exclude-standard"]).split("\n").filter(Boolean)) {
        if (f.startsWith(".git/") || f.includes("__pycache__") || f.includes("node_modules/")) continue;
        const r = []; scanFile(join(cwd, f), f, budget, r);
        reasons.push(...r.map((x) => x.replace("secret pattern in ", "secret pattern in ignored file ")));
      }
    } catch { reasons.push("scan incomplete: could not list ignored files"); }
  }
  if (files.includes(".gitignore")) reasons.push(".gitignore changed");
  const bad = files.filter((f) => (forbid && rx(forbid).test(f)) || (allow && !rx(allow).test(f)));
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
