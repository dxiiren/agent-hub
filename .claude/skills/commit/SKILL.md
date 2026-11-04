---
name: commit
description: Use when the developer says 'commit', 'save changes', or 'git commit'. DEFAULT for "commit all" / "just commit" / "commit ... bruh" (any all-in variant) -> go STRAIGHT to `git add -A` + `git commit` - NO per-file staging, NO approval wait, NO grouping/split. Only a scoped "commit only this" uses stage-by-name + approval.
model: sonnet
---

# Commit - Standardized Git Commit

Triggers: "commit", "save changes", "git commit", "commit this", "commit all", "just commit",
"commit everything", "commit ... bruh", "commit only this".

The procedure lives in the `commit` agent (`.claude/agents/commit.md`). Hand the work to it - do
not run git yourself. The ONE step that stays here is the approval on a scoped commit, because a
subagent cannot ask the developer.

## 1 - Pick the mode

- "commit all" / "just commit" / "commit everything" / any all-in or impatient variant, or a
  bare "commit" with no scope -> **ALL**. Those words ARE the approval: no staging review, no
  approval wait, no grouping or split into several commits.
- A scoped or careful commit ("commit only this", "commit the X part") -> **PREPARE**, then the
  approval below, then **COMMIT**.

## 2 - Hand off

```
Agent(subagent_type: "commit", model: "sonnet",
      description: "Commit (ALL or PREPARE)",
      prompt: "MODE: <ALL|PREPARE>. Developer said: <their words verbatim>. Scope: <paths or area they named, if any>.")
```

## 3 - Approval (PREPARE only - stays in this skill)

Show the developer the agent's `STAGED:` list and `DRAFT:` message and WAIT for an explicit
"yes" / "go" / "looks good". Do NOT commit without it. If they edit the message, use their
version. If the agent returned `AMBIGUOUS TYPE`, ask the developer to pick the type first (never
guess) and put it in the message you show. On "no", stop and say the files are still staged.
On approval:

```
Agent(subagent_type: "commit", model: "sonnet",
      description: "Commit the approved staged files",
      prompt: "MODE: COMMIT. Approved message:\n<message verbatim>\nApproved files:\n<STAGED list>")
```

In MODE: ALL an `AMBIGUOUS TYPE` answer also comes back here: ask the type, then call the agent
again with `MODE: ALL. Type: <type>.`

## 4 - Relay

Relay the agent's `COMMIT: <hash> <subject>`, or the hook failure it could not fix (it runs
whatever hooks this repo has). Never suggest `--no-verify` and never amend.
