// Gate core: pure functions, no Paseo imports, so the unit tests run under plain node.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";

// Secret scanning is delegated to gitleaks (pinned version, rules = config/gitleaks.toml: the default rules plus a few of ours). No hand-written regexes here.
export const GITLEAKS_VERSION = "8.30.1";
// The Paseo plugin bundler leaves import.meta.url undefined, which made this module throw at load (gate "failed" in `paseo plugin ls`): fall back to AGENT_HUB_REPO, then the install path in the Paseo config.
function repoRoot() {
  try { return join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); } catch { /* bundled */ }
  if (process.env.AGENT_HUB_REPO) return process.env.AGENT_HUB_REPO;
  try {
    const cfg = JSON.parse(readFileSync(join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "config.json"), "utf8"));
    const p = Object.values(cfg.plugins ?? {}).map((x) => x?.path).find((x) => x && existsSync(join(x, "..", "..", "config", "gitleaks.toml")));
    if (p) return join(p, "..", "..");
  } catch { /* no config */ }
  return process.cwd();
}
const ROOT = repoRoot();
export const GITLEAKS_CONFIG = join(ROOT, "config", "gitleaks.toml");
/** Binary: AGENT_HUB_GITLEAKS, else <repo>/tools/gitleaks/ (installed by the README steps), else `gitleaks` on PATH. */
export function gitleaksBin(env = process.env) {
  if (env.AGENT_HUB_GITLEAKS) return env.AGENT_HUB_GITLEAKS;
  const local = join(ROOT, "tools", "gitleaks", process.platform === "win32" ? "gitleaks.exe" : "gitleaks");
  return existsSync(local) ? local : "gitleaks";
}
/** ONE scratch folder per process, made on first use (never at import: 8,561 empty dirs piled up in %TEMP%) and removed when the process exits. */
let WORK = null;
function work() {
  if (!WORK) { WORK = mkdtempSync(join(tmpdir(), "agent-hub-gate-")); writeFileSync(join(WORK, "owner.pid"), String(process.pid)); // cleanup removes the folder once this pid is dead
    process.once("exit", () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ } }); }
  return WORK;
}
/** Empty folder: no .gitleaks.toml or .gitleaksignore is ever picked up from the caller's folder. */
const scanCwd = () => { const d = join(work(), "scan"); mkdirSync(d, { recursive: true }); return d; };
let verified = null;
/** Throws "secret scanner unavailable: ..." when the binary is missing, not the pinned version, times out or errors: callers FAIL CLOSED. */
function gl(args, input, bin, timeout) {
  const r = spawnSync(bin, args, { input, cwd: scanCwd(), encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 1 << 20, windowsHide: true });
  if (r.error) throw new Error("secret scanner unavailable: " + (r.error.code === "ETIMEDOUT" ? "timed out" : r.error.message));
  return r;
}
export function checkScanner(bin = gitleaksBin()) {
  const r = gl(["version"], "", bin, 15000);
  const v = String(r.stdout).trim();
  if (r.status !== 0 || v !== GITLEAKS_VERSION) throw new Error(`secret scanner unavailable: gitleaks ${GITLEAKS_VERSION} required, found ${v || "none"}`);
  return v;
}
const norm = (l) => l.replace(/\s+/g, " ").trim();
/** True when `text` holds a secret as is OR with the lines joined (a wrapped secret). Throws when the scanner cannot run. */
export function hasSecret(text, bin = gitleaksBin(), config = GITLEAKS_CONFIG) {
  const t = String(text);
  if (!t.trim()) return false;
  if (verified !== bin) { checkScanner(bin); verified = bin; }
  const NL = String.fromCharCode(10);
  const lines = t.replaceAll(String.fromCharCode(13), NL).split(NL).map(norm);
  // A text header first (leading binary-looking bytes must not make gitleaks skip the stream) and a random canary last: the scan counts only when gitleaks reports the canary, so a skipped or truncated scan is "unavailable", never "clean".
  const canary = "AGENTHUBCANARY" + randomBytes(16).toString("hex");
  const input = ["agent-hub secret scan input", t, lines.join(NL), lines.join(""), canary, ""].join(NL);
  const rep = join(mkdtempSync(join(scanCwd(), "r-")), "report.json");
  // --ignore-gitleaks-allow: a `gitleaks:allow` comment in the scanned text must not switch the scan off
  const r = gl(["stdin", "--no-banner", "--no-color", "--log-level", "error", "--ignore-gitleaks-allow", "--exit-code", "7", "--report-format", "json", "--report-path", rep, "-c", config], input, bin, 30000 + 10000 * (input.length >> 20));
  if (r.status !== 7 && r.status !== 0) throw new Error("secret scanner unavailable: gitleaks exited " + r.status);
  let found = null;
  try { found = JSON.parse(readFileSync(rep, "utf8")); } catch { /* missing or unreadable report: treated as unavailable below */ }
  rmSync(dirname(rep), { recursive: true, force: true });
  // the one accepted canary finding: this call's random value, on the last line. Any other finding, a canary-shaped string in the scanned text included, is a real one.
  const lastLine = input.split(NL).length - 1;
  const isCanary = (f) => f.RuleID === "agent-hub-canary" && f.Secret === canary && (f.StartLine === undefined || f.StartLine === lastLine);
  if (Array.isArray(found) && found.some((f) => !isCanary(f))) return true; // blocks even when the canary was dropped (gitleaks drops the tail of some huge repeated-pattern inputs)
  if (!Array.isArray(found) || !found.some(isCanary)) throw new Error("secret scanner unavailable: canary not reported (input skipped or scan incomplete)");
  return false;
}

