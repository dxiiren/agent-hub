import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { callerGate, runStatus } from "../route.mjs";
import { evaluate } from "../../gate/server/hook.mjs";
import { writeRequest } from "../../gate/server/store.mjs";
import { gateOpts, runGate } from "../../gate/server/gate.mjs";

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
const ff = () => {
  const d = mkdtempSync(join(tmpdir(), "ff-")), out = mkdtempSync(join(tmpdir(), "out-"));
  const mk = (n, c = "a b 1 2", dir = d) => { const p = join(dir, n); writeFileSync(p, c); return p; };
  return { d, out, mk, o: { roots: [d], scan: () => false, home: join(d, "home") } };
};
test("--file: sensitive names, dotfiles, ../ traversal and symlinks to them are refused", () => {
  const { d, mk, o } = ff(); mkdirSync(join(d, "sub"));
  for (const n of ["credentials.json", "server.key", ".env", "id_rsa", "my-secret.txt"]) assert.match(checkFileInputs([mk(n)], o).error ?? "", /refused/, n);
  assert.match(checkFileInputs([join(d, "sub", "..", "credentials.json")], o).error ?? "", /refused/);
  try { symlinkSync(join(d, "credentials.json"), join(d, "sub", "harmless.txt")); assert.match(checkFileInputs([join(d, "sub", "harmless.txt")], o).error ?? "", /refused/); } catch (e) { if (e.code !== "EPERM") throw e; }
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
