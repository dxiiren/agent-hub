// Regression 05-11: the usage UI sat dead after a reboot and `just doctor` said nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { probeStack } from '../usage-stack.mjs';

test('probeStack reports a dead stack as not ok and a live one as ok', async () => {
  const s = createServer((q, r) => { r.statusCode = q.url === '/' ? 404 : 200; r.end('{}'); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const up = await probeStack({ collector: base + '/', prometheus: base + '/-/ready', grafana: base + '/api/health' });
  assert.ok(up.every((x) => x.ok), JSON.stringify(up));
  s.close(); s.closeAllConnections(); // close() alone keeps undici's pooled keep-alive socket open: the 'down' probe then reached the closed-over server and the test failed intermittently
  const down = await probeStack({ collector: base + '/', grafana: base + '/api/health' });
  assert.ok(down.every((x) => !x.ok), JSON.stringify(down));
});

test('usageMode: native on Windows, docker elsewhere, USAGE_MODE wins, junk values fall back', async () => {
  const { usageMode } = await import('../usage-stack.mjs');
  assert.equal(usageMode({}, 'win32'), 'native');
  assert.equal(usageMode({}, 'linux'), 'docker');
  assert.equal(usageMode({ USAGE_MODE: 'docker' }, 'win32'), 'docker');
  assert.equal(usageMode({ USAGE_MODE: 'NATIVE' }, 'linux'), 'native');
  assert.equal(usageMode({ USAGE_MODE: 'bogus' }, 'win32'), 'native');
});
