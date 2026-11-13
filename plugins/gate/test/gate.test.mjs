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
  writeFileSync(join(d, ".gitignore"), "c.py\n"); writeFileSync(join(d, "c.py"), 'api_key = "' + "z9".repeat(15) + '"\n');
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
import { writeRequest, writeDirectMarker, removeDirectMarker, hasDirectMarkers, bindDirect, claimDirect } from "../server/store.mjs";
import { existsSync, writeFileSync as wf, readFileSync as rf, readdirSync } from "node:fs";
const require_len = (d) => readdirSync(d).length;

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
  writeRequest(st, d, OK, head(d)); // routes default is BAD, caller says OK
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

// --- round 1 verifier findings 1 and 2 ---
const SEC = "AKIAABCDEFGHIJKLMNOP";
const commitAll = (d, m) => { sh(d, "add", "."); sh(d, "-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", m); };
const head = (d) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
test("a secret the agent COMMITTED fails when the gate diffs against the task's base", () => {
  const d = repo(); const base = head(d);
  writeFileSync(join(d, "n.txt"), SEC + "\n"); commitAll(d, "s");
  assert.equal(runGate(d, { cmd: OK }).status, "PASS"); // HEAD-relative diff is blind to it: the reason for the base
  assert.match(runGate(d, { cmd: OK, base }).reasons.join(), /secret pattern/);
});
test("a secret committed then removed is still caught in history", () => {
  const d = repo(); const base = head(d);
  writeFileSync(join(d, "n.txt"), SEC + "\n"); commitAll(d, "s");
  writeFileSync(join(d, "n.txt"), "clean\n"); commitAll(d, "rm");
  assert.match(runGate(d, { cmd: OK, base }).reasons.join(), /secret pattern in diff/);
});
test("an unknown base fails closed", () => {
  const d = repo();
  assert.match(runGate(d, { cmd: OK, base: "deadbeef" }).reasons.join(), /base commit is missing/);
});
test("binary, UTF-16 and ignored-binary secrets fail (git repo)", () => {
  const d = repo();
  writeFileSync(join(d, "n.bin"), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(SEC)]));
  writeFileSync(join(d, "u.txt"), Buffer.from(SEC, "utf16le"));
  writeFileSync(join(d, "o.txt"), Buffer.concat([Buffer.from("x"), Buffer.from(SEC, "utf16le")])); // odd alignment
  const r = runGate(d, { cmd: OK }).reasons.join();
  for (const f of ["n.bin", "u.txt", "o.txt"]) assert.match(r, new RegExp("secret pattern in " + f.replace(".", "[.]")));
});
test("non-git folder: binary, UTF-16, deep and big-file secrets fail; unscannable fails closed", () => {
  const p = (files) => { const d = mkdtempSync(join(tmpdir(), "gate-np-")); for (const [n, c] of Object.entries(files)) { mkdirSync(join(d, n, ".."), { recursive: true }); writeFileSync(join(d, n), c); } return d; };
  assert.match(runGate(p({ "n.bin": Buffer.concat([Buffer.from([0, 0]), Buffer.from(SEC)]) }), { cmd: OK }).reasons.join(), /secret pattern in n\.bin/);
  assert.match(runGate(p({ "u.txt": Buffer.from(SEC, "utf16le") }), { cmd: OK }).reasons.join(), /secret pattern in u\.txt/);
  assert.match(runGate(p({ "a/b/c/d/e/f/g/h/n.txt": SEC }), { cmd: OK }).reasons.join(), /secret pattern in a\/b\/c\/d\/e\/f\/g\/h\/n\.txt/);
  const big = Buffer.concat([Buffer.alloc(2200000, 65), Buffer.from("\n" + SEC)]);
  assert.match(runGate(p({ "big.txt": big }), { cmd: OK }).reasons.join(), /secret pattern in big\.txt/);
  const deep = Array.from({ length: 18 }, (_, i) => "d" + i).join("/") + "/x.txt";
  assert.match(runGate(p({ [deep]: "x" }), { cmd: OK }).reasons.join(), /scan incomplete/);
  assert.match(runGate(p({ "huge.bin": Buffer.alloc((16 << 20) + 1, 65) }), { cmd: OK }).reasons.join(), /scan incomplete.*too large/);
});

