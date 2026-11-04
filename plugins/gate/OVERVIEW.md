# Agent Hub gate

After an agent finishes a turn this plugin runs the gate: the caller's command (label `gate/cmd`) or the repo default from the routing file, a secret scan of the diff and of ignored files, and a diff-size and path check. The first failure re-prompts the agent once; the second marks `gate/status=FAIL`. Verdict labels: `gate/status`, `gate/reasons`, `gate/attempts`.

Caller labels: `gate/cmd`, `gate/maxLines`, `gate/skip`, `gate/retry=off`.
Env: `PASEO_PASSWORD` (inherited from the daemon), `AGENT_HUB_MCP` (default `http://127.0.0.1:6790/mcp/agents`), `AGENT_HUB_ROUTES` (routing file).
