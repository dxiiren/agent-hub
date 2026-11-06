// Launcher for every Qwen Code provider added with `agent-hub provider add` (or the Paseo Settings screen): resolves the served model id from <base>/v1/models at spawn time
// (cached 10 min), so an office upgrade needs no config change. Usage: node office-agent.mjs <QWEN_BIN> <base-url> <fallback-model> [--read-only]
// It is an ACP proxy (plugins/routing/acp-proxy.mjs): the session offers the mode "read-only", and choosing it restarts qwen with the deny settings. --read-only (old twin entries) = read-only from the start.
// An endpoint key (env HUB_OPENAI_API_KEY, set by `provider add --key`) never reaches the agent: it stays in this launcher, which fronts the endpoint with a local auth proxy.
import { spawn } from 'node:child_process';
import { servedModel, qwenEnv, takeReadOnlyFlag, startAuthProxy, scrubKeyEnv } from '../../plugins/routing/office.mjs';
import { modeProxy } from '../../plugins/routing/acp-proxy.mjs';

const legacyReadOnly = takeReadOnlyFlag(process.argv);
const [bin, upstream, fallback] = process.argv.slice(2);
const key = process.env.HUB_OPENAI_API_KEY;
const proxy = key ? await startAuthProxy(upstream, key) : null;
const base = proxy ? proxy.base : upstream;
const model = await servedModel(base, { fallback, ...(proxy ? { f: (u, o) => fetch(u, { ...o, headers: { ...o?.headers, authorization: `Bearer ${proxy.secret}` } }) } : {}) });
const spawnQwen = (readOnly) => spawn(bin, ['--acp', '--auth-type', 'openai', '--openai-base-url', base, '--openai-api-key', proxy ? proxy.secret : 'none', '--model', model],
  { stdio: ['pipe', 'pipe', 'inherit'], env: scrubKeyEnv(qwenEnv(process.env, readOnly)), shell: /\.(cmd|bat)$/i.test(bin) });
const { done } = modeProxy({ spawnAgent: spawnQwen, initialReadOnly: legacyReadOnly });
done.then((c) => { proxy?.close(); process.exitCode = c; }); // no process.exit: exiting with the proxy server mid-close trips a libuv assertion on Windows
