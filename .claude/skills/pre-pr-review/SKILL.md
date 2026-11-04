---
name: pre-pr-review
description: Use when the developer says 'pre-pr review', 'review my branch', 'audit my work', or 'self review' — self-reviews the current branch's diff against this project's stack checklist before opening a PR, then saves a report to .claude/workspace/reports/pr/.
model: sonnet
---

# Pre-PR Review (Self-Audit)

Triggers: "pre-pr review", "self review", "review my branch", "review my work", "review my code",
"audit my work", "audit my branch".

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `pre-pr-review` agent (`.claude/agents/pre-pr-review.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "pre-pr-review", model: "sonnet",
      description: "Pre-PR self-review",
      prompt: "<the developer's request verbatim> | Scope: <branch/base or 'report only' if the developer said so>")
```

Relay the agent's review (the `## Pre-PR Review` block and the saved-report path) as it returns it.
