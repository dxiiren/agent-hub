// Generic ACP launcher for providers that are a plain CLI (Qoder): node acp-grant.mjs <bin> [args...]
// It runs the agent unchanged, adds the MCP servers named in env HUB_MCP (resolved against the hub's own allowlist, see
// plugins/routing/mcp-grant.mjs) to session/new, puts the hub's "load deferred tools" preamble before the first prompt, and writes a
// per-call tool log (run dir, toolcalls-<name>-<pid>.jsonl) because these lanes leave none. No read-only mode here: read-only types never run on this launcher.
import { basename, join } from 'node:path';
import { spawnSafe } from '../../plugins/routing/spawn-safe.mjs';
import { modeProxy } from '../../plugins/routing/acp-proxy.mjs';
import { grantFromEnv } from '../../plugins/routing/mcp-grant.mjs';
import { runDir } from '../../plugins/routing/runstate.mjs';

const [bin, ...args] = process.argv.slice(2);
if (!bin) { process.stderr.write('usage: acp-grant.mjs <agent-binary> [args...]' + String.fromCharCode(10)); process.exit(2); }
const mcp = grantFromEnv(process.env);
if (mcp.refused) { process.stderr.write('acp-grant: ' + mcp.refused + String.fromCharCode(10)); process.exit(2); }
const name = basename(/^node(.exe)?$/i.test(basename(bin)) && args[0] ? args[0] : bin).replace(/\.[a-z]+$/i, '').replace(/[^A-Za-z0-9-]/g, '_');
const { done } = modeProxy({ spawnAgent: () => spawnSafe(bin, args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env }), allowRo: false, mcp, toolLog: join(runDir(), `toolcalls-${name}-${process.pid}.jsonl`) });
done.then((c) => { process.exitCode = c; });
