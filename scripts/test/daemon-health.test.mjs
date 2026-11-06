import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as http } from 'node:http';
import { createServer as tcp } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeDaemon, daemonAdvice } from '../daemon-health.mjs';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'hub.mjs');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const freePort = async () => { const s = tcp(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; };
/** A "hung daemon": accepts the connection and never answers. */
const hung = () => { const socks = new Set(); const s = tcp((c) => { socks.add(c); c.on('error', () => {}); }); s.closeAll = () => { for (const c of socks) c.destroy(); return new Promise((r) => s.close(r)); }; return s; };

test('probeDaemon: up / sick / hung (port open, no answer) / down (refused)', async () => {
  const ok = http((q, r) => r.end('{}')); const sick = http((q, r) => { r.statusCode = 503; r.end('x'); }); const h = hung();
  const [pOk, pSick, pHung] = [await listen(ok), await listen(sick), await listen(h)];
  try {
    assert.equal((await probeDaemon(pOk, { timeoutMs: 1000 })).state, 'up');
    assert.equal((await probeDaemon(pSick, { timeoutMs: 1000 })).state, 'sick');
    const hp = await probeDaemon(pHung, { timeoutMs: 300, attempts: 2, backoffMs: 10 });
    assert.equal(hp.state, 'hung'); assert.match(daemonAdvice(hp), /HUNG.*#8244.*restart/s);
    const dp = await probeDaemon(await freePort(), { timeoutMs: 1000 });
    assert.equal(dp.state, 'down'); assert.match(daemonAdvice(dp), /just up/);
  } finally { ok.close(); sick.close(); await h.closeAll(); }
});

test('doctor says HUNG, not "down", and exits 1 when the daemon accepts connections but never answers', async () => {
  const h = hung(); const port = await listen(h);
  try {
    const env = { ...process.env, AGENT_HUB_PORT: String(port), AGENT_HUB_HEALTH_MS: '400', AGENT_HUB_HOME: mkdtempSync(join(tmpdir(), 'ahub-doc-')), AGENT_HUB_NO_USAGE_STACK: '1' };
    const r = await new Promise((res) => { const p = spawn(process.execPath, [HUB, 'doctor'], { env }); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; }); p.on('exit', (c) => res({ c, o })); });
    assert.equal(r.c, 1, r.o); assert.match(r.o, /FAIL\s+daemon health/); assert.match(r.o, /daemon is HUNG/); assert.doesNotMatch(r.o, /daemon is down/);
  } finally { await h.closeAll(); }
});

test('probeDaemon: one missed window followed by an answer is up, not hung (busy daemon)', async () => {
  let n = 0;
  const f = async (u, { signal }) => { if (n++ === 0) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); return { status: 200, text: async () => '{}' }; };
  assert.equal((await probeDaemon(1, { fetchFn: f, backoffMs: 5 })).state, 'up');
  assert.equal(n, 2);
});
