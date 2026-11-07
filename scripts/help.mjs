// agent-hub --help and agent-hub <command> --help: plain text only, never runs the command.
const H = {
  _: `usage: agent-hub <route|reply|provider|routes|usage|doctor|cleanup> [--help]
agent-hub hands a task to an agent provider through the local Paseo daemon.

Commands (run \`agent-hub <command> --help\` for details and examples):
  route     send a task to a provider chain and get the answer back (JSON)
  reply     answer a question an agent asked (status "asking")
  provider  add, edit, list, remove providers; list kinds and models
  routes    models, slots and chain order per provider (Settings > Routing & slots)
  usage     tokens, credits and cost for a session or for everything
  doctor    health checks: daemon, MCP, providers, secret scanner
  cleanup   archive finished agents and temp leftovers (preview with --dry-run)

Example: agent-hub route summarise "Summarise README.md in 5 bullets" --cwd .`,
  route: `route: send one task to the first working provider of a task type.
usage: agent-hub route <type> "<prompt>" [--cwd D] [--gate CMD] [--new-workspace worktree]
         [--provider P/M] [--mode M] [--session ID] [--dev D] [--client C] [--home H] [--keep]
types: code-edit, code-edit-easy, test-scaffold (edit files; use --new-workspace worktree and a --gate)
       summarise, review (read-only; need a provider added with --routes summarise|review)
output: one JSON line {used, agentId, status, gate, trace, answer}; exit 0 = completed,
        3 = the agent asked a question (answer it with: agent-hub reply), 1 = failed, 2 = bad input.
example: agent-hub route code-edit "add a --version flag" --cwd . --new-workspace worktree --gate "npm test"`,
  reply: `reply: answer a question from an agent that finished a route with status "asking".
usage: agent-hub reply <agentId> "<text>" [--home H]
Never put a password, token or key in the text (it is refused).
example: agent-hub reply 1b2c3d4e-... "Use the v2 endpoint"`,
  provider: `provider: manage the providers (agents) the hub can route to. Same thing as Settings > Providers.
usage: agent-hub provider kinds | list | models --kind K [--url U] [--key K]
       agent-hub provider add <name> --kind K [--url U] --model M [--key K] [--slots N] [--routes code-edit:2,summarise] [--readonly false] [--label "Name"]
       agent-hub provider add <name> --kind claude|codex|qoder --account A --model M   (separate login folder)
       agent-hub provider edit <name> [--model M] [--url U] [--key K] [--slots N] [--routes ...]
       agent-hub provider remove <name> [--purge]
kinds: qwen-code, opencode, local-llama, qoder, codex, claude (see \`provider kinds\`)
example: agent-hub provider add my-qwen --kind qwen-code --url http://127.0.0.1:8000/v1 --model my-model --routes summarise,code-edit
Restart the daemon after adding a provider that has its own entry: just down && just up`,
  routes: `routes: which models each provider may use, its slots, and the order of each task type's chain. Same thing as Settings > Plugins > agent-hub-providers > Routing & slots.
usage: agent-hub routes show [--json] | models <provider> | undo
       agent-hub routes set <provider> [--slots 1..64] [--models id,id|all] [--enabled true|false]
       agent-hub routes chain <type> <entry,entry,...>      (an empty value empties the chain)
       agent-hub routes move <type> <entry> up|down|off
Invalid input is refused with every problem listed and nothing is written. undo restores the file byte for byte.
example: agent-hub routes set codex --models gpt-6.1-sol --slots 2`,
  usage: `usage: show tokens, credits and estimated cost.
usage: agent-hub usage --session <id> [--json] [--dir D] | agent-hub usage --all
example: agent-hub usage --all`,
  doctor: `doctor: PASS/FAIL per check (daemon, allow-listed environment, usage stack, MCP, each provider, gitleaks).
usage: agent-hub doctor [--deep]     --deep runs one tiny task on every provider (uses tokens)
FAIL = something is broken, exit 1. WARN/NOTE/INFO = advice, exit 0.
example: agent-hub doctor`,
  cleanup: `cleanup: archive finished agents that agent-hub created, remove temp leftovers. Never touches running agents.
usage: agent-hub cleanup [--older-than 30m] [--mine|--all] [--dry-run] [--stale-projects] [--paseo-defaults]
example: agent-hub cleanup --older-than 30m --dry-run`,
};
const a = process.argv[2];
if (a && !H[a] && !['help', '--help', '-h'].includes(a)) console.error(`agent-hub: unknown command '${a}'. Use one of: route, reply, provider, routes, usage, doctor, cleanup.`);
console.log(H[a] || H._);
process.exit(a && !H[a] && !['help', '--help', '-h'].includes(a) ? 2 : 0);
