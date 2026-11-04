// Gate core: pure functions, no Paseo imports, so the unit tests run under plain node.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

/**
 * Run the gate in `cwd`.
 * opts: { cmd, maxLines = 400, forbid (RegExp source or null), allow (RegExp source or null) }
 * `allow`: when set, every changed file must match it (the allowed-path check); `forbid`: no changed file may match.
 */
export function runGate(cwd, opts = {}) {
  const { cmd, maxLines = 400, forbid = null, allow = null } = opts;
  const reasons = [];
  let diff = "", files = [];
  try {
    git(cwd, ["add", "-N", "."]); // intent-to-add so new files show in the diff
    diff = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]);
    files = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--name-only"]).split("\n").filter((f) => f && !f.includes("__pycache__") && !f.endsWith(".pyc"));
  } catch { reasons.push("git diff failed (not a repo or no HEAD)"); }
  const lines = diff.split("\n");
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
  if (added.some((l) => SECRET_RE.test(l))) reasons.push("secret pattern in diff");
  if (added.length + removed.length > maxLines) reasons.push(`diff larger than ${maxLines} lines`);
  // an agent can hide a file with .gitignore: scan ignored files too and flag .gitignore edits
  try {
    for (const f of git(cwd, ["ls-files", "-o", "-i", "--exclude-standard"]).split("\n").filter(Boolean)) {
      if (f.startsWith(".git/") || f.includes("__pycache__") || f.includes("node_modules/")) continue;
      try { if (SECRET_RE.test(readFileSync(join(cwd, f), "utf8"))) reasons.push("secret pattern in ignored file " + f); } catch { /* binary or unreadable */ }
    }
  } catch { /* not a repo */ }
  if (files.includes(".gitignore")) reasons.push(".gitignore changed");
  const bad = files.filter((f) => (forbid && rx(forbid).test(f)) || (allow && !rx(allow).test(f)));
  if (bad.length) reasons.push("path not allowed: " + bad.join(","));
  if (cmd) {
    const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) reasons.push(`gate cmd exit ${r.status}: ` + (r.stderr || r.stdout || "").trim().slice(-300));
  }
  return { status: reasons.length ? "FAIL" : "PASS", reasons, files: files.length, changed: added.length + removed.length, ranCmd: Boolean(cmd) };
}

/** Attempt logic (decision 47): first failure -> RETRY (re-prompt once), second -> FAIL (back to the caller). */
export function decide(prevAttempts, result, retryOff = false) {
  if (result.status === "PASS") return { status: "PASS", attempts: prevAttempts, reprompt: false };
  const attempts = prevAttempts + 1;
  if (attempts === 1 && !retryOff) return { status: "RETRY", attempts, reprompt: true };
  return { status: "FAIL", attempts, reprompt: false };
}
