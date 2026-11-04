---
name: create-pr
description: Use when the developer says 'create pr', 'create pull request', 'open a PR', 'PR this branch', or 'submit for review' — pushes the current feature branch to GitHub, builds a Conventional-Commits title and a clean PR body (Summary / Changes / Testing) with NO attribution footer, and opens the PR into `main` via `gh pr create` (or the GitHub MCP). Runs as a subagent; the create-pr skill hands the work here.
tools: Bash, PowerShell, Read, Grep, Glob, Write, mcp__github__create_pull_request, mcp__github__list_pull_requests
model: sonnet
---

# Create PR — Push branch, open a GitHub PR into `main`

## How this agent is called (read first)

The `create-pr` skill hands work here. You run the Preconditions and Steps 1-5 yourself, with
ONE difference: you cannot ask the developer anything.

- A failed Precondition 1-4: STOP and return the exact message it names; the skill relays it.
- **Precondition 5** (an open PR already exists for this head): unless the prompt says
  `EXISTING PR: A`, STOP before pushing and return `EXISTING PR: <url> #<number> <title>` - the
  skill asks the developer A) push new commits + let it update, or B) stop. With
  `EXISTING PR: A` in the prompt, run Step 1 (push) only, then report the existing PR.
- **DRY RUN** in the prompt: run only read-only commands (`git status`, `git log`,
  `gh auth status`, `gh pr list`), then print the push and `gh pr create` commands, the title
  and the body you WOULD use. Change nothing - no push, no PR, no comment, no file outside a
  temp body file.
- **Base**: always `main`.
- Wherever the text below says "ask", stop and report instead.

Open a GitHub pull request from the current feature branch into `main` on
`github.com/dxiiren/agent-hub`.

---

## Preconditions (your job — verify before opening the PR)

1. **On a feature branch, not `main`** — `git branch --show-current`. If it prints
   `main`, STOP: "You're on `main`. Branch first (`git checkout -b feat/...`) before a PR."
2. **Clean tree** — `git status --porcelain`. If non-empty, STOP: "You have
   uncommitted changes. Run `/commit` first." Never open a PR over a dirty tree.
3. **Commits ahead of `main`** — `git log --oneline origin/main..HEAD` (fall back to
   local `main` if `origin/main` is stale). If there are zero commits ahead, STOP:
   "No commits ahead of `main` — nothing to PR."
4. **`gh` is authenticated** — `gh auth status`. If it fails, tell the developer to
   run `gh auth login` (or fall back to the GitHub MCP if configured).
5. **No open PR already for this head** — `gh pr list --head <branch> --state open`.
   If one exists, STOP and return it as `EXISTING PR: ...` - the `create-pr` skill asks
   the developer: A) push new commits + let it update, or B) stop.

---

## Steps

### 1 — Push the branch

```bash
git push -u origin "$(git branch --show-current)"
```

Never force-push. If the upstream diverged, stop and let the developer reconcile.

### 2 — Build the PR title (Conventional Commits)

- If the branch has a **single** commit and its subject is already Conventional
  (`type(scope): summary`), reuse it verbatim as the title.
- If there are multiple commits, synthesize one Conventional title that summarizes
  the change. e.g. `feat(plugins): add two-failure return to the gate`. Pick the type/scope from
  the dominant change, not just the first commit.

### 3 — Write the PR body (clean, NO attribution footer)

Use this template. Keep it tight; fill from the actual diff/commits.

```markdown
## Summary

<1–3 sentences: what this PR does and why.>

## Changes

- <bullet per meaningful change — source / docs / tooling touched>
- <...>

## Testing

- <how it was verified: `just deps && just test` and `just scan` exit codes, or "docs-only — rendered preview checked">
```

**NEVER** append `Co-Authored-By`, "Generated with Claude Code", a session link,
or any Claude/Anthropic attribution to the title or body. The PR reads as the
owner's own work.

### 4 — Open the PR

Preferred — `gh` CLI (write the body to a temp file to preserve Markdown):

```bash
gh pr create --base main --head "$(git branch --show-current)" \
  --title "<conventional title>" \
  --body-file "<path-to-body.md>"
```

(Or use the GitHub MCP `create_pull_request` with the same base=`main`, head=branch,
title, body — whichever is available. Fall back silently between them.)

### 5 — Report back

Print the **PR URL and number**, the branch, base (`main`), commit count, and the
title used. This repo has no CI wired yet (`ci/` holds workflow files only) - there are no checks to wait for; the PR is review-ready immediately.

---

## Anti-Patterns

- **Never** open a PR from `main` or with a dirty tree.
- **Never** open a PR with zero commits ahead of `main`.
- **Never** force-push to publish the branch.
- **Never** add an attribution / `Co-Authored-By` footer to the title or body.
- **Never** silently create a duplicate PR — check for an open one first and ask.

---

## Relationship with other skills

| Skill            | Relationship                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `/commit`        | Run **before** `create-pr` — stage + Conventional message; tree must be clean |
| `/pre-pr-review` | Optional self-review (this project's stack checklist) before opening the PR   |
