// A temp PASEO_HOME / AGENT_HUB_HOME must never make provider/migrate write the clone's own config/*.local.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../provider.mjs';

const tmp = join(tmpdir(), 'agent-hub-homeguard');
test('a home other than ~/.paseo without AGENT_HUB_NO_LOCAL is refused', () => {
  assert.throws(() => paths({ AGENT_HUB_HOME: tmp }), /REFUSED/);
  assert.throws(() => paths({ PASEO_HOME: tmp }), /REFUSED/);
});
test('AGENT_HUB_NO_LOCAL=1 keeps the files inside the temp home', () => {
  const p = paths({ AGENT_HUB_HOME: tmp, AGENT_HUB_NO_LOCAL: '1' });
  assert.ok(p.local.startsWith(tmp) && p.routes.startsWith(tmp));
});
test('explicit AGENT_HUB_LOCAL + AGENT_HUB_ROUTES (hermetic tests) are allowed', () => {
  const p = paths({ AGENT_HUB_HOME: tmp, AGENT_HUB_LOCAL: join(tmp, 'l.json'), AGENT_HUB_ROUTES: join(tmp, 'r.json') });
  assert.equal(p.local, join(tmp, 'l.json'));
});
test('the default home is accepted', () => {
  assert.doesNotThrow(() => paths({}));
});
