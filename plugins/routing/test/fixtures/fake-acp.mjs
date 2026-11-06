// Fake ACP agent for the mode-proxy test. FAKE_RO=1 plays the read-only launch: a write and a sensitive read are refused, like qwen with the deny settings.
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync } from 'node:fs';
const ro = process.env.FAKE_RO === '1'; let sid = null, mode = 'default';
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') return out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
  if (m.method === 'session/new') { sid = `S${process.pid}`; return out({ id: m.id, result: { sessionId: sid, modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] }, ...(process.env.FAKE_MODELS ? { models: { currentModelId: '$runtime|openai|Big-Model(openai)', availableModels: [{ modelId: '$runtime|openai|Big-Model(openai)', name: 'Big-Model' }, { modelId: 'Own(openai)', name: 'user-own' }] } } : {}) } }); }
  if (m.method === 'session/set_model') { mode = 'model=' + m.params.modelId; return out({ id: m.id, result: {} }); }
  if (m.method === 'session/set_mode') { mode = m.params.modeId; return out({ id: m.id, result: {} }); }
  if (m.method === 'session/prompt') {
    const [verb, arg] = m.params.prompt[0].text.split(' '); let text;
    if (m.params.sessionId !== sid) text = `BAD-SESSION ${m.params.sessionId} != ${sid}`;
    else if (verb === 'WRITE') { if (ro) text = 'REFUSED write'; else { writeFileSync(arg, 'x'); text = 'WROTE'; } }
    else if (verb === 'READ') { if (ro && /(^|[\\/])\.env/.test(arg)) text = 'REFUSED sensitive read'; else text = 'READ ' + readFileSync(arg, 'utf8'); }
    else text = `MODE ${mode} RO ${ro}`;
    out({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    return out({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  out({ id: m.id, error: { code: -32601, message: 'no such method' } });
});
