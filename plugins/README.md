# Plugins

Paseo plugins and CLIs for agent-hub. Install a plugin with `paseo plugin install <dir>` (needs `pluginsEnabled: true` in the daemon `config.json`).

| dir | what | key settings |
|---|---|---|
| `gate/` | After a turn: caller gate (request in the plugin store, never a label) or repo default, secret scan, diff-size and path check; one re-prompt, then `gate/status=FAIL`. Verdict in labels `gate/status`, `gate/reasons`, `gate/attempts`, `gate/diff`. | env `AGENT_HUB_ROUTES`, `AGENT_HUB_GATE_DIR`, `AGENT_HUB_MCP`; `PASEO_PASSWORD` is inherited from the daemon |
| `routing/` | `route.mjs <type> "<prompt>"`: provider chain from `config/routes/routes.local.json`, caller `--provider` override, skip a busy provider, fall back on failure. Sets the `session`, `dev`, `caller` labels and writes the caller gate request. | `--mode`, `--gate`, `--session`, `--home` |
| `usage-otel/` | After a turn: one usage record to `<usage dir>/usage.jsonl` and `sessions/<id>.jsonl` (+ a ready `.sum.json`), and OTLP counts to `AGENT_HUB_OTLP`. `bin/agent_hub_usage.py usage --session <id> --json` is the statusline read path (python, about 42 ms). Pollers for Qoder credits and OpenCode exports in `pollers/`. | env `AGENT_HUB_USAGE_DIR`, `AGENT_HUB_OTLP` |

Tests: `npm test` (config check, node tests, python tests).
Windows note: pass native paths (`C:/...`) in env vars to the daemon; a Git-Bash `/c/...` path is written to `C:\c\...`.
Statusline: call the python file directly; going through `bin/agent-hub.cmd` adds about 45 ms of cmd.exe start-up.
