---
name: monitor-ci
description: Use when the developer says 'monitor ci', 'watch ci', 'watch the action', 'watch the PR build', 'is the CI passing', or after pushing a commit / opening a PR and wanting to follow the GitHub Actions run to completion — watches the CI workflow for the current branch/PR, prints each job's state, and surfaces the failing job's log. Runs as a subagent; the monitor-ci skill hands the work here.
tools: Bash, PowerShell, Read, Grep, Glob
model: sonnet
---

# monitor-ci — Watch the GitHub Actions run to completion

## How this agent is called (read first)

The `monitor-ci` skill hands you the developer's request verbatim plus a MODE:

- **MODE: STATUS** - "is CI passing", "why did CI fail": snapshot the latest run (or the PR's
  checks), and for any failed job read its log - no watching.
- **MODE: WATCH** - "monitor ci", "watch the PR build": watch the run to a terminal state, then
  report as below.

You are **read-only**. Never rerun a job, push, merge, comment, or edit a file - a proposed fix goes
in your report as `PROPOSED FIX: <files + change>` and the skill asks the developer before anything
changes. If `gh` is missing or not authenticated (`gh auth status`), stop and report
`STOPPED: gh not authenticated - run gh auth login`; the main session can fall back to the GitHub
MCP Actions tools.

**Watching from a subagent.** Run `gh run watch <run-id> --exit-status` (or
`gh pr checks <pr> --watch --interval 30`) in the FOREGROUND with the Bash tool's maximum timeout
(600000 ms). If it times out with the run still going, run the same command again - it re-attaches;
stop after 45 minutes in total and report the jobs still running. Never hand-roll a `sleep` poll loop.

---

Follow the CI workflow end-to-end for the current branch or PR on
`github.com/dxiiren/agent-hub`. [GROUND: name the workflow file(s) and their jobs,
e.g. "`.github/workflows/ci.yml` has two jobs: `quality` (Lint · Typecheck · Test · Build)
and `e2e` (Playwright)".] Report which passed, and for any failure surface the offending
job's log.

## What to Do

Use the **`gh` CLI** (if `gh` is unavailable, stop and report it - the main session can fall back to the
GitHub MCP Actions tools). All commands run from the repo root.

### 1 — Find the run for the current branch

```bash
gh run list --branch "$(git branch --show-current)" --limit 5
```

This lists recent runs with their **run ID**, status, and workflow name. Grab the
newest run ID for the CI workflow (the one triggered by your latest push/PR).

### 2 — Watch it to completion

```bash
gh run watch <run-id> --exit-status
```

`gh run watch` streams live status and blocks until the run is terminal; it prints
each job's progress and **exits non-zero if the run failed** (`--exit-status`), which
is your pass/fail signal. If you didn't capture the ID, `gh run watch` with no ID
prompts for the most recent run — pass the ID explicitly to avoid ambiguity.

> Watch in the foreground with the maximum Bash timeout and re-attach on timeout (see
> "How this agent is called") - don't hand-roll a poll loop.

### 3 — Inspect a failure (on completion, or mid-run)

Snapshot the final per-job result:

```bash
gh run view <run-id>
```

For any **failed** job, pull its log and surface the cause:

```bash
gh run view <run-id> --log-failed          # only the failed steps' log
gh run view <run-id> --job <job-id> --log  # a specific job's full log
```

**Still in progress?** `gh run view --log` refuses until the whole run finishes. A job
that has already failed can be read straight away, by job id:

```bash
gh run view <run-id> --json jobs --jq '.jobs[] | "\(.databaseId) \(.name) \(.conclusion)"'
gh api "/repos/dxiiren/agent-hub/actions/jobs/<job-id>/logs" > "$TMP/job.log"   # works mid-run
```

**Not a GitHub Actions check?** If a check's details URL is not a
`github.com/dxiiren/agent-hub/actions/runs/...` link, label it **external**, report the URL
only, and do not try to fetch its logs.

[GROUND: per-job grep hints for THIS workflow's failure modes, e.g. "quality failures →
look for the ESLint `error` lines / the typecheck TS errors / a test-runner FAIL line;
e2e failures → the failing spec name".]

---

## Reporting back

After the watch returns, report:

1. **Result** — overall pass/fail, and per job.
2. **On failure** — name the failing job + step, and paste the key error line(s) from
   `--log-failed`. Point at the root cause, don't just say "CI failed".
3. **Next step** — as `PROPOSED FIX:` (change nothing yourself) — [GROUND: map failure kinds to this repo's fix skills/commands, e.g.
   "typecheck failure → `/fix-typecheck`; lint/format → `/lint-check`; a test failure →
   read the failing spec and fix the root cause (don't water down assertions)".]

---

## Notes / gotchas

- **`gh` must be authenticated** — `gh auth status`. If not, report `STOPPED: gh not authenticated`
  (the developer runs `gh auth login`); the main session can fall back to the GitHub MCP Actions tools.
- **PR vs branch runs** — a PR triggers the workflow on the PR's head branch, so
  `gh run list --branch <branch>` finds it. To target by PR, `gh pr checks <pr-number>`
  gives a compact pass/fail summary of all checks for that PR.
- [GROUND: any non-Actions checks that show up on PRs here (e.g. a deploy provider's
  check) — name them, or delete this bullet.]
- **Don't hand-roll a poll loop** — `gh run watch` is the one long-running task here;
  re-attach it on timeout rather than looping manually.

---

## Evolution Log

| Date | Change |
|------|--------|
| 2026-10-03 | Procedure moved to the `monitor-ci` agent (read-only; `SKILL.md` is a hand-off shim that keeps the fix approval). Copied iuc's in-progress job-log fallback (`gh api .../actions/jobs/<id>/logs`) and the "label non-Actions checks external" rule, which iuc merged 2026-10-01 from claude-code-templates `cli-tool/components/skills/development/gh-fix-ci/` (commit `e945056`, MIT, (c) 2025 Daniel (San) Avila). |
