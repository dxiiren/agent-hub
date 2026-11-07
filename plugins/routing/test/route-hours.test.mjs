import { test } from "node:test";
import assert from "node:assert/strict";
import { inHours, outsideHours, parseHours } from "../hours.mjs";

test("inHours: wrapping hours 22:00-08:00 Asia/Kuala_Lumpur", () => {
  const w = { hours: "22:00-08:00", tz: "Asia/Kuala_Lumpur" };
  assert.equal(inHours(w, Date.parse("2026-11-08T15:00:00Z")), true);
  assert.equal(inHours(w, Date.parse("2026-11-08T23:30:00Z")), true);
  assert.equal(inHours(w, Date.parse("2026-11-08T01:00:00Z")), false);
  assert.equal(inHours(w, Date.parse("2026-11-08T14:00:00Z")), true);
  assert.equal(inHours(w, Date.parse("2026-11-08T00:00:00Z")), false);
});

test("inHours: non-wrapping hours 09:00-17:00 UTC", () => {
  const w = { hours: "09:00-17:00", tz: "UTC" };
  assert.equal(inHours(w, Date.parse("2026-11-08T10:00:00Z")), true);
  assert.equal(inHours(w, Date.parse("2026-11-08T09:00:00Z")), true);
  assert.equal(inHours(w, Date.parse("2026-11-08T16:59:00Z")), true);
  assert.equal(inHours(w, Date.parse("2026-11-08T17:00:00Z")), false);
  assert.equal(inHours(w, Date.parse("2026-11-08T08:59:00Z")), false);
});

test("inHours: default timezone is UTC", () => {
  const w = { hours: "09:00-17:00" };
  assert.equal(inHours(w, Date.parse("2026-11-08T10:00:00Z")), true);
  assert.equal(inHours(w, Date.parse("2026-11-08T08:00:00Z")), false);
});

test("outsideHours: returns null for entry without a window", () => {
  const routes = { hours: {} };
  assert.equal(outsideHours(routes, "missing", Date.now()), null);
});

test("outsideHours: returns string containing 'outside its hours' when outside", () => {
  const routes = { hours: { "off-peak": { hours: "09:00-17:00", tz: "UTC" } } };
  const result = outsideHours(routes, "off-peak", Date.parse("2026-11-08T08:00:00Z"));
  assert.ok(result !== null);
  assert.match(result, /outside its hours/);
});

test("parseHours: rejects invalid hour '25:00-08:00'", () => {
  assert.equal(parseHours("25:00-08:00"), null);
});
