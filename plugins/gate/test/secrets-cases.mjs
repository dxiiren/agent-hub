// Table-driven: EVERY secret form x EVERY shape of wrapping/case must be blocked by hasSecret (the one list the gate, the file scan and the reply scan share).

export const LF = String.fromCharCode(10), CRLF = String.fromCharCode(13, 10);
// Built from pieces so this file holds no literal secret.
export const SECRETS = {
  akia: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  jwt: "ey" + "JhbGciOiJIUzI1NiJ9." + "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0." + "abcdefghijklmnop",
  ghp: "gh" + "p_" + "A".repeat(36),
  sk: "s" + "k-" + "abcdefghij0123456789ABCD",
  bearer: "Bear" + "er " + "Zx9kLm2pQrStUvWxYz0123456789abcd",
  awsSecret: "aws_secret_access_" + "key=" + "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  pwd: "pass" + "word = " + "\"Sup3r$ecret!Passw0rd#2026\"",
  pwdUnquoted: "DB_PASS" + "WORD=" + "hunter2hunter2hunter2",
  skProj: "s" + "k-proj-" + "abcdefghij0123456789ABCDEFGH",
  skAnt: "s" + "k-ant-api03-" + "abcdefghij0123456789ABCDEFGH",
  skOr: "s" + "k-or-v1-" + "abcdefghij0123456789ABCDEFGH",
  pwdEqTwice: "pass" + "word=" + "abc=defGHIjkl123",
  colonPwd: "pass" + "word=" + "Xk9mQ2pL7:abcdefghij",
  colonToken: "tok" + "en=" + "Xk9mQ2pL7:abcdefghij",
  colonApiKey: "api_" + "key=" + "Xk9mQ2pL7:abcdefghij",
  colonSecret: "sec" + "ret=" + "Xk9mQ2pL7:abcdefghij",
  colonUpper: "PASS" + "WORD: " + "Zq8!wR5t=hunter",
  colonDb: "db_pass" + "word=" + "Qw3rTy9@:superlongtail",
  colonQuoted: "pass" + "word=\"" + "Xk9mQ2pL7:abcdefghij\"",
  pwdEqInside: "pass" + "word=" + "a1=bcdefghijk",
  apiKeyPadded: "api_" + "key=" + "base64abc==XYZ1",
  apiKey: "api_" + "key: " + "abcdefghijklmnopqrstuv9",
  pem: "-----BEGIN " + "RSA PRIVATE KEY" + "-----",
  pgp: "-----BEGIN " + "PGP PRIVATE KEY BLOCK" + "-----",
};
const wrap = (s, eol, at) => s.slice(0, at) + eol + "  " + s.slice(at); // wrapped mid-token, indented continuation
export const shapes = {
  single: (s) => s,
  "split LF": (s) => wrap(s, LF, Math.floor(s.length / 2)),
  "split CRLF": (s) => wrap(s, CRLF, Math.floor(s.length / 2)),
  "split early LF": (s) => wrap(s, LF, 4),
  "split late CRLF": (s) => wrap(s, CRLF, s.length - 3),
  "3-way LF": (s) => { const a = Math.floor(s.length / 3); return s.slice(0, a) + LF + s.slice(a, 2 * a) + LF + s.slice(2 * a); },
  "mixed case": (s) => s.toLowerCase(),
  "upper case": (s) => s.toUpperCase(),
  "mixed case split": (s) => wrap(s.toLowerCase(), CRLF, Math.floor(s.length / 2)),
  "word chars on the lines before and after": (s) => "abc" + LF + s + LF + "def",
  "word chars glued, split": (s) => "abc" + LF + s.slice(0, 6) + LF + s.slice(6) + LF + "def",
  "prose around": (s) => "see the note below" + LF + s + LF + "thanks",
  "diff-style prefix stripped, trailing blanks": (s) => "   " + s + "   " + LF + LF,
};
