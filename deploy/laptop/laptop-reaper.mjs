// Detached keep-warm reaper: stops the llama-server this hub started once it has been idle LAPTOP_IDLE_MIN minutes (default 15).
// Never stops a server it did not start: the pid must be the one recorded at start and still the listener on the port.
import { listenerPid, stopPid, readOwn, reapStep, anyInflight } from './gpu-guard.mjs';
const port = process.argv[2] || process.env.LAPTOP_PORT || '8089';
const idleMs = Number(process.env.LAPTOP_IDLE_MIN || 15) * 60_000;
const pollMs = Number(process.env.LAPTOP_REAPER_MS || 30_000);
const t = setInterval(() => {
  const r = reapStep({ own: readOwn(port), listener: listenerPid(port), inflight: anyInflight(port), now: Date.now(), idleMs });
  if (r.act === 'stop') stopPid(r.pid);
  if (r.act !== 'keep') clearInterval(t); // stopped, or the server is gone / replaced by someone else's: nothing of ours left to reap
}, pollMs);
