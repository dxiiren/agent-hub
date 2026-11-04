---
name: fix-phpstan
description: Use when PHPStan / Larastan (or its pre-commit hook) fails with static-analysis errors, or when the developer says 'fix phpstan', 'fix larastan', 'phpstan failing', or 'fix static analysis' — reads the reported errors, fixes the root cause in the source, and re-runs until clean, pasting the clean result before claiming done.
model: sonnet
---

# fix-phpstan — Resolve PHPStan / Larastan errors

Triggers: "fix phpstan", "fix larastan", "phpstan failing", "fix static analysis", or a failing phpstan command / pre-commit hook.

**Your first action is the `Agent` call below** - before any Read, Bash or other tool call of
your own. The procedure (capture every error, fix the root cause, re-run to `[OK] No errors`, the never-suppress guardrails) lives in the `fix-phpstan` agent
(`.claude/agents/fix-phpstan.md`). Hand the work to it - do not run it yourself:

```
Agent(subagent_type: "fix-phpstan", model: "sonnet",
      description: "Fix PHPStan errors",
      prompt: "<the developer's request verbatim, plus the failing output or file scope if they gave one; add REPORT ONLY if they asked for a check without edits>")
```

Relay the pasted final phpstan result and the touched files. Never claim green without that pasted
line; commit only when the developer asks (`/commit`).


## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/` (inert). Its agent ships beside it as
`agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled (moved to
`.claude/skills/`, e.g. by `/ground-project`), move `agent.md` to
`.claude/agents/fix-phpstan.md` in the same step - the hand-off above names that path.
