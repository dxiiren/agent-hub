// One writer for every JSON config the hub rewrites: 2-space indent, final newline, and the file's own line endings (a CRLF file stays CRLF).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LF = String.fromCharCode(10), CRLF = String.fromCharCode(13, 10);
export function writeJsonKeepEol(p, o) {
  mkdirSync(dirname(p), { recursive: true });
  let t = JSON.stringify(o, null, 2) + LF;
  try { if (readFileSync(p, "utf8").includes(CRLF)) t = t.split(LF).join(CRLF); } catch { /* new file: LF */ }
  writeFileSync(p, t);
}
