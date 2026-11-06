// The hermetic guard (scripts/test-guard.mjs) is what keeps `npm test` independent of the developer's own setup (verifier round D, M1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = pathToFileURL(resolve(HERE, '..', 'test-guard.mjs')).href;
const REPO = resolve(HERE, '..', '..');
const probe = (code, extra = {}) => {
  const log = join(mkdtempSync(join(tmpdir(), 'tg-')), 'v.txt'); writeFileSync(log, '');
  const r = spawnSync(process.execPath, ['--import', GUARD, '-e', code], { encoding: 'utf8', env: { ...process.env, AGENT_HUB_TEST_VIOLATIONS: log, AGENT_HUB_TEST_REAL_HOME: homedir(), ...extra } });
  return { out: (r.stdout || '').trim(), violations: readFileSync(log, 'utf8').trim() };
};
test('a read, stat or listing of the developer\'s own config/*.local.* is refused AND recorded (a swallowed error cannot hide it)', () => {
  const f = JSON.stringify(join(REPO, 'config', 'hub.local.json'));
  const r = probe(`const fs=require('fs');let c='none';try{fs.readFileSync(${f})}catch(e){c=e.code}console.log(c)`);
  assert.equal(r.out, 'EACCES'); assert.match(r.violations, /readFileSync .*hub\.local\.json/);
  assert.match(probe(`try{require('fs').existsSync(${JSON.stringify(join(REPO, 'config', 'routes', 'routes.local.json'))})}catch{}`).violations, /existsSync .*routes\.local\.json/);
});
test('the real ~/.paseo is refused too', () => {
  const r = probe(`try{require('fs').readFileSync(${JSON.stringify(join(homedir(), '.paseo', 'config.json'))})}catch{}`);
  assert.match(r.violations, /config\.json/);
});
test('templates, temp files and other repo files are untouched by the guard', () => {
  const t = join(mkdtempSync(join(tmpdir(), 'tg-ok-')), 'hub.local.json'); writeFileSync(t, '{}');
  const r = probe(`const fs=require('fs');fs.readFileSync(${JSON.stringify(join(REPO, 'config', 'hub.local.template.json'))});fs.readFileSync(${JSON.stringify(t)});console.log('ok')`);
  assert.equal(r.out, 'ok'); assert.equal(r.violations, '');
});
