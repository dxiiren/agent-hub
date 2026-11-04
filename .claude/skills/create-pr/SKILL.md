---
name: create-pr
description: Use when the developer says 'create pr', 'create pull request', 'open a PR', 'PR this branch', or 'submit for review' — pushes the current feature branch to GitHub, builds a Conventional-Commits title and a clean PR body (Summary / Changes / Testing) with NO attribution footer, and opens the PR into `main` via `gh pr create` (or the GitHub MCP).
model: sonnet
---

# Create PR — Push branch, open a GitHub PR into `main`

Triggers: "create pr", "create pull request", "open a PR", "PR this branch", "PR for this work",
"submit for review".

The procedure lives in the `create-pr` agent (`.claude/agents/create-pr.md`). Hand the work to
it at once - do not check the preconditions, push or open the PR yourself, even when the tree
looks dirty or the branch looks empty: the agent checks every precondition and reports the one
that stops it (a DRY RUN included). The ONE step that stays here is the question about a PR that
is already open, because a subagent cannot ask the developer.

```
Agent(subagent_type: "create-pr", model: "sonnet",
      description: "Push the branch and open a PR",
      prompt: "<the developer's request verbatim>. <add DRY RUN if they asked for one>")
```

If the agent returns `EXISTING PR: <url> ...`, show it and ask: **A)** push new commits + let it
update, or **B)** stop. On A:

```
Agent(subagent_type: "create-pr", model: "sonnet",
      description: "Push new commits to the open PR",
      prompt: "EXISTING PR: A. <the original request verbatim>")
```

Relay the agent's report: PR URL and number, branch, base, commit count, title - or the
precondition it stopped on (dirty tree -> `/commit` first, on the base branch -> branch first).
Relay the agent's CI line as is (whether there are checks to wait for).
