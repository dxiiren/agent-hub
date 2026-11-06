// ACP stdio proxy between Paseo and a Qwen Code process. Qwen fixes its deny rules when the process starts, so a per-session
// "read-only" mode cannot be a flag inside qwen. This proxy offers it anyway: it adds the mode "read-only" to the session's
// modes, and when Paseo selects it (session/set_mode, before the first prompt) it restarts qwen with the read-only settings,
// replays initialize + session/new, and keeps talking to Paseo under the original session id. One provider entry per endpoint.
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { runDir, tryWriteState, readStateJson } from './runstate.mjs';
/** Run-dir file that maps the session id Paseo sees to the id of qwen's own session (they differ after the read-only restart). */
export const aliasFile = (outer) => `qwen-session-${String(outer).replace(/[^A-Za-z0-9-]/g, '_')}.json`;
export const innerSession = (outer) => { try { return readStateJson(join(runDir(), aliasFile(outer)))?.inner ?? null; } catch { return null; } };

export const RO_MODE = { id: 'read-only', name: 'Read-only', description: 'Reads files inside the task folder only: no edits, no shell, sensitive files refused by the agent itself.' };
const NL = String.fromCharCode(10);
const lines = (stream, fn) => createInterface({ input: stream, crlfDelay: Infinity }).on('line', fn);

/**
 * spawnAgent(readOnly) -> child process (stdin/stdout pipes). initialReadOnly = a legacy "-ro" twin entry: read-only from the start.
 * beforeForward(line) / onAgentLine(line): optional hooks (the laptop launcher starts its model server on the first prompt).
 * Returns { done } resolving with the agent's exit code.
 */
export function modeProxy({ spawnAgent, input = process.stdin, output = process.stdout, initialReadOnly = false, roBaseMode = 'plan', beforeForward, onAgentLine, timeoutMs = 60000 }) {
  let agent = null, known = new Set(), ro = false, gen = 0, prompted = false, init = null, sess = null, outer = null, inner = null, awaiting = null, hub = 0;
  const waits = new Map();
  let exit; const done = new Promise((r) => { exit = r; });
  const toAgent = (m) => agent.stdin.write(JSON.stringify(m) + NL);
  const toClient = (m) => output.write((typeof m === 'string' ? m : JSON.stringify(m)) + NL);
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = `hub:${++hub}`; const t = setTimeout(() => { waits.delete(id); rej(new Error(`${method} timed out`)); }, timeoutMs);
    waits.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message || method)) : res(m.result); });
    toAgent({ jsonrpc: '2.0', id, method, params });
  });
  const start = (readOnly) => {
    const g = ++gen; agent = spawnAgent(readOnly); ro = readOnly;
    lines(agent.stdout, (l) => fromAgent(l, g));
    agent.on('exit', (c) => { if (g === gen) exit(c ?? 1); });
    agent.stdin.on('error', () => {});
  };
  function fromAgent(l, g) {
    if (g !== gen) return;
    onAgentLine?.(l);
    let m; try { m = JSON.parse(l); } catch { return toClient(l); }
    if (typeof m.id === 'string' && m.id.startsWith('hub:') && !m.method) { const w = waits.get(m.id); waits.delete(m.id); return w?.(m); }
    if (awaiting !== null && m.id === awaiting && !m.method) { // answer to the client's session/new or session/load
      awaiting = null;
      if (m.result) {
        inner = m.result.sessionId ?? inner ?? sess.params?.sessionId; outer = inner;
        const a = m.result.modes?.availableModes; if (Array.isArray(a)) for (const x of a) known.add(x.id);
        if (Array.isArray(a) && !a.some((x) => x.id === RO_MODE.id)) a.push(RO_MODE);
        if (ro && m.result.modes) m.result.modes.currentModeId = RO_MODE.id;
      }
      return toClient(m);
    }
    if (m.params?.sessionId && m.params.sessionId === inner && inner !== outer) m.params.sessionId = outer;
    toClient(m);
  }
  async function restartReadOnly() {
    const old = agent; gen++; start(true); // the old agent's output and exit are ignored from here on
    try { old.stdin.end(); old.kill(); } catch { /* already gone */ }
    await rpc('initialize', init.params);
    const r = await rpc(sess.method, { ...sess.params, ...(sess.method === 'session/load' ? { sessionId: inner } : {}) });
    inner = r?.sessionId ?? inner;
    if (inner !== outer) tryWriteState(join(runDir(), aliasFile(outer)), { inner }); // Paseo only knows `outer`; the usage hook finds qwen's own chat file (the token counts) through this
    await rpc('session/set_mode', { sessionId: inner, modeId: roBaseMode });
  }
  const reply = (id, result) => toClient({ jsonrpc: '2.0', id, result });
  const fail = (id, message) => toClient({ jsonrpc: '2.0', id, error: { code: -32602, message } });
  async function fromClient(l) {
    let m; try { m = JSON.parse(l); } catch { m = null; }
    if (m && beforeForward) await beforeForward(l, m);
    if (!m) return agent.stdin.write(l + NL);
    if (m.method === 'initialize') init = m;
    else if (m.method === 'session/new' || m.method === 'session/load') { sess = m; awaiting = m.id; if (m.method === 'session/load') inner = outer = m.params?.sessionId; }
    else if (m.method === 'session/prompt') prompted = true;
    else if (m.method === 'session/set_mode') {
      // deny by default: read-only unless the client names a mode the agent itself offers (a missing or unknown mode id never reaches the agent as a normal mode)
      if (m.params?.modeId === RO_MODE.id || !known.has(m.params?.modeId)) {
        if (ro) return reply(m.id, {});
        if (prompted || !sess) return fail(m.id, 'read-only must be chosen before the first prompt');
        try { await restartReadOnly(); } catch (e) { return fail(m.id, `read-only restart failed: ${e.message}`); }
        return reply(m.id, {});
      }
      if (ro) return fail(m.id, 'this session is read-only: its mode cannot be changed');
    }
    if (m.params?.sessionId && m.params.sessionId === outer && inner !== outer) m.params.sessionId = inner;
    toAgent(m);
  }
  start(initialReadOnly); // eager: Paseo's first message (initialize) arrives at once, and a launcher with no ACP client still runs its agent
  let chain = Promise.resolve();
  lines(input, (l) => { if (l.trim()) chain = chain.then(() => fromClient(l)).catch((e) => process.stderr.write(`acp-proxy: ${e.message}${NL}`)); });
  input.on('end', () => chain.then(() => agent?.stdin.end()));
  return { done, kill: () => agent?.kill() };
}
