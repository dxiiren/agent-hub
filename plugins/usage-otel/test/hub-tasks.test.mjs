import test from "node:test";
import assert from "node:assert/strict";
import { hubTasksReport } from "../server/hub-tasks-usage.mjs";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const L = (o) => JSON.stringify({ in: 0, out: 0, credits: 0, ...o });

test("hub tasks card: all-time and 7-day totals per provider match the CLI's all-time sums", () => {
  const feed = [L({ ts: "2026-11-06T01:00:00Z", provider: "codex", in: 1000000, out: 500 }), L({ ts: "2026-10-01T01:00:00Z", provider: "codex", in: 5000000 }),
    L({ ts: "2026-11-05T01:00:00Z", provider: "qoder", credits: 468 }), "junk"].join("\n");
  const r = hubTasksReport(feed, NOW), d = Object.fromEntries(r.details.map((x) => [x.id, x]));
  assert.equal(r.planLabel, "3 tasks across 2 providers");
  assert.match(d.all.value, /^3 tasks, 6\.0M in \/ 500 out, 468 credits$/);
  assert.match(d.week.value, /^2 tasks, 1\.0M in/);
  assert.match(r.details.find((x) => x.label === "codex").value, /^2 tasks.*last 7 days: 1\)$/);
});
test("hub tasks card: empty feed says so", () => {
  assert.match(hubTasksReport("", NOW).details[0].value, /None yet/);
});
