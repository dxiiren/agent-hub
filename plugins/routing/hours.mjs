// Time windows for chain entries: routes.hours = { "<chain entry>": { hours: "22:00-08:00", tz: "Asia/Kuala_Lumpur" } } (tz defaults to UTC).
// An entry with a window is tried only inside it (Qoder off-peak models); entries without one are unchanged. A window past midnight (22:00-08:00) wraps; start == end means all day.
const own = (o, k) => (o != null && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : undefined);
const HOURS_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
export const parseHours = (s) => { const m = HOURS_RE.exec(String(s)); return m ? [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])] : null; };
export const validTz = (tz) => { try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; } };
const minutesIn = (tz, ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ms).map((x) => [x.type, x.value])); return Number(p.hour) * 60 + Number(p.minute); };
export const label = (w) => `${w.hours} ${w.tz ?? "UTC"}`;
export function inHours(w, ms = Date.now()) {
  const r = parseHours(w?.hours); if (!r) return true; // a malformed window never blocks: validation refuses it on save
  const [a, b] = r; const n = minutesIn(w.tz ?? "UTC", ms);
  return a === b ? true : a < b ? n >= a && n < b : n >= a || n < b;
}
/** Error string when the entry has a window and now is outside it, else null. */
export function outsideHours(routes, entry, ms) {
  const w = own(routes?.hours, entry);
  return w && !inHours(w, ms) ? `outside its hours (${label(w)})` : null;
}
