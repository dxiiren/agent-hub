import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAsk, mayAsk, MAX_ASKS, park, loadPark, reapParked, runReply, runRoute } from "../route.mjs";

test("parseAsk: only the last non-empty line counts", () => {
  assert.equal(parseAsk("working\n[ASK] which file name?"), "which file name?");
  assert.equal(parseAsk("working\n[ASK] which file name?\n\n  "), "which file name?");
  assert.equal(parseAsk("[ASK] early\nthen I went on and finished"), null);
  assert.equal(parseAsk("done. [ASK] inline is prose"), null);
  assert.equal(parseAsk("[ASK]"), null);
  assert.equal(parseAsk(""), null);
});
test("round cap: three asks allowed, the fourth is final", () => {
  assert.equal(MAX_ASKS, 3);
  assert.deepEqual([0, 1, 2, 3].map(mayAsk), [true, true, true, false]);
});

const dir = () => mkdtempSync(join(tmpdir(), "parked-"));
// logs: full transcript then assistant-only, both end with `ans`
const fake = (ans, extra = {}) => {
  const calls = [];
  const f = (a) => { calls.push(a);
    if (a[0] === "logs") return { text: a.includes("--filter") ? ans : "[User] x\n" + ans };
    if (a[0] === "wait") return extra.wait ?? { status: "idle" };
    if (a[0] === "send") return extra.send ?? {};
    return {}; };
  f.calls = calls; return f;
};
const rec = (d, o = {}) => { park({ agentId: "A1", provider: "claude-clean/haiku", cwd: "/r", asks: 1, ...o }, { dir: d, reaper: false }); };

test("reply with a credential-like text is rejected before anything is sent", () => {
  const d = dir(); rec(d); const p = fake("x");
  const r = runReply("A1", ["use pass" + "word=Sup3rS3cret!x", "please"].join(" "), p, {}, { dir: d, answerRetryMs: 0 });
  assert.equal(r.status, "rejected"); assert.equal(p.calls.length, 0); assert.ok(loadPark("A1", d));
});
test("reply to an unknown agent errors", () => {
  assert.equal(runReply("nope", "hi", fake("x"), {}, { dir: dir() }).status, "error");
});
test("reply: send + wait, final answer returned, agent retired", () => {
  const d = dir(); rec(d); const p = fake("created notes.txt");
  const r = runReply("A1", "notes.txt", p, {}, { dir: d, answerRetryMs: 0 });
  assert.equal(r.status, "completed"); assert.equal(r.answer, "created notes.txt");
  assert.deepEqual(p.calls.slice(0, 2).map((c) => c[0]), ["send", "wait"]);
  assert.ok(p.calls.some((c) => c[0] === "stop") && p.calls.some((c) => c[0] === "archive"));
  assert.equal(loadPark("A1", d), null);
});
test("reply can ask again and stays parked with the next round", () => {
  const d = dir(); rec(d); const p = fake("hmm\n[ASK] and the folder?");
  const r = runReply("A1", "notes.txt", p, {}, { dir: d, answerRetryMs: 0 });
  assert.equal(r.status, "asking"); assert.equal(r.question, "and the folder?"); assert.equal(r.round, 2);
  assert.equal(loadPark("A1", d).asks, 2); assert.ok(!p.calls.some((c) => c[0] === "stop"));
});
test("after the third question the reply must finish: a further [ASK] is returned as the final answer", () => {
  const d = dir(); rec(d, { asks: 3 }); const p = fake("still unsure\n[ASK] again?");
  const r = runReply("A1", "just guess", p, {}, { dir: d, answerRetryMs: 0 });
  assert.equal(r.status, "completed"); assert.match(p.calls.find((c) => c[0] === "send")[2], /last reply/);
  assert.equal(loadPark("A1", d), null);
});
test("the original gate runs on the final answer", () => {
  const d = dir(); rec(d, { gate: "true" }); const p = fake("done"); p.ls = [];
  const r = runReply("A1", "ok", (a) => (a[0] === "ls" ? [{ id: "A1", cwd: "/r" }] : p(a)), {}, { dir: d, answerRetryMs: 0, gate: () => ({ status: "FAIL", reasons: ["bad"] }), });
  assert.equal(r.status, "gate-failed");
});
test("reap stops only an agent whose park is unchanged", () => {
  const d = dir(); const at = park({ agentId: "A2", provider: "x", cwd: "/r", asks: 1 }, { dir: d, reaper: false });
  const p = fake("x");
  assert.equal(reapParked(p, "A2", at - 1, d), false); assert.ok(loadPark("A2", d));
  assert.equal(reapParked(p, "A2", at, d), true); assert.equal(loadPark("A2", d), null);
  assert.ok(p.calls.some((c) => c[0] === "stop" && c[1] === "A2"));
});
test("route parks an agent whose final line is [ASK]: status asking, alive, no gate, no retire", () => {
  const d = dir(); const calls = [];
  const p = (a) => { calls.push(a);
    if (a[0] === "run") return { status: "completed", agentId: "R1" };
    if (a[0] === "logs") return { text: a.includes("--filter") ? "I need a name\n[ASK] which file name?" : "[User] t\nI need a name\n[ASK] which file name?" };
    return a[0] === "ls" ? [] : {}; };
  const routes = { slots: { qwen: 1 }, routes: { edit: ["qwen/b"] } };
  const r = runRoute({ type: "edit", prompt: "p", cwd: process.cwd(), gate: "false", answerRetryMs: 0, home: d, reaper: false }, p, routes);
  assert.equal(r.status, "asking"); assert.equal(r.question, "which file name?"); assert.equal(r.agentId, "R1");
  assert.ok(!calls.some((c) => c[0] === "stop" || c[0] === "archive"));
  assert.ok(existsSync(join(d, "usage", "parked", "R1.json")));
  assert.equal(loadPark("R1", join(d, "usage", "parked")).gate, "false");
  assert.ok(loadPark("R1", join(d, "usage", "parked")));
});
