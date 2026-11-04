# Project Overview — Agent Hub

> **TL;DR** — Agent Hub configures and extends the Paseo agent daemon so any AI client can hand a task to any agent provider and get a verdict plus a diff back.

## What it is

Agent Hub configures and extends the [Paseo](https://github.com/getpaseo/paseo) agent daemon so that any AI client (Claude Code, Codex, Qoder, OpenCode, Qwen Code) can hand a task to any agent provider (Codex, Qoder, Claude, Qwen Code, an office SGLang server, a laptop llama.cpp server) and get a verdict plus a diff back. It adds provider config templates, a gate plugin (secret scan, diff-size and path check, two-failure return), a usage plugin with an OTel/Prometheus/Grafana stack, a routing table, a laptop pre-flight, and install scripts for Windows and Linux.

Features:

1. Provider config templates for Codex, Qoder, Claude, Qwen Code, an office SGLang server and a laptop llama.cpp server (`config/`).
2. A gate plugin: secret scan, diff-size and path check, and a two-failure return (`plugins/`).
3. A usage plugin and an OTel/Prometheus/Grafana stack (`deploy/usage/`).
4. A routing table that maps a task to a provider (`config/routes/routes.template.json`).
5. A laptop pre-flight and install scripts for Windows and Linux (`deploy/laptop/`, `setup.ps1`, `setup.sh`).

Users are developers who run several AI clients and want one hand-off path between them.

## How it's put together

A client sends a task to the Paseo daemon through the MCP client config (`config/mcp/clients.template.json`). The routing table picks a provider, the provider works on a branch, and the gate plugin checks the result (secret scan, diff size and path check). After two gate failures the task returns to the caller with the verdict. A passing task returns the verdict plus the diff. The usage plugin emits OTel metrics that Prometheus scrapes and Grafana shows.

This repo holds no server of its own. The only code run locally is `scripts/check-config.mjs` (every JSON template parses and holds placeholders only) and `scripts/scan.mjs` (no internal hosts, paths or secrets in tracked files). Real values live outside the repo; templates use placeholders such as `<OFFICE_QWEN_URL>`. The design is in `specs/001-agent-hub/` (spec.md, plan.md, tasks.md).

## Tech stack

| Layer | Technology | Key details |
| --- | --- | --- |
| Runtime | Node >= 20, ESM scripts | `package.json` `type: module`; `test`/`lint`/`build` run `scripts/check-config.mjs`, `scan` runs `scripts/scan.mjs` |
| Daemon | Paseo (github.com/getpaseo/paseo) | Configured and extended here; credited in `NOTICE` |
| Config | JSON templates in `config/` | `<PLACEHOLDERS>` only, never real hosts or secrets |
| Plugins | `plugins/` | Gate (secret scan, diff size and path check, two-failure return) and usage |
| Observability | OTel, Prometheus, Grafana | `deploy/usage/` |
| Task runner | `just` | Windows PowerShell and Linux sh; `setup.ps1` / `setup.sh` install the toolchain |
| Specs | spec-kit | `specs/001-agent-hub/`, `.specify/` |
| License | Apache-2.0 | `LICENSE`, `NOTICE` |

## Related docs

| Doc | Why |
| --- | --- |
| [getting-started.md](../02-setup/getting-started.md) | Set the project up from zero |
| [project-layout.md](../05-reference/project-layout.md) | The annotated file tree |
