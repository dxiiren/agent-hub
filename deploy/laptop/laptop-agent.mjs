// Laptop model launcher for the Paseo provider "qwen-laptop": cheap pre-flight, then `qwen --acp`; llama-server (once) is
// started only when the first prompt arrives, so Paseo's status probe (initialize only) never loads the model.
// Refuses with exit 3 and the reason on stderr so the router falls back to the office model.
//   node laptop-agent.mjs --check        pre-flight only (used by `just doctor`)
// Env: LLAMA_SERVER_BIN, LAPTOP_MODEL_PATH, QWEN_BIN (required); HEAVY_LOCK_GLOB, LAPTOP_PORT (8089), LAPTOP_CTX (65536: Qwen Code passed 4/10 hard edits at 64k against 1/10 at 32k; 7.5 GB of the 8 GB card),
//      LAPTOP_MIN_FREE_GB (3), LAPTOP_ALIAS (qwen35-9b), LAPTOP_DEVICE (CUDA0; a non-CUDA device skips the NVIDIA guard), LAPTOP_IDLE_MIN (15, read by the reaper).
// Normally started by a provider of kind `local-llama` (scripts/provider-kinds.mjs), which sets this env.
import { spawnSafe } from '../../plugins/routing/spawn-safe.mjs';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { freemem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { firstId, qwenEnv, takeReadOnlyFlag, scrubKeyEnv } from '../../plugins/routing/office.mjs';
import { modeProxy } from '../../plugins/routing/acp-proxy.mjs';
import { runDir } from '../../plugins/routing/runstate.mjs';
import { judge, pnpStatus, smi, listenerPid, cpuSeconds, stopPid, readOwn, writeOwn, ownedStopTarget, idleExpired, modelMatches, markInflight, clearInflight, anyInflight, sharedIdle, cpuJudgeable, llamaArgs, startRefusal, spawnOrphan, ensureReaper, ownRecord } from './gpu-guard.mjs';

const READ_ONLY = takeReadOnlyFlag(process.argv); // legacy "-ro" twin entry: read-only from the start
const E = process.env;
const PORT = E.LAPTOP_PORT || '8089';
const ALIAS = E.LAPTOP_ALIAS || 'qwen35-9b';
const DEVICE = E.LAPTOP_DEVICE || 'CUDA0';
const NV = /^cuda/i.test(DEVICE); // the pnp/nvidia-smi guard only applies to an NVIDIA device
const LOCK = join(runDir(), `agent-hub-laptop-${PORT}.lock`);
const refuse = (m) => { process.stderr.write(`LAPTOP-REFUSED: ${m}\n`); process.exit(3); };
const up = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
// any HTTP answer (503 while the model loads) means a server already owns the port: never start a second one
const listening = async () => { try { await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; } };
const touch = () => { const o = readOwn(PORT); if (o) writeOwn(PORT, { ...o, lastUsed: Date.now() }); if (inflight > 0) markInflight(PORT); else clearInflight(PORT); };
const REAPER = join(dirname(fileURLToPath(import.meta.url)), 'laptop-reaper.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pnp = NV ? pnpStatus() : 'OK';
if (pnp !== 'OK') refuse(`GPU missing -> provider disabled (NVIDIA PnP status ${pnp})`);
const gpu = NV ? smi() : { ok: true, usedMiB: 0, apps: [] };
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
  if (await up()) { await checkServed(); ensureReaper(PORT, REAPER); return; } // a server we own that runs without a reaper (its reaper died) gets a new one
  // one starter at a time: three parallel callers once started six servers without this lock
  if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > 180000) unlinkSync(LOCK);
  let owner = true;
  try { if (existsSync(LOCK) && lstatSync(LOCK).isSymbolicLink()) unlinkSync(LOCK); closeSync(openSync(LOCK, 'wx', 0o600)); } catch { owner = false; }
  try {
    if (owner && !(await listening())) {
      const g = NV ? smi() : null;
      const why = g ? startRefusal({ pnp: pnpStatus(), smiOk: g.ok, usedMiB: g.usedMiB }, Number(E.LAPTOP_BUSY_MIB || 600)) : '';
      if (why) throw new Error(why);
      // outside the launcher's process tree: Paseo's tree kill of an archived/timed-out agent must not take the model server (or its reaper) with it
      const pid = spawnOrphan(E.LLAMA_SERVER_BIN, llamaArgs({ model: E.LAPTOP_MODEL_PATH, ctx: E.LAPTOP_CTX, port: PORT, alias: ALIAS, device: DEVICE }));
      if (!pid) throw new Error('llama-server did not start');
      writeOwn(PORT, ownRecord(pid, E.LLAMA_SERVER_BIN)); // only this pid is ever stopped by the hub
      spawnOrphan(process.execPath, [REAPER, PORT]);
    }
    for (let i = 0; i < 90; i++) { if (await up()) { ensureReaper(PORT, REAPER); return; } await sleep(2000); }
    throw new Error('llama-server did not start');
  } finally { if (owner && existsSync(LOCK)) unlinkSync(LOCK); }
}

// Use the model id llama-server actually serves (GET /v1/models) when it is already up; else the alias it will be started with.
let model = ALIAS;
if (await up()) { try { model = await checkServed(); } catch (e) { refuse(e.message); } }
const spawnQwen = (ro) => spawnSafe(E.QWEN_BIN, ['--acp', '--auth-type', 'openai', '--openai-base-url', `http://127.0.0.1:${PORT}/v1`, '--openai-api-key', 'none', '--model', model, ...process.argv.slice(2)], { stdio: ['pipe', 'pipe', 'inherit'], env: scrubKeyEnv(qwenEnv(E, ro)) });
// ACP proxy (offers the mode "read-only", restarts qwen with the deny settings when it is chosen); the model server starts only when the first prompt arrives.
const refuseOn = (e) => { process.stderr.write('LAPTOP-REFUSED: ' + e.message + String.fromCharCode(10)); proxy.kill(); process.exit(3); };
const proxy = modeProxy({ spawnAgent: spawnQwen, initialReadOnly: READ_ONLY,
  beforeForward: async (l) => { if (l.includes('"session/prompt"')) { inflight++; markInflight(PORT); try { await ensureServer(); } catch (e) { refuseOn(e); } touch(); } },
  onAgentLine: (d) => { const n = String(d).split('"stopReason"').length - 1; if (n) { inflight = Math.max(0, inflight - n); touch(); } } });
const child = { kill: () => proxy.kill() };
proxy.done.then((c) => { clearInflight(PORT); process.exit(c ?? 1); });
// Keep-warm clock: a turn longer than LAPTOP_IDLE_MIN must not look idle to the reaper, so refresh lastUsed while a prompt is in flight and when it ends.
let inflight = 0;
setInterval(() => { if (inflight > 0) touch(); }, 30000).unref();
// Runtime watchdog: the card can vanish after sleep while llama-server keeps running on the CPU.
let strikes = 0; let lastCpu = null; let healthSeen = false;
setInterval(() => {
  if (!NV) return;
  const listener = listenerPid(PORT);
  const own = readOwn(PORT);
  const pid = ownedStopTarget(own, listener); // a server this hub did not start is never judged or stopped
  // shared state, never this process's own clock: another agent's prompt or a model load must not look idle
  if (!healthSeen) up().then((ok) => { if (ok) healthSeen = true; });
  const now = Date.now();
  const idle = sharedIdle(own, anyInflight(PORT, now) || inflight > 0, now, 300000) && cpuJudgeable(own, healthSeen, now);
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
process.on('exit', () => clearInflight(PORT));
