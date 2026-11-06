import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasSecret, bufHasSecret } from "../server/gate.mjs";
import { runReply } from "../../routing/route.mjs";
import { LF, CRLF, SECRETS, shapes } from "./secrets-cases.mjs";

test("blocked in file bytes too: UTF-8 split CRLF and UTF-16LE", () => {
  assert.ok(bufHasSecret(Buffer.from(shapes["split CRLF"](SECRETS.sk), "utf8")));
  assert.ok(bufHasSecret(Buffer.from(shapes["split LF"](SECRETS.bearer), "utf16le")));
});
test("allowed: public keys, certificates, normal code and prose, also over line breaks", () => {
  const ok = [
    "-----BEGIN PGP PUBLIC KEY BLOCK-----", "-----BEGIN CERTIFICATE-----", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnopqrstuvwxyz user@host",
    "token = tokens[i]", "password_field = input", "const token = await getToken(req);", "Authorization: Bearer <token>", "private_key = load_private_key(path)",
    "a risk-based approach to the deployment of the task-force", "The bearer of the message described the secret recipe at length" + LF + "and the token economy",
    "ask-the-team-about-their-schedule-for-the-release", "see eyJ-prefixed values in the docs", "a.b.c version 1.2.3", "const secret = getSecretFromTheEnvironment();",
    "function parse(a) {" + LF + "  return a.map((x) => x + 1);" + LF + "}", "# api_key is read from the environment" + LF + "x = 1234567890",
    "password:" + LF + "  see the vault", "token" + LF + "= parse_the_user_token",
    "\"passwordEnv\": \"AGENT_HUB_" + "PASSWORD\"", "\"Authorization\": \"Bear" + "er REPLACE_WITH_YOUR_GITHUB_PAT\"",
  ];
  for (const t of ok) assert.ok(!hasSecret(t), JSON.stringify(t).slice(0, 80));
});
test("reply scan uses the same list: wrapped sk- and Bearer replies are rejected before anything is sent", () => {
  for (const s of [SECRETS.sk, SECRETS.bearer, SECRETS.pwd]) {
    const sent = [];
    const r = runReply("abc123", shapes["split CRLF"](s), (a) => { sent.push(a); return {}; }, {}, { dir: process.env.TEMP || "/tmp", reaper: false });
    assert.equal(r.status, "rejected"); assert.deepEqual(sent, []);
  }
});

// ReDoS guard: 100 KB adversarial inputs aimed at each pattern's quantifiers must finish fast (and match nothing).
const A = (n, c) => c.repeat(n);
const ADVERSARIAL = {
  "PEM spaces": "-----BEGIN" + A(50000, " ") + A(50000, "A"),
  "PEM words": "-----BEGIN " + A(25000, "AB "),
  "PEM repeated": A(10000, "-----BEGIN "),
  "JWT run": "eyJ" + A(100000, "a"),
  "JWT repeated": A(33000, "eyJ"),
  "JWT dots": A(20000, "eyJabcdefgh."),
  "ghp repeated": A(25000, "ghp_"), "ghp long": "ghp_" + A(100000, "a") + "-",
  "sk repeated": A(33000, "sk-"), "AKIA repeated": A(25000, "AKIA"),
  "Bearer repeated": A(14000, "Bearer "), "Bearer joined": A(14000, "Bearer"), "Bearer spaces": "Bearer" + A(100000, " "),
  "aws repeated": A(10000, "aws_secret"), "aws long": "aws" + A(100000, "x"),
  "key repeated": A(16000, "token"), "key long": "password" + A(100000, "x"), "key spaces": "password" + A(100000, " "),
  "key assign repeated": A(11000, "pass" + "word="), "key quote repeated": A(11000, "pass" + "word='"), "key assign space": A(7000, "token = "),
  "value long quoted": "pass" + "word=\"" + A(100000, "a"), "value long unquoted": "pass" + "word=" + A(100000, "a"),
  "value long punct-less": "tok" + "en=" + A(100000, "a") + " ", "quote long": "secret:'" + A(100000, "ab"),
  "delims after key": "token" + A(100000, "= "), "secret assign repeated": A(14000, "secret=a1"), "key word run then =": A(20000, "secret") + "=" + A(50, "a1"), "quote after key": A(16000, "pwd'= "),
  "newline joined": A(20000, "pass\n  word\n"),
};
hasSecret("warm up");
const T0 = process.hrtime.bigint(); hasSecret("x"); const SPAWN_MS = Number(process.hrtime.bigint() - T0) / 1e6; // process start cost of this machine (virus scanners make it 0.7 s)
for (const [name, t] of Object.entries(ADVERSARIAL)) {
  test(`ReDoS: ${name} (${t.length} chars) is scanned in within 1 s of a bare process spawn`, () => {
    const t0 = process.hrtime.bigint(); hasSecret(t); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < SPAWN_MS + 1000, `${name}: ${ms.toFixed(1)} ms`);
  });
}
test("a secret in the middle of a 200 KB line, and across a window boundary, is still found", () => {
  const key = SECRETS.sk;
  for (const at of [0, 50000, 32768 - 5, 65536 - 10, 150000]) assert.ok(hasSecret(A(at, "x ") + key + A(100000, " y")), "at " + at);
});

