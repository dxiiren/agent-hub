// Detached keep-warm reaper: stops the llama-server this hub started once it has been idle LAPTOP_IDLE_MIN minutes (default 15).
// Never stops a server it did not start: the pid must be the recorded one and its command line a llama-server. It never exits while that pid lives
// (an unknown port listener = the model is still loading or the lookup timed out: keep watching); it exits when the server is gone or after stopping it.
import { listenerPid, stopVerified, readOwn, reapStep, anyInflight, ownedAlive, readReaper, writeReaper, clearReaper, reaperRunning } from './gpu-guard.mjs';
const port = process.argv[2] || process.env.LAPTOP_PORT || '8089';
const idleMs = Number(process.env.LAPTOP_IDLE_MIN || 15) * 60_000;
const pollMs = Number(process.env.LAPTOP_REAPER_MS || 30_000);
const other = readReaper(port); if (other && other !== process.pid && reaperRunning(other)) process.exit(0); // one reaper per port
writeReaper(port);
process.on('exit', () => clearReaper(port));
const t = setInterval(() => {
  const own = readOwn(port);
  const r = reapStep({ own, listener: listenerPid(port), ownAlive: ownedAlive(own), inflight: anyInflight(port), now: Date.now(), idleMs });
  if (r.act === 'stop' && !stopVerified(own)) return; // not positively our llama-server: leave it, keep watching
  if (r.act !== 'keep') clearInterval(t); // stopped, or our server is dead / nothing recorded: nothing left to reap
}, pollMs);
