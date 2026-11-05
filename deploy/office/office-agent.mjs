// Launcher for the office Qwen providers (qwen-code, qwen-code-2): resolves the served model id from <base>/v1/models at spawn time
// (cached 10 min), so an office upgrade needs no config change. Usage: node office-agent.mjs <QWEN_BIN> <base-url> <fallback-model>
import { spawn } from 'node:child_process';
import { servedModel, qwenEnv } from '../../plugins/routing/office.mjs';

const [bin, base, fallback] = process.argv.slice(2);
const model = await servedModel(base, { fallback });
const child = spawn(bin, ['--acp', '--auth-type', 'openai', '--openai-base-url', base, '--openai-api-key', 'none', '--model', model],
  { stdio: 'inherit', env: qwenEnv(), shell: /\.(cmd|bat)$/i.test(bin) });
child.on('exit', (c) => process.exit(c ?? 1));
