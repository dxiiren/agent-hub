import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { decide, repoGate, runGate } from "../server/gate.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "ignore" });
function repo() {
  const d = mkdtempSync(join(tmpdir(), "gate-"));
  sh(d, "init", "-q");
  writeFileSync(join(d, "a.py"), "x = 1\n");
  sh(d, "add", "."); sh(d, "-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", "init");
  return d;
}
const OK = 'node -e "process.exit(0)"', BAD = 'node -e "process.exit(1)"';

test("good diff passes", () => {
  const d = repo(); writeFileSync(join(d, "a.py"), "x = 2\n");
  const r = runGate(d, { cmd: OK });
  assert.equal(r.status, "PASS"); assert.deepEqual(r.reasons, []);
});
test("failing gate command fails", () => {
  const d = repo(); writeFileSync(join(d, "a.py"), "x = 2\n");
  const r = runGate(d, { cmd: BAD });
  assert.equal(r.status, "FAIL"); assert.match(r.reasons[0], /gate cmd exit 1/);
});
test("secret in a new file fails", () => {
  const d = repo(); writeFileSync(join(d, "c.py"), 'token = "ghp_' + "a".repeat(36) + '"\n');
  assert.match(runGate(d, { cmd: OK }).reasons.join(), /secret pattern in diff/);
});
test("secret hidden by .gitignore fails", () => {
  const d = repo();
  writeFileSync(join(d, ".gitignore"), "c.py\n"); writeFileSync(join(d, "c.py"), 'api_key = "' + "z".repeat(30) + '"\n');
  const r = runGate(d, { cmd: OK });
  assert.match(r.reasons.join(), /ignored file c\.py/); assert.match(r.reasons.join(), /\.gitignore changed/);
});
test("forbidden and out-of-scope paths fail", () => {
  const d = repo(); mkdirSync(join(d, ".github")); writeFileSync(join(d, ".github", "w.yml"), "a: 1\n"); writeFileSync(join(d, "a.py"), "x = 3\n");
  assert.match(runGate(d, { cmd: OK, forbid: "^[.]github/" }).reasons.join(), /path not allowed: \.github\/w\.yml/);
  assert.match(runGate(d, { cmd: OK, allow: "^src/" }).reasons.join(), /path not allowed: .*a\.py/);
});
test("diff-size limit", () => {
  const d = repo(); writeFileSync(join(d, "big.txt"), "l\n".repeat(50));
  assert.match(runGate(d, { cmd: OK, maxLines: 10 }).reasons.join(), /larger than 10/);
});
test("no gate command is scan-only, not a failure", () => {
  const d = repo(); writeFileSync(join(d, "a.py"), "x = 2\n");
  const r = runGate(d, {}); assert.equal(r.status, "PASS"); assert.equal(r.ranCmd, false);
});
test("two-failure return: RETRY once, then FAIL", () => {
  const f = { status: "FAIL", reasons: ["x"] };
  assert.deepEqual(decide(0, f), { status: "RETRY", attempts: 1, reprompt: true });
  assert.deepEqual(decide(1, f), { status: "FAIL", attempts: 2, reprompt: false });
  assert.equal(decide(0, f, true).status, "FAIL");
  assert.equal(decide(1, { status: "PASS", reasons: [] }).status, "PASS");
});
test("repo default gate: matching row, then gateDefault, placeholder ignored", () => {
  const rt = { gates: [{ match: "my-repo$", cmd: "npm test" }], gateDefault: "<REPO_GATE_COMMAND>" };
  assert.equal(repoGate(rt, "C:/x/my-repo").cmd, "npm test");
  assert.deepEqual(repoGate(rt, "/other"), {});
  assert.equal(repoGate({ gateDefault: "make test" }, "/other").cmd, "make test");
});
