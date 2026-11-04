# Project Layout — Agent Hub

> **TL;DR** — the code lives in `scripts/` (checks), `plugins/` (gate and usage) and `deploy/` (install scripts); the data is `config/` templates.

## Annotated tree

```
agent-hub/
├── config/              JSON templates with <PLACEHOLDERS> (daemon config, MCP clients, routes, claude-clean settings)
├── scripts/             check-config.mjs (validates every template), scan.mjs (internal host/path/secret scan)
├── plugins/             gate and usage plugins (land per specs/001-agent-hub/tasks.md)
├── deploy/
│   ├── laptop/          laptop pre-flight and llama.cpp server setup
│   ├── usage/           OTel / Prometheus / Grafana stack
│   └── server/          server-side install
├── ci/                  CI workflow files
├── specs/001-agent-hub/ spec-kit: spec.md, plan.md, tasks.md
├── .specify/            spec-kit templates and scripts
├── .docs/               developer docs (start at tldr.md)
├── .claude/             Claude Code kit (skills, agents, hooks, settings)
├── justfile             daily recipes (Windows PowerShell and Linux sh)
├── setup.ps1 / setup.sh toolchain install (Windows / Linux)
├── package.json         Node >=20, ESM; test/lint/build/scan scripts
├── LICENSE / NOTICE     Apache-2.0; NOTICE credits Paseo
└── README.md / CLAUDE.md
```

`config/` is the contract: templates only, with `<PLACEHOLDERS>` for every host, URL and key. `scripts/` validates and scans them. `plugins/` extends the Paseo daemon. `deploy/` holds one folder per target machine. `specs/001-agent-hub/` is the design and the task list.

## Related docs

| Doc | Why |
| --- | --- |
| [project-overview.md](../01-overview/project-overview.md) | What the app in this tree does |
| [commands.md](commands.md) | The recipes that operate on it |
