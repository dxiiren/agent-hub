// GPU-only guard for the laptop model (owner rule: the model must load 100% on the GPU, never on the CPU).
// Pure decision logic (judge) plus the Windows/NVIDIA probes. Used by laptop-agent.mjs (start + watchdog).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, windowsHide: true });

// The NVIDIA display adapter must report PnP status OK; after a sleep the card can sit at "Unknown".
export function pnpStatus() {
  if (process.platform !== 'win32') return 'OK';
  const r = sh('powershell', ['-NoProfile', '-Command', "Get-PnpDevice -Class Display | Where-Object FriendlyName -like '*NVIDIA*' | ForEach-Object { $_.Status }"]);
  return (r.stdout || '').trim().split(/\s+/)[0] || 'Missing';
}

export function smi() {
  const g = sh('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits']);
  const usedMiB = parseInt((g.stdout || '').split(/\s/)[0], 10);
  const a = sh('nvidia-smi', ['--query-compute-apps=pid', '--format=csv,noheader']);
  return { ok: g.status === 0 && !Number.isNaN(usedMiB), usedMiB, apps: (a.stdout || '').split(/\s+/).map(Number).filter(Boolean) };
}

// in: { pnp, smiOk, usedMiB, apps[], serverPid|null, cpuPct|null, idle }. Returns a reason string, or '' when healthy.
export function judge({ pnp, smiOk, usedMiB = 0, apps = [], serverPid = null, cpuPct = null, idle = false }, cpuMax = 60) {
  if (pnp !== 'OK') return `NVIDIA device PnP status is ${pnp}, not OK`;
  if (!smiOk) return 'nvidia-smi failed';
  // WDDM may not list the pid, so "no app" only counts when no model-sized GPU memory is in use either
  if (serverPid && !apps.includes(serverPid) && usedMiB < 1000) return `llama-server pid ${serverPid} is loaded but uses no GPU memory (running on the CPU)`;
  if (serverPid && idle && cpuPct != null && cpuPct > cpuMax) return `llama-server burns ${cpuPct.toFixed(0)}% CPU while idle`;
  return '';
}

export function listenerPid(port) {
  const r = sh('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`]);
  return parseInt(r.stdout, 10) || null;
}

export function cpuSeconds(pid) {
  const r = sh('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CPU`]);
  const v = parseFloat(r.stdout);
  return Number.isNaN(v) ? null : v;
}

export const stopPid = (pid) => sh('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);

// ---- ownership: the hub only ever stops a llama-server it started itself (a benchmark's or a teammate's server on the same port is left alone)
const stateFile = (port) => join(tmpdir(), `agent-hub-laptop-${port}.json`);
export function readOwn(port) { try { return JSON.parse(readFileSync(stateFile(port), 'utf8')); } catch { return null; } }
export function writeOwn(port, own) { writeFileSync(stateFile(port), JSON.stringify(own)); }
/** Stop target: the recorded pid, and only while it is still the listener on the port. Else null (foreign server or none). */
export function ownedStopTarget(own, listener) { return own?.pid && listener === own.pid ? own.pid : null; }
/** Keep-warm: an owned server is stopped only after idleMs without a prompt. */
export function idleExpired(own, now, idleMs) { return Boolean(own?.pid) && now - (own.lastUsed ?? 0) > idleMs; }
/** Does the model id a server reports on /v1/models match the alias we start with or the model file name? */
export function modelMatches(id, alias, modelPath) {
  const strip = (x) => String(x ?? '').toLowerCase().replace(/\.gguf$/, '');
  const file = strip(String(modelPath ?? "").split(/[\\/]/).pop());
  return Boolean(id) && (strip(id) === strip(alias) || (file !== '' && strip(id) === file));
}
export { existsSync };
