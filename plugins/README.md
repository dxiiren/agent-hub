# Plugins

Paseo plugins and CLIs for agent-hub. Install a plugin with `paseo plugin install <dir>` (needs `pluginsEnabled: true` in the daemon `config.json`).

| dir | what | key settings |
|---|---|---|
| `gate/` | After a turn: caller gate (request in the plugin store, never a label) or repo default, secret scan, diff-size and path check; one re-prompt, then `gate/status=FAIL`. Verdict in labels `gate/status`, `gate/reasons`, `gate/attempts`, `gate/diff`. | env `AGENT_HUB_ROUTES`, `AGENT_HUB_GATE_DIR`, `AGENT_HUB_MCP`; the password is read from the secret file |
| `routing/` | `route.mjs <type> "<prompt>"`: provider chain from `config/routes/routes.local.json`, caller `--provider` override, skip a busy provider, fall back on failure. Sets the `session`, `dev`, `caller` labels and writes the caller gate request. | `--mode`, `--gate`, `--session`, `--home` |
| `usage-otel/` | After a turn: one usage record to `<usage dir>/usage.jsonl` and `sessions/<id>.jsonl` (+ a ready `.sum.json`), and OTLP counts to `AGENT_HUB_OTLP`. `bin/agent_hub_usage.py usage --session <id> --json` is the statusline read path (python, about 42 ms). Pollers for Qoder credits and OpenCode exports in `pollers/`. Also registers a Paseo usage source `qoder`: the web UI Usage panel shows a Qoder row (credits used/remaining, quota %, reset time) next to Codex and Claude, from `qoder_poll.py` (cached 5 min; a slow poll keeps running and feeds the next refresh). | env `AGENT_HUB_USAGE_DIR`, `AGENT_HUB_OTLP` |

Tests: `npm test` (config check, node tests, python tests).
Windows note: pass native paths (`C:/...`) in env vars to the daemon; a Git-Bash `/c/...` path is written to `C:\c\...`.
Statusline: call the python file directly; going through `bin/agent-hub.cmd` adds about 45 ms of cmd.exe start-up.

**Latest aliases.** A route entry may name `codex/latest`, `codex/latest-sol|terra|luna`, `claude/latest-opus|sonnet|haiku` or `qoder/<tier>@latest` instead of a pinned model. `route.mjs` resolves it at dispatch to the highest version the provider lists (Codex: `~/.codex/models_cache.json`, version-sorted, `astra` never chosen, a family without the newest version falls back to the newest overall for `codex/latest`; Claude and Qoder: `paseo provider models`), cached 10 min. `node plugins/routing/route.mjs --resolve <alias>` prints the mapping now; `just doctor` lists resolved aliases and warns about pinned older models.
