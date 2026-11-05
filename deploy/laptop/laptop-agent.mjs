// Laptop model launcher for the Paseo provider "qwen-laptop": cheap pre-flight, then `qwen --acp`; llama-server (once) is
// started only when the first prompt arrives, so Paseo's status probe (initialize only) never loads the model.
// Refuses with exit 3 and the reason on stderr so the router falls back to the office model.
//   node laptop-agent.mjs --check        pre-flight only (used by `just doctor`)
// Env: LLAMA_SERVER_BIN, LAPTOP_MODEL_PATH, QWEN_BIN (required); HEAVY_LOCK_GLOB, LAPTOP_PORT (8089), LAPTOP_CTX (65536: Qwen Code passed 4/10 hard edits at 64k against 1/10 at 32k; 7.5 GB of the 8 GB card),
//      LAPTOP_MIN_FREE_GB (3), LAPTOP_ALIAS (qwen35-9b).
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { firstId } from '../../plugins/routing/office.mjs';
import { judge, pnpStatus, smi, listenerPid, cpuSeconds, stopPid, readOwn, writeOwn, ownedStopTarget, idleExpired, modelMatches } from './gpu-guard.mjs';

const E = process.env;
const PORT = E.LAPTOP_PORT || '8089';
const ALIAS = E.LAPTOP_ALIAS || 'qwen35-9b';
const LOCK = join(tmpdir(), `agent-hub-laptop-${PORT}.lock`);
const refuse = (m) => { process.stderr.write(`LAPTOP-REFUSED: ${m}\n`); process.exit(3); };
const up = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
// any HTTP answer (503 while the model loads) means a server already owns the port: never start a second one
const listening = async () => { try { await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; } };
const touch = () => { const o = readOwn(PORT); if (o) writeOwn(PORT, { ...o, lastUsed: Date.now() }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pnp = pnpStatus();
if (pnp !== 'OK') refuse(`GPU missing -> provider disabled (NVIDIA PnP status ${pnp})`);
const gpu = smi();
const used = gpu.usedMiB;
if (!gpu.ok) refuse('GPU missing -> provider disabled (nvidia-smi fails)');

if (E.HEAVY_LOCK_GLOB) {
  const dir = dirname(E.HEAVY_LOCK_GLOB);
  const [pre, post = ''] = basename(E.HEAVY_LOCK_GLOB).split('*'); // one * wildcard is enough for heavy-run-*.lock
  if (existsSync(dir) && readdirSync(dir).some((f) => f.startsWith(pre) && f.endsWith(post))) refuse('heavy-run lock present');
}

const serverUp0 = await up();
const freeGb = freemem() / 2 ** 30;
if (!serverUp0 && freeGb < Number(E.LAPTOP_MIN_FREE_GB || 3)) refuse(`free RAM ${freeGb.toFixed(1)} GB < ${E.LAPTOP_MIN_FREE_GB || 3}`);
if (process.argv.includes('--check')) { console.log(`laptop pre-flight ok (GPU used ${used} MiB, free RAM ${freeGb.toFixed(1)} GB, server ${serverUp0 ? 'up' : 'not started'})`); process.exit(0); }
if (!E.LLAMA_SERVER_BIN || !E.LAPTOP_MODEL_PATH || !E.QWEN_BIN) refuse('LLAMA_SERVER_BIN, LAPTOP_MODEL_PATH and QWEN_BIN must be set');

// A server already on the port is reused only if it serves our model; otherwise refuse and leave it alone (never use or stop it).
async function checkServed() {
  let id = '';
  try { id = firstId(await (await fetch(`http://127.0.0.1:${PORT}/v1/models`, { signal: AbortSignal.timeout(2000) })).json()); } catch { /* unreadable: treated as a mismatch */ }
  if (!modelMatches(id, ALIAS, E.LAPTOP_MODEL_PATH)) throw new Error(`wrong model on port ${PORT} (serves "${id || 'unknown'}", expected ${ALIAS})`);
  return id;
}
async function ensureServer() {
  if (await up()) { await checkServed(); return; }
  // one starter at a time: three parallel callers once started six servers without this lock
  if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > 180000) unlinkSync(LOCK);
  let owner = true;
  try { closeSync(openSync(LOCK, 'wx')); } catch { owner = false; }
  try {
    if (owner && !(await listening())) {
      const g = smi();
      if (pnpStatus() !== 'OK' || !g.ok) throw new Error('GPU missing -> provider disabled');
      const u = g.usedMiB;
      if (u > Number(process.env.LAPTOP_BUSY_MIB || 600)) throw new Error(`GPU busy (${u} MiB used by another process)`);
      const srv = spawn(E.LLAMA_SERVER_BIN, ['-m', E.LAPTOP_MODEL_PATH, '--jinja', '-ngl', '99', '-c', E.LAPTOP_CTX || '65536', '-np', '1', '-fa', 'on',
        '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--reasoning', 'off', '--temp', '0.7', '--top-p', '0.8', '--top-k', '20',
        '--device', 'CUDA0', '--load-mode', 'none', '--host', '127.0.0.1', '--port', PORT, '--alias', ALIAS, '--metrics', '--cache-ram', '0'],
      { detached: true, stdio: 'ignore', windowsHide: true });
      srv.unref();
      writeOwn(PORT, { pid: srv.pid, startedAt: Date.now(), lastUsed: Date.now() }); // only this pid is ever stopped by the hub
      spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'laptop-reaper.mjs'), PORT], { detached: true, stdio: 'ignore', windowsHide: true, env: E }).unref();
    }
    for (let i = 0; i < 90; i++) { if (await up()) return; await sleep(2000); }
    throw new Error('llama-server did not start');
  } finally { if (owner && existsSync(LOCK)) unlinkSync(LOCK); }
}

