// Fake `qwen --acp`: answers every JSON-RPC line; a session/prompt takes FAKE_QWEN_MS and ends with a stopReason.
// With FAKE_QWEN_ECHO set it prints its argv and exits.
const NL = String.fromCharCode(10);
if (process.env.FAKE_QWEN_ECHO) { console.log('ARGS ' + process.argv.slice(2).join(' ')); process.exit(0); }
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split(NL); buf = lines.pop();
  for (const l of lines) {
    const id = JSON.parse(l).id;
    if (l.includes('"session/prompt"')) setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }) + NL), Number(process.env.FAKE_QWEN_MS || 800));
    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + NL);
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 1000));
