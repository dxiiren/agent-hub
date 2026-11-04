# CLAUDE.md — agent-hub

> Human-facing developer docs live in [`.docs/`](./.docs/README.md) — start at
> [`.docs/tldr.md`](./.docs/tldr.md). Keep them in sync when changing behavior they document.

## Project: Agent Hub

Agent Hub configures and extends the [Paseo](https://github.com/getpaseo/paseo) agent daemon so that any AI client (Claude Code, Codex, Qoder, OpenCode, Qwen Code) can hand a task to any agent provider (Codex, Qoder, Claude, Qwen Code, an office SGLang server, a laptop llama.cpp server) and get a verdict plus a diff back. It adds provider config templates, a gate plugin (secret scan, diff-size and path check, two-failure return), a usage plugin with an OTel/Prometheus/Grafana stack, a routing table, a laptop pre-flight, and install scripts for Windows and Linux.

- **Repo:** GitHub — `github.com/dxiiren/agent-hub`
- **Config-and-plugins repo** — no dev server and no port; the checks are `just deps && just test`.
  Deploy scripts under `deploy/` target a laptop, a usage host and a server.

### Tech Stack Quick Reference

| Layer | Technology | Key details |
| --- | --- | --- |
| Runtime | Node >= 20, ESM scripts | `package.json` `type: module`; scripts `test`/`lint`/`build` = `scripts/check-config.mjs`, `scan` = `scripts/scan.mjs` |
| Daemon | Paseo (github.com/getpaseo/paseo) | Configured and extended here; credited in `NOTICE` |
| Config | JSON templates in `config/` | `<PLACEHOLDERS>` only, never real hosts or secrets |
| Plugins | `plugins/` | Gate (secret scan, diff size and path check, two-failure return) and usage |
| Observability | OTel, Prometheus, Grafana | `deploy/usage/` |
| Task runner | `just` | Windows PowerShell and Linux sh; `setup.ps1` / `setup.sh` install the toolchain |
| Specs | spec-kit | `specs/001-agent-hub/` (spec.md, plan.md, tasks.md), `.specify/` |
| License | Apache-2.0 | `LICENSE`, `NOTICE` |

### Project Structure

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

## Git Commits

- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:` ...).
- **NEVER** add `Co-Authored-By` lines or "Generated with Claude Code" / session-link footers to
  **any** outward artifact — commit messages, PR descriptions, or issue comments.
- Commit author email: the repo default identity (no per-repo override).
- Only stage and commit files relevant to the change. **Never auto-commit** after a fix — the
  developer says "commit" first.

## Local Development

- No `just` on the machine yet: `powershell -ExecutionPolicy Bypass -File install-just.ps1`
  (winget, with the WinGet `Links` PATH fix), then open a new terminal. `just install` runs `setup.ps1`.
- One-time machine setup: `just install` or `pwsh ./setup.ps1` (idempotent — installs Git, Node LTS,
  just, the Claude Code CLI). Then `just deps`, then `just test`.
- All day-2 commands are `just` recipes — run `just` to list them. Never invent an alternative
  command for something a recipe already covers.
- Public repo: never write internal IPs, host names, company names or personal paths in any file. Use placeholders (`<OFFICE_QWEN_URL>`) and run `just scan` before a push.
- Every JSON under `config/` is a template; `just test` rejects anything that is not a placeholder.

## Project Skills

Development skills live in `.claude/skills/` — check `.claude/skills/README.md` for the catalog
and **follow the relevant skill before writing code**. Notables: `/commit`, `/create-pr`,
`/pre-pr-review`, `/lint-check`, `/claude-transfer`, `/llm-transfer`, `/define-goal`,
`/define-requirements`, `/audit-docs`, `/setup-mcp`, `/test-all-mcp`, `/audit-skills`,
`/setup-just`.

**Every skill hands its procedure to an agent.** Each `SKILL.md` is a thin shim whose first action is
`Agent(subagent_type: "<name>", model: "sonnet")`; the procedure lives in `.claude/agents/<name>.md` (`model: sonnet`).
Interactive steps (owner approval, AskUserQuestion) stay in the shim; `verify-before-claim` maps to `verifier`.
An optional skill keeps its agent beside it (`skills-optional/<name>/agent.md`) until `/ground-project` enables it.
A skill a production app loads byte-for-byte is runtime-locked (never shimmed; list it in `audit.py` `RUNTIME_LOCKED`).
`/audit-skills` FAILS (NO_AGENT) on a skill without its agent. `.claude/agents/` must never ship in an image.

New project or a major new capability with no spec yet? Start at `/define-requirements`
(Discovery → BRD → PRD → FSD → TDD into `.docs/00-requirements/`), then `/audit-docs`, then
`/define-goal` to turn the TDD's build plan into an autonomous run.

## MCP Servers

Wired via the committed-stub + git-ignored-secret pattern: `.mcp.json.stub` (committed,
placeholders) → `.mcp.json` (git-ignored, real — seeded by `setup.ps1`). Turnkey: `context7`
(library docs — call `resolve-library-id` then `query-docs` instead of recalling APIs),
`playwright` (drive a real browser). Per-dev: `github` (fill the PAT in `.mcp.json`).
Health check: `/test-all-mcp`. Fall back to native tools silently if a server is unavailable.

## Memory

Lightweight, single-developer, file-based project memory at `.claude/memory/`:

- **`MEMORY.md`** is the index (one line per memory: `- [Title](file.md) — hook`), loaded each
  session.
- Each memory is **one fact in its own `*.md` file** with frontmatter (`name`, `description`,
  `metadata.type` = `reference` | `feedback` | `project`). Read the fact file on demand when its
  index hook is relevant.
- After writing a fact file, add its one-line pointer to `MEMORY.md`. Update rather than
  duplicate; delete a memory that turns out wrong. Don't store what the repo already records.

## Workflow Orchestration

### 1. Plan Mode Default

- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions).
- If something goes sideways, STOP and re-plan immediately — don't keep pushing.
- Use plan mode for verification steps, not just building.
- Write detailed specs upfront to reduce ambiguity.

### 2. Subagent Strategy

- Use subagents liberally to keep the main context window clean.
- Offload research, exploration, and parallel analysis to subagents.
- For complex problems, throw more compute at it via subagents.
- One task per subagent for focused execution.
- Parallelize independent sub-tasks in a SINGLE message with multiple Agent calls; go sequential
  only when one sub-task's result feeds the next.

### 3. Self-Improvement Loop

- After ANY correction from the developer: capture the *pattern*, not just the instance.
- Write rules for yourself that prevent the same mistake recurring.
- Ruthlessly iterate on these lessons until the mistake rate drops.
- Review lessons at session start — that is what `.claude/memory/MEMORY.md` is loaded for.
- Persist every correction as a `metadata.type: feedback` memory (see **Memory** above). A
  correction that only changes the current session is a correction lost.

### 4. Verification Before Done

- The bar is **Verification Rules** below — live evidence only. Never mark a task complete
  without proving it works.
- Diff behavior between the base branch and your changes when relevant.
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness.

### 5. Demand Elegance (Balanced)

- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution."
- Skip this for simple, obvious fixes — don't over-engineer.
- Challenge your own work before presenting it.

### 6. Autonomous Bug Fixing

- When given a bug report: just fix it. Don't ask for hand-holding.
- Point at logs, errors, failing tests -> then resolve them.
- Zero context switching required from the developer.
- Go fix failing CI tests without being told how.

## Task Management

1. **Plan First**: write the plan as checkable items before implementing.
2. **Verify Plan**: check in before starting implementation.
3. **Track Progress**: mark items complete as you go.
4. **Explain Changes**: high-level summary at each step.
5. **Document Results**: add a review section when the work is done.
6. **Capture Lessons**: persist the correction after any course-change.

Run these on the machinery this skeleton already ships — `TodoWrite` for in-session tracking,
`.claude/checklist/{topic}/` (via `/define-goal`) for durable multi-session plans, and
`.claude/memory/` for step 6. Do NOT introduce a parallel `tasks/todo.md`; a second tracker that
nothing reads is worse than none.

## Core Principles

- **Simplicity First**: make every change as simple as possible. Impact minimal code.
- **No Laziness**: find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: changes should only touch what's necessary. Avoid introducing bugs.

## Verification Rules

- A change is UNPROVEN until it has been exercised against the actually-running system: a live
  browser / Playwright run, a real HTTP call, a real login, or the real deployed environment.
- These do NOT count as verification: mocked unit tests, `git log` greps, a green build, or "the
  deployment is present".
- If verification is blocked (VPN down, host unreachable, auth failing), say so explicitly and mark
  the item **UNVERIFIED**. Never report success you could not prove.

## Source of Truth

- Check live state BEFORE reading documentation: query the actual DB, the actual running
  container/service, and the branch that is actually deployed. Repo docs and migration notes go
  stale.

## Autonomy & Merging

- I have admin access via the GitHub API. Do not stall on branch protection, approvals, or
  "which branch should I use" — pick the safe default (a new worktree off the target branch), state
  the choice in one line, and proceed.
- Ask ONLY when the action is destructive and irreversible: force-push, branch or repo deletion,
  history rewrite on a protected branch, or DDL/writes on a shared database.

## Output Style

- Lead with a one-line summary, then short numbered sections.
- Keep findings and analysis OUT of dense multi-column tables. Tables are for tabular DATA (report
  grids, status matrices) — never for burying conclusions the reader must act on.
- Use mermaid for flows, and a table of contents for any document over ~100 lines.

## Windows/Env Gotchas

- Prefix git commands taking a `<rev>:<path>` argument with `MSYS_NO_PATHCONV=1` — Git Bash mangles
  the path half otherwise.
- Use `plink -batch`, or pre-accept the host key, before any SSH automation. An interactive
  host-key prompt hangs the run.
- Never hardcode `$HOME\Downloads` or any personal path in a script handed to teammates. Test every
  copy-paste one-liner before documenting it.

**Secret files are deny-listed** in `.claude/settings.json` (`Read`/`Edit` of `.env`, `.env.local`, `.env.*.local`, `.env.development`, `.env.production`, `.env.staging`, `.env.test` - not `.env.example` - plus `*.pem`, `*.key`, `id_rsa*`, `credentials.json`; any other `.env.*` name is NOT covered, so add it before you create one) - adapted from claude-code-templates `cli-tool/components/settings/permissions/deny-sensitive-files.json` @ 8b1f883, MIT, (c) 2025 Daniel (San) Avila. The `secret_scanner.py` and `no_force_push.py` PreToolUse hooks sit beside it.
