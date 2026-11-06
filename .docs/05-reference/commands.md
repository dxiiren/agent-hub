# Commands — Agent Hub

> **TL;DR** — run `just` with no arguments to list every recipe. This page explains each
> one and when to reach for it.

## Recipes

Every stack ships `install`, which runs `setup.ps1` (the toolchain). `just` itself comes from
`install-just.ps1` (`-DryRun` previews, `-Force` reinstalls). On the node stacks the npm
dependency install is `deps`.

| Recipe | What it does | When |
| --- | --- | --- |
| `install` | Install the toolchain (runs `setup.ps1` on Windows, `setup.sh` on Linux and macOS) | Once per machine |
| `deps` | `npm install --no-audit --no-fund` | After a pull that changed `package.json` |
| `test` | `npm test`: `scripts/check-config.mjs` validates every config template | Before every commit |
| `lint` | `npm run lint`: the same config check | Before every commit |
| `build` | `npm run build`: the same config check | Before a PR |
| `scan` | `npm run scan`: `scripts/scan.mjs` finds internal hosts, paths and secrets in tracked files | Before every push |
| `doctor` | PASS/FAIL per check and provider, resolved `latest` aliases, served office model ids, the laptop GGUF and its date, and every CLI's installed vs latest published version (read only); `just doctor --deep` (or `agent-hub doctor --deep`) runs one tiny task per provider | After any change, weekly |
| `update` | Update each CLI that is behind (Codex, Claude Code, Qwen Code, OpenCode, qodercli). Paseo stays pinned unless `just update --paseo` (decision 38: the fork is rebased per release). Manual only, never in the background | When `doctor` says UPDATE |
| `claudex` | Claude Code, all permissions, Sonnet | AI-assisted dev |
| `claudeo` | Same on Opus | Deep design work |
| `claudeh` | Same on Haiku | Bulk, simple work |

## Guards

The `[private] _require-*` recipes fail fast with a "run setup.ps1 first" message when a
required tool is missing — you never see them in `just --list`, but every recipe that
needs a tool depends on one.

## Related docs

| Doc | Why |
| --- | --- |
| [workflow.md](../03-development/workflow.md) | How the recipes fit the daily loop |
| [stack-notes.md](stack-notes.md) | Why some recipes look the way they do |
