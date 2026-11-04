---
name: ground-project
description: "Use when the developer says '/ground-project', 'ground project', 'ground the kit', or 'finish scaffolding' — the one-time intelligent pass after init.ps1: reads the conventions doc + the project's real code, fills every remaining content token in CLAUDE.md/README/.docs, grounds the core skills' GROUND: ... markers in real code facts, enables qualifying optional skills, runs the skill audit to PASS, and boot-verifies the project. Runs as a subagent; the ground-project skill hands the work here."
tools: Read, Grep, Glob, Bash, PowerShell, Edit, Write
model: sonnet
---

# ground-project — finish the scaffold with real code facts

`init.ps1` did the mechanical half (stack files in place, mechanical tokens filled). This
agent does the intelligent half: everything that requires actually READING this project.
It runs once per project; when it finishes there are no content tokens and no
`GROUND: ...` markers left anywhere except the token table inside
`.docs/05-reference/conventions.md`.

## How this agent is called (read first)

The `ground-project` skill hands you the developer's request verbatim. If it says **PLAN ONLY**
(or "dry run", "change nothing"), do Step 0 and the Step 1-3 sweeps read-only, then report the
worklist you WOULD fill (file -> token/marker -> the fact you would put there), the optional skills
you would enable and why, and edit, move or run NOTHING else (no `setup.ps1`, no `just start`).
Otherwise run every step below. You never commit.

## Step 0 — Read the ground truth first

1. **`.docs/05-reference/conventions.md`** — the invariants, token table, boot-verify
   table, and git rules for this project family. Everything below defers to it.
2. **`.docs/05-reference/stack-notes.md`** — this stack's field-proven gotchas.
3. **The project's actual code** — entry points, `package.json`/`composer.json` scripts,
   routes/pages/classes, DB usage, existing README content. Write down 3–6 real facts
   (features, models, pages, commands) — these feed every fill below. If the repo had a
   pre-existing README with unique content, fold it into `.docs/01-overview/` — never
   discard information.

## Step 1 — Fill every remaining content token

Sweep first so you know the full worklist:

```bash
grep -rnI "@[@]" --exclude-dir=node_modules --exclude-dir=vendor --exclude-dir=.git .
```

Fill each hit from your Step-0 reading (token names below are written without their
doubled-at-sign delimiters so this file stays sweep-clean; definitions live in the
conventions token table):

- **CLAUDE.md** — `WHAT_IT_IS`, `STACK_TABLE_ROWS`, `LAYOUT_TREE`,
  `TOOLCHAIN_SUMMARY`, `BOOTSTRAP_LINE`, `DEV_GOTCHAS` (real gotchas or
  delete the line).
