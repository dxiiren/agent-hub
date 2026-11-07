// Patches the installed Paseo daemon (its own server files, not the web bundle) with the small edit list in patches/paseo-<version>/server-files.json:
// a daemon-wide cap on provider probes (4 at once) and a one-line error for a failed probe. Same safety as scripts/paseo-web-patch.mjs:
//  - only when the installed @getpaseo/server version AND every target file's sha256 match the spec; anything else: skip with a warning, nothing touched
//  - all edits are computed first; a file is written only when every edit of every file matched exactly once
//  - the original of each file is kept as <file>.agent-hub-orig; `restore` puts it back
//  - idempotent: a file carrying the marker /*agent-hub-server-rev:N*/ is left alone; an older rev is re-applied from the original
// Needs a daemon restart to take effect. Usage: node scripts/paseo-server-patch.mjs apply|status|restore [--quiet]
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findServerDir } from './paseo-web-patch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ORIG = '.agent-hub-orig';

export function loadServerSpec(version, dir = join(REPO, 'patches', `paseo-${version}`)) {
  const f = join(dir, 'server-files.json');
  if (!existsSync(f)) return null;
  const spec = JSON.parse(readFileSync(f, 'utf8'));
  for (const file of spec.files) for (const e of file.edits) if (e.replaceFile) e.replace = (e.prepend ?? '') + readFileSync(join(dir, e.replaceFile), 'utf8').trimEnd();
  return spec;
}

/** @returns {{state:'patched'|'applied'|'unpatched'|'skipped'|'restored', reason?:string}} */
export function runServerPatch(action, { serverDir = findServerDir(), spec } = {}) {
  if (!serverDir || !existsSync(join(serverDir, 'package.json'))) return { state: 'skipped', reason: 'Paseo server package not found' };
  const version = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')).version;
  spec ??= loadServerSpec(version);
  if (!spec || spec.paseo !== version) return { state: 'skipped', reason: `no server patch for Paseo ${version} (patches/paseo-${version}/server-files.json)` };
  const mark = `/*agent-hub-server-rev:${spec.rev}*/`;
  const files = spec.files.map((f) => ({ ...f, abs: join(serverDir, f.path) }));
  if (files.some((f) => !existsSync(f.abs))) return { state: 'skipped', reason: 'a target file is missing in this Paseo install' };
  const live = files.map((f) => readFileSync(f.abs, 'utf8'));
  const patchedNow = live.every((t) => t.includes(mark));
  const anyPatched = live.some((t) => /\/\*agent-hub-server-rev:\d+\*\//.test(t));
  if (action === 'status') return { state: patchedNow ? 'patched' : 'unpatched' };
  if (action === 'restore') {
    if (!anyPatched) return { state: 'unpatched' };
    for (const f of files) if (existsSync(f.abs + ORIG)) copyFileSync(f.abs + ORIG, f.abs);
    return { state: 'restored' };
  }
  if (patchedNow) return { state: 'patched' };
  // an older revision is live: start from the untouched original
  const srcs = files.map((f, i) => (existsSync(f.abs + ORIG) && /\/\*agent-hub-server-rev:\d+\*\//.test(live[i]) ? readFileSync(f.abs + ORIG) : Buffer.from(live[i], 'utf8')));
  const out = [];
  for (const [i, f] of files.entries()) {
    if (sha(srcs[i]) !== f.sha256) return { state: 'skipped', reason: `${f.path} of this Paseo ${version} install differs from the one the patch was written for (sha256 ${sha(srcs[i]).slice(0, 12)}...); not patched` };
    let text = srcs[i].toString('utf8');
    for (const e of f.edits) {
      const n = text.split(e.find).length - 1;
      if (n !== 1) return { state: 'skipped', reason: `edit "${e.name}" matches ${n} times (needs exactly 1); not patched` };
      text = text.replace(e.find, () => e.replace);
    }
    out.push(text);
  }
  for (const [i, f] of files.entries()) {
    if (!existsSync(f.abs + ORIG)) copyFileSync(f.abs, f.abs + ORIG);
    writeFileSync(f.abs, out[i]);
  }
  return { state: 'applied' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [action = 'status'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const quiet = process.argv.includes('--quiet');
  let r;
  try { r = runServerPatch(action); } catch (e) { r = { state: 'skipped', reason: e.message }; }
  if (!(quiet && (r.state === 'patched' || r.state === 'unpatched'))) console.log(`${r.state === 'skipped' ? 'WARN' : 'OK  '} paseo server patch: ${r.state}${r.reason ? ` - ${r.reason}` : ''}${r.state === 'applied' ? ' (restart the daemon to load it)' : ''}`);
  process.exit(0);
}
