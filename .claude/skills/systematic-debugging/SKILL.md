---
name: systematic-debugging
description: Use when facing any bug, test failure, flaky test or unexpected behaviour, BEFORE proposing a fix - enforces a four-phase root-cause method (live state first, investigate, compare with a working sibling, one hypothesis, test-first fix), stops after three failed fixes to question the design, and ships find-polluter.sh and an exit-125-aware bisect wrapper. Also triggers on 'debug this', 'why is this failing', 'this test is flaky', 'it works on my machine', 'unexpected behaviour', 'find the root cause'.
model: sonnet
---

# systematic-debugging

Triggers: any bug, test failure, flaky test or unexpected behaviour BEFORE a fix is proposed;
"debug this", "why is this failing", "this test is flaky", "it works on my machine", "unexpected
behaviour", "find the root cause", "/systematic-debugging", or a fix that did not work.

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
four-phase root-cause method (Phase 0 environment traps, investigate, compare, one hypothesis,
test-first fix, the three-failed-fixes stop) and its tools (`reference.md`, `find-polluter.sh`)
live in the `systematic-debugging` agent (`.claude/agents/systematic-debugging.md`). Hand the work
to it - do not start guessing at fixes yourself:

```
Agent(subagent_type: "systematic-debugging", model: "sonnet",
      description: "Find the root cause",
      prompt: "<the developer's report verbatim, the exact error text, what was already tried and how many fixes failed; say INVESTIGATE ONLY when they did not ask for a fix>")
```

Relay the agent's root cause, evidence and fix (or proposed fix) as it returns them. If it stopped
after three failed fixes or with a design question, put that question to the developer - do not
attempt fix number four yourself. If it ends with `NEXT: verify-before-claim`, run that skill next.
