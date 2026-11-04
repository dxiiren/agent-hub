# Re-sweeping the aitmpl catalog

How to check [app.aitmpl.com](https://app.aitmpl.com/) (the `davila7/claude-code-templates` repo,
MIT) for things this skeleton - or a project scaffolded from it - should adopt. Last full sweep:
2026-10-03 at upstream `8b1f883` (four repos, ~2,030 items each, every row verifier-checked).

## 1. Get the catalog

```bash
git clone --depth 1 https://github.com/davila7/claude-code-templates <scratch>/claude-code-templates
git -C <scratch>/claude-code-templates rev-parse HEAD     # record this SHA - every row cites it
```

Clone into a scratch folder, never into the project. Item locations:

| Category | Where | One item is |
| --- | --- | --- |
| skills | `cli-tool/components/skills/<cat>/<name>/SKILL.md` | a folder (nested parents count too) |
| agents | `cli-tool/components/agents/<cat>/*.md` | a file |
| commands | `cli-tool/components/commands/<cat>/*.md` | a file |
| hooks | `cli-tool/components/hooks/<cat>/*.json` (+ companion scripts) | a `.json` |
| settings | `cli-tool/components/settings/<cat>/*.json` | a `.json` |
| MCPs | `cli-tool/components/mcps/<cat>/*.json` | a `.json` |
| mods | `cli-tool/components/mods/<cat>/<name>/` | a folder |
| loops, sandbox | `cli-tool/components/loops/`, `.../sandbox/` | a file / a folder |
| plugin marketplaces | `dashboard/public/plugins.json` | an entry |
| project templates | `docs/components.json` -> `templates` | an entry |

Count each category first and keep the numbers: the triage must account for every item.

## 2. Triage - one table per repo

Read every item (at least its frontmatter and enough body to judge). Fan out: one sonnet subagent per
category slice, each returning rows for every repo in scope.

**ADOPT only when ALL hold:** it fills a real gap today or will plausibly be used soon; it works on
the repo's stack and on Windows 11 + Git Bash/PowerShell + `just` + GitHub Actions; it needs no paid
account or secret; it is not a duplicate. A near-duplicate is REJECT - but MERGE its useful part
into the existing skill/agent/hook and say so in the reason. There is no cap.

**Off-stack** (named in a per-sub-category list instead of its own row) is ONLY for another
language/runtime/platform or a paid account/secret. Everything else gets a row with a true,
checkable reason - "no plausible use: <why>" is a REJECT reason, not an off-stack one. Three
verifier rounds in 2026-10 failed on exactly this.

Write a coverage script that enumerates upstream items and checks each is a row or a named
off-stack entry; it must print 0 missing before review.

## 3. Verify, then adopt

- A fresh sonnet `verifier` per table: re-opens >= 20% of REJECTs at random (seed printed), EVERY
  ADOPT, and reconciles the counts itself. Only a PASS makes the table final.
- Every ADOPT and every merge becomes a work row: adapt, never paste (`just` recipes, this repo's
  conventions), one attribution line per adopted file:
  `Adapted from claude-code-templates <path> @ <sha>, MIT, (c) 2025 Daniel (San) Avila`
  (check the item's own licence - some folders are Apache-2.0).
- A new skill is born in the agent + shim form (below) - `audit-skills` fails otherwise.

## 4. The skill -> agent convention this sweep enforces

Every `.claude/skills/<name>/SKILL.md` is a thin shim whose first action is
`Agent(subagent_type: "<name>", model: "sonnet")`; the procedure lives in `.claude/agents/<name>.md`
(`model: sonnet`, least-privilege `tools:`). Interactive steps (AskUserQuestion, owner approval) stay
in the shim - a subagent cannot ask the user. An optional skill keeps its agent beside it as
`.claude/skills-optional/<name>/agent.md` and `/ground-project` moves it into `.claude/agents/` when
the skill is enabled. A skill loaded byte-for-byte by a production app is RUNTIME-LOCKED: never
shimmed, listed in `audit.py`'s `RUNTIME_LOCKED`, its agent a dev-only by-name helper.