// Use the model id llama-server actually serves (GET /v1/models) when it is already up; else the alias it will be started with.
let model = ALIAS;
if (await up()) { try { model = await checkServed(); } catch (e) { refuse(e.message); } }
const win = /\.(cmd|bat)$/i.test(E.QWEN_BIN);
const child = spawn(E.QWEN_BIN, ['--acp', '--auth-type', 'openai', '--openai-base-url', `http://127.0.0.1:${PORT}/v1`, '--openai-api-key', 'none', '--model', model, ...process.argv.slice(2)], { stdio: ['pipe', 'pipe', 'inherit'], shell: win });
child.stdout.on('data', (d) => { process.stdout.write(d); const n = String(d).split('"stopReason"').length - 1; if (n) { inflight = Math.max(0, inflight - n); touch(); } });
child.on('exit', (c) => process.exit(c ?? 1));
// Keep-warm clock: a turn longer than LAPTOP_IDLE_MIN must not look idle to the reaper, so refresh lastUsed while a prompt is in flight and when it ends.
let inflight = 0;
setInterval(() => { if (inflight > 0) touch(); }, 60000).unref();
// Runtime watchdog: the card can vanish after sleep while llama-server keeps running on the CPU.
let lastPrompt = 0; let strikes = 0; let lastCpu = null;
setInterval(() => {
  const listener = listenerPid(PORT);
  const own = readOwn(PORT);
  const pid = ownedStopTarget(own, listener); // a server this hub did not start is never judged or stopped
  const idle = Date.now() - lastPrompt > 300000;
  let cpuPct = null;
  if (pid) { const c = cpuSeconds(pid); if (c != null && lastCpu && lastCpu.pid === pid) cpuPct = ((c - lastCpu.c) / ((Date.now() - lastCpu.t) / 1000)) * 100; lastCpu = c == null ? null : { pid, c, t: Date.now() }; }
  const g = smi();
  const why = judge({ pnp: pnpStatus(), smiOk: g.ok, usedMiB: g.usedMiB, apps: g.apps, serverPid: pid, cpuPct, idle });
  strikes = why ? strikes + 1 : 0;
  // a lost card is certain after one probe; the softer signals need two in a row
  if (why && (strikes >= 2 || /PnP|nvidia-smi/.test(why))) {
    if (pid) stopPid(pid);
    process.stderr.write(`LAPTOP-REFUSED: GPU missing -> provider disabled (${why})
`);
    child.kill(); process.exit(3);
  }
}, Number(E.LAPTOP_WATCHDOG_MS || 15000)).unref();
// ACP is newline-delimited JSON-RPC: hold session/prompt until the model server answers /health.
let chain = Promise.resolve(); let buf = '';
const NL = String.fromCharCode(10);
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split(NL); buf = lines.pop();
  for (const l of lines) chain = chain.then(async () => { if (l.includes('"session/prompt"')) { lastPrompt = Date.now(); inflight++; await ensureServer(); touch(); } child.stdin.write(l + NL); })
    .catch((e) => { process.stderr.write('LAPTOP-REFUSED: ' + e.message + NL); child.kill(); process.exit(3); });
});
process.stdin.on('end', () => chain.then(() => child.stdin.end()));
