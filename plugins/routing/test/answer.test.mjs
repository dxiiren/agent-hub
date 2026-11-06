import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lastAnswer, runRoute, withAnswer } from "../route.mjs";
import { claimRequest, saveState } from "../../gate/server/store.mjs";

const ALL = ["codex", "qwen", "claude", "claude-clean", "qwen-code", "qwen-code-2", "qwen-laptop", "opencode", "qoder"];
const routes = { readOnlyEnforced: ALL, readOnlyModes: { codex: "auto", qwen: "plan" }, slots: { codex: 1, qwen: 2 }, routes: { edit: ["codex/a", "qwen/b"] } };
const o = { type: "edit", prompt: "p", cwd: "/r", session: "S1", dev: "d", client: "claude", answerRetryMs: 0 };
const FIX = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "logs");
const fixture = (n) => readFileSync(join(FIX, n), "utf8");

// real `paseo logs` / `paseo logs --filter assistant` output of one agent per provider family (paths anonymised)
const PAGING = "Fixed: `paging.py` now computes the start index as `(n - 1) * size`, so pages are 1-based as the docstring says. `python -m unittest test_paging` ran 2 tests and both passed.\n\nI didn't add handling for `n < 1`. With `n = 0` the start index goes negative and returns items from the end of the list.";
const FAMILIES = [
  ["codex", "Committed `ok-1.txt` containing exactly `OK`.\n\nBase commit: `53f8b6204a52cb82038bf29ad3188b12d15d9945`\nTask commit: `ed89a94436c517e1317c63de6d6ef7bc82b97af0`"],
  ["claude", PAGING],
  ["claude-clean", "OK"],
  ["qoder", "Committed `ok-4.txt` (commit `71ecce4`)."],
  ["qwen-code", "OK"],
  ["qwen-code-2", "OK"],
  ["qwen-laptop", "OK"],
  ["opencode", "Created `cell.txt` with exactly `OK-qoder-opencode`. No commit made."],
];

test("answer is the agent's last assistant message for every provider family (real log fixtures)", () => {
  for (const [fam, want] of FAMILIES) {
    const p = (a) => (a[0] === "ls" ? [] : a[0] === "logs" ? { text: fixture(a.includes("--filter") ? `${fam}.assistant.txt` : `${fam}.txt`) } : { status: "completed", agentId: "A1" });
    const r = runRoute({ ...o, provider: "qwen/b" }, p, routes);
    assert.equal(r.answer.replace(/ +$/gm, ""), want, fam);
    assert.equal(r.answerReason, undefined, fam);
  }
});

test("answer: a re-prompt block, a thought continuation and tool lines after the final message never become the answer", () => {
  const full = "[User] q\nOK first\n[User] Your work failed the gate: x\nFix it and finish.\n[Thought] hmm\n\nmore thinking\nReal final.\n[Shell] git commit\n";
  assert.equal(lastAnswer(full, 4096, "OK first\nReal final.").answer, "Real final.");
  assert.equal(lastAnswer("[User] q\nline two of the prompt\n", 4096, "").answer, "", "no assistant text at all");
  assert.equal(lastAnswer("[User] q\nOK\n[Thought] trailing\n\nthought tail", 4096, "OK").answer, "OK", "final run is a thought: fall back to the assistant text");
  assert.equal(lastAnswer("[Tasks]\n- [x] a\nDone.", 4096, "Done.").answer, "Done.");
});

test("answer is present for every route: empty plus answerReason when nothing readable; a late message is re-read once", () => {
  const empty = withAnswer({ agentId: "A" }, (a) => ({ text: a.includes("--filter") ? "" : "[User] q\n[Shell] x\n" }), 0);
  assert.equal(empty.answer, ""); assert.match(empty.answerReason, /no assistant text/);
  assert.match(withAnswer({ agentId: "A" }, () => ({ error: "boom" }), 0).answerReason, /unreadable: boom/);
  let n = 0; let slept = 0;
  const late = (a) => { if (a[0] !== "logs") return {}; const done = n > 0; if (!a.includes("--filter")) n++; return { text: a.includes("--filter") ? (done ? "final" : "") : (done ? "[User] q\nfinal\n" : "[User] q\n[Shell] x\n") }; };
  assert.equal(withAnswer({ agentId: "A" }, late, 1500, () => { slept++; }).answer, "final"); assert.equal(slept, 1);
});

