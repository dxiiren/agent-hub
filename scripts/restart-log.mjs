// Who asked for this daemon start/stop? `just up` / `just down` (service.ps1 / service.sh) call this before acting; one line per request goes to
// <home>/restart-requests.log: time, action, the requester's process chain (pid name command, secrets blanked). Paseo's own daemon.log only names the
// client id of a shutdown RPC (cid_...), which is what made three unexplained restarts untraceable. Never fails the caller.
//   node scripts/restart-log.mjs <start|stop> [reason...]      (env AGENT_HUB_REASON adds a free-text reason; AGENT_HUB_HOME = the Paseo home)
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SECRET = /((?:pass(?:word)?|token|secret|key|auth)[\w-]*[=:\s]+)\S+/gi;
export const scrub = (s) => String(s ?? '').replace(SECRET, '$1***').replace(/\s+/g, ' ').trim().slice(0, 200);

/** [{pid, name, cmd}] from `pid` upwards, at most `max` levels. */
export function ancestry(pid = process.pid, max = 6) {
  if (process.platform === 'win32') {
    const ps = `$p=${pid};1..${max}|%{$x=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -EA 0;if(!$x){return};"$($x.ProcessId)|$($x.Name)|$($x.CommandLine)";$p=$x.ParentProcessId}`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15000 });
    return (r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => { const [p, n, ...c] = l.split('|'); return { pid: +p, name: n, cmd: c.join('|') }; });
  }
  const out = []; let p = pid;
  for (let i = 0; i < max && p > 0; i++) {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'utf8'); const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      out.push({ pid: p, name, cmd: readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').join(' ') });
      p = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
    } catch { break; }
  }
  return out;
}

export function logRequest(action, reason = '', { home = process.env.AGENT_HUB_HOME || join(homedir(), '.paseo'), chain = ancestry(), now = new Date() } = {}) {
  const file = join(resolve(home), 'restart-requests.log');
  const line = `${now.toISOString()} ${action}${reason ? ` reason="${scrub(reason)}"` : ''} by ${chain.map((c) => `${c.pid}:${c.name} [${scrub(c.cmd)}]`).join(' <- ') || 'unknown'}\n`;
  mkdirSync(resolve(home), { recursive: true });
  try { if (statSync(file).size > 200_000) writeFileSync(file, readFileSync(file, 'utf8').slice(-100_000)); } catch { /* no log yet */ }
  appendFileSync(file, line);
  return line;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { logRequest(process.argv[2] || 'unknown', [process.env.AGENT_HUB_REASON, ...process.argv.slice(3)].filter(Boolean).join(' ')); } catch (e) { console.error(`[WARN] restart log: ${e.message}`); }
}
