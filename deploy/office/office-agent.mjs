// Launcher for the office Qwen providers (qwen-code, qwen-code-2) and for providers added with `agent-hub provider add`: resolves the served model id from <base>/v1/models at spawn time
// (cached 10 min), so an office upgrade needs no config change. Usage: node office-agent.mjs <QWEN_BIN> <base-url> <fallback-model> [--read-only]
// An endpoint key (env HUB_OPENAI_API_KEY, set by `provider add --key`) never reaches the agent: it stays in this launcher, which fronts the endpoint with a local auth proxy.
import { spawn } from 'node:child_process';
import { servedModel, qwenEnv, takeReadOnlyFlag, startAuthProxy, scrubKeyEnv } from '../../plugins/routing/office.mjs';

const readOnly = takeReadOnlyFlag(process.argv); // the "-ro" twin provider
const [bin, upstream, fallback] = process.argv.slice(2);
const key = process.env.HUB_OPENAI_API_KEY;
const proxy = key ? await startAuthProxy(upstream, key) : null;
const base = proxy ? proxy.base : upstream;
const model = await servedModel(base, { fallback });
const child = spawn(bin, ['--acp', '--auth-type', 'openai', '--openai-base-url', base, '--openai-api-key', 'none', '--model', model],
  { stdio: 'inherit', env: scrubKeyEnv(qwenEnv(process.env, readOnly)), shell: /\.(cmd|bat)$/i.test(bin) });
child.on('exit', (c) => { proxy?.close(); process.exit(c ?? 1); });
