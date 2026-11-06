import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonStrict, writeJsonKeepEol } from '../../plugins/routing/jsonfile.mjs';
import { add, remove } from '../provider.mjs';

const BOM = String.fromCharCode(0xfeff);
const d = () => mkdtempSync(join(tmpdir(), 'ahub-json-'));
test('readJsonStrict: BOM stripped, missing = default, unparsable throws and names the file', () => {
  const t = d(); const f = join(t, 'a.json');
  assert.deepEqual(readJsonStrict(f, { x: 1 }), { x: 1 });
  writeFileSync(f, BOM + '{"keep":1}'); assert.deepEqual(readJsonStrict(f, {}), { keep: 1 });
  for (const bad of ['{"keep":', '', 'not json', '[1,', BOM + '{oops']) { writeFileSync(f, bad); assert.throws(() => readJsonStrict(f, {}), /not valid JSON/); }
});
test('writeJsonKeepEol keeps a BOM and CRLF the file had, adds neither to a new file', () => {
  const t = d(); const f = join(t, 'b.json');
  writeJsonKeepEol(f, { a: 1 }); assert.ok(!readFileSync(f, 'utf8').startsWith(BOM));
  writeFileSync(f, BOM + '{"a":1}\r\n'); writeJsonKeepEol(f, { a: 2 });
  const s = readFileSync(f, 'utf8'); assert.ok(s.startsWith(BOM)); assert.ok(s.includes('\r\n')); assert.deepEqual(JSON.parse(s.slice(1)), { a: 2 });
});
const served = async () => ({ ok: true, json: async () => ({ data: [{ id: 'm1' }] }) });
function box(files) {
  const t = d(); const p = { local: join(t, 'hub.local.json'), paseo: join(t, 'config.json'), routes: join(t, 'routes.json') };
  const def = { local: '{}', paseo: JSON.stringify({ version: 1, keep: 'me' }), routes: JSON.stringify({ routes: { summarise: ['qwen-laptop'] } }) };
  for (const k of Object.keys(def)) writeFileSync(p[k], files[k] ?? def[k]);
  return p;
}
const A = { name: 'qwen-x', url: 'http://llm.example.test:8000/v1', model: 'm1', slots: '1', routes: 'summarise' };
for (const k of ['local', 'paseo', 'routes']) for (const bad of ['{"keep": ', 'garbage', '']) {
  test(`provider add refuses an unparsable ${k} file (${JSON.stringify(bad)}) and writes nothing`, async () => {
    const p = box({ [k]: bad }); const before = Object.fromEntries(['local', 'paseo', 'routes'].map((f) => [f, readFileSync(p[f], 'utf8')]));
    await assert.rejects(add(A, p, { f: served, which: () => 'qwen' }), /not valid JSON|unreadable/);
    for (const f of Object.keys(before)) assert.equal(readFileSync(p[f], 'utf8'), before[f], f + ' untouched');
    assert.throws(() => remove('qwen-x', p), /not valid JSON|not an added provider/);
  });
}
test('provider add on BOM files works, keeps the other settings and the BOM', async () => {
  const p = box({ paseo: BOM + JSON.stringify({ version: 1, keep: 'me' }) + '\r\n' });
  await add(A, p, { f: served, which: () => 'qwen' });
  const s = readFileSync(p.paseo, 'utf8'); assert.ok(s.startsWith(BOM)); const j = JSON.parse(s.slice(1)); assert.equal(j.keep, 'me'); assert.ok(j.agents.providers['qwen-x']);
});
