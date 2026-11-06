// GPU-only guard for the laptop model (owner rule: the model must load 100% on the GPU, never on the CPU).
// Pure decision logic (judge) plus the Windows/NVIDIA probes. Used by laptop-agent.mjs (start + watchdog).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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

const win = process.platform === 'win32';
export function listenerPid(port) {
  if (!win) return parseInt(sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).stdout, 10) || null;
  const r = sh('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`]);
  return parseInt(r.stdout, 10) || null;
}

export function cpuSeconds(pid) {
  if (!win) { const t = (sh('ps', ['-o', 'time=', '-p', String(pid)]).stdout || '').trim().split(/[-:]/).map(Number).reverse(); return t.length >= 2 && !t.some(Number.isNaN) ? t[0] + 60 * t[1] + 3600 * (t[2] || 0) + 86400 * (t[3] || 0) : null; }
  const r = sh('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CPU`]);
  const v = parseFloat(r.stdout);
  return Number.isNaN(v) ? null : v;
}

/** Start a process OUTSIDE the caller's process tree and return its pid (null when it did not start). Paseo ends an agent with a tree kill (tree-kill -> `taskkill /T /F`), which walks
 *  parent-pid links: a llama-server or reaper spawned `detached` by the launcher still has the launcher as parent on Windows and died with it (an archived or timed-out agent
 *  stopped the hub's server within seconds). A short-lived middle process starts it and exits, so the child's parent is gone and no tree walk reaches it. */
export function spawnOrphan(cmd, args = []) {
  const code = "const p=require('node:child_process').spawn(process.argv[1],JSON.parse(process.argv[2]),{detached:true,stdio:'ignore',windowsHide:true});p.on('error',()=>process.exit(1));p.unref();setTimeout(()=>{process.stdout.write(String(p.pid));process.exit(0)},300)";
  const r = sh(process.execPath, ['-e', code, cmd, JSON.stringify(args)]);
  return parseInt(r.stdout, 10) || null;
}

export const stopPid = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } };

/** The llama-server command line: GPU only (every layer offloaded, one device) and NO mmap (`--load-mode none`), so the weights are not kept in system RAM.
 *  `-ot token_embd.weight=<device>` also puts the input-embedding table on the card: llama.cpp keeps it in host RAM even with -ngl 99 (546 MiB "CUDA_Host model buffer"
 *  for Qwen3.5-9B). Measured 06-11: working set 1404 -> 842 MB, same tokens/s, +546 MiB VRAM. */
export function llamaArgs({ model, ctx = '65536', port, alias, device = 'CUDA0' }) {
  return ['-m', model, '--jinja', '-ngl', '99', '-c', String(ctx), '-np', '1', '-fa', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--reasoning', 'off',
    '--temp', '0.7', '--top-p', '0.8', '--top-k', '20', '--device', device, '--load-mode', 'none', '--host', '127.0.0.1', '--port', String(port), '--alias', alias, '--metrics', '--cache-ram', '0', '-ot', `token_embd\.weight=${device}`];
}
/** Start verdict: a reason string when the server must NOT be started (GPU missing, nvidia-smi failing, GPU already used by something else), else ''. */
export function startRefusal({ pnp, smiOk, usedMiB = 0 }, busyMiB = 600) {
  if (pnp !== 'OK' || !smiOk) return 'GPU missing -> provider disabled';
  if (usedMiB > busyMiB) return `GPU busy (${usedMiB} MiB used by another process)`;
  return '';
}
/** One reaper tick: 'gone' = nothing of ours left (stop watching), 'stop' = idle past the limit (stop `pid`), 'keep' otherwise. */
export function reapStep({ own, listener, inflight, now, idleMs }) {
  const pid = ownedStopTarget(own, listener);
  if (!pid) return { act: 'gone' };
  return !inflight && idleExpired(own, now, idleMs) ? { act: 'stop', pid } : { act: 'keep' };
}

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

// ---- shared in-flight marker: one file per agent process while it has a prompt running, refreshed while it runs.
// Every process (other agents, the reaper, the watchdog) reads the same files, so none judges "idle" from its own memory.
const MARK_TTL = 150_000; // a marker not refreshed for this long belongs to a dead process
const markPrefix = (port) => `agent-hub-laptop-${port}.inflight.`;
export const markInflight = (port, pid = process.pid) => writeFileSync(join(tmpdir(), markPrefix(port) + pid), String(Date.now()));
export const clearInflight = (port, pid = process.pid) => { try { unlinkSync(join(tmpdir(), markPrefix(port) + pid)); } catch { /* already gone */ } };
export function anyInflight(port, now = Date.now(), dir = tmpdir()) {
  try { return readdirSync(dir).some((f) => f.startsWith(markPrefix(port)) && now - statSync(join(dir, f)).mtimeMs < MARK_TTL); } catch { return false; }
}
/** Truly idle = nobody has a prompt in flight and the shared lastUsed is older than idleMs. */
export const sharedIdle = (own, inflight, now, idleMs) => !inflight && now - (own?.lastUsed ?? 0) > idleMs;
/** CPU is judged only after the first /health success and 60 s after the server start (model load burns CPU). */
export const cpuJudgeable = (own, healthSeen, now) => Boolean(healthSeen) && now - (own?.startedAt ?? 0) > 60_000;
export { existsSync };
