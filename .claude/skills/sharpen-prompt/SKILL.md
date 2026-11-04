---
name: sharpen-prompt
description: Use at the START of any request that could be read more than one way, or that says build/fix/investigate/audit/check/update without naming what proof counts as done - rewrites the request into a precise brief (objective, definition of done with live evidence, scope boundaries, execution shape) and states the assumptions made, so the work matches the intent on the first pass instead of the third. Also triggers on 'sharpen this', 'rewrite my prompt', 'what do you think I mean'.
model: sonnet
---

# sharpen-prompt — Turn a fuzzy ask into a brief that can only be done one way

Triggers: "sharpen this", "rewrite my prompt", "what do you think I mean" - and the START of any
ambiguous request (below).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
rewrite lives in the `sharpen-prompt` agent (`.claude/agents/sharpen-prompt.md`). Writing the
`SHARPENED` block yourself, even a quick one, is a failure of this skill - hand it off:

```
Agent(subagent_type: "sharpen-prompt", model: "sonnet",
      description: "Sharpen the request",
      prompt: "<the developer's request verbatim> | Session context: <anything from this
               conversation the repo cannot tell it - prior turns, what was already tried>")
```

What stays here: deciding whether to sharpen at all, the one question when it is warranted, and doing
the work.

## When to run

Run this **before starting work**, not after, whenever any of these is true:

- The request could be read two ways and the readings produce **different work**.
- It says build / fix / add / investigate / audit / check / update / verify but never says
  **what proof would count as done**.
- It names a scale word — "all", "every", "the whole", "across the repos" — without a count.
- It is a repeat of something done before (a candidate for codifying, not redoing).
- The developer says "sharpen this", "rewrite my prompt", "what do you think I mean".

**Skip it** for genuinely unambiguous one-liners ("commit", "push", "what's the branch") —
sharpening those is the ceremony this skill is supposed to remove.

## After the agent returns

1. The agent returns one of three things: a `SHARPENED` block, `QUESTION`, or `TRIVIAL`.

2. **If it returns `QUESTION`** - ask exactly that one question with `AskUserQuestion`, the two
   readings as the options (never a list of five), then `SendMessage` the agent the answer (or re-run it with the answer added) and take
   the block it returns. If it returns `TRIVIAL`, skip the brief and just do the request.

3. **Print the block verbatim and start immediately.** Do not wait for confirmation - the developer
   reads it as you work and interrupts if a line is wrong. Blocking on confirmation is a worse
   failure than a wrong assumption stated out loud. If `Assumed` was wrong, one correction beats
   three challenge rounds.

4. **Work in the `Shape` it names.** The `Done when` line is the evidence you paste at the end -
   never degrade it to "tests pass". If evidence cannot be gathered, say `BLOCKED: <reason>` and mark
   the item UNVERIFIED.

### The shapes

**subagent, report-only** — dispatch (model `sonnet`) with: return only (a) the 3 most likely causes ranked,
(b) exact `file:line` evidence for each, (c) the cheapest experiment that discriminates
between them. Edit nothing. Time-box ~15 tool calls. Independent probes go out as multiple
Agent calls in one message, not one after another.

**checkpointed batch** — before starting, create the progress ledger. After **each** item
append one line: `{item, status, evidence, timestamp}`. On startup read it and skip anything
already done. Run in foreground chunks of ~20 with a one-line summary per chunk, so a dead
session costs one chunk. This exists because a long audit died with its parent process and
had to restart from zero.

**codify it** — if this is the third time, the deliverable is the skill, not the output.
Check `.claude/skills/README.md` first; extend the existing skill rather than writing a
second one that will drift.
