# Agent Hub usage

On every finished turn, writes one record (tokens in/out/cached, cost, credits, provider, model, dev, calling client, caller session) to the append-only file `<usage dir>/usage.jsonl` and to `<usage dir>/sessions/<session>.jsonl`, and exports counts (never the prompt, never the session id) as OTLP/JSON to `AGENT_HUB_OTLP`.

Caller labels: `session` (the caller's session id), `parent_session` (subagents: rolls up to the parent), `dev`, `caller` (client name). `route.mjs` sets them.
Env: `AGENT_HUB_USAGE_DIR` (else `<PASEO_HOME or ~/.paseo>/usage`), `AGENT_HUB_OTLP`, `AGENT_HUB_MCP`, the password (read from `<paseo home>/agent-hub-secret`).
Read it with `bin/agent-hub usage --session <id> --json` (python, stdlib only).
