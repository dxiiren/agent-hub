// Hub entry cap: at most `maxInFlight` routes (default 8) run at once across ALL callers; the rest wait here, holding no agent, no worktree and no daemon connection.
// 08-11: 13-24 parallel routes, each spawning dozens of `paseo` CLI processes (one websocket + hello each) against a Windows daemon whose git queue was already saturated,
// stalled its event loop for 40-250 s and then hung it twice. A waiting route costs the daemon nothing: it only polls slot files on disk (no `paseo` call), every 2-4 s (jittered).
// Slots are files <run dir>/inflight/slot-<n>.json {pid, at}, taken with O_EXCL; a slot whose pid is dead (or older than 3 h) is taken over.
// Config: routes.local.json "maxInFlight" (0 = no cap), env AGENT_HUB_MAX_INFLIGHT overrides. shortcut: no FIFO order (a waiter may be overtaken), fine for a cap whose job is only to bound the load.
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MAX_IN_FLIGHT = 8;
export const maxInFlight = (routes = {}, env = process.env) => {
  const v = Number(env.AGENT_HUB_MAX_INFLIGHT ?? routes.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_MAX_IN_FLIGHT;
};
export const alive = (pid, kill = process.kill) => { try { kill(pid, 0); return true; } catch { return false; } }; // EPERM = reused pid of another account, not our process
// no process-start-time check here: it costs a powershell call and this runs on every poll of every waiting route. Pid reuse is bounded by the 3 h age limit (a route lives 15-45 min).
const owned = (o, now) => o && Number.isInteger(o.pid) && alive(o.pid) && now - (o.at ?? 0) < 3 * 3600_000;
const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Take one of `max` slots, waiting up to `waitMs`. -> { release(), waitedMs, slot } or null when the wait ran out. max 0 = no cap. */
export function acquireEntry({ dir, max, waitMs = 30 * 60_000, sleep = defaultSleep, now = Date.now, jitter = () => 2000 + Math.random() * 2000, pid = process.pid, onWait = () => {} }) {
  if (!max) return { release() {}, waitedMs: 0, slot: null };
  const d = join(dir, "inflight"); mkdirSync(d, { recursive: true });
  const t0 = now(); const me = { pid, at: t0 }; let announced = false; sweepDead(d, now);
  for (;;) {
    let reclaimed = false;
    for (let n = 0; n < max; n++) {
      const f = join(d, `slot-${n}.json`);
      try { writeFileSync(f, JSON.stringify(me), { flag: "wx" }); return { release: () => { try { if (JSON.parse(readFileSync(f, "utf8")).pid === pid) rmSync(f, { force: true }); } catch { /* gone */ } }, waitedMs: now() - t0, slot: n }; }
      catch (e) {
        if (e?.code !== "EEXIST") throw e;
        let o = null; try { o = JSON.parse(readFileSync(f, "utf8")); } catch { /* torn: the owner is between create and write */ }
        if (o && !owned(o, now())) { try { rmSync(f, { force: true }); reclaimed = true; } catch { /* raced */ } }
      }
    }
    if (reclaimed) continue;
    if (now() - t0 >= waitMs) return null;
    if (!announced) { announced = true; onWait(held(d), max); }
    sleep(jitter());
  }
}
/** Remove every slot file in `d` whose owner is dead or over 3 h old (not only the one a scan happens to hit); returns how many. A torn (unparsable) file is left to its writer. */
export function sweepDead(d, now = Date.now) {
  let n = 0; let names = []; try { names = readdirSync(d).filter((f) => /^slot-\d+\.json$/.test(f)); } catch { return 0; }
  for (const f of names) { try { const o = JSON.parse(readFileSync(join(d, f), "utf8")); if (!owned(o, now())) { rmSync(join(d, f), { force: true }); n++; } } catch { /* torn or gone */ } }
  return n;
}
/** Live slot count: dead ones are swept first, so doctor and the wait message show the real number. */
export const held = (d) => { sweepDead(d); try { return readdirSync(d).filter((f) => /^slot-\d+\.json$/.test(f)).length; } catch { return 0; } };
