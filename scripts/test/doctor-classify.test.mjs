import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFailure, agentLastError } from '../doctor-classify.mjs';
import { removeDoctorDir, cleanDoctorLeftovers } from '../../plugins/routing/cleanup.mjs';

test('classifyFailure: quota and expired login are environment, anything else (or nothing) is a real failure', () => {
  const q = classifyFailure("You've hit your usage limit. Upgrade to Pro or try again at 4:04 AM.");
  assert.equal(q.kind, 'quota'); assert.match(q.reason, /usage limit.*4:04 AM/);
  assert.equal(classifyFailure('429 Too Many Requests, rate limit reached').kind, 'quota');
  assert.equal(classifyFailure('Not logged in. Please log in again.').kind, 'auth');
  assert.equal(classifyFailure('401 Unauthorized').kind, 'auth');
  assert.equal(classifyFailure('spawn ENOENT: codex not found').kind, 'real');
  assert.equal(classifyFailure('ACP agent process exited before initialization completed (exit code 1)').kind, 'real');
  assert.equal(classifyFailure('').kind, 'real');
});
test('agentLastError reads Paseo\'s record for the agent and repairs the Latin-1 apostrophe', () => {
  const home = mkdtempSync(join(tmpdir(), 'dc-home-')); mkdirSync(join(home, 'agents', 'proj-a'), { recursive: true });
  writeFileSync(join(home, 'agents', 'proj-a', 'abc.json'), JSON.stringify({ lastError: 'You\u00e2\u20ac\u2122ve hit your usage limit' }));
  assert.equal(agentLastError(home, 'abc'), "You've hit your usage limit");
  assert.equal(agentLastError(home, 'nope'), ''); assert.equal(agentLastError(join(home, 'missing'), 'abc'), '');
});
const fakePaseo = (projects) => { const calls = []; return { calls, p: (a) => { calls.push(a.join(' ')); return a[0] === 'project' && a[1] === 'ls' ? projects : {}; } }; };
test('removeDoctorDir deletes its own project and the folder; refuses a folder that is not a hub-doctor temp dir', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'dc-')), '..', 'hub-doctor-Ab3dEf'); mkdirSync(dir, { recursive: true });
  const f = fakePaseo([{ projectId: 'prj_1', name: 'hub-doctor-Ab3dEf', path: dir }, { projectId: 'prj_2', name: 'other', path: tmpdir() }]);
  const r = removeDoctorDir(dir, f.p, { sleep: () => {} });
  assert.deepEqual(r, { projects: 1, removed: true }); assert.equal(existsSync(dir), false);
  assert.deepEqual(f.calls.filter((c) => c.includes('delete')), ['project delete prj_1']);
  const keep = mkdtempSync(join(tmpdir(), 'dc-keep-'));
  assert.equal(removeDoctorDir(keep, fakePaseo([]).p).removed, false); assert.equal(existsSync(keep), true);
});
test('cleanDoctorLeftovers removes only hub-doctor-XXXXXX folders and projects; dry run changes nothing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dc-tmp-'));
  for (const n of ['hub-doctor-aaaaaa', 'hub-doctor-bbbbbb', 'hub-doctor-x', 'keepme']) mkdirSync(join(tmp, n));
  const pr = [{ projectId: 'prj_1', name: 'hub-doctor-zzzzzz', path: join(tmpdir(), 'hub-doctor-zzzzzz') }, { projectId: 'prj_2', name: 'mine', path: join(tmpdir(), 'mine') }];
  const dry = fakePaseo(pr); assert.deepEqual(cleanDoctorLeftovers({ paseo: dry.p, dry: true, tmp }), { dirs: 2, projects: 1 });
  assert.equal(readdirSync(tmp).length, 4); assert.equal(dry.calls.filter((c) => c.includes('delete')).length, 0);
  const live = fakePaseo(pr); assert.deepEqual(cleanDoctorLeftovers({ paseo: live.p, tmp }), { dirs: 2, projects: 1 });
  assert.deepEqual(readdirSync(tmp).sort(), ['hub-doctor-x', 'keepme']); assert.deepEqual(live.calls.filter((c) => c.includes('delete')), ['project delete prj_1']);
});