- **README.md** — `WHAT_IT_IS`, `PREREQ_ROWS`, `QUICKSTART_STEPS`,
  `COMMANDS_ROWS` (rows for THIS justfile's daily recipes),
  `TROUBLESHOOTING_H3S` (write after Step 5's boot-verify — real symptoms only),
  `LAYOUT_TREE`, `LICENSE_SECTION` (only if a LICENSE **file** exists, else
  delete the line). CLI stacks (no port): replace the server-shaped
  "app is now at http://..." / `just stop` sentences with build-run equivalents; keep
  every section heading.
- **`.docs/`** — every placeholder doc: keep the TL;DR-opener + Related-docs-table
  shape, replace the placeholder bodies and `GROUND: ...` markers with real content.
  Write `06-troubleshooting/common-issues.md`, `07-faq/faq.md`, and `tldr.md` LAST —
  after boot-verify, so they contain the real symptoms you hit. Update the `.docs/README.md`
  index tables to describe what each doc now actually covers.
- **justfile** — prune recipes whose underlying script doesn't exist; add `lint`/`test`/
  `format` recipes for scripts that do (per stack-notes). Keep every invariant
  (summary comment LAST, project-scoped stop, claudex tail).

## Step 2 — Ground the core skills

Grep the skills AND the agents for the markers (most core skills are thin shims whose procedure
lives in `.claude/agents/<name>.md`, so that is where most markers now sit; this skill's own
folder and this agent's file are excluded — their instructions legitimately mention the marker):

```bash
grep -rn "GROUND:" .claude/skills/ .claude/agents/ --exclude-dir=ground-project --exclude=ground-project.md
```

Resolve every `GROUND: ...` in the core skills and their agents with THIS project's facts — worked
examples, scope tables, verification commands, checklist rows. Keep each SKILL.md's
(and agent's) structure and flow intact (they are battle-tested); you are localizing content, not
redesigning. In particular:

- **commit** — real scope table from this repo's layout; hooks note (this kit ships no
  pre-commit framework unless the project already has one).
- **create-pr / pre-pr-review / lint-check** — real verification commands (`just ...`,
  probe URL or build-run), a stack-appropriate review checklist, the real quality layers.
- **verify-before-claim** — how THIS project is started and exercised for live evidence:
  the start command plus its readiness check (or the build + run pair for a CLI stack with
  no server), the exact local app URL and the routes that exercise changed behaviour, the
  stop command plus the orphaned-process check, how to reach the data store (or "no data
  store"), and this repo's source globs for the missed-call-path sweep.
- **define-goal (+ references) / claude-transfer / llm-transfer** — bootstrap commands,
  evidence examples, personas, and the worked examples rewritten around this repo.
- **setup-just** — the real recipe table read off this project's root `justfile`, and the
  cheapest safe recipe to smoke-test after install (never a long-running or destructive one).
- **setup-mcp / test-all-mcp** — registry purposes and check prompts already carry the
  repo slug/port from init; verify they read correctly for this stack (e.g. the
  playwright check's target URL, or "no server" for CLI stacks).

## Step 3 — Evaluate and enable optional skills

For each folder in `.claude/skills-optional/`, check its prerequisite in the real code:

| Skill | Prerequisite |
| --- | --- |
| monitor-ci | CI workflow files exist (`.github/workflows/` or equivalent) |
| generate-playwright-tests | a Playwright dependency or config exists |
| fix-typecheck | a typecheck script or `tsconfig.json` exists |
| fix-phpstan | phpstan/larastan in `composer.json` |
| update-or-create-docs | always recommend once `.docs/` has real content — enable it |
| audit-pagespeed | the project serves a **web page on a public URL** (PageSpeed cannot reach `localhost`) |
| supply-chain-audit | a lockfile or dependency manifest exists (`package-lock.json`, `uv.lock`, `composer.lock`, `pom.xml`, ...) or a `Dockerfile` / `.github/workflows/` |
| dependabot-review | `.github/dependabot.yml` exists |

Qualifying skill → **move** its folder into `.claude/skills/` — if it ships an `agent.md`,
move that to `.claude/agents/<name>.md` in the same step (the skill's hand-off names that path) —
then resolve its `GROUND: ...` markers (SKILL.md and the moved agent), and add its catalog row in `.claude/skills/README.md`.
Non-qualifying skills **stay in `skills-optional/`** (keep the folder) — the catalog's
"Optional skills" section already notes they are inert; update that table if you moved
any out.

## Step 4 — Audit until PASS

```bash
uv run --no-project python .claude/skills/audit-skills/audit.py
```

Fix whatever it reports (registration rows, frontmatter, models, BOMs) and re-run until
`RESULT: PASS`. Do not weaken the script.

## Step 5 — Boot-verify

Follow the boot-verify row for this stack in `conventions.md`:
`pwsh ./setup.ps1` (expect all-`[OK]`; fix template-level breakage, budget 30 min / 3
attempts) → `just start` or `just build`+`just run` → probe per the table → `just stop`
→ confirm no orphaned project process → re-run `pwsh ./setup.ps1` (must be an all-`[OK]`
no-op). Feed every real symptom into `06-troubleshooting/common-issues.md` and the
README's `TROUBLESHOOTING_H3S` fill. Check `git status` afterwards — git-ignore anything the app
wrote at runtime.

## Step 6 — Final sweep + summary

1. Re-run the `@[@]` sweep and the `GROUND:` grep over BOTH trees
   (`grep -rn "GROUND:" .claude/skills/ .claude/agents/ --exclude-dir=ground-project --exclude=ground-project.md`)
   — the ONLY remaining hits must be `.docs/05-reference/conventions.md` (its token table +
   marker documentation), this skill's own SKILL.md and this agent's file
   `.claude/agents/ground-project.md` (their instructions).
2. Report: the 3–6 repo facts you grounded on · every file whose tokens/markers you
   filled · optional skills enabled (and why) vs left inert · audit result ·
   boot-verify evidence (commands + probe output) · anything degraded or deferred, with
   its `.docs/06-troubleshooting` entry.

Do NOT commit — present the summary and let the developer review, then `/commit`.

## Anti-patterns

- **Never** fill a token or marker from memory/guesswork — every fact comes from a file
  you read or a command you ran this session.
- **Never** leave a `GROUND: ...` marker or content token behind (conventions.md's
  token table is the sole exception).
- **Never** break an invariant while localizing (log tags, guard pattern, justfile rules,
  `.docs` structure, docs style).
- **Never** skip boot-verify — troubleshooting docs written without it are fiction.
- **Never** auto-commit the grounding.
