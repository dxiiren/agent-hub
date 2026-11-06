// Table-driven: EVERY secret form x EVERY shape of wrapping/case must be blocked by hasSecret (the one list the gate, the file scan and the reply scan share).
import test from "node:test";
import assert from "node:assert/strict";
import { hasSecret, bufHasSecret } from "../server/gate.mjs";
import { runReply } from "../../routing/route.mjs";

const LF = String.fromCharCode(10), CRLF = String.fromCharCode(13, 10);
// Built from pieces so this file holds no literal secret.
const SECRETS = {
  akia: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  jwt: "ey" + "JhbGciOiJIUzI1NiJ9." + "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0." + "abcdefghijklmnop",
  ghp: "gh" + "p_" + "A".repeat(36),
  sk: "s" + "k-" + "abcdefghij0123456789ABCD",
  bearer: "Bear" + "er " + "abcdefghijklmnopqrstuvwxyz0123456789",
  awsSecret: "aws_secret_access_" + "key=" + "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  pwd: "pass" + "word = " + "\"Sup3r$ecret!Passw0rd#2026\"",
  pwdUnquoted: "DB_PASS" + "WORD=" + "hunter2hunter2hunter2",
  apiKey: "api_" + "key: " + "abcdefghijklmnopqrstuv9",
  pem: "-----BEGIN " + "RSA PRIVATE KEY" + "-----",
  pgp: "-----BEGIN " + "PGP PRIVATE KEY BLOCK" + "-----",
};
const wrap = (s, eol, at) => s.slice(0, at) + eol + "  " + s.slice(at); // wrapped mid-token, indented continuation
const shapes = {
  single: (s) => s,
  "split LF": (s) => wrap(s, LF, Math.floor(s.length / 2)),
  "split CRLF": (s) => wrap(s, CRLF, Math.floor(s.length / 2)),
  "split early LF": (s) => wrap(s, LF, 4),
  "split late CRLF": (s) => wrap(s, CRLF, s.length - 3),
  "3-way LF": (s) => { const a = Math.floor(s.length / 3); return s.slice(0, a) + LF + s.slice(a, 2 * a) + LF + s.slice(2 * a); },
  "mixed case": (s) => s.toLowerCase(),
  "upper case": (s) => s.toUpperCase(),
  "mixed case split": (s) => wrap(s.toLowerCase(), CRLF, Math.floor(s.length / 2)),
  "prose around": (s) => "see the note below" + LF + s + LF + "thanks",
  "diff-style prefix stripped, trailing blanks": (s) => "   " + s + "   " + LF + LF,
};
for (const [name, s] of Object.entries(SECRETS)) for (const [shape, f] of Object.entries(shapes)) {
  test(`blocked: ${name} x ${shape}`, () => {
    const t = f(s);
    assert.ok(hasSecret(t), JSON.stringify(t).slice(0, 80));
  });
}
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
  "newline joined": A(20000, "pass\n  word\n"),
};
for (const [name, t] of Object.entries(ADVERSARIAL)) {
  test(`ReDoS: ${name} (${t.length} chars) is scanned in under 200 ms`, () => {
    const t0 = process.hrtime.bigint(); hasSecret(t); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, `${name}: ${ms.toFixed(1)} ms`);
  });
}
test("a secret in the middle of a 200 KB line, and across a window boundary, is still found", () => {
  const key = SECRETS.sk;
  for (const at of [0, 50000, 32768 - 5, 65536 - 10, 150000]) assert.ok(hasSecret(A(at, "x ") + key + A(100000, " y")), "at " + at);
});
