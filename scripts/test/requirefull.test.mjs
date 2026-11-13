// A missing gitleaks skips 9 suites on a developer clone, but a strict run (AGENT_HUB_REQUIRE_FULL=1, or CI set) must FAIL, loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { strictRun } from '../test-env.mjs';

test('strictRun: REQUIRE_FULL=1 or CI, unless REQUIRE_FULL=0', () => {
  assert.equal(strictRun({}), false);
  assert.equal(strictRun({ AGENT_HUB_REQUIRE_FULL: '1' }), true);
  assert.equal(strictRun({ CI: 'true' }), true);
  assert.equal(strictRun({ CI: 'true', AGENT_HUB_REQUIRE_FULL: '0' }), false);
});
test('node-tests.mjs exits 1 with FAIL when gitleaks is missing and the run is strict, and does not when it is not strict', () => {
  const env = (x) => ({ ...process.env, AGENT_HUB_GITLEAKS: 'no-such-gitleaks-binary-xyz', AGENT_HUB_REQUIRE_FULL: '', CI: '', ...x });
  const strict = spawnSync(process.execPath, ['scripts/node-tests.mjs'], { env: env({ CI: '1' }), encoding: 'utf8' });
  assert.equal(strict.status, 1); assert.match(strict.stdout, /FAIL: strict run/);
  const lax = spawnSync(process.execPath, ['-e', 'import("./scripts/test-env.mjs").then(m=>process.exit(m.strictRun()?1:0))'], { env: env({}) });
  assert.equal(lax.status, 0);
});
