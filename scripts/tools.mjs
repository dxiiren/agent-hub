// CLI inventory for `just doctor` (installed vs latest published, read only) and `just update`. Never runs in the background.
import { spawnSyncSafe } from '../plugins/routing/spawn-safe.mjs';

// update: argv run by `just update`. Paseo is excluded unless --paseo (decision 38: the fork is rebased per release).
export const TOOLS = [
  { name: 'Paseo', bin: 'paseo', pkg: '@getpaseo/cli', pinned: true, update: ['npm', 'i', '-g', '@getpaseo/cli@latest'] },
  { name: 'Codex', bin: 'codex', pkg: '@openai/codex', update: ['npm', 'i', '-g', '@openai/codex@latest'] },
  { name: 'Claude Code', bin: 'claude', pkg: '@anthropic-ai/claude-code', update: ['claude', 'update'] },
  { name: 'Qwen Code', bin: 'qwen', pkg: '@qwen-code/qwen-code', update: ['npm', 'i', '-g', '@qwen-code/qwen-code@latest'] },
  { name: 'OpenCode', bin: 'opencode', pkg: 'opencode-ai', update: ['opencode', 'upgrade'] },
  { name: 'qodercli', bin: 'qodercli', pkg: '@qoder-ai/qodercli', pin: '1.1.81', update: ['qodercli', 'update'] }, // pin: 1.1.83 ignores the tier model over ACP (README, Changes 05-11); `just update` never moves it
];

/** First x.y.z in a --version line, or "". */
export const parseVersion = (s) => /\d+(?:\.\d+){1,3}/.exec(s ?? '')?.[0] ?? '';
/** -1 installed older, 0 same, 1 installed newer; null when either side is unknown. */
export function compareVersions(a, b) {
  if (!a || !b) return null;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
/** WARN line for a tool installed at a version other than its pin, or '' (read only: the owner's install is never changed). */
export const pinWarning = (t) => (t.pin && t.installed && t.installed !== t.pin ? `${t.name} ${t.installed} is installed but the hub pins ${t.pin} (a newer one ignores the tier model over ACP). Fix: npm i -g ${t.pkg}@${t.pin} (stop agents using it first)` : '');
export const verdict = (installed, latest) => {
  if (!installed) return 'NOT INSTALLED';
  const c = compareVersions(installed, latest);
  return c === null ? 'UNKNOWN' : c < 0 ? 'UPDATE' : 'current';
};

const WIN = process.platform === 'win32';
const sh = (cmd, args) => spawnSyncSafe(cmd, args, { encoding: 'utf8', timeout: 30000 }); // a Windows .cmd shim runs as node <entry>, no shell
export function inventory(tools = TOOLS) {
  return tools.map((t) => {
    const installed = parseVersion(sh(t.bin, ['--version']).stdout);
    const latest = parseVersion(sh('npm', ['view', t.pkg, 'version']).stdout);
    return { ...t, installed, latest, verdict: verdict(installed, latest) };
  });
}
export const table = (rows) => rows.map((r) => `${r.name.padEnd(12)} ${(r.installed || '-').padEnd(10)} ${(r.latest || '-').padEnd(10)} ${r.verdict}${r.pinned && r.verdict === 'UPDATE' ? ' (pinned: just update --paseo)' : ''}`).join('\n');

/** `update [--paseo]`: updates every behind tool; Paseo only with --paseo. */
export function update(withPaseo) {
  for (const r of inventory()) {
    if (r.pin) { console.log(`skip ${r.name}: pinned to ${r.pin} (installed ${r.installed || 'none'})`); continue; }
    if (r.verdict !== 'UPDATE') { console.log(`skip ${r.name}: ${r.verdict}`); continue; }
    if (r.pinned && !withPaseo) { console.log(`skip ${r.name}: pinned (${r.installed} -> ${r.latest}); run \`just update --paseo\` after the fork rebase`); continue; }
    console.log(`update ${r.name}: ${r.installed} -> ${r.latest}`);
    const s = sh(r.update[0], r.update.slice(1)); console.log(s.status === 0 ? '  ok' : `  FAILED: ${(s.stderr || s.stdout || '').trim().slice(-200)}`);
  }
}
