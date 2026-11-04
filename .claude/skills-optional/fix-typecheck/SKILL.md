---
name: fix-typecheck
description: Use when the project's typecheck command (tsc / vue-tsc / nuxt typecheck) or a pre-push hook fails with TypeScript errors, or when the developer says 'fix typecheck', 'fix type errors', or 'typecheck failing' — reads the reported errors, fixes the root cause in the source, and re-runs until clean, pasting the clean result before claiming done.
model: sonnet
---

# fix-typecheck — Resolve TypeScript typecheck errors

Triggers: "fix typecheck", "fix type errors", "typecheck failing", or a failing typecheck command / pre-push hook.

**Your first action is the `Agent` call below** - before any Read, Bash or other tool call of
your own. The procedure (capture every error, fix the root cause, re-run to 0 errors, the never-suppress guardrails) lives in the `fix-typecheck` agent
(`.claude/agents/fix-typecheck.md`). Hand the work to it - do not run it yourself:

```
Agent(subagent_type: "fix-typecheck", model: "sonnet",
      description: "Fix typecheck errors",
      prompt: "<the developer's request verbatim, plus the failing output or file scope if they gave one; add REPORT ONLY if they asked for a check without edits>")
```

Relay the pasted final typecheck result and the touched files. Never claim green without that pasted
line; commit only when the developer asks (`/commit`).


## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/` (inert). Its agent ships beside it as
`agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled (moved to
`.claude/skills/`, e.g. by `/ground-project`), move `agent.md` to
`.claude/agents/fix-typecheck.md` in the same step - the hand-off above names that path.
