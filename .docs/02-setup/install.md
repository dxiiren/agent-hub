# Install the hub on your machine

`just install` (Windows: `setup.ps1`, Linux/macOS: `setup.sh`) is safe to re-run. It does, in order:

1. Checks Git, Node, Claude Code, uv, just, gh; installs Paseo 0.15.0 (pinned) with npm.
2. Checks which agent CLIs exist (codex, claude, qodercli, qwen, opencode). A provider is registered only for a CLI that is installed.
3. `scripts/hub.mjs configure`: writes the Paseo `config.json` (bind 127.0.0.1, `injectIntoAgents=true`, a generated daemon password stored as a bcrypt hash; the plain secret stays in `<paseo home>/agent-hub-secret`, never in the repo) and the providers:
   - `codex` (gpt-6.1-terra and gpt-6.1-sol only), `claude-clean` (Claude with an empty MCP set), `qoder` (`qodercli --acp`), `qwen-code` (office model, needs `OFFICE_QWEN_URL`), `opencode` (`OPENCODE_DISABLE_MODELS_FETCH=1`), `qwen-laptop` (only when a GPU with 7.5 GiB or more is present and `LLAMA_SERVER_BIN` / `LAPTOP_MODEL_PATH` are set).
   - Host-specific values come from the environment or `config/hub.local.json` (template: `config/hub.local.template.json`).
4. `scripts/hub.mjs mcp add`: registers `agent-hub` (`/mcp/agents` with the bearer secret) in Claude Code, Qoder, Qwen Code, Codex and OpenCode. The file is backed up once to `<file>.agent-hub.bak` when it exists, only the `agent-hub` entry is touched, and `just mcp-remove` removes it again. Skip with `-NoMcp` / `--no-mcp`.
5. Service mode: Windows = Task Scheduler task `AgentHub` (at logon plus every minute with `IgnoreNew`, per user, no admin); Linux = systemd user unit `agent-hub` with `Restart=on-failure` and linger. Skip with `-NoService` / `--no-service`. A host without systemd prints a skip line and `just start` runs `paseo daemon start`.

Daily commands: `just start`, `just stop`, `just status`, `just doctor` (PASS/FAIL per check and provider; `--deep` also runs one tiny task on each provider), `just uninstall`.

Test overrides (never touch your real configs): `AGENT_HUB_HOME` (Paseo home), `AGENT_HUB_PORT`, `AGENT_HUB_CLIENT_ROOT` (every client config goes under that folder), `AGENT_HUB_TASK` (task name).

## Laptop model guard

`deploy/laptop/laptop-agent.mjs` is the `qwen-laptop` command. At start it refuses (exit 3, reason on stderr) when the GPU is not visible, a heavy-run lock matching `HEAVY_LOCK_GLOB` exists, or free RAM is under 3 GB. It starts `llama-server` (with `--load-mode none`, one starter at a time) only when the first prompt arrives, so Paseo's status probe never loads the model; it refuses then too if another process already holds more than 600 MiB of VRAM.
