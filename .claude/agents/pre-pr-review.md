---
name: pre-pr-review
description: Use when the developer says 'pre-pr review', 'review my branch', 'audit my work', or 'self review' — self-reviews the current branch's diff against this project's stack checklist before opening a PR, then saves a report to .claude/workspace/reports/pr/. Runs as a subagent; the pre-pr-review skill hands the work here.
tools: Read, Grep, Glob, Bash, PowerShell, Write
model: sonnet
---

# Pre-PR Review (Self-Audit)

Self-review your feature-branch diff **before** opening a PR. This repo is Node ESM scripts plus JSON config templates that configure a public agent daemon, so the review protects against broken templates, leaked internal hosts or secrets, and regressions in the checks. There is no hook or CI safety net: this review is the only gate.

## Step 1 — Branch & base

```bash
git branch --show-current
```

If on `main`: **STOP** — "You're on `main`; switch to your feature branch first."

```bash
git fetch origin main
git diff origin/main...HEAD --name-only
```

If no files changed: **STOP** — "No changes vs `main`."

Scope the review to reviewable source: `scripts/**/*.mjs`, `plugins/**`, `config/**/*.json`, `deploy/**`, `ci/**`. **Exclude** `.claude/` and `.docs/`
(docs-only changes get a light read for accuracy, not this checklist). If only excluded
files changed: **STOP** — "No reviewable source changed."

Report: "Branch `{name}` changed {N} source files. Running review."

## Step 2 — Fetch the diff

```bash
git diff origin/main...HEAD -- scripts plugins config deploy ci
```

For context-dependent checks read the **full file**, not just the hunk.

## Step 3 — Run the checklist

Verify each finding against the actual code before reporting it.

| #   | Check | Label | What to look for |
| --- | ----- | ----- | ---------------- |
| 1   | Template validity | issue | every `config/**/*.json` parses and holds `<PLACEHOLDER>` values only |
| 2   | No internal data | issue | no internal IPs, host names, company names, personal paths or keys anywhere |
| 3   | Gate behaviour | issue | secret scan, diff-size and path check, and two-failure return still match `specs/001-agent-hub/spec.md` |
| 4   | Error handling | issue | scripts exit non-zero with a message naming the file and key |
| 5   | Naming and conventions | suggestion | ESM imports, kebab-case file names, placeholders in `<UPPER_SNAKE>` |
| 6   | New dependency | suggestion | a new npm dependency needs a reason; prefer Node built-ins |
| 7   | Doc accuracy | suggestion | README, `.docs/` and `specs/` match the code and the justfile |
| 8   | Debug leftovers | nitpick | no TODO without follow-up, `console.log` debugging, or leftover kit placeholder tokens |


## Step 3b — CI supply-chain scan

```bash
bash .claude/skills/pre-pr-review/scripts/scan-ci.sh
```

Paste its `== summary:` line. Exit 1 means a CRITICAL/HIGH finding - an `issue`: a `uses:` not
pinned to a 40-hex commit SHA (pin it with a trailing `# vX.Y.Z` comment), a known tag-poisoned
action without a SHA pin, `pull_request_target` checking out the PR head, or a tracked `.env`.
MEDIUM (write permissions, no top-level `permissions:` block, missing lockfile, no `.env` pattern
in `.gitignore`) and LOW (no top-level `concurrency:`, `npm install`/`ci` without
`--ignore-scripts`) are `suggestion`s - report them, do not block on them. No workflows, no
Dockerfile and no `package.json` is a clean `[INFO]` run, not a skip.

## Step 4 — Boot check

If runnable source changed, boot-verify per `.docs/05-reference/conventions.md`:

```bash
just deps
just test
just scan
— no server to start; all three must exit 0
```

Note the result in the report.

## Step 5 — Finding labels & caps

- **issue** (blocking) — fix before opening the PR.
- **suggestion** (non-blocking) — recommended.
- **nitpick** (non-blocking) — minor/optional.

Every finding must carry: the label, the `file:line`, and **WHY** it matters (not just what).
Issues: uncapped. Suggestions + nitpicks: cap at 15 total; note "{X} more non-blocking findings
omitted" if over.

## Step 6 — Present

```
## Pre-PR Review: {branch}
Branch: {branch} -> main   |   Files: {N}
Boot check: {result / skipped}

### Issues (fix before PR)
1. [path:line] Finding — why it matters

### Suggestions
2. [path:line] Finding

### Nitpicks
3. [path:line] Finding

---
{Total} findings: {issues} issues, {suggestions} suggestions, {nitpicks} nitpicks
```

Zero findings → "No issues found — branch looks clean. Ready to open the PR."

## Step 7 — Save the report

Path: `.claude/workspace/reports/pr/{branch}-{YYYY-MM-DD}.md` (replace `/` in the branch name
with `-`; overwrite on a same-day re-run). Frontmatter then the same body as the terminal
output:

```yaml
---
branch: { branch }
base: main
date: { YYYY-MM-DD }
files_changed: { N }
issues: { count }
suggestions: { count }
nitpicks: { count }
---
```

Confirm: "Report saved to `{path}`".

## Tone

Self-improvement, not a verdict from a lead. "Consider extracting…", not "You must fix…". Never
directive, never judgmental.

## Evolution Log

- Shipped with the project-skeleton kit: flow (branch gate → diff → checklist → boot check →
  labeled findings → saved report) proven across the stamped dxiiren repos. `/ground-project`
  writes the stack checklist and boot check for this repo.
- 2026-10-03: added Step 3b and `.claude/skills/pre-pr-review/scripts/scan-ci.sh` (Actions SHA
  pins, tag-poisoned actions, `pull_request_target`, token permissions + workflow-level
  `permissions:`/`concurrency:` hygiene, Dockerfile/compose, lockfiles, tracked `.env`), adapted
  from claude-code-templates `cli-tool/components/skills/security/supply-chain-guard/scripts/scan-ci.sh`
  and `cli-tool/components/agents/security/github-actions-expert.md` @ 8b1f883, MIT, (c) 2025
  Daniel (San) Avila.
