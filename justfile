# Agent Hub justfile: development recipes (Windows and Linux)

set shell := ["sh", "-cu"]
set windows-shell := ["powershell.exe", "-NoProfile", "-Command"]

# List available recipes
default:
    @just --list

# ─── Setup ───────────────────────────────────────────────

# First-time machine setup on Windows: installs the toolchain (runs setup.ps1). Safe to re-run.
[windows]
install:
    @powershell.exe -NoProfile -ExecutionPolicy Bypass -File '{{justfile_directory()}}/setup.ps1'

# First-time machine setup on Linux and macOS: installs the toolchain (runs setup.sh). Safe to re-run.
[unix]
install *flags:
    @sh '{{justfile_directory()}}/setup.sh' {{flags}}

# ─── Hub: daemon, providers, MCP ─────────────────────────

# Start the daemon (the scheduled task / systemd unit when installed, else a plain `paseo daemon start`).
[windows]
up:
    @& '{{justfile_directory()}}/deploy/service/service.ps1' start

[unix]
up:
    @sh '{{justfile_directory()}}/deploy/service/service.sh' start

# Stop the daemon.
[windows]
down:
    @& '{{justfile_directory()}}/deploy/service/service.ps1' stop

[unix]
down:
    @sh '{{justfile_directory()}}/deploy/service/service.sh' stop

# Show the service and daemon state.
[windows]
status:
    @& '{{justfile_directory()}}/deploy/service/service.ps1' status

[unix]
status:
    @sh '{{justfile_directory()}}/deploy/service/service.sh' status

# Enable plugins in the daemon and install the gate and usage plugins (daemon running).
plugins:
    node scripts/hub.mjs plugins

# Update every CLI that is behind (Codex, Claude Code, Qwen Code, OpenCode, qodercli). Paseo stays pinned unless `just update --paseo`. Manual only, never in the background.
update *flags:
    node scripts/hub.mjs update {{flags}}

# PASS/FAIL per check and per provider; add --deep to run one tiny task on each provider.
doctor *flags:
    node scripts/hub.mjs doctor {{flags}}

# Register the agent-hub MCP server in every installed client (backs up first; only the agent-hub entry).
mcp-add:
    node scripts/hub.mjs mcp add

# Remove the agent-hub MCP server from every installed client.
mcp-remove:
    node scripts/hub.mjs mcp remove

# Undo the install: service, MCP entries, providers and secret (Paseo itself and your agent CLIs stay).
[windows]
uninstall:
    @& '{{justfile_directory()}}/deploy/service/service.ps1' uninstall; node scripts/hub.mjs mcp remove; node scripts/hub.mjs unconfigure

[unix]
uninstall:
    @sh '{{justfile_directory()}}/deploy/service/service.sh' uninstall; node scripts/hub.mjs mcp remove; node scripts/hub.mjs unconfigure

# ─── Build and quality ───────────────────────────────────

# Install the npm dependencies (npm ci when the lockfile allows, else npm install).
deps:
    npm install --no-audit --no-fund

# Validate every config template (JSON parses, placeholders only).
test:
    npm test

# Lint = the same config check (no code to lint yet).
lint:
    npm run lint

# Build check = the same config check (plugins land per tasks.md).
build:
    npm run build

# Scan tracked files for internal hosts, paths and secrets before any push.
scan:
    npm run scan

# ─── Tools ───────────────────────────────────────────────

# Launch Claude Code with all permissions: Sonnet (latest)
claudex:
    claude --dangerously-skip-permissions --model sonnet

# Launch Claude Code with all permissions: Opus (latest)
claudeo:
    claude --dangerously-skip-permissions --model opus

# Launch Claude Code with all permissions: Haiku (latest)
claudeh:
    claude --dangerously-skip-permissions --model haiku
