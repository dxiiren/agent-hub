# Development Workflow — Agent Hub

> **TL;DR** — edit a template or script, run `just test`, run `just scan` before a push,
> then `/commit` and `/create-pr`.

## The daily loop

1. `just deps` after pulling (when `package.json` changed).
2. Edit a file under `config/`, `scripts/`, `plugins/` or `deploy/`.
3. `just test` to validate every config template.
4. `just scan` to catch internal hosts, paths and secrets.
5. Commit with `/commit`.

All commands are `just` recipes; never invent an alternative for something a recipe covers.

## Quality gates

- `just test`, `just lint` and `just build` all run `scripts/check-config.mjs`; green is exit 0 and no error lines.
- `just scan` runs `scripts/scan.mjs`; green is exit 0 with no findings.

There is no separate linter or unit-test runner yet; plugin tests are added per `specs/001-agent-hub/tasks.md`.

## Git conventions

- Conventional Commits; use the `/commit` skill.
- Branch off `main`; open PRs with `/create-pr`; self-review with `/pre-pr-review`.
- NEVER add attribution trailers (`Co-Authored-By`, "Generated with Claude Code",
  session links) to any outward artifact.
- Full rules: [conventions.md](../05-reference/conventions.md).

## Claude Code

Project skills live in `.claude/skills/` (catalog: `.claude/skills/README.md`). Follow
the relevant skill before writing code. MCP servers are wired via `.mcp.json.stub` →
git-ignored `.mcp.json` (`/setup-mcp`, `/test-all-mcp`). `just claudex`, `just claudeo` and `just claudeh` launch Claude Code on Sonnet, Opus and Haiku.

## Related docs

| Doc | Why |
| --- | --- |
| [commands.md](../05-reference/commands.md) | Every recipe in detail |
| [conventions.md](../05-reference/conventions.md) | The family-wide invariants + git rules |
