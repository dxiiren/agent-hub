# Agent Hub gate

After an agent finishes a turn this plugin runs the gate: the caller's command or the repo default from the routing file, a secret scan of the diff and of ignored files, and a diff-size and path check. The first failure re-prompts the agent once; the second marks FAIL.

Trust model: agent labels are never read. Command, `maxLines`, `forbid`, `allow` come from the routes file (`gates` rows, `gateDefault`); the caller's own command comes from a request that `route.mjs --gate` writes to the plugin store before it creates the agent (bound to the first agent that finishes a turn in that cwd). Attempts and status live in `<gate dir>/state.json`. Labels `gate/status`, `gate/reasons`, `gate/attempts`, `gate/diff` only mirror the verdict for `get_agent_status`. Patterns are regexes from the routes file, capped at 200 characters. Git runs with `core.fsmonitor=false`, an empty hooks dir, no external diff or textconv, and empty system and global config.

Env: `AGENT_HUB_GATE_DIR` (else `<PASEO_HOME or ~/.paseo>/gate`; the same value for the daemon and for `route.mjs`), `AGENT_HUB_ROUTES`, `AGENT_HUB_MCP`, `PASEO_PASSWORD` (inherited). Routes option `gateRetry: false` turns the re-prompt off.
