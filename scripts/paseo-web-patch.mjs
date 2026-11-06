// Puts the Agent Hub provider kinds into Paseo's own Settings > Providers > "Add provider" list.
// Paseo 0.15.2 bakes that list into its web bundle and has no plugin hook for it (docs/paseo-upstream-notes.md), so this applies the small
// edit list in patches/paseo-<version>/web-bundle.json to the installed bundle. Safe by construction:
//  - only when the installed @getpaseo/server version AND the bundle sha256 match the patch file; anything else: skip with a warning, nothing touched
//  - the original bundle file is never modified: the patched copy gets a new content-hashed name and index.html (+ .gz/.br) points to it
//  - idempotent: an index.html that already points at a patched bundle is left alone (only the catalog JSON is rewritten)
//  - `restore` points index.html back at the original bundle
// Usage: node scripts/paseo-web-patch.mjs apply|status|restore [--quiet]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncSafe } from '../plugins/routing/spawn-safe.mjs';
import { catalogEntries } from './catalog-entries.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARK = '/*agent-hub-catalog*/';
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The installed @getpaseo/server directory (npm global root, or $PASEO_SERVER_DIR for tests/odd installs). */
export function findServerDir() {
  if (process.env.PASEO_SERVER_DIR) return process.env.PASEO_SERVER_DIR;
  const r = spawnSyncSafe('npm', ['root', '-g'], { encoding: 'utf8' });
  const root = (r.stdout || '').trim();
  const c = [join(root, '@getpaseo', 'cli', 'node_modules', '@getpaseo', 'server'), join(root, '@getpaseo', 'server')];
  return c.find((d) => existsSync(join(d, 'package.json')));
}

export function loadSpec(version, dir = join(REPO, 'patches', `paseo-${version}`)) {
  const f = join(dir, 'web-bundle.json');
  if (!existsSync(f)) return null;
  const spec = JSON.parse(readFileSync(f, 'utf8'));
  for (const e of spec.edits) if (e.replaceFile) e.replace = readFileSync(join(dirname(f), e.replaceFile), 'utf8').trimEnd(); // long edits live in their own readable file
  return spec;
}

const writeBoth = (file, buf) => { writeFileSync(file, buf); writeFileSync(`${file}.gz`, gzipSync(buf)); writeFileSync(`${file}.br`, brotliCompressSync(buf)); };
const bundleRef = (html) => (html.match(/_expo\/static\/js\/web\/index-[0-9a-f]+\.js/) || [])[0];

/** @returns {{state:'patched'|'applied'|'unpatched'|'skipped'|'restored', reason?:string}} */
export function run(action, { serverDir = findServerDir(), spec, entries = catalogEntries() } = {}) {
  if (!serverDir || !existsSync(join(serverDir, 'package.json'))) return { state: 'skipped', reason: 'Paseo server package not found' };
  const version = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')).version;
  spec ??= loadSpec(version);
  if (!spec || spec.paseo !== version) return { state: 'skipped', reason: `no patch for Paseo ${version} (patches/paseo-${version}/web-bundle.json); the provider form stays under Plugins > agent-hub-providers` };
  const ui = join(serverDir, 'dist', 'server', 'web-ui');
  const htmlFile = join(ui, 'index.html');
  if (!existsSync(htmlFile)) return { state: 'skipped', reason: 'web-ui/index.html not found (daemon started with --no-web-ui?)' };
  let html = readFileSync(htmlFile, 'utf8');
  let cur = bundleRef(html);
  if (!cur) return { state: 'skipped', reason: 'index.html names no index bundle' };
  const orig = join(ui, 'index.html.agent-hub-orig');
  const text0 = existsSync(join(ui, cur)) ? readFileSync(join(ui, cur), 'utf8') : '';
  let patchedNow = text0.includes(MARK);
  // an older patch revision is live: patch again from the untouched original bundle (a new content-hashed file), then drop the stale one
  let stale;
  if (action === 'apply' && patchedNow && spec.rev && !text0.includes(`/*agent-hub-rev:${spec.rev}*/`) && existsSync(orig)) {
    stale = cur; html = readFileSync(orig, 'utf8'); cur = bundleRef(html); patchedNow = false;
  }

  if (action === 'status') return { state: patchedNow ? 'patched' : 'unpatched' };
  if (action === 'restore') {
    if (!patchedNow || !existsSync(orig)) return { state: 'unpatched' };
    writeBoth(htmlFile, readFileSync(orig));
    rmSync(join(ui, 'agent-hub-catalog.json'), { force: true });
    return { state: 'restored' };
  }
  if (patchedNow) { writeFileSync(join(ui, 'agent-hub-catalog.json'), JSON.stringify(entries)); return { state: 'patched' }; }

  const src = join(ui, cur);
  const buf = readFileSync(src);
  if (sha(buf) !== spec.sha256 || cur !== spec.bundle) return { state: 'skipped', reason: `the web bundle of this Paseo ${version} install differs from the one the patch was written for (sha256 ${sha(buf).slice(0, 12)}...); not patched` };
  let text = buf.toString('utf8');
  for (const e of spec.edits) {
    const n = text.split(e.find).length - 1;
    if (n !== 1) return { state: 'skipped', reason: `edit "${e.name}" matches ${n} times (needs exactly 1); not patched` };
    text = text.replace(e.find, () => e.replace);
  }
  const out = Buffer.from(text, 'utf8');
  const name = `${cur.slice(0, cur.lastIndexOf('-') + 1)}${sha(out).slice(0, 32)}.js`;
  writeBoth(join(ui, name), out);
  if (!existsSync(orig)) copyFileSync(htmlFile, orig);
  writeFileSync(join(ui, 'agent-hub-catalog.json'), JSON.stringify(entries));
  writeBoth(htmlFile, Buffer.from(html.replace(cur, name), 'utf8'));
  if (stale) for (const x of ['', '.gz', '.br']) rmSync(join(ui, stale + x), { force: true });
  return { state: 'applied' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [action = 'status'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const quiet = process.argv.includes('--quiet');
  let r;
  try { r = run(action); } catch (e) { r = { state: 'skipped', reason: e.message }; }
  if (!(quiet && (r.state === 'patched' || r.state === 'unpatched'))) console.log(`${r.state === 'skipped' ? 'WARN' : 'OK  '} paseo web patch: ${r.state}${r.reason ? ` - ${r.reason}` : ''}`);
  process.exit(0); // never blocks `just up`
}
