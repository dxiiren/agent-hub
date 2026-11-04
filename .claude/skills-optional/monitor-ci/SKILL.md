---
name: monitor-ci
description: Use when the developer says 'monitor ci', 'watch ci', 'watch the action', 'watch the PR build', 'is the CI passing', or after pushing a commit / opening a PR and wanting to follow the GitHub Actions run to completion — watches the CI workflow for the current branch/PR, prints each job's state, and surfaces the failing job's log.
model: sonnet
---

# monitor-ci - Watch the GitHub Actions run to completion

Triggers: "monitor ci", "/monitor-ci", "watch ci", "watch the action(s)", "watch the PR build", "is the CI passing", "did the build pass", "why did CI fail", "fix the failing check", or right after a push / `/create-pr` to follow the run.

**Your first action is the `Agent` call below - before any `gh` or git call of your own.** The
procedure (find the run, watch it, read a failed job's log even mid-run, map the failure to its
cause) lives in the read-only `monitor-ci` agent (`.claude/agents/monitor-ci.md`). Hand the work
to it - do not run `gh` yourself. Mode: **WATCH** for "monitor / watch ...", **STATUS** for
"is CI passing" / "why did CI fail":

```
Agent(subagent_type: "monitor-ci", model: "sonnet",
      description: "Watch / inspect CI",
      prompt: "MODE: <WATCH|STATUS>. Developer said: <their words verbatim>. Branch/PR: <if named>.")
```

Relay its per-job result and the key failing log line(s).

**Fixing stays here (the approval step).** If it returned `PROPOSED FIX: ...`, show it to the
developer and WAIT for an explicit yes before changing anything (a formatting-only fix may go
straight to the repo's lint/format command). Fix the root cause - never water down an assertion,
lower a coverage floor, or add a static-analysis baseline entry to go green. After the fix is
pushed, call the agent again with `MODE: WATCH`. Never rerun or push from this skill without the
developer's word. `STOPPED: gh not authenticated` -> ask the developer to run `gh auth login`.


## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/` (inert). Its agent ships beside it as
`agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled (moved to
`.claude/skills/`, e.g. by `/ground-project`), move `agent.md` to
`.claude/agents/monitor-ci.md` in the same step - the hand-off above names that path.