// The worktree is untrusted: its .git/config must not run code (fsmonitor, hooks, external diff, textconv) and no user/system config is read.
const emptyDir = () => { const d = join(work(), "nohooks"); mkdirSync(d, { recursive: true }); const c = join(d, "empty.gitconfig"); if (!existsSync(c)) writeFileSync(c, ""); return d; };
// core.autocrlf=input: a worktree checked out with the user's autocrlf=true holds CRLF files; the empty gate config would diff every one of them
export const gitFlags = () => ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + emptyDir(), "-c", "diff.external=", "-c", "core.pager=cat", "-c", "core.longpaths=true", "-c", "core.autocrlf=input"];
export const gitEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(emptyDir(), "empty.gitconfig"), GIT_TERMINAL_PROMPT: "0" });
const git = (cwd, args) => execFileSync("git", [...gitFlags(), ...args], { cwd, env: gitEnv(), encoding: "utf8", maxBuffer: 32 << 20, stdio: ["ignore", "pipe", "ignore"] });

/** Patterns come only from the trusted routes file; cap the length so a bad config cannot build a huge regex. */
export function rx(src) {
  if (typeof src !== "string" || src.length > 200) throw new Error("pattern too long or not a string");
  return new RegExp(src);
}

/** Routing file: AGENT_HUB_ROUTES, else config/routes/routes.local.json, else the template (when import.meta.url is available; a bundled plugin loader may not set it). */
export function loadRoutes(env = process.env) {
  let root = null;
  try { root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "routes"); } catch { /* bundled: env only */ }
  for (const p of [env.AGENT_HUB_ROUTES, root && !(env.AGENT_HUB_NO_LOCAL === "1") && join(root, "routes.local.json"), root && join(root, "routes.template.json")]) {
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
const bufText = (buf) => {
  const parts = [buf.toString("latin1")];
  if (buf.includes(0)) for (const b of [buf, buf.subarray(1)]) {
    const even = b.subarray(0, b.length & ~1);
    parts.push(even.toString("utf16le"), Buffer.from(even).swap16().toString("utf16le"));
  }
  return parts.join(String.fromCharCode(10));
};
export const bufHasSecret = (buf) => hasSecret(bufText(buf));

// One gitleaks launch per file cost 0.1-2.2 s each: a plain 1,800-file folder took 3+ min per gate, 5,000 files over an hour (09-11-2026 hung routes). Files are scanned in batches of BATCH bytes; only a batch with a hit is re-scanned file by file to name the file.
const BATCH = 4 << 20;
function flushScan(budget, out) {
  const items = budget.batch ?? []; budget.batch = []; budget.batchBytes = 0;
  if (!items.length) return;
  // a hit is narrowed by halving (k hits cost about k*log2(n) scans, not n); a hit that no single file shows (a secret wrapped across two files) still fails closed
  const hit = (xs) => hasSecret(xs.map((i) => i.text).join(String.fromCharCode(10)));
  const find = (xs) => { if (!hit(xs)) return 0; if (xs.length === 1) { out.push("secret pattern in " + xs[0].label); return 1; } const m = xs.length >> 1; return find(xs.slice(0, m)) + find(xs.slice(m)) || (out.push("secret pattern across files " + xs.map((i) => i.label).slice(0, 3).join(", ")), 1); };
  try { find(items); } catch (e) { out.push(e.message); }
}
/** Scan one file into `out`; the budget is shared so a repo of many files cannot pass unscanned. */
function scanFile(f, label, budget, out, deleted = new Set()) {
  try {
    const st = statSync(f);
    if (st.size > MAX_FILE || st.size > budget.left) { out.push("scan incomplete: " + label + " is too large to scan (" + st.size + " bytes)"); return; }
    if (budget.deadline && Date.now() > budget.deadline) { if (!budget.timedOut) out.push("scan incomplete: the gate time limit was reached before every file was scanned"); budget.timedOut = true; return; }
    budget.left -= st.size;
    const text = bufText(readFileSync(f));
    (budget.batch ??= []).push({ label, text }); budget.batchBytes = (budget.batchBytes ?? 0) + text.length;
    if (budget.batchBytes >= BATCH) flushScan(budget, out);
  } catch (e) {
    if (/secret scanner unavailable/.test(e?.message)) { out.push(e.message); return; } if (!(e?.code === "ENOENT" && deleted.has(label))) out.push("scan incomplete: cannot read " + label); /* only a file git lists as deleted has nothing to scan */ }
}

/** Secret scan of a plain folder: every file (binary and UTF-16 included) up to depth 16, 16 MB per file, 128 MB total; scans .git and node_modules too (the shared budget makes a huge one fail closed); reports what it could not cover. */
export function scanFolder(root, budget = { left: MAX_TOTAL }, depth = 0, rel = "") {
  const out = [];
  let ents = [];
  // symlinks are followed by real path; a folder already scanned (or being scanned) is skipped, which also breaks loops. pnpm node_modules is mostly links into its own .pnpm store, so each target is read once.
  try { const real = realpathSync(root); const seen = (budget.seen ??= new Set()); if (seen.has(real)) return out; seen.add(real); } catch { return ["scan incomplete: cannot resolve folder " + (rel || ".")]; }
  try { ents = readdirSync(root, { withFileTypes: true }); } catch { return ["scan incomplete: cannot read folder " + (rel || ".")]; }
  for (const e of ents) {
    const f = join(root, e.name), label = rel + e.name;
    if (e.isSymbolicLink()) {
      let st; try { st = statSync(f); } catch { out.push("scan incomplete: symlink " + label + " not scanned (broken or unreadable target)"); continue; }
      if (st.isDirectory()) { if (depth >= MAX_DEPTH) { out.push("scan incomplete: " + label + " is deeper than " + MAX_DEPTH + " levels"); continue; } out.push(...scanFolder(f, budget, depth + 1, label + "/")); }
      else if (st.isFile()) { let real = f; try { real = realpathSync(f); } catch { /* scan the link path */ } const seen = (budget.seenFiles ??= new Set()); if (!seen.has(real)) { seen.add(real); scanFile(f, label, budget, out); } }
      else out.push("scan incomplete: symlink " + label + " not scanned (not a file or folder)");
      continue;
    }
    if (e.isDirectory()) {
      if (depth >= MAX_DEPTH) { out.push("scan incomplete: " + label + " is deeper than " + MAX_DEPTH + " levels"); continue; }
      out.push(...scanFolder(f, budget, depth + 1, label + "/")); continue;
    }
    if (e.isFile()) scanFile(f, label, budget, out);
  }
  flushScan(budget, out);
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
export function gateOpts(routes, cwd, cmd, base = null, maxLines = null) {
  const row = repoGate(routes, cwd);
  return { base, requireBase: true, cmd: cmd ?? row.cmd, maxLines: Number(maxLines ?? row.maxLines ?? 400), forbid: row.forbid ?? null, allow: row.allow ?? null };
}

export const OVERRUN = "!overrun";
/** Stat-only fingerprint of the git-ignored entries below cwd (same `--directory` listing as the gate's ignored scan; symlinks are not followed). overrun = the entry or time bound was hit, so the fingerprint cannot prove "unchanged". shortcut: (1) only inside cwd, readAllow roots outside it are not fingerprinted; (2) inside node_modules only names and folder mtimes are fingerprinted (a create or delete is caught, an in-place edit of an existing file is not) because lstat costs 0.5 ms per entry on this laptop (27 s for a 56k-entry pnpm tree); upgrade both if a read-only provider can write there. */
export function ignoredSig(cwd, { maxEntries = 400000, maxMs = 30000 } = {}) {
  const h = createHash("sha1"), end = Date.now() + maxMs; let n = 0, overrun = false;
  const walk = (dir, rel, nm) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { h.update("?" + rel); return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (overrun) return;
      if (++n > maxEntries || ((n & 255) === 0 && Date.now() > end)) { overrun = true; return; }
      const p = join(dir, e.name), r = rel + e.name;
      if (e.isDirectory()) { let m = 0; try { m = lstatSync(p).mtimeMs; } catch { /* vanished */ } h.update("d|" + r + "|" + m + "\n"); walk(p, r + "/", nm || e.name === "node_modules"); continue; }
      if (nm) { h.update("n|" + r + "\n"); continue; }
      try { const st = lstatSync(p); h.update(r + "|" + st.size + "|" + st.mtimeMs + "\n"); } catch { h.update("x|" + r + "\n"); }
    }
  };
  for (const f of git(cwd, ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"]).split(String.fromCharCode(0)).filter(Boolean)) {
    if (f.startsWith(".git/") || overrun) continue;
    if (f.endsWith("/")) { h.update("d|" + f + "\n"); walk(join(cwd, f), f, f === "node_modules/" || f.endsWith("/node_modules/")); continue; }
    try { const st = lstatSync(join(cwd, f)); h.update(f + "|" + st.size + "|" + st.mtimeMs + "\n"); } catch { h.update("x|" + f + "\n"); }
    if (++n > maxEntries) overrun = true;
  }
  return { hash: h.digest("hex"), overrun };
}

/** Cheap "did anything change" fingerprint of a git work tree: git status (untracked included, ignored not) plus the diff against HEAD plus the ignored-file stat fingerprint (ignoredSig). null = not a git work tree / git failed. A read-only task must leave it unchanged. */
export function gitSig(cwd, opts = {}) {
  try {
    const h = createHash("sha1");
    h.update(git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]));
    h.update(git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]));
    h.update(git(cwd, ["rev-parse", "HEAD"])); // a commit or reset leaves status and diff clean
    try { h.update(git(cwd, ["symbolic-ref", "-q", "HEAD"])); } catch { h.update("detached"); } // a branch switch likewise
    // ignored files: path + size + mtime of every ignored entry inside cwd (stat only, no reads; a content scan of a pnpm tree was 50 MB / 34 s), bounded by entries and time; over the bound the sig ends in OVERRUN and the caller reports unverifiable, never PASS
    const ig = ignoredSig(cwd, opts); h.update(ig.hash); if (ig.overrun) return h.digest("hex") + OVERRUN;
    return h.digest("hex");
  } catch { return null; }
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
  // read-only task: nothing may have changed (the caller compares gitSig before/after), so the diff, history and ignored-file scans have nothing to judge; only the gate command runs
  if (opts.readOnly) {
    if (cmd) { const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout: 120_000 }); if (r.status !== 0) reasons.push(`gate cmd exit ${r.status}: ` + (r.stderr || r.stdout || "").trim().slice(-300)); }
    return { status: reasons.length ? "FAIL" : "PASS", noRepo: false, reasons, files: 0, changed: 0, ranCmd: Boolean(cmd), readOnly: true };
  }
  let diff = "", hist = "", files = [], raw = [], deleted = new Set();
  const budget = { left: MAX_TOTAL, deadline: opts.deadlineMs ?? null };
  // not a git work tree: the diff rules cannot run, so fail closed unless a cmd gate exists and no path rules were asked for
  let inRepo = true;
  try { git(cwd, ["rev-parse", "--is-inside-work-tree"]); } catch { inRepo = false; }
  if (!inRepo) {
    if (forbid || allow) reasons.push("not a git work tree: diff-based rules cannot be evaluated");
    else if (!cmd) reasons.push("nothing to verify");
    else reasons.push(...scanFolder(cwd, budget)); // cmd-only PASS still gets a bounded secret scan of the folder
  }
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
  const histAdded = hist.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  try {
    if (hasSecret(added.map((l) => l.slice(1)).join(String.fromCharCode(10))) || hasSecret(histAdded.map((l) => l.slice(1)).join(String.fromCharCode(10)))) reasons.push("secret pattern in diff");
  } catch (e) { reasons.push(e.message); }
  if (added.length + removed.length > maxLines) reasons.push(`diff larger than ${maxLines} lines (split the task into smaller ones, or pass --max-lines N to agent-hub route)`);
  // binary and UTF-16 files show no text in a diff: scan every changed file's bytes, and ignored files too (an agent can hide a file with .gitignore)
  if (inRepo) {
    for (const f of raw) scanFile(join(cwd, f), f, budget, reasons, deleted);
    flushScan(budget, reasons);
    for (const d of nestedGit(cwd, reasons)) reasons.push(...scanFolder(join(cwd, d), budget, 0, d + "/"));
    try {
      // --directory: an ignored folder (node_modules) is ONE entry, not 50 MB of file names that overflowed git()'s buffer; it is then walked by scanFolder under the same budget and deadline, so a huge one fails closed with the honest "too large to scan" reason
      for (const f of git(cwd, ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"]).split(String.fromCharCode(0)).filter(Boolean)) {
        if (f.startsWith(".git/")) continue;
        const r = f.endsWith("/") ? scanFolder(join(cwd, f), budget, 0, f) : (() => { const o = []; scanFile(join(cwd, f), f, budget, o); return o; })();
        const rr = r.map((x) => x.replace("secret pattern in ", "secret pattern in ignored file "));
        reasons.push(...rr.slice(0, 5), ...(rr.length > 5 ? ["scan incomplete: " + (rr.length - 5) + " more findings in " + f] : [])); // a 100k-file folder must not return 100k reasons
      }
      { const r = []; flushScan(budget, r); reasons.push(...r.map((x) => x.replace("secret pattern in ", "secret pattern in ignored file "))); }
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
