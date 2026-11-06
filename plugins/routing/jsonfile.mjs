// One reader and one writer for every JSON config the hub rewrites. Reader: strips a UTF-8 BOM, a missing file gives the default, an unparsable file THROWS (a caller that then writes would destroy it).
// Writer: 2-space indent, final newline, the file's own line endings (a CRLF file stays CRLF) and its BOM (a BOM file keeps it).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LF = String.fromCharCode(10), CRLF = String.fromCharCode(13, 10), BOM = String.fromCharCode(0xfeff);
export function readJsonStrict(p, d) {
  let t;
  try { t = readFileSync(p, "utf8"); } catch (e) { if (e?.code === "ENOENT") return d; throw new Error(`cannot read ${p}: ${e.message}. Nothing was written.`); }
  let j;
  try { j = JSON.parse(t.startsWith(BOM) ? t.slice(1) : t); } catch (e) { throw new Error(`${p} is not valid JSON (${e.message}). Fix or remove it; nothing was written.`); }
  if (j === null || typeof j !== "object" || Array.isArray(j)) throw new Error(`${p} is not a JSON object (top level must be { ... }). Fix or remove it; nothing was written.`);
  return j;
}
export function writeJsonKeepEol(p, o) {
  mkdirSync(dirname(p), { recursive: true });
  let t = JSON.stringify(o, null, 2) + LF;
  try { const old = readFileSync(p, "utf8"); if (old.includes(CRLF)) t = t.split(LF).join(CRLF); if (old.startsWith(BOM)) t = BOM + t; } catch { /* new file: LF, no BOM */ }
  writeFileSync(p, t);
}

/** o[k] only when k is an OWN key (never Object.prototype's constructor, toString, hasOwnProperty, __proto__ ...); config objects are indexed by user-chosen names. */
export const own = (o, k) => (o != null && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : undefined);
