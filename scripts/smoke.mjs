#!/usr/bin/env node
// agent-hub smoke (HUBFIX3): one read-only route + one gated edit route on a throwaway git folder.
// usage: node scripts/smoke.mjs [--session <id>]      exit 0 = every step PASS
// Prints PASS/FAIL per step with seconds and removes its folder, agents and workspaces afterwards.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const route = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "routing", "route.mjs");
const sid = process.argv.includes("--session") ? process.argv[process.argv.indexOf("--session") + 1] : `smoke-${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "hub-smoke-")).split("\\").join("/");
const git = (...a) => spawnSync("git", ["-C", dir, "-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", ...a], { encoding: "utf8" });
writeFileSync(join(dir, "m.py"), "def f(x):\n    return x\n");
writeFileSync(join(dir, "test_m.py"), "from m import f\n\ndef test_f():\n    assert f(1) == 1\n");
git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init");

const results = [];
function step(name, type, prompt, extra, timeoutS, check) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [route, type, prompt, "--cwd", dir, "--session", sid, "--timeout", String(timeoutS), ...extra], { encoding: "utf8", timeout: (timeoutS + 20) * 1000 });
  const secs = Math.round((Date.now() - t0) / 1000);
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* no json */ }
  const bad = j ? check(j) : `no JSON answer (rc ${r.status}): ${String(r.stderr).trim().split("\n").pop()?.slice(0, 160)}`;
  results.push({ name, ok: !bad, secs, why: bad || `${j.used ?? "?"}` });
  console.log(`${bad ? "FAIL" : "PASS"}  ${name.padEnd(22)} ${String(secs).padStart(4)} s  ${bad || j.used}`);
}

step("read-only summarise", "summarise", "List the function names defined in m.py. One line.", [], 120, (j) => (j.status === "completed" && /\bf\b/.test(String(j.answer ?? ""))) ? "" : `status ${j.status}, answer ${JSON.stringify(String(j.answer ?? "").slice(0, 80))}${j.error ? ", " + String(j.error).slice(0, 120) : ""}`);
step("gated edit", "code-edit-easy", "In m.py add a function is_even(n) returning True for even n. Do not run git commands.", ["--gate", "python -m pytest -q"], 170, (j) => (j.status === "completed" && (j.gate?.status ?? "PASS") === "PASS") ? "" : `status ${j.status}, gate ${j.gate?.status}${j.error ? ", " + String(j.error).slice(0, 120) : ""}`);

// cleanup: our folder, and any agent or workspace still pointing at it
const t0 = Date.now();
const paseo = (a) => { const r = spawnSync("paseo", [...a, "--json"], { encoding: "utf8", timeout: 60000, shell: process.platform === "win32" }); try { return JSON.parse(r.stdout); } catch { return []; } };
const norm = (p) => String(p).split("\\").join("/").toLowerCase();
for (const w of paseo(["workspace", "ls"])) if (norm(w.cwd).startsWith(norm(dir))) spawnSync("paseo", ["workspace", "archive", w.workspaceId], { timeout: 60000, shell: process.platform === "win32" });
const left = paseo(["ls", "-a", "-g"]).filter((a) => norm(a.cwd ?? "").includes(norm(dir).split("/").pop()) && /running|idle/i.test(String(a.status)));
for (const a of left) spawnSync("paseo", ["stop", a.id], { timeout: 60000, shell: process.platform === "win32" });
rmSync(dir, { recursive: true, force: true });
console.log(`${left.length ? "WARN" : "PASS"}  cleanup                ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${left.length ? left.length + " agent(s) of this smoke were still alive and were stopped" : "folder, workspace and agents removed"}`);
const total = results.reduce((s, r) => s + r.secs, 0);
console.log(`${results.every((r) => r.ok) ? "SMOKE PASS" : "SMOKE FAIL"} (session ${sid}, ${total} s)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
