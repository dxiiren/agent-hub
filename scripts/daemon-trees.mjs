// Finds every `paseo daemon run --home <home>` process tree by COMMAND LINE (paseo.pid only knows the last supervisor: on 08-11 a second tree on the same
// home, started while the first was wedged, was invisible to stop/restart). Pure functions over a process table + one bounded snapshot call.
//   node scripts/daemon-trees.mjs [list|guard|kill]    env: AGENT_HUB_HOME   (guard exits 3 when a tree is alive)
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const norm = (p) => String(p).replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const LAUNCHER = /^(node|cmd)(\.exe)?$/i;

/** Table of [{pid, ppid, name, cmd, born}] for the whole machine. Never throws. */
export function snapshotProcs({ run = spawnSync, platform = process.platform, timeoutMs = 25000 } = {}) {
  const procs = [];
  if (platform === 'win32') {
    const ps = "$ErrorActionPreference='SilentlyContinue';Get-CimInstance Win32_Process | %{ 'P|' + $_.ProcessId + '|' + $_.ParentProcessId + '|' + $_.Name + '|' + $(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}) + '|' + $_.CommandLine }";
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true });
    for (const l of String(r.stdout || '').split(/\r?\n/)) { const f = l.split('|'); if (f[0] === 'P') procs.push({ pid: +f[1], ppid: +f[2], name: f[3], born: f[4], cmd: f.slice(5).join('|') }); }
  } else {
    const r = run('ps', ['-eo', 'pid=,ppid=,lstart=,args='], { encoding: 'utf8', timeout: timeoutMs });
    for (const l of String(r.stdout || '').split('\n')) { const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d+)\s+(.*)$/.exec(l); if (m) procs.push({ pid: +m[1], ppid: +m[2], name: m[4].split(/\s+/)[0].split('/').pop(), born: new Date(m[3]).toISOString(), cmd: m[4] }); }
  }
  return procs;
}

/** Trees whose root is a node/cmd process running `daemon run --home <home>` (any wrapper level), with all descendants. `self` and its ancestors are never included. -> {roots, pids} */
export function findDaemonTrees(procs, home, { self = process.pid } = {}) {
  const want = norm(home), byPid = new Map(procs.map((p) => [p.pid, p]));
  const keep = new Set(); for (let p = self, i = 0; p && byPid.has(p) && i < 20; i++) { keep.add(p); p = byPid.get(p).ppid; }
  const isRoot = (p) => LAUNCHER.test(p.name || '') && /\bdaemon\s+run\b/.test(p.cmd) && (() => { const m = /--home[ =]+("[^"]+"|'[^']+'|\S+)/.exec(p.cmd); return m && norm(m[1]) === want; })();
  const matched = new Set(procs.filter((p) => isRoot(p) && !keep.has(p.pid)).map((p) => p.pid));
  const roots = [...matched].filter((pid) => !matched.has(byPid.get(pid).ppid));
  const pids = new Set(roots), kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
  const walk = (pid) => { for (const c of kids.get(pid) ?? []) if (!pids.has(c) && !keep.has(c)) { pids.add(c); walk(c); } };
  for (const r of roots) walk(r);
  for (const m of matched) pids.add(m);
  return { roots, pids: [...pids] };
}

/** paseo-server-patch.mjs helpers whose parent no longer exists (the 08-11 helper hung 11 min after its caller died). */
export function orphanPatchHelpers(procs) {
  const alive = new Set(procs.map((p) => p.pid));
  return procs.filter((p) => /paseo-server-patch\.mjs/.test(p.cmd) && LAUNCHER.test(p.name || '') && !alive.has(p.ppid)).map((p) => p.pid);
}

/** Earliest start (ms) among the pids, or null. */
export function oldestStart(procs, pids) {
  const t = procs.filter((p) => pids.includes(p.pid) && p.born).map((p) => Date.parse(p.born)).filter(Number.isFinite);
  return t.length ? Math.min(...t) : null;
}

/** Stops exact pids, newest first. -> {killed, failed} */
export function killPids(pids, kill = (pid) => process.kill(pid, 'SIGKILL')) {
  const killed = [], failed = [];
  for (const pid of [...pids].sort((a, b) => b - a)) { try { kill(pid); killed.push(pid); } catch (e) { if (e.code !== 'ESRCH') failed.push(pid); } }
  return { killed, failed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const home = resolve(process.env.AGENT_HUB_HOME || join(homedir(), '.paseo')); const cmd = process.argv[2] || 'list';
  const procs = snapshotProcs(); const t = findDaemonTrees(procs, home); const orphans = orphanPatchHelpers(procs);
  if (cmd === 'kill') { const r = killPids([...t.pids, ...orphans]); console.log(`killed ${r.killed.join(',') || '-'}${r.failed.length ? ` FAILED ${r.failed.join(',')}` : ''}`); process.exit(r.failed.length ? 1 : 0); }
  console.log(t.pids.length ? `daemon tree pids for ${home}: ${t.pids.join(', ')} (roots ${t.roots.join(', ')})` : `no daemon tree for ${home}`);
  process.exit(cmd === 'guard' && t.pids.length ? 3 : 0);
}
