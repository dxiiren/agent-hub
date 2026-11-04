// Laptop model launcher for the Paseo provider "qwen-laptop": cheap pre-flight, then `qwen --acp`; llama-server (once) is
// started only when the first prompt arrives, so Paseo's status probe (initialize only) never loads the model.
// Refuses with exit 3 and the reason on stderr so the router falls back to the office model.
//   node laptop-agent.mjs --check        pre-flight only (used by `just doctor`)
// Env: LLAMA_SERVER_BIN, LAPTOP_MODEL_PATH, QWEN_BIN (required); HEAVY_LOCK_GLOB, LAPTOP_PORT (8089), LAPTOP_CTX (32768),
//      LAPTOP_MIN_FREE_GB (3), LAPTOP_ALIAS (qwen35-9b).
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const E = process.env;
const PORT = E.LAPTOP_PORT || '8089';
const ALIAS = E.LAPTOP_ALIAS || 'qwen35-9b';
const LOCK = join(tmpdir(), `agent-hub-laptop-${PORT}.lock`);
const refuse = (m) => { process.stderr.write(`LAPTOP-REFUSED: ${m}\n`); process.exit(3); };
const up = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gpu = spawnSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 15000 });
const used = parseInt((gpu.stdout || '').split(/\s/)[0], 10);
if (gpu.status !== 0 || Number.isNaN(used)) refuse('GPU not visible');

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

async function ensureServer() {
  if (await up()) return;
  // one starter at a time: three parallel callers once started six servers without this lock
  if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > 180000) unlinkSync(LOCK);
  let owner = true;
  try { closeSync(openSync(LOCK, 'wx')); } catch { owner = false; }
  try {
    if (owner) {
      const u = parseInt((spawnSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 15000 }).stdout || '').split(/\s/)[0], 10);
      if (Number.isNaN(u)) throw new Error('GPU not visible');
      if (u > 600) throw new Error(`GPU busy (${u} MiB used by another process)`);
      spawn(E.LLAMA_SERVER_BIN, ['-m', E.LAPTOP_MODEL_PATH, '--jinja', '-ngl', '99', '-c', E.LAPTOP_CTX || '32768', '-np', '1', '-fa', 'on',
        '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--reasoning', 'off', '--temp', '0.7', '--top-p', '0.8', '--top-k', '20',
        '--load-mode', 'none', '--host', '127.0.0.1', '--port', PORT, '--alias', ALIAS, '--metrics'],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    for (let i = 0; i < 90; i++) { if (await up()) return; await sleep(2000); }
    throw new Error('llama-server did not start');
  } finally { if (owner && existsSync(LOCK)) unlinkSync(LOCK); }
}

const win = /\.(cmd|bat)$/i.test(E.QWEN_BIN);
const child = spawn(E.QWEN_BIN, ['--acp', '--auth-type', 'openai', '--openai-base-url', `http://127.0.0.1:${PORT}/v1`, '--openai-api-key', 'none', '--model', ALIAS, ...process.argv.slice(2)], { stdio: ['pipe', 'inherit', 'inherit'], shell: win });
child.on('exit', (c) => process.exit(c ?? 1));
// ACP is newline-delimited JSON-RPC: hold session/prompt until the model server answers /health.
let chain = Promise.resolve(); let buf = '';
const NL = String.fromCharCode(10);
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split(NL); buf = lines.pop();
  for (const l of lines) chain = chain.then(async () => { if (l.includes('"session/prompt"')) await ensureServer(); child.stdin.write(l + NL); })
    .catch((e) => { process.stderr.write('LAPTOP-REFUSED: ' + e.message + NL); child.kill(); process.exit(3); });
});
process.stdin.on('end', () => chain.then(() => child.stdin.end()));
