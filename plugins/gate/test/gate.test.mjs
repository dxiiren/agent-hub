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

import { evaluate } from "../server/hook.mjs";
import { writeRequest } from "../server/store.mjs";
import { existsSync, writeFileSync as wf, readFileSync as rf } from "node:fs";

const routesCfg = { gates: [{ match: ".*", cmd: BAD, maxLines: 400 }] };

test("agent labels cannot switch the gate off or swap its command (labels are not an input)", () => {
  const d = repo(), st = mkdtempSync(join(tmpdir(), "st-"));
  wf(join(d, "a.py"), "x = 2\n");
  // evaluate() takes no labels at all; the attack is an agent that wrote gate/skip, gate/cmd=true, gate/forbid=.* on itself
  const r = evaluate({ dir: st, id: "A", cwd: d, routes: routesCfg });
  assert.equal(r.d.status, "RETRY"); assert.match(r.res.reasons.join(), /gate cmd exit 1/);
  assert.equal(evaluate({ dir: st, id: "A", cwd: d, routes: routesCfg }).d.status, "FAIL");
});
test("attempt counter lives in the plugin store, survives a restart, and ignores label rewrites", () => {
  const d = repo(), st = mkdtempSync(join(tmpdir(), "st-"));
  wf(join(d, "a.py"), "x = 2\n");
  assert.equal(evaluate({ dir: st, id: "B", cwd: d, routes: routesCfg }).mirror["gate/attempts"], "1");
  const state = JSON.parse(rf(join(st, "state.json"), "utf8")); assert.equal(state.B.attempts, 1);
  const again = evaluate({ dir: st, id: "B", cwd: d, routes: routesCfg }); // a "restart": state reloaded from disk
  assert.equal(again.d.status, "FAIL"); assert.equal(again.mirror["gate/attempts"], "2");
});
test("caller-supplied gate comes from the plugin-side request, bound to the agent once", () => {
  const d = repo(), st = mkdtempSync(join(tmpdir(), "st-"));
  wf(join(d, "a.py"), "x = 2\n");
  writeRequest(st, d, OK); // routes default is BAD, caller says OK
  assert.equal(evaluate({ dir: st, id: "C", cwd: d, routes: routesCfg }).d.status, "PASS");
  assert.equal(evaluate({ dir: st, id: "D", cwd: d, routes: routesCfg }).d.status, "RETRY"); // request was consumed
});
test("a repo with a malicious core.fsmonitor / diff.external / textconv does not execute it", () => {
  const d = repo(), marker = join(mkdtempSync(join(tmpdir(), "pwn-")), "PWNED");
  const evil = `node -e "require('fs').writeFileSync('${marker.split(String.fromCharCode(92)).join("/")}','1')"`;
  sh(d, "config", "core.fsmonitor", evil);
  sh(d, "config", "diff.external", evil);
  sh(d, "config", "diff.evil.textconv", evil);
  wf(join(d, ".gitattributes"), "*.py diff=evil\n");
  wf(join(d, "a.py"), "x = 9\n");
  const r = runGate(d, { cmd: OK });
  assert.equal(existsSync(marker), false, "repo-controlled command ran");
  assert.ok(r.files >= 1);
  // control: plain git in the same repo does run it, so the test can fail
  execFileSync("git", ["diff", "HEAD"], { cwd: d, stdio: "ignore" });
  assert.equal(existsSync(marker), true, "control: unhardened git should have triggered the config");
});
test("pattern length is capped", () => {
  assert.throws(() => repoGate({ gates: [{ match: "a".repeat(300) }] }, "/x"), /too long/);
});

function plain(extra = {}) {
  const d = mkdtempSync(join(tmpdir(), "nogit-"));
  for (const [k, v] of Object.entries(extra)) writeFileSync(join(d, k), v);
  return d;
}
test("no repo + path rules: FAIL, rules cannot be evaluated (a)", () => {
  const r = runGate(plain(), { cmd: OK, forbid: "^x" });
  assert.equal(r.status, "FAIL"); assert.match(r.reasons.join(), /not a git work tree: diff-based rules cannot be evaluated/);
  assert.equal(runGate(plain(), { cmd: OK, allow: "^src/" }).status, "FAIL");
});
test("no repo + no cmd: FAIL nothing to verify (b)", () => {
  const r = runGate(plain(), {}); assert.equal(r.status, "FAIL"); assert.match(r.reasons.join(), /nothing to verify/);
});
test("no repo + cmd only: PASS, but a secret in the folder FAILs (c)", () => {
  assert.equal(runGate(plain({ "a.txt": "hello" }), { cmd: OK }).status, "PASS");
  const r = runGate(plain({ "k.txt": "key = AKIAABCDEFGHIJKLMNOP" }), { cmd: OK });
  assert.equal(r.status, "FAIL"); assert.match(r.reasons.join(), /secret pattern in k\.txt/);
});

test("hook: an agent in a plain folder is labelled FAIL at once and never re-prompted", async () => {
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "nogit-")), st = mkdtempSync(join(tmpdir(), "gstate-"));
  const r = evaluate({ dir: st, id: "P", cwd: d, routes: {} });
  assert.equal(r.d.status, "FAIL"); assert.equal(r.d.reprompt, false); assert.match(r.mirror["gate/reasons"], /nothing to verify/);
});
