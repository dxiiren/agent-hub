// The served model id ends up on a spawned command line, so anything but plain id characters is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstId, safeId, servedModel } from '../office.mjs';

test('firstId accepts normal model ids', () => {
  assert.equal(firstId({ data: [{ id: 'Qwen3.8-27B' }] }), 'Qwen3.8-27B');
  assert.equal(firstId({ data: [{ id: 'org/model:v1.2_x' }] }), 'org/model:v1.2_x');
});

test('firstId rejects ids with shell metacharacters', () => {
  for (const bad of ['x & calc', 'a"b', 'm;rm -rf', '$(id)', 'a|b', 'a b', 'x'.repeat(200)]) {
    assert.equal(firstId({ data: [{ id: bad }] }), '', bad);
  }
  assert.equal(safeId('ok-id'), 'ok-id');
});

test('servedModel falls back when the server serves an unsafe id', async () => {
  const f = async () => ({ json: async () => ({ data: [{ id: 'evil & calc.exe' }] }) });
  const id = await servedModel('http://x', { fallback: 'Qwen3.8-27B', f, file: 'nonexistent-dir/none.json', now: 1 });
  assert.equal(id, 'Qwen3.8-27B');
});
