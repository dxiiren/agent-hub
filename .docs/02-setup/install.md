# Install the hub on your machine

`just install` (Windows: `setup.ps1`, Linux/macOS: `setup.sh`) is safe to re-run. It does, in order:

1. Checks Git, Node, Claude Code, uv, just, gh; installs Paseo 0.15.2 (pinned) with npm.
2. Checks which agent CLIs exist (codex, claude, qodercli, qwen, opencode). A provider is registered only for a CLI that is installed.
3. `scripts/hub.mjs configure`: writes the Paseo `config.json` (bind 127.0.0.1, `injectIntoAgents=true`, a generated daemon password stored as a bcrypt hash; the plain secret stays in `<paseo home>/agent-hub-secret`, never in the repo) and the providers:
   - Nothing is preconfigured. Paseo itself detects `codex` and `claude` when installed; every other provider (Qwen Code endpoint, OpenCode, Qoder tier, a local llama.cpp model) you add yourself with Settings > Providers > Add provider or `agent-hub provider add` (README, quick start step 4). An older install's seeded providers are converted by `agent-hub provider migrate` (run by setup; `--undo` restores the old files).
   - Host-specific values (endpoints, keys, llama-server path) live in `config/hub.local.json` (git-ignored; template `config/hub.local.template.json`) or the environment.
   - Host-specific values come from the environment or `config/hub.local.json` (template: `config/hub.local.template.json`).
4. `scripts/hub.mjs mcp add`: registers `agent-hub` (`/mcp/agents` with the bearer secret) in Claude Code, Qoder, Qwen Code, Codex and OpenCode. The file is backed up once to `<file>.agent-hub.bak` when it exists, only the `agent-hub` entry is touched, and `just mcp-remove` removes it again. Skip with `-NoMcp` / `--no-mcp`.
5. Service mode: Windows = Task Scheduler task `AgentHub` (at logon plus every minute with `IgnoreNew`, per user, no admin); Linux = systemd user unit `agent-hub` with `Restart=on-failure` and linger. Skip with `-NoService` / `--no-service`. A host without systemd prints a skip line and `just up` runs `paseo daemon start`.

6. Plugins (daemon running): `just plugins` sets `pluginsEnabled` and installs the gate and usage plugins. The service task runs `deploy/service/daemon-run.ps1`, which gives the daemon its plugin environment (`AGENT_HUB_MCP`, `AGENT_HUB_ROUTES` = `config/routes/routes.local.json`, `AGENT_HUB_OTLP`, `AGENT_HUB_POLLER_DIR`) and puts Git Bash first on `PATH` so gates that run hooks do not pick the WSL `bash.exe`.

Daily commands: `just up`, `just down`, `just status`, `just plugins`, `just doctor` (PASS/FAIL per check and provider; `just doctor --deep` also runs one tiny task on each provider; the same thing is `agent-hub doctor --deep`), `just uninstall`.

Test overrides (never touch your real configs): `AGENT_HUB_HOME` (Paseo home), `AGENT_HUB_PORT`, `AGENT_HUB_CLIENT_ROOT` (every client config goes under that folder), `AGENT_HUB_TASK` (task name).

## Laptop model guard

`deploy/laptop/laptop-agent.mjs` is the launcher of a `local-llama` provider (add one with `agent-hub provider add <name> --kind local-llama ...`). At start it refuses (exit 3, reason on stderr) when the GPU is not visible, a heavy-run lock matching `HEAVY_LOCK_GLOB` exists, or free RAM is under 3 GB. It starts `llama-server` (with `--load-mode none`, one starter at a time) only when the first prompt arrives, so Paseo's status probe never loads the model; it refuses then too if another process already holds more than 600 MiB of VRAM.
