// Real-time proof that the hang watchdog recovers a hung daemon with NO manual help. Windows only, throwaway home + port + task names (never the real hub):
//   1. a real Paseo daemon on <home>:<port>, 2. the REAL scheduled task (service.ps1 watchdog-install, 1-min repetition) pointed at it, 3. the worker process is SUSPENDED
//   (NtSuspendProcess: the port stays open, nothing answers = the 08-11 hang), 4. we only watch /api/health until a NEW worker answers; the elapsed time must be under 5 min.
//   node scripts/watchdog-e2e.mjs --home <dir> --port 6891 [--limit-min 5]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenerPid } from './daemon-ctl.mjs';
import { paseoCommand } from '../plugins/routing/route.mjs';

if (process.platform !== 'win32') { console.log('SKIP: Windows only (Task Scheduler + NtSuspendProcess)'); process.exit(0); }
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const home = resolve(arg('--home')), port = Number(arg('--port', 6891)), limitMin = Number(arg('--limit-min', 5));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'), svc = join(repo, 'deploy', 'service', 'service.ps1');
const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_PORT: String(port), AGENT_HUB_TASK: 'AgentHubE2ENone', AGENT_HUB_WATCHDOG_TASK: 'AgentHubWatchdogE2E', AGENT_HUB_WATCHDOG_TIMEOUT_MS: '5000', AGENT_HUB_NO_USAGE_STACK: '1', AGENT_HUB_NO_WEB_PATCH: '1', AGENT_HUB_NO_SERVER_PATCH: '1' };
const ps = (cmd, ms = 60000) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: ms, env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async (ms = 4000) => { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(ms) }); await r.text(); return r.status; } catch (e) { return e?.name === 'TimeoutError' ? 'hung' : 'down'; } };
const stamp = () => new Date().toISOString().slice(11, 19);
let ok = false;
try {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, daemon: { listen: `127.0.0.1:${port}`, mcp: { enabled: false }, relay: { enabled: false } } }));
  console.log(`${stamp()} starting a real daemon on ${home} :${port}`);
  { const [pc, ...pa] = paseoCommand(); spawnSync(pc, [...pa, 'daemon', 'start', '--home', home, '--timeout', '120'], { encoding: 'utf8', timeout: 150000 }); } // the shim's node entry, never a shell
  if ((await health()) !== 200) throw new Error('test daemon did not come up');
  const worker = listenerPid(port); console.log(`${stamp()} worker pid ${worker}, health 200`);
  const inst = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', svc, 'watchdog-install'], { encoding: 'utf8', timeout: 60000, env }); console.log(`${stamp()} ${String(inst.stdout).trim()}`);
  await sleep(2000);
  const sus = ps(`Add-Type -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);' -Name N -Namespace W; [W.N]::NtSuspendProcess((Get-Process -Id ${worker}).Handle)`);
  const t0 = Date.now(); console.log(`${stamp()} worker ${worker} SUSPENDED (NtSuspendProcess -> ${String(sus.stdout).trim() || sus.stderr.slice(0, 100)}); health now: ${await health()}`);
  let last = '';
  while (Date.now() - t0 < limitMin * 60_000) {
    const h = await health(); const pid = listenerPid(port); const line = `health=${h} holder=${pid}`;
    if (line !== last) { console.log(`${stamp()} +${Math.round((Date.now() - t0) / 1000)}s ${line}`); last = line; }
    if (h === 200 && pid && pid !== worker) { ok = true; console.log(`RECOVERED in ${Math.round((Date.now() - t0) / 1000)} s with no manual help (new worker ${pid}, limit ${limitMin} min)`); break; }
    await sleep(5000);
  }
  if (!ok) console.log(`FAILED: no recovery within ${limitMin} min`);
  for (const f of ['watchdog.log', 'restart-requests.log', 'watchdog-evidence.log']) { const p = join(home, f); if (existsSync(p)) console.log(`--- ${f}\n${readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => !/^  \d+ <-/.test(l)).slice(-8).join('\n').slice(0, 1800)}`); }
} finally {
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', svc, 'watchdog-uninstall'], { encoding: 'utf8', timeout: 60000, env });
  const pid = listenerPid(port); const rec = (() => { try { return JSON.parse(readFileSync(join(home, 'paseo.pid'), 'utf8')).pid; } catch { return null; } })();
  for (const p of [rec, pid]) if (p) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
}
process.exit(ok ? 0 : 1);
