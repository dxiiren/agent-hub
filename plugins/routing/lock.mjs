// Cross-process lock for the config files the hub rewrites (routes, hub.local.json, Paseo config.json): a lock file created with O_EXCL holding the owner's pid and time.
// A lock whose owner pid is dead (or older than STALE_MS, pid reuse) is taken over. Re-entrant inside one async call chain (add -> reconcile -> removeManual).
// shortcut: the sync form waits by sleeping the thread, so never call it while ANOTHER async call chain of the same process holds the lock; it times out with an error instead of hanging.
import { writeFileSync, readFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, resolve } from "node:path";

const als = new AsyncLocalStorage();
export const STALE_MS = 10 * 60 * 1000;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };

function tryTake(lf) {
  mkdirSync(dirname(lf), { recursive: true }); // a fresh home has no folder yet
  try { writeFileSync(lf, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" }); return true; }
  catch (e) {
    if (e?.code !== "EEXIST") throw e;
    let o; try { o = JSON.parse(readFileSync(lf, "utf8")); } catch { o = null; }
    if (o === null) { // empty/torn file: owner is between create and write; only a long-lived one is junk
      try { if (Date.now() - (statMtime(lf)) > 10_000) rmSync(lf, { force: true }); } catch { /* raced */ }
      return false;
    }
    if (!alive(o.pid) || Date.now() - o.at > STALE_MS) { try { rmSync(lf, { force: true }); } catch { /* raced */ } }
    return false;
  }
}

const statMtime = (f) => { try { return statSync(f).mtimeMs; } catch { return Date.now(); } };
const release = (lf) => { try { const o = JSON.parse(readFileSync(lf, "utf8")); if (o.pid === process.pid) rmSync(lf, { force: true }); } catch { /* gone */ } };
const held = (lf) => als.getStore()?.has(lf);
const enter = (lf, fn) => als.run(new Set([...(als.getStore() ?? []), lf]), fn);

export function withLockSync(file, fn, { timeoutMs = 30_000 } = {}) {
  const lf = resolve(file);
  if (held(lf)) return fn();
  const end = Date.now() + timeoutMs;
  while (!tryTake(lf)) {
    if (Date.now() > end) throw new Error(`config lock ${lf} is held by another process; try again`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + Math.random() * 50);
  }
  try { return enter(lf, fn); } finally { release(lf); }
}
export async function withLock(file, fn, { timeoutMs = 30_000 } = {}) {
  const lf = resolve(file);
  if (held(lf)) return fn();
  const end = Date.now() + timeoutMs;
  while (!tryTake(lf)) {
    if (Date.now() > end) throw new Error(`config lock ${lf} is held by another process; try again`);
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
  }
  try { return await enter(lf, fn); } finally { release(lf); }
}
