// Paseo bundles each plugin ALONE (compiler-build.js): modules only from client/, server/ or shared/ of that plugin, and no import
// that leaves the plugin folder. 8c6ab3a: usage-otel imported ../../routing/acp-proxy.mjs, the plugin failed to build and Settings > Usage lost its cards.
// (1) static import-graph check of every plugin (always runs); (2) Paseo's own compiler on every plugin when it is installed (npm root -g, or PASEO_SERVER_DIR).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const PLUGINS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins');
const plugins = readdirSync(PLUGINS).filter((d) => existsSync(join(PLUGINS, d, 'paseo-plugin.json')));
const ENTRY = /^index\.(client|server)\.tsx?$/;
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
const EXTS = ['', '.ts', '.tsx', '.mjs', '.js', '.json', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];
const resolveFile = (from, spec) => { const base = resolve(dirname(from), spec); return EXTS.map((e) => base + e).find((p) => existsSync(p) && statSync(p).isFile()); };

/** Every file reachable from the plugin's entries through relative imports; the problems found on the way. */
export function walk(dir) {
  const problems = []; const seen = new Set(); const todo = readdirSync(dir).filter((f) => ENTRY.test(f)).map((f) => join(dir, f));
  while (todo.length) {
    const file = todo.pop(); if (seen.has(file)) continue; seen.add(file);
    const rel = relative(dir, file).split(sep);
    if (rel.length > 1 && !['client', 'server', 'shared'].includes(rel[0])) problems.push(`${rel.join('/')}: modules belong in client/, server/ or shared/`);
    if (!/\.(tsx?|mjs|js)$/.test(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(SPEC)) {
      const spec = m[1]; if (!spec.startsWith('.')) continue;
      const to = resolveFile(file, spec);
      if (!to) { problems.push(`${relative(dir, file)}: cannot resolve ${spec}`); continue; }
      if (relative(dir, to).startsWith('..')) { problems.push(`${relative(dir, file)}: imports ${spec}, outside the plugin folder (Paseo bundles the plugin alone)`); continue; }
      const top = relative(dir, to).split(sep);
      if (top[0] === 'client' && /server/.test(rel[0])) problems.push(`${relative(dir, file)}: server code imports client/${top.slice(1).join('/')}`);
      todo.push(to);
    }
  }
  return problems;
}

test('there are plugins to check', () => assert.ok(plugins.length >= 3, plugins.join()));
for (const p of plugins) {
  test(`plugin ${p}: self-contained import graph (client/, server/, shared/ only, nothing outside the folder)`, () => {
    assert.deepEqual(walk(join(PLUGINS, p)), []);
  });
}
test('the checker itself flags a cross-plugin import and a stray top-level module', () => {
  const bad = join(PLUGINS, '..', 'scripts', 'test', 'fixtures', 'bad-plugin');
  assert.ok(walk(bad).some((x) => /outside the plugin folder/.test(x)) && walk(bad).some((x) => /belong in client/.test(x)), walk(bad).join('\n'));
});

function paseoCompiler() {
  const cands = [process.env.PASEO_SERVER_DIR && join(process.env.PASEO_SERVER_DIR, 'dist/server/server/plugins/compiler-build.js')];
  const g = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (g.status === 0) cands.push(join(g.stdout.trim(), '@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/plugins/compiler-build.js'), join(g.stdout.trim(), '@getpaseo/server/dist/server/server/plugins/compiler-build.js'));
  return cands.find((c) => c && existsSync(c));
}
const compiler = paseoCompiler();
for (const p of plugins) {
  test(`plugin ${p}: Paseo's own compiler builds it`, { skip: compiler ? false : 'Paseo is not installed here (npm i -g @getpaseo/cli, or set PASEO_SERVER_DIR)' }, async () => {
    const { compileDirectoryPlugin } = await import(pathToFileURL(compiler).href);
    const out = await compileDirectoryPlugin(join(PLUGINS, p), '0.15.2');
    assert.ok(out.serverBundle || out.clientBundle);
  });
}