test("worktree route: the route creates the worktree from the pinned base and registers the gate request under its path BEFORE the agent exists (a fast agent cannot beat registration)", () => {
  const d = mkdtempSync(join(tmpdir(), "gd-")); const seen = {};
  const p = (a) => {
    if (a[0] === "worktree" && a[1] === "create") { seen.create = a; return { name: "wt-x", worktreePath: "/wt/one" }; }
    if (a[0] === "run") { seen.runCwd = a[a.indexOf("--cwd") + 1]; seen.reqAtRun = claimRequest(d, "/wt/one"); return { status: "running", agentId: "W1" }; }
    return a[0] === "ls" ? [{ id: "W1", cwd: "/wt/one" }] : a[0] === "wait" ? { status: "idle" } : {};
  };
  runRoute({ ...o, provider: "qwen/b", worktree: true, base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", gate: "true", gateDir: d }, p, routes, () => ({ status: "PASS", reasons: [] }));
  assert.deepEqual(seen.reqAtRun, { cmd: "true", base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "request existed when run was called");
  assert.equal(seen.runCwd, "/wt/one"); assert.equal(claimRequest(d, "/r"), null);
  assert.deepEqual(seen.create.slice(0, 8), ["worktree", "create", "--mode", "branch-off", "--new-branch", seen.create[5], "--base", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
});
test("worktree route: no commit to pin or a failed create launches nothing", () => {
  const calls = [];
  const none = runRoute({ ...o, provider: "qwen/b", worktree: true }, (a) => { calls.push(a); return a[0] === "ls" ? [] : {}; }, routes);
  assert.equal(none.used, null); assert.match(JSON.stringify(none.trace), /at least one commit/);
  const bad = runRoute({ ...o, provider: "qwen/b", worktree: true, base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, (a) => { calls.push(a); return a[0] === "worktree" ? { error: "boom" } : a[0] === "ls" ? [] : {}; }, routes);
  assert.equal(bad.used, null); assert.match(JSON.stringify(bad.trace), /worktree create failed: boom/);
  assert.ok(!calls.some((c) => c[0] === "run"));
});
test("the gate attempts include the re-prompt the plugin hook already sent", () => {
  const d = mkdtempSync(join(tmpdir(), "gd-")); saveState(d, { W2: { attempts: 1, status: "PASS" } });
  const p = (a) => (a[0] === "ls" ? [{ id: "W2", cwd: "/wt/two" }] : a[0] === "run" ? { status: "completed", agentId: "W2" } : {});
  const r = runRoute({ ...o, provider: "qwen/b", gate: "true", gateDir: d }, p, routes, () => ({ status: "PASS", reasons: [] }));
  assert.equal(r.gate.attempts, 1);
});

test("worktree retire: the route-created worktree is archived by name after the agent, --keep leaves it, and an agent-less failure still removes it", () => {
  const calls = [];
  const p = (a) => { calls.push(a); return a[0] === "ls" ? [] : a[0] === "worktree" ? (a[1] === "create" ? { name: "wt-9", worktreePath: "/wt/9" } : {}) : a[0] === "run" ? { status: "completed", agentId: "W9" } : {}; };
  runRoute({ ...o, provider: "qwen/b", worktree: true, base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, p, routes);
  assert.deepEqual(calls.filter((c) => c[0] === "worktree" && c[1] === "archive"), [["worktree", "archive", "wt-9", "--cwd", "/r"]]);
  assert.ok(calls.findIndex((c) => c[0] === "archive") < calls.findIndex((c) => c[0] === "worktree" && c[1] === "archive"), "agent archived first");
  calls.length = 0;
  runRoute({ ...o, provider: "qwen/b", worktree: true, base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, (a) => (a[0] === "run" ? { error: "x" } : p(a)), routes);
  assert.ok(calls.some((c) => c[0] === "worktree" && c[1] === "archive"));
});
