# Getting Started — Agent Hub

> **TL;DR** — `pwsh ./setup.ps1` once (idempotent), reopen PowerShell, then
> `just deps && just test`.

## Prerequisites

PowerShell + winget (stock Windows 10/11). Everything else is installed by `setup.ps1`.

## One-time machine setup

If `just` is not installed yet, get it first (winget, with the PATH fix), then open a new terminal:

```powershell
powershell -ExecutionPolicy Bypass -File install-just.ps1
```

Then:

```powershell
just install     # runs setup.ps1 (or directly: pwsh ./setup.ps1)
```

Idempotent — safe to re-run; a second run must be all-`[OK]`. Then CLOSE AND REOPEN
PowerShell so PATH updates land.

`setup.ps1` installs Git, Node LTS, `just` and the Claude Code CLI. On Linux and macOS run `sh ./setup.sh` (or `just install`) instead. Follow-up: fill the GitHub PAT in `.mcp.json` if you use the `github` MCP server. Copy a `config/*.template.json` and replace each `<PLACEHOLDER>` outside the repo before pointing the daemon at it.

## First boot

```powershell
just deps    # npm install
just test    # validate every config template
```

There is no server to start or stop. Success is `just test` exiting 0. `just scan` must also exit 0 before any push.

## Related docs

| Doc | Why |
| --- | --- |
| [workflow.md](../03-development/workflow.md) | The day-2 development loop |
| [common-issues.md](../06-troubleshooting/common-issues.md) | When a step fails |
