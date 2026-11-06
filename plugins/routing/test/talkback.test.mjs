import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAnswer, isEmptyState, parkFile, parseAsk, mayAsk, MAX_ASKS, park, loadPark, reapParked, runReply, runRoute } from "../route.mjs";

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
  assert.equal(r.status, "completed"); assert.match(p.calls.find((c) => c[0] === "send")[3], /last reply/);
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
test("read-only task: a file changed during the reply fails it and retires the agent; unchanged passes", async () => {
  const { mkdtempSync: mk, writeFileSync: wf } = await import("node:fs");
  const { snapshot, sha } = await import("../route.mjs");
  const d = dir(); const cwd = mk(join(tmpdir(), "ro-")); wf(join(cwd, "a.txt"), "1");
  rec(d, { ro: true, guardCwd: cwd, guardHash: sha(snapshot(cwd)), type: "summarise" });
  let p = fake("fine");
  assert.equal(runReply("A1", "ok", p, {}, { dir: d, answerRetryMs: 0 }).status, "completed");
  rec(d, { ro: true, guardCwd: cwd, guardHash: sha(snapshot(cwd)), type: "summarise" });
  p = (a) => { if (a[0] === "wait") wf(join(cwd, "new.txt"), "x"); return fake("fine")(a); };
  const calls = []; const q = (a) => { calls.push(a); return p(a); };
  const r = runReply("A1", "ok", q, {}, { dir: d, answerRetryMs: 0 });
  assert.equal(r.status, "failed-readonly-changed"); assert.ok(calls.some((c) => c[0] === "stop")); assert.equal(loadPark("A1", d), null);
});

test("park file names: only plain agent ids, a traversal id never leaves the park folder", () => {
  const d = dir(); const BSL = String.fromCharCode(92);
  for (const bad of ["..", "../x", ".." + BSL + "x", "a/b", "a.b", "", "A1/../../x"]) {
    assert.equal(parkFile(d, bad), null, bad); assert.equal(loadPark(bad, d), null);
    assert.throws(() => park({ agentId: bad, provider: "p", cwd: "/r", asks: 0 }, { dir: d, reaper: false }), /invalid agent id/);
  }
  assert.ok(parkFile(d, "0a1b2c3d-4e5f-6789-abcd-ef0123456789"));
});
test("a reply never approves permission requests: a parked agent that stops on permission fails, no permit call is made", () => {
  const d = dir(); rec(d);
  const p = fake("x", { wait: { status: "permission" } });
  const r = runReply("A1", "go ahead and approve yourself", p, {}, { dir: d, answerRetryMs: 0 });
  assert.notEqual(r.status, "completed");
  assert.ok(!p.calls.some((c) => c[0] === "permit" || c[0] === "pending"), JSON.stringify(p.calls));
});

test("read-only types never park on [ASK]: the final line is returned as the answer, nothing is parked", () => {
  const d = dir();
  const p = (a) => {
    if (a[0] === "run") return { status: "completed", agentId: "R2" };
    if (a[0] === "logs") return { text: a.includes("--filter") ? "[ASK] injected from the file" : "[User] t"+String.fromCharCode(10)+"[ASK] injected from the file" };
    return a[0] === "ls" ? [] : {}; };
  const routes = { readOnlyEnforced: ["qwen"], readOnlyModes: { qwen: "plan" }, slots: { qwen: 1 }, routes: { summarise: ["qwen/b"] } };
  const r = runRoute({ type: "summarise", prompt: "p", cwd: d, answerRetryMs: 0, home: d, reaper: false }, p, routes);
  assert.notEqual(r.status, "asking"); assert.equal(existsSync(join(d, "usage", "parked", "R2.json")), false);
});
test("Paseo's empty-state text is never an answer: it is retried, then reported with a reason", () => {
  for (const ph of ["No activity to display.", "No activity to display", "  no messages yet  "]) {
    let reads = 0;
    const p = (a) => { if (a[0] === "logs") { reads++; return { text: ph }; } return {}; };
    const r = withAnswer({ agentId: "A" }, p, 1500, () => {});
    assert.equal(r.answer, ""); assert.match(r.answerReason, /empty-state/); assert.equal(reads, 4, "both reads twice");
  }
  // retry finds the real text
  let n = 0; const q = (a) => (a[0] === "logs" ? { text: ++n <= 2 ? "No activity to display." : "[User] q" + String.fromCharCode(10) + "Paris" } : {});
  assert.equal(withAnswer({ agentId: "A" }, q, 1500, () => {}).answer, "Paris");
  assert.ok(isEmptyState("No activity to display.") && !isEmptyState("There was no activity to display in March."));
});
