// Preload (node --import): fakes the GPU probes so launcher scripts run on a laptop with no card. Everything else is the real spawnSync.
import { createRequire, syncBuiltinESMExports } from 'node:module';
const cp = createRequire(import.meta.url)('node:child_process');
const real = cp.spawnSync;
const fake = (stdout) => ({ status: 0, stdout, stderr: '', pid: 0, output: [], signal: null });
cp.spawnSync = (cmd, args = [], o) => {
  const a = args.join(' ');
  if (cmd === 'nvidia-smi') return fake(a.includes('memory.used') ? '100\n' : '\n');
  if (cmd === 'powershell') {
    if (/Get-PnpDevice/.test(a)) return fake('OK\n');
    if (/Get-NetTCPConnection/.test(a)) return fake('\n');
    if (/Get-Process/.test(a)) return fake('1\n');
  }
  return real(cmd, args, o);
};
syncBuiltinESMExports();