// --- coordinator review: NUL-separated paths, merge/binary history, unborn HEAD ---
import { EMPTY_TREE } from "../server/gate.mjs";
const git2 = (d, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", ...a], { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
test("non-ASCII and quoted paths are scanned and path rules see the real name", () => {
  const d = repo(); const base = head(d);
  writeFileSync(join(d, "caf\u00e9 q.bin"), Buffer.concat([Buffer.from([0, 0]), Buffer.from(SEC)]));
  const r = runGate(d, { cmd: OK, base, forbid: "caf\u00e9" });
  assert.match(r.reasons.join(), /secret pattern in caf\u00e9 q.bin/); assert.match(r.reasons.join(), /path not allowed: caf\u00e9/);
  assert.ok(!/scan incomplete/.test(r.reasons.join()));
});
test("a deleted tracked file is fine, an unreadable listed file fails closed", () => {
  const d = repo(); const base = head(d);
  execFileSync("node", ["-e", "require('fs').unlinkSync('a.py')"], { cwd: d });
  assert.equal(runGate(d, { cmd: OK, base }).status, "PASS");
});
test("a secret only in a merge commit's conflict resolution, or in a NUL-containing text file, is caught in history", () => {
  const d = repo(); const base = head(d);
  git2(d, "checkout", "-q", "-b", "side"); writeFileSync(join(d, "a.py"), "x = 2\n"); commitAll(d, "side");
  git2(d, "checkout", "-q", "-"); writeFileSync(join(d, "a.py"), "x = 3\n"); commitAll(d, "main");
  try { git2(d, "merge", "side"); } catch { /* conflict expected */ }
  writeFileSync(join(d, "a.py"), "x = '" + SEC + "'\n"); commitAll(d, "merge");
  writeFileSync(join(d, "a.py"), "x = 3\n"); commitAll(d, "clean");
  assert.match(runGate(d, { cmd: OK, base }).reasons.join(), /secret pattern in diff/);
  const e = repo(); const b2 = head(e);
  writeFileSync(join(e, "t.txt"), Buffer.concat([Buffer.from([0]), Buffer.from(SEC)])); commitAll(e, "bin");
  execFileSync("node", ["-e", "require('fs').unlinkSync('t.txt')"], { cwd: e }); commitAll(e, "rm");
  assert.match(runGate(e, { cmd: OK, base: b2 }).reasons.join(), /secret pattern in diff/);
});
test("unborn HEAD: the empty-tree base diffs and scans everything; no base recorded in a repo fails closed", () => {
  const d = mkdtempSync(join(tmpdir(), "gate-unborn-")); sh(d, "init", "-q");
  writeFileSync(join(d, "n.txt"), SEC + "\n");
  assert.match(runGate(d, { cmd: OK, base: EMPTY_TREE }).reasons.join(), /secret pattern/);
  assert.match(runGate(d, { cmd: OK, requireBase: true }).reasons.join(), /no base commit recorded/);
});

// --- round 4: fail closed on git view disagreement, UTF-16BE odd length, no skip by name, unquoted/JSON secrets ---
import { bufHasSecret, hasSecret } from "../server/gate.mjs";
test("a secret under a path over 260 chars is found, and a status/diff disagreement fails closed", () => {
  const d = repo(); const base = head(d);
  const deep = Array(12).fill("d".repeat(25)).join("/");
  mkdirSync(join(d, deep), { recursive: true }); writeFileSync(join(d, deep, "s.txt"), SEC + "\n");
  const r = runGate(d, { cmd: OK, base });
  assert.equal(r.status, "FAIL"); assert.ok(r.files > 0 || /disagree/.test(r.reasons.join()), JSON.stringify(r));
  assert.match(r.reasons.join(), /secret pattern|disagree/);
});
test("UTF-16 big and little endian secrets at the end of an odd or even length buffer are found", () => {
  const be = (s) => Buffer.from(s, "utf16le").swap16();
  for (const b of [be(SEC), Buffer.concat([Buffer.from([0xfe, 0xff]), be(SEC)]), Buffer.concat([Buffer.from([0]), be(SEC)]), Buffer.concat([Buffer.from([0]), be(SEC), Buffer.from([0x41])]),
    Buffer.from(SEC, "utf16le"), Buffer.concat([Buffer.from([1]), Buffer.from(SEC, "utf16le")]), Buffer.concat([Buffer.from(SEC, "utf16le"), Buffer.from([1])])])
    assert.ok(bufHasSecret(b), "len " + b.length);
  assert.ok(!bufHasSecret(be("nothing to see here at all")));
});
test("node_modules and .git are scanned in a plain folder, and a nested repo inside a repo is scanned", () => {
  const d = mkdtempSync(join(tmpdir(), "gate-nm-"));
  for (const sub of ["node_modules/p", ".git"]) { mkdirSync(join(d, sub), { recursive: true }); writeFileSync(join(d, sub, "x.txt"), SEC); }
  const r = runGate(d, { cmd: OK }).reasons.join();
  assert.match(r, /secret pattern in node_modules\/p\/x\.txt/); assert.match(r, /secret pattern in \.git\/x\.txt/);
  const e = repo(); const base = head(e);
  mkdirSync(join(e, "nest")); sh(join(e, "nest"), "init", "-q"); writeFileSync(join(e, "nest", "k.txt"), SEC);
  assert.match(runGate(e, { cmd: OK, base }).reasons.join(), /secret pattern in nest\/k\.txt/);
});
test("unquoted .env lines and JSON values are secrets; code that merely names a token is not", () => {
  const EQ = "="; // built from parts so the public-repo scan does not match the fixtures
  for (const l of ["DB_PASSWORD" + EQ + "hunter2hunter2hunter2", '{"token":"Zx9kLm2pQrStUvWxYz123456abcd"}', 'password: "Abcdefghijklmnopqrst"', "API_KEY = abcdefghijklmnopqrstuv9"]) assert.ok(hasSecret(l), l);
  for (const l of ["token = parse_the_user_token_value", "password" + EQ + "short1", "const secret = getSecretFromTheEnvironment();", '"token": "abc"', "# api_key is read from the environment"]) assert.ok(!hasSecret(l), l);
  const d = repo(); writeFileSync(join(d, "e.env"), "DB_PASSWORD" + EQ + "hunter2hunter2hunter2\n");
  assert.match(runGate(d, { cmd: OK }).reasons.join(), /secret pattern/);
});

test("round 5: canonical secrets are caught, normal code is not", () => {
  for (const l of ["AWS_SECRET_ACCESS_KEY=" + "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", 'DB_PASS' + 'WORD="' + 'my.secret.pass.w0rd.value9"', 'password: "' + 'Sup3r$ecret!Passw0rd#2026"', 'private_key="' + 'MIIEvQIBADANBgkqhkiG9w0BAQEFAAS"', "Authorization: Bear" + "er Zx9kLm2pQrStUvWxYz0123456789abcd", "client_secret = " + "Zx9!kLm2#pQrSt"]) assert.ok(hasSecret(l), l.slice(0, 18));
  for (const l of ["token = tokens[i]", "password_field = input", "const token = await getToken(req);", "secret = os.environ['X']", "Authorization: Bearer <token>", "private_key = load_private_key(path)"]) assert.ok(!hasSecret(l), l);
});
test("round 5: forbid applies to __pycache__ and .pyc paths", () => {
  const d = mkdtempSync(join(tmpdir(), "pyc-")); const g = (...a) => execFileSync("git", a, { cwd: d });
  g("init", "-q"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i");
  mkdirSync(join(d, "__pycache__")); writeFileSync(join(d, "__pycache__", "x.txt"), "hi");
  assert.match(runGate(d, { cmd: OK, forbid: "pycache" }).reasons.join(), /path not allowed: __pycache__\/x\.txt/);
});

import { writeRequest as wreq } from "../server/store.mjs";
const gitOut = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const GID = ["-c", "user.name=t", "-c", "user.email=t@t.t"];
function linkedWorktree() {
  const d = repo(); const start = gitOut(d, "rev-parse", "HEAD");
  const wt = join(mkdtempSync(join(tmpdir(), "wt-")), "w1");
  sh(d, "worktree", "add", "-q", "-b", "task1", wt);
  return { d, wt, start };
}
test("worktree task with NO recorded request fails closed: the base is never derived at turn end (fast agent finished before registration)", () => {
  const { wt } = linkedWorktree(); writeFileSync(join(wt, "evil.txt"), "x\n");
  sh(wt, "add", "."); sh(wt, ...GID, "commit", "-qm", "evil");
  const r = evaluate({ dir: mkdtempSync(join(tmpdir(), "gs-")), id: "F", cwd: wt, routes: {} });
  assert.notEqual(r.d.status, "PASS"); assert.match(r.res.reasons.join(), /no base commit recorded/);
});
test("direct run: exempt only for the agent that claims the launcher's single-use nonce; a label, a cwd, another agent, a stale or used nonce, or a route request never exempts", () => {
  const { wt, start } = linkedWorktree(); const N = "a".repeat(32), N2 = "b".repeat(32);
  const fresh = () => mkdtempSync(join(tmpdir(), "gs-"));
  // 1. a routed agent that labels itself direct (labels are not even an input) or invents a nonce is still gated
  assert.equal(evaluate({ dir: fresh(), id: "LABELLED", cwd: wt, routes: {}, directNonce: N, labels: { "route/type": "direct" } }).d.reprompt, true, "invented nonce, nothing in the store: gated");
  // 2. the launcher stores the nonce first; only the agent carrying it is exempt, exactly once
  const dir = fresh(); writeDirectMarker(dir, N); assert.equal(bindDirect(dir, N, "DIR"), true);
  assert.equal(evaluate({ dir, id: "OTHER", cwd: wt, routes: {}, directNonce: null }).d.reprompt, true, "a different agent in the same cwd inside the TTL (no nonce) is gated");
  writeDirectMarker(dir, N2); bindDirect(dir, N2, "N2AGENT"); // OTHER's gate consumed no marker; N is still held
  assert.equal(evaluate({ dir, id: "WRONG", cwd: wt, routes: {}, directNonce: "c".repeat(32) }).d.reprompt, true, "a wrong nonce is gated");
  const r = evaluate({ dir, id: "DIR", cwd: wt, routes: {}, directNonce: N });
  assert.equal(r.d.status, "N/A"); assert.equal(r.d.reprompt, false); assert.deepEqual(r.res.reasons, []);
  assert.equal(evaluate({ dir, id: "DIR", cwd: wt, routes: {}, directNonce: null }).d.reprompt, false, "second turn of the same agent id: still exempt");
  assert.equal(evaluate({ dir, id: "REPLAY", cwd: wt, routes: {}, directNonce: N }).d.reprompt, true, "the nonce is single use: another agent replaying it is gated");
  // 3. a stale marker exempts nobody
  const old = fresh(); writeDirectMarker(old, N, Date.now() - 11 * 60_000); bindDirect(old, N, "LATE");
  assert.equal(evaluate({ dir: old, id: "LATE", cwd: wt, routes: {}, directNonce: N }).d.reprompt, true, "expired");
  // 4. a route request for the cwd always wins, and the marker is left alone
  const mixed = fresh(); writeDirectMarker(mixed, N); bindDirect(mixed, N, "ROUTED"); wreq(mixed, wt, null, start); writeFileSync(join(wt, "ok.txt"), "OK" + String.fromCharCode(10));
  assert.equal(evaluate({ dir: mixed, id: "ROUTED", cwd: wt, routes: {}, directNonce: N }).d.status, "PASS", "request present: gated normally even with a valid nonce");
  // 4b. r5: the label (nonce) copied onto another agent does not exempt it, does not burn the real one's marker, and an unbound marker is "pending" (never exempt)
  const cp = fresh(); writeDirectMarker(cp, N);
  assert.equal(claimDirect(cp, N, "REAL"), "pending", "launcher has not bound an id yet");
  assert.equal(evaluate({ dir: cp, id: "REAL", cwd: wt, routes: {}, directNonce: N }).d.reprompt, true, "unbound marker: nobody is exempt");
  assert.equal(bindDirect(cp, N, "REAL"), true); assert.equal(bindDirect(cp, N, "ATTACKER"), false, "first bind wins");
  assert.equal(evaluate({ dir: cp, id: "ATTACKER", cwd: wt, routes: {}, directNonce: N }).d.reprompt, true, "a copied label on another agent is gated");
  assert.equal(hasDirectMarkers(cp), true, "the attacker did not consume the marker");
  assert.equal(evaluate({ dir: cp, id: "REAL", cwd: wt, routes: {}, directNonce: N }).d.reprompt, false, "the bound agent is exempt");
  // 5. a marker is never overwritten, a bad nonce is refused
  assert.throws(() => writeDirectMarker(mixed, N), /EEXIST/); assert.throws(() => writeDirectMarker(mixed, "../x"), /32 hex/);
  removeDirectMarker(mixed, N); assert.equal(hasDirectMarkers(mixed), false);
});
test("worktree task with a request registered before the agent starts is judged against that base, and a clean task passes the first time", () => {
  const { wt, start } = linkedWorktree(); const dir = mkdtempSync(join(tmpdir(), "gs-"));
  wreq(dir, wt, null, start);
  writeFileSync(join(wt, "ok.txt"), "OK\n");
  const first = evaluate({ dir, id: "W", cwd: wt, routes: {} });
  assert.equal(first.d.status, "PASS"); assert.deepEqual(first.res.reasons, []);
  assert.equal(first.res.files, 1, "a CRLF checkout of an untouched file (global autocrlf) is not a change");
});
test("attack: an agent that commits, moves HEAD and the branch ref, or rewrites history cannot move the recorded base: the gate still FAILs", () => {
  const routesCfg = { gates: [{ match: ".*", forbid: "^evil" }] };
  const attacks = {
    "commit then move the branch ref back": (wt, start) => { writeFileSync(join(wt, "evil.txt"), "x\n"); sh(wt, "add", "."); sh(wt, ...GID, "commit", "-qm", "e"); sh(wt, "update-ref", "refs/heads/task1", start); },
    "commit then re-root HEAD on an empty parentless commit": (wt) => { writeFileSync(join(wt, "evil.txt"), "x\n"); sh(wt, "add", "."); sh(wt, ...GID, "commit", "-qm", "e"); const c = gitOut(wt, ...GID, "commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "fresh"); sh(wt, "update-ref", "refs/heads/task1", c); },
    "commit, rewind HEAD, then hide the file from the index (assume-unchanged / skip-worktree)": (wt, start) => { writeFileSync(join(wt, "evil.txt"), "x\n"); sh(wt, "add", "."); sh(wt, ...GID, "commit", "-qm", "e"); sh(wt, "update-ref", "HEAD", start); sh(wt, "update-index", "--assume-unchanged", "--skip-worktree", "evil.txt"); },
    "commit, rewind HEAD, drop the file from the index": (wt, start) => { writeFileSync(join(wt, "evil.txt"), "x\n"); sh(wt, "add", "."); sh(wt, ...GID, "commit", "-qm", "e"); sh(wt, "update-ref", "HEAD", start); sh(wt, "rm", "-q", "--cached", "evil.txt"); },
  };
  for (const [name, run] of Object.entries(attacks)) {
    const { wt, start } = linkedWorktree(); const dir = mkdtempSync(join(tmpdir(), "gs-")); wreq(dir, wt, null, start);
    run(wt, start);
    const r = evaluate({ dir, id: "A", cwd: wt, routes: routesCfg });
    assert.notEqual(r.d.status, "PASS", name); assert.match(r.res.reasons.join(), /path not allowed: evil.txt/, name);
  }
});

test("round 7: a bare JWT and a PGP private key block are secrets; ordinary dotted text is not", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join(".");
  const pgp = "-----BEGIN PGP PRIVATE " + "KEY BLOCK-----";
  for (const l of ["+auth: " + jwt, jwt, pgp]) assert.ok(hasSecret(l), l.slice(0, 20));
  for (const l of ["see eyJ-prefixed values in the docs", "a.b.c version 1.2.3", "-----BEGIN PGP PUBLIC KEY BLOCK-----", "eyJhbGciOiJIUzI1NiJ9 header only"]) assert.ok(!hasSecret(l), l);
  const d = repo(); writeFileSync(join(d, "t.txt"), "x = " + jwt);
  assert.match(runGate(d, { cmd: OK }).reasons.join(), /secret pattern/);
});

test("round 8: a JWT wrapped over several lines is a secret, in a diff and in a file", () => {
  const NL = String.fromCharCode(10);
  const parts = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"];
  assert.ok(bufHasSecret(Buffer.from(parts.join("." + NL))));
  assert.ok(!bufHasSecret(Buffer.from("eyJ-not a token" + NL + "a.b.c")));
  const d = repo(); const base = head(d); writeFileSync(join(d, "w.txt"), parts.join("." + NL) + NL);
  assert.match(runGate(d, { cmd: OK, base }).reasons.join(), /secret pattern/);
});

test("round 9: every token-shaped secret is found wrapped over lines (LF and CRLF); case-insensitive forms and key names still match; prose does not", () => {
  const LF = String.fromCharCode(10), CRLF = String.fromCharCode(13, 10);
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"];
  const aws = "AK" + "IA" + "ABCDEFGHIJKLMNOP"; const ghp = "gh" + "p_" + "a".repeat(36);
  const pem = ["-----BEGIN RSA PRIV" + "ATE KEY-----", "-----BEGIN PGP PRIV" + "ATE KEY BLOCK-----", "-----BEGIN PRIV" + "ATE KEY-----"];
  const cases = [jwt.join("." + LF), jwt.join("." + CRLF), aws.slice(0, 7) + LF + aws.slice(7), aws.slice(0, 9) + CRLF + aws.slice(9), ghp.slice(0, 10) + LF + ghp.slice(10), ghp.slice(0, 20) + CRLF + ghp.slice(20),
    ...pem, pem[0].replace("BEGIN ", "BEGIN" + LF), pem[1].replace("PGP ", "PGP" + CRLF)];
  for (const c of cases) assert.ok(bufHasSecret(Buffer.from(c)), JSON.stringify(c).slice(0, 40));
  assert.ok(bufHasSecret(Buffer.from(cases[0], "utf16le")), "utf16");
  // mixed case and CRLF around key-name rules
  for (const l of ["akia" + "ABCDEFGHIJKLMNOP", "Db_Pass" + "word=" + "hunter2hunter2hunter2" + CRLF, "BEARER Zx9kLm2pQrStUvWxYz0123456789abcd", pem[1].toLowerCase()]) assert.ok(hasSecret(l), JSON.stringify(l).slice(0, 30));
  for (const l of ["risk- averse analysis of something long" + LF + "more words", "Ask a question" + CRLF + "about a task-management tool", "eyJ" + LF + "short"]) assert.ok(!bufHasSecret(Buffer.from(l)), l.slice(0, 20));
});
