// "Hub tasks" card of the Usage page: the totals `agent-hub usage --all` prints (all time, every provider), plus the last 7 days, so the page and the CLI agree.
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)));
const blank = () => ({ n: 0, in: 0, out: 0, credits: 0 });
const add = (b, r) => { b.n += 1; b.in += Number(r.in) || 0; b.out += Number(r.out) || 0; b.credits += Number(r.credits) || 0; };
const line = (b) => `${b.n} task${b.n === 1 ? "" : "s"}, ${fmt(b.in)} in / ${fmt(b.out)} out${b.credits ? `, ${b.credits.toFixed(0)} credits` : ""}`;

/** usage.jsonl text -> one Paseo UsageReport. Pure. */
export function hubTasksReport(jsonl, now = Date.now()) {
  const all = blank(), week = blank(), by = new Map();
  for (const l of String(jsonl).split("\n")) {
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const p = String(r.provider || "unknown"), inWeek = now - Date.parse(r.ts) < 7 * 864e5;
    const e = by.get(p) ?? { all: blank(), week: blank() };
    by.set(p, e);
    add(all, r); add(e.all, r);
    if (inWeek) { add(week, r); add(e.week, r); }
  }
  if (!all.n) return { status: "available", planLabel: "No hub tasks yet", windows: [], details: [{ id: "none", label: "Recorded", value: "None yet. Tasks sent through the hub appear here.", tone: "default" }] };
  const rows = [...by.entries()].sort((a, b) => b[1].all.n - a[1].all.n).map(([p, e], k) => ({ id: `p-${k}`, label: p, value: `${line(e.all)} (last 7 days: ${e.week.n})`, tone: "ok" }));
  return { status: "available", planLabel: `${all.n} tasks across ${by.size} provider${by.size === 1 ? "" : "s"}`, windows: [], details: [
    { id: "all", label: "All time", value: line(all) }, { id: "week", label: "Last 7 days", value: line(week) }, ...rows] };
}
