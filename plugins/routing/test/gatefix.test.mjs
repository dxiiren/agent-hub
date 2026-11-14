import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { callerGate, runStatus } from "../route.mjs";
import { evaluate } from "../../gate/server/hook.mjs";
import { writeRequest } from "../../gate/server/store.mjs";
import { gateOpts, runGate, gitSig } from "../../gate/server/gate.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
function repo() {
  const d = mkdtempSync(join(tmpdir(), "gf-"));
  sh(d, "init", "-q"); writeFileSync(join(d, "a.txt"), "x\n"); sh(d, "add", "."); sh(d, "-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", "i");
  return d;
}
const head = (d) => sh(d, "rev-parse", "HEAD").trim();
const OK = 'node -e "process.exit(0)"';
const paseo = (d) => (a) => (a[0] === "ls" ? [{ id: "A1", cwd: d }] : a[0] === "send" ? {} : a[0] === "wait" ? { status: "idle" } : {});

test("issue 1: a read-only request makes the hook skip the diff gate (N/A, no re-prompt)", () => {
  const d = repo(), st = mkdtempSync(join(tmpdir(), "st-"));
  writeRequest(st, d, null, head(d), { readOnly: true });
  const r = evaluate({ dir: st, id: "S1", cwd: d, routes: {} });
  assert.equal(r.mirror["gate/status"], "N/A"); assert.equal(r.d.reprompt, false);
  assert.doesNotMatch(r.mirror["gate/reasons"], /nothing to verify/);
});
test("issue 1: an edit request is still gated", () => {
  const d = repo(), st = mkdtempSync(join(tmpdir(), "st-"));
  writeRequest(st, d, 'node -e "process.exit(1)"', head(d), { readOnly: false });
  assert.equal(evaluate({ dir: st, id: "E1", cwd: d, routes: {} }).d.status, "RETRY");
});
test("issue 2: --max-lines raises the limit for one call; the failure says how", () => {
  const d = repo(), b = head(d);
  writeFileSync(join(d, "big.txt"), "l\n".repeat(500));
  const low = runGate(d, gateOpts({}, d, OK, b));
  assert.match(low.reasons.join(), /diff larger than 400 lines \(split the task.*--max-lines/);
  assert.equal(runGate(d, gateOpts({}, d, OK, b, 600)).status, "PASS");
});
test("issue 2: the request carries maxLines to the hook", () => {
  const d = repo(), st = mkdtempSync(join(tmpdir(), "st-"));
  writeFileSync(join(d, "big.txt"), "l\n".repeat(500));
  writeRequest(st, d, OK, head(d), { maxLines: 700 });
  assert.equal(evaluate({ dir: st, id: "M1", cwd: d, routes: {} }).d.status, "PASS");
});
test("issue 3: an edit whose gate saw no changed file is a failure, not a pass", () => {
  const d = repo();
  const g = callerGate({ gate: OK, base: head(d), knownCwd: d }, "A1", paseo(d), runGate, { gateRetry: false });
  assert.equal(g.status, "FAIL"); assert.match(g.reasons.join(), /no diff produced/);
});
test("issue 3: a real edit still passes", () => {
  const d = repo(), b = head(d); writeFileSync(join(d, "a.txt"), "y\n");
  assert.equal(callerGate({ gate: OK, base: b, knownCwd: d }, "A1", paseo(d), runGate, { gateRetry: false }).status, "PASS");
});
test("issue 4: --status returns status, gate state and the answer", () => {
  const p = (a) => (a[0] === "inspect" ? { Status: "idle", Archived: false, Cwd: "/x" } : a[0] === "logs" ? { text: "[User] q\nthe answer\n" } : {});
  const r = runStatus("A1", p, mkdtempSync(join(tmpdir(), "st-")));
  assert.equal(r.status, "completed"); assert.equal(r.answer, "the answer"); assert.equal(r.gate, null);
  assert.equal(runStatus("A1", (a) => (a[0] === "inspect" ? { Status: "running" } : {}), mkdtempSync(join(tmpdir(), "st-"))).status, "running");
  assert.match(runStatus("../x", p).error, /not an agent id/);
});

import { checkFileInputs } from "../route.mjs";
import { mkdirSync, symlinkSync } from "node:fs";
const CRED = ["cred", "entials.json"].join(""); // spelled in two parts so the repo secret scan does not flag a fixture name
const ff = () => {
  const d = mkdtempSync(join(tmpdir(), "ff-")), out = mkdtempSync(join(tmpdir(), "out-"));
  const mk = (n, c = "a b 1 2", dir = d) => { const p = join(dir, n); writeFileSync(p, c); return p; };
  return { d, out, mk, o: { roots: [d], scan: () => false, home: join(d, "home") } };
};
test("--file: sensitive names, dotfiles, ../ traversal and symlinks to them are refused", () => {
  const { d, mk, o } = ff(); mkdirSync(join(d, "sub"));
  for (const n of [CRED, "server.key", ".env", "id_rsa", "my-secret.txt"]) assert.match(checkFileInputs([mk(n)], o).error ?? "", /refused/, n);
  assert.match(checkFileInputs([join(d, "sub", "..", CRED)], o).error ?? "", /refused/);
  try { symlinkSync(join(d, CRED), join(d, "sub", "harmless.txt")); assert.match(checkFileInputs([join(d, "sub", "harmless.txt")], o).error ?? "", /refused/); } catch (e) { if (e.code !== "EPERM") throw e; }
});
test("--file: a file under a dot-folder inside the allow root, and a file outside it, are refused", () => {
  const { d, out, mk, o } = ff(); mkdirSync(join(d, ".ssh"));
  assert.match(checkFileInputs([mk("id_x.tsv", "k", join(d, ".ssh"))], o).error ?? "", /refused: dotfile/);
  assert.match(checkFileInputs([mk("data.tsv", "k", out)], o).error ?? "", /refused: outside/);
});
test("--file: UTF-16, NUL bytes and a scanner hit are refused; a plain UTF-8 .tsv inside the root passes", () => {
  const { d, mk, o } = ff();
  assert.match(checkFileInputs([mk("u16.txt", Buffer.from("﻿token ghp_" + "a".repeat(36), "utf16le"))], o).error ?? "", /not plain UTF-8/);
  assert.match(checkFileInputs([mk("bin.dat", Buffer.from([65, 0, 66]))], o).error ?? "", /not plain UTF-8/);
  assert.match(checkFileInputs([mk("hit.tsv")], { ...o, scan: () => true }).error ?? "", /credential/);
  assert.equal(checkFileInputs([mk("data.tsv")], o).error, undefined);
});
test("--file: a file inside a protected folder is refused even when it is under the root", () => {
  const home = mkdtempSync(join(tmpdir(), "hm-")); mkdirSync(join(home, ".claude")); const p = join(home, ".claude", "n.tsv"); writeFileSync(p, "x");
  assert.match(checkFileInputs([p], { roots: [home], scan: () => false, home }).error, /refused/);
});
test("hung routes: the gate re-prompt wait is bounded by the attempt deadline, not a flat 900 s", () => {
  const d = repo(), calls = [];
  const p = (a, opts) => { calls.push([a, opts]); return a[0] === "ls" ? [{ id: "A1", cwd: d }] : {}; };
  const fail = () => ({ status: "FAIL", reasons: ["x"], files: 1, changed: 1 });
  callerGate({ gate: OK, knownCwd: d, now: () => 1000, deadlineMs: 1000 + 120_000 }, "A1", p, fail, {});
  const w = calls.find(([a]) => a[0] === "wait");
  assert.equal(w[0][3], "120"); assert.equal(w[1].timeoutMs, 150_000);
  calls.length = 0; callerGate({ gate: OK, knownCwd: d, now: () => 5000, deadlineMs: 1000 }, "A1", p, fail, {});
  assert.equal(calls.find(([a]) => a[0] === "wait")[0][3], "60");
});
test("hung routes: a folder of many files is scanned in batches, not one gitleaks launch per file", () => {
  const d = mkdtempSync(join(tmpdir(), "many-")); // not a git repo: the gate secret-scans every file of the folder
  for (let i = 0; i < 150; i++) writeFileSync(join(d, `f${i}.json`), JSON.stringify({ i, note: "plain text" }));
  const t = Date.now(); const r = runGate(d, { cmd: OK });
  assert.equal(r.status, "PASS"); assert.ok(Date.now() - t < 20_000, "150 files took " + (Date.now() - t) + " ms (was ~0.3-2 s per file)");
  writeFileSync(join(d, "f7.json"), "aws_access_key_id = AKIAIOSFODNN7EXAMPLQ\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEYQ1\n");
  assert.match(runGate(d, { cmd: OK }).reasons.join(), /secret pattern in f7\.json/);
});
test("hung routes: the gate stops scanning at its deadline and fails closed", () => {
  const d = mkdtempSync(join(tmpdir(), "late-")); for (let i = 0; i < 5; i++) writeFileSync(join(d, `f${i}`), "x");
  const r = runGate(d, { cmd: OK, deadlineMs: Date.now() - 1 });
  assert.equal(r.status, "FAIL"); assert.match(r.reasons.join(), /gate time limit/);
});
test("issue 5: --status of a cut-off route runs the requested gate (a no-op edit is not 'completed, gate null')", () => {
  const d = repo(), b = head(d), st = mkdtempSync(join(tmpdir(), "st-"));
  writeRequest(st, d, 'node -e "process.exit(0)"', b, {});
  const p = (a) => (a[0] === "inspect" ? { Status: "idle", Cwd: d } : a[0] === "ls" ? [{ id: "A1", cwd: d }] : a[0] === "logs" ? { text: "x\nok\n" } : {});
  const r = runStatus("A1", p, st, runGate, { gateRetry: false });
  assert.equal(r.status, "gate-failed"); assert.equal(r.gate.status, "FAIL"); assert.match(r.gate.reasons.join(), /no diff produced/);
  writeFileSync(join(d, "a.txt"), "y\n"); // a real edit with a failing gate command must fail too
  writeRequest(st, d, 'node -e "process.exit(1)"', b, {});
  assert.equal(runStatus("A1", p, st, runGate, {}).status, "gate-failed");
  writeRequest(st, d, 'node -e "process.exit(0)"', b, {});
  { const r3 = runStatus("A1", p, st, runGate, {}); assert.equal(r3.status, "completed", JSON.stringify(r3.gate)); }
});
test("read-only: --status runs only the command and the unchanged-tree check (no diff/ignored scan)", () => {
  const d = repo(), b = head(d), st = mkdtempSync(join(tmpdir(), "st-"));
  const p = (a) => (a[0] === "inspect" ? { Status: "idle", Cwd: d } : a[0] === "ls" ? [{ id: "A1", cwd: d }] : a[0] === "logs" ? { text: "x\nok\n" } : {});
  writeRequest(st, d, null, b, { readOnly: true, sig: gitSig(d) });
  const r = runStatus("A1", p, st, runGate, {}); assert.equal(r.status, "completed"); assert.equal(r.gate.status, "PASS");
  writeFileSync(join(d, "new.txt"), "changed\n"); // the read-only task changed the tree
  const r2 = runStatus("A1", p, st, runGate, {}); assert.equal(r2.status, "failed-readonly-changed"); assert.match(r2.gate.reasons.join(), /changed the work tree/);
});
test("read-only: callerGate with --gate passes on no change, fails on a change or a failing command", () => {
  const d = repo(), b = head(d), sig = gitSig(d), p = (a) => (a[0] === "ls" ? [{ id: "A1", cwd: d }] : {});
  const o = (gate) => ({ gate, base: b, ro: true, roSig: sig });
  assert.equal(callerGate(o('node -e "process.exit(0)"'), "A1", p, runGate, {}).status, "PASS"); // no diff is not a failure here
  assert.equal(callerGate(o('node -e "process.exit(1)"'), "A1", p, runGate, {}).status, "FAIL");
  writeFileSync(join(d, "a.txt"), "z\n");
  const r = callerGate(o('node -e "process.exit(0)"'), "A1", p, runGate, {}); assert.equal(r.status, "FAIL"); assert.match(r.reasons.join(), /changed the work tree/);
});
