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
