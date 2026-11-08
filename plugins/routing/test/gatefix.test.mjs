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
test("--file: sensitive names, dotfiles, symlinks to them and ../ traversal are refused; a normal .tsv passes", () => {
  const d = mkdtempSync(join(tmpdir(), "ff-")), sub = join(d, "sub"); mkdirSync(sub);
  const mk = (n, c = "a\tb\n1\t2\n") => { const p = join(d, n); writeFileSync(p, c); return p; };
  const none = { scan: () => false, home: join(d, "home") };
  for (const n of ["credentials.json", "server.key", ".env", "id_rsa", "my-secret.txt"]) assert.match(checkFileInputs([mk(n)], none).error ?? "", /refused/, n);
  assert.match(checkFileInputs([join(sub, "..", "credentials.json")], none).error ?? "", /refused/); // traversal resolves to the real file first
  const link = join(sub, "harmless.txt");
  try { symlinkSync(join(d, "credentials.json"), link); assert.match(checkFileInputs([link], none).error ?? "", /refused: sensitive/); } catch (e) { if (e.code !== "EPERM") throw e; } // no symlink right on this Windows: skip
  assert.match(checkFileInputs([mk("data.tsv", "k\n")], { ...none, scan: () => true }).error ?? "", /credential/); // content scanner
  assert.equal(checkFileInputs([mk("data.tsv")], none).error, undefined);
  assert.match(checkFileInputs([join(d, "nope.tsv")], none).error, /does not resolve/);
});
test("--file: a file inside a protected folder (~/.claude) is refused", () => {
  const home = mkdtempSync(join(tmpdir(), "hm-")); mkdirSync(join(home, ".claude")); const p = join(home, ".claude", "notes.tsv"); writeFileSync(p, "x");
  assert.match(checkFileInputs([p], { scan: () => false, home }).error, /refused/);
});
