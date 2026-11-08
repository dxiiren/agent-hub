// Load test for the daemon on a THROWAWAY home and port (never the real hub): N concurrent fake routes doing what a real route does to the daemon (worktree create, a few `paseo ls`,
// worktree archive; every call is a CLI process = one websocket + hello), optionally behind the hub entry cap, while a sampler records /api/health latency, the worker's RSS and the TCP
// connection count every 5 s. Prints p50/p95/max and the first-third vs last-third means (flat = no leak) and the daemon's own eventLoopDelay / git queue peaks from daemon.log.
//   node scripts/load-test.mjs --home <dir> --port 6890 --repo <git repo with a `main` branch> [--routes 20] [--minutes 30] [--cap 8|0] [--out <summary.json>]
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireEntry } from '../plugins/routing/entry-gate.mjs';
import { listenerPid } from './daemon-ctl.mjs';
import { spawnSyncSafe, spawnSafe } from '../plugins/routing/spawn-safe.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const home = resolve(arg('--home')), port = Number(arg('--port', 6890)), repo = resolve(arg('--repo')), routes = Number(arg('--routes', 20)), minutes = Number(arg('--minutes', 30)), cap = Number(arg('--cap', 8));
const out = arg('--out', join(home, 'load-summary.json')); const samples = join(home, 'load-samples.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
mkdirSync(home, { recursive: true });
const paseoBin = process.env.AGENT_HUB_PASEO || 'paseo';
const cli = (args, ms = 90000) => new Promise((res) => {
  let p; try { p = spawnSafe(paseoBin, ['--home', home, ...args, '--json'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch (e) { return res({ error: String(e) }); }
  let o = ''; p.stdout.on('data', (d) => (o += d)); const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} res({ error: 'timeout' }); }, ms);
  p.on('close', (c) => { clearTimeout(t); try { res(JSON.parse(o.slice(o.search(/[[{]/)))); } catch { res({ error: `exit ${c}` }); } });
});

const t0 = Date.now(), end = t0 + minutes * 60_000; const stat = { cycles: 0, failures: 0, creates: [] };
async function fakeRoute(i) {
  const dir = join(home, 'run');
  while (Date.now() < end) {
    // acquireEntry blocks its thread while it waits (fine in a CLI process); in this one process the waiter polls with waitMs 0 so the other fake routes keep running
    let s = acquireEntry({ dir, max: cap, waitMs: 0 }); while (!s && Date.now() < end) { await sleep(2000 + Math.random() * 2000); s = acquireEntry({ dir, max: cap, waitMs: 0 }); }
    if (!s) return;
    try {
      const c0 = Date.now(); const c = await cli(['worktree', 'create', '--mode', 'branch-off', '--new-branch', `route-lt${i}x${Date.now().toString(16)}`, '--base', 'main', '--cwd', repo]);
      stat.creates.push(Date.now() - c0);
      if (!c?.name) { stat.failures++; continue; }
      for (let k = 0; k < 3; k++) { await cli(['ls']); await sleep(2000 + Math.random() * 2000); } // the busy checks / waits of a route: gentle, jittered, >= 2 s
      await sleep(3000 + Math.random() * 7000); // the agent "works"
      const a = await cli(['worktree', 'archive', c.name, '--cwd', repo]); if (a?.error) stat.failures++;
      stat.cycles++;
    } finally { s.release(); }
    await sleep(1000 + Math.random() * 2000);
  }
}

async function health() { const s = Date.now(); try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) }); await r.text(); return r.status === 200 ? Date.now() - s : 5000; } catch { return 5000; } }
function tcpCount() { const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }); return (r.stdout || '').split(/\r?\n/).filter((l) => l.includes(`127.0.0.1:${port} `) && /ESTABLISHED/.test(l)).length / 2 | 0; }
function rssMb(pid) { const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }); const m = /"([\d,]+) K"/.exec(r.stdout || ''); return m ? Math.round(Number(m[1].replace(/,/g, '')) / 1024) : null; }
const rows = [];
const sampler = (async () => { while (Date.now() < end + 5000) { const pid = listenerPid(port); const r = { t: Math.round((Date.now() - t0) / 1000), healthMs: await health(), conns: tcpCount(), rssMb: pid ? rssMb(pid) : null, pid }; rows.push(r); appendFileSync(samples, JSON.stringify(r) + '\n'); await sleep(5000); } })();

console.log(`load test: ${routes} fake routes, cap ${cap || 'none'}, ${minutes} min, home ${home}, port ${port}`);
await Promise.all([...Array.from({ length: routes }, (_, i) => sleep(i * 400).then(() => fakeRoute(i))), sampler]);

const third = Math.floor(rows.length / 3); const H = rows.map((r) => r.healthMs);
const log = (() => { try { return readFileSync(join(home, 'daemon.log'), 'utf8').split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r?.msg === 'ws_runtime_metrics'); } catch { return []; } })();
const summary = {
  routes, cap, minutes, cycles: stat.cycles, failures: stat.failures, createMs: { p50: pct(stat.creates, 0.5), p95: pct(stat.creates, 0.95), max: Math.max(0, ...stat.creates) },
  health: { n: H.length, p50: pct(H, 0.5), p95: pct(H, 0.95), max: Math.max(...H), over1s: H.filter((x) => x > 1000).length },
  rssMb: { first: Math.round(mean(rows.slice(0, third).map((r) => r.rssMb).filter(Boolean))), last: Math.round(mean(rows.slice(-third).map((r) => r.rssMb).filter(Boolean))), max: Math.max(...rows.map((r) => r.rssMb ?? 0)) },
  conns: { first: mean(rows.slice(0, third).map((r) => r.conns)), last: mean(rows.slice(-third).map((r) => r.conns)), max: Math.max(...rows.map((r) => r.conns)) },
  daemon: { windows: log.length, eventLoopMaxMs: Math.max(0, ...log.map((r) => r.eventLoopDelay?.maxMs ?? 0)), eventLoopP99MaxMs: Math.max(0, ...log.map((r) => r.eventLoopDelay?.p99Ms ?? 0)), gitPendingPeak: Math.max(0, ...log.map((r) => r.git?.commands?.peakPending ?? 0)), activeWorkspaces: log.at(-1)?.git?.workspaceService?.workspaceTargetCount ?? null },
};
writeFileSync(out, JSON.stringify(summary, null, 1)); console.log(JSON.stringify(summary));
