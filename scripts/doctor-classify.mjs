// `doctor --deep`: why did a provider's one-word task fail, and is that the machine's fault or the environment's (quota, expired login)?
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const QUOTA = /usage limit|hit your .{0,20}limit|quota|rate.?limit|too many requests|credits?\b.{0,30}(exhaust|deplet|run out|insufficient)|insufficient[_ ]funds|try again at|resets? (at|in|on)|billing/i;
const AUTH = /not (logged|signed) in|log ?in (again|required)|please (log|sign) ?in|login required|authenticat\w* (failed|required|expired)|(token|session|credentials?|api key)\b.{0,20}(expired|invalid|revoked|missing)|unauthori[sz]ed|\b401\b|\b403\b/i;
// Paseo stores some provider messages UTF-8 read as Latin-1 (a typographic apostrophe arrives as three characters): put it back to ASCII.
const MOJIBAKE = [[/â€™/g, "'"], [/â€[œ\u009d“”]/g, '"'], [/’/g, "'"]];
/** The text Paseo kept as the agent's last error (record file under <home>/agents/<project>/<id>.json). '' when none. */
export function agentLastError(home, id) {
  try {
    for (const d of readdirSync(join(home, "agents"))) {
      try { const e = JSON.parse(readFileSync(join(home, "agents", d, `${id}.json`), "utf8")).lastError; if (e) return MOJIBAKE.reduce((t, [re, to]) => t.replace(re, to), String(e)); } catch { /* not in this project folder */ }
    }
  } catch { /* no agents folder */ }
  return "";
}
/** 'quota' | 'auth' (environment: the provider works, the account cannot run it now) | 'real' (a breakage doctor must fail on); `reason` is the provider's own words, one line. */
export function classifyFailure(text) {
  const reason = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!reason) return { kind: "real", reason };
  if (QUOTA.test(reason)) return { kind: "quota", reason };
  if (AUTH.test(reason)) return { kind: "auth", reason };
  return { kind: "real", reason };
}
