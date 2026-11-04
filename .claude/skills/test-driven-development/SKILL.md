---
name: test-driven-development
description: Use when implementing a feature or bugfix, before writing the production code - write the failing test first, SEE it fail for the right reason with the narrow test command, write the minimum code to pass, then refactor; never commit red. Covers infra work (behaviour/acceptance table, source-level guard tests proven with a mutant), impossible fixtures and sandboxed tests. Also triggers on 'tdd', 'test first', 'write the failing test', 'red green refactor'.
model: sonnet
---

# test-driven-development

Triggers: implementing a feature or bugfix (before the production code), "tdd", "test first",
"write the failing test", "red green refactor", "what's the red-green plan for X",
"/test-driven-development".

**Your first action is the step-1 check below, then the `Agent` call - no Bash, Read or code of
your own.** The cycle (think about the OLD code, RED seen, GREEN minimum, refactor, infra acceptance
tables, guard tests, never commit red) lives in the `test-driven-development` agent
(`.claude/agents/test-driven-development.md`).

1. **Skip request? (stays here - an owner decision).** Test-first is the default for every feature,
   bugfix and behaviour change. Only if the developer asked to skip it for a throwaway prototype or
   generated code, ask them to confirm and wait. Infra work is never an exemption (it gets an
   acceptance table). Otherwise go straight to step 2.
2. **Hand off:**

```
Agent(subagent_type: "test-driven-development", model: "sonnet",
      description: "Test-first change (or plan)",
      prompt: "<the developer's request verbatim, the files/behaviour involved; say PLAN ONLY when they asked for the red-green plan without edits; say TDD WAIVED BY OWNER only after step 1 got a yes>")
```

3. **Relay** the agent's red lines, green line and changed files. If it ends with
   `NEXT: verify-before-claim`, run that skill next with the requirement and file list it gave.