test("bypass cases from the security review are blocked", () => {
  const sk = SECRETS.sk, sp = (n) => " ".repeat(n);
  const must = [
    "Bear" + "er" + sp(5) + "Zx9kLm2pQrStUvWxYz0123456789abcd", "Bear" + "er" + sp(500) + "Zx9kLm2pQrStUvWxYz0123456789abcd",
    "pass" + "word" + sp(21) + "=" + sp(21) + "hunter2hunter2hunter2", "tok" + "en" + sp(100) + ":" + sp(100) + "abcdefghij0123456789",
    "-----BEGIN" + sp(70) + "RSA PRIVATE KEY-----", "-----BEGIN RSA" + sp(70) + "PRIVATE" + sp(70) + "KEY-----",
    "pass" + "word=\"" + "a1".repeat(150) + "\"", "pass" + "word=\"" + "a1".repeat(150), "secret_key='" + "Zx9!".repeat(80),
    "my_service_api_key_for_the_production_billing_system = " + "abcdefghijklmnop012345", "MY_SERVICE_PASSWORD_FOR_THE_PRODUCTION_BILLING_SYSTEM_V2=" + "hunter2hunter2hunter2",
    "aws_secret_access_" + "key_for_a_very_long_service_name_here=" + "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "see this" + LF + "word" + SECRETS.jwt.slice(0, 20) + LF + SECRETS.jwt.slice(20), "prefix" + SECRETS.jwt, "x".repeat(30) + LF + SECRETS.jwt,
    "ghp_" + "A".repeat(20) + LF + "A".repeat(16), sk.slice(0, 5) + CRLF + CRLF + sk.slice(5),
  ];
  for (const t of must) assert.ok(hasSecret(t), JSON.stringify(t).slice(0, 90));
});

test("fail closed: a missing, wrong-version or broken scanner throws 'secret scanner unavailable' and the gate and the reply scan block", () => {
  const bad = join(tmpdir(), "no-such-gitleaks-binary");
  assert.throws(() => hasSecret("hello world", bad), /secret scanner unavailable/);
  const old = process.env.AGENT_HUB_GITLEAKS; process.env.AGENT_HUB_GITLEAKS = bad;
  try {
    const sent = [];
    const r = runReply("abc123", "a harmless reply", (a) => { sent.push(a); return {}; }, {}, { dir: process.env.TEMP || "/tmp", reaper: false });
    assert.equal(r.status, "rejected"); assert.match(r.error, /secret scanner unavailable/); assert.deepEqual(sent, []);
  } finally { if (old === undefined) delete process.env.AGENT_HUB_GITLEAKS; else process.env.AGENT_HUB_GITLEAKS = old; }
});
