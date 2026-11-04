---
name: lint-check
description: Use when the developer says 'lint check', 'run lint', 'check lint', 'run the quality suite', or 'lint everything' — runs the quality layers this project has (its stack gate, a leftover-placeholder grep, a debug-leftover grep) and reports pass/fail per layer.
model: sonnet
---

# lint-check — Quality layers (stack gate · placeholders · leftovers)

Triggers: "lint check", "run lint", "check lint", "run the quality suite", "lint everything".

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `lint-check` agent (`.claude/agents/lint-check.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "lint-check", model: "sonnet",
      description: "Run the quality suite",
      prompt: "<the developer's request verbatim, plus any scope they named>")
```

Relay the agent's per-layer table and OVERALL verdict as it returns it.
