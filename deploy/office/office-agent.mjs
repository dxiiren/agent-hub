// Launcher for every Qwen Code provider added with `agent-hub provider add` (or the Paseo Settings screen): resolves the served model id from <base>/v1/models at spawn time
// (cached 10 min), so an office upgrade needs no config change. Usage: node office-agent.mjs <QWEN_BIN> <base-url> <fallback-model> [--read-only]
// It is an ACP proxy (plugins/routing/acp-proxy.mjs): the session offers the mode "read-only", and choosing it restarts qwen with the deny settings. --read-only (old twin entries) = read-only from the start.
// An endpoint key (env HUB_OPENAI_API_KEY, set by `provider add --key`) never reaches the agent: it stays in this launcher, which fronts the endpoint with a local auth proxy.
import { spawnSafe } from '../../plugins/routing/spawn-safe.mjs';
import { safeUrl, servedModel, endpointDown, qwenEnv, takeReadOnlyFlag, startAuthProxy, scrubKeyEnv } from '../../plugins/routing/office.mjs';
import { modeProxy } from '../../plugins/routing/acp-proxy.mjs';

const legacyReadOnly = takeReadOnlyFlag(process.argv);
const [bin, upstream0, fallback] = process.argv.slice(2);
const upstream = safeUrl(upstream0);
if (!upstream) { process.stderr.write('office-agent: refusing an unsafe base URL' + String.fromCharCode(10)); process.exit(2); }
const key = process.env.HUB_OPENAI_API_KEY;
const proxy = key ? await startAuthProxy(upstream, key) : null;
const base = proxy ? proxy.base : upstream;
const authF = proxy ? (u, o) => fetch(u, { ...o, headers: { ...o?.headers, authorization: `Bearer ${proxy.secret}` } }) : fetch;
// an endpoint that does not answer fails the launch with a plain line: Paseo shows it as the provider's error (Settings > Providers, Routing & slots) instead of "Ready"
// right after a boot the LAN/VPN is not up yet and the daemon probes once (07:46 09-11: both office providers stuck in `error` until a manual refresh): retry for ~20 s before giving up
let down = await endpointDown(base, { f: authF });
for (let i = 0; down && i < 3; i++) { await new Promise((r) => setTimeout(r, 5000)); down = await endpointDown(base, { f: authF }); }
if (down) { process.stderr.write(down + String.fromCharCode(10)); proxy?.close(); process.exitCode = 75; } else {
const model = await servedModel(base, { fallback, f: authF });
const spawnQwen = (readOnly) => spawnSafe(bin, ['--acp', '--auth-type', 'openai', '--openai-base-url', base, '--openai-api-key', proxy ? proxy.secret : 'none', '--model', model],
  { stdio: ['pipe', 'pipe', 'inherit'], env: scrubKeyEnv(qwenEnv(process.env, readOnly)) });
const { done } = modeProxy({ spawnAgent: spawnQwen, initialReadOnly: legacyReadOnly });
done.then((c) => { proxy?.close(); process.exitCode = c; }); // no process.exit: exiting with the proxy server mid-close trips a libuv assertion on Windows
}
