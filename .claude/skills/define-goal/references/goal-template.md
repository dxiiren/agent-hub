# Goal file template - the exact shape of every `{topic}-goal.md`

Every file `define-goal` writes uses this structure, in this order. Consistency is the point: a
reader (human or the `/goal` evaluator) always finds the STOP CONDITION at the top and the work-list
in the middle. Fill **every** section; if one truly doesn't apply, keep the heading and write one
line saying why (e.g. "No environment bootstrap - pure-analysis goal") rather than deleting it.

## Contents

- [The template](#the-template)
- [Field guidance](#field-guidance)
- [Worked example (compact)](#worked-example-compact)
- [The handoff block to print after writing](#the-handoff-block-to-print-after-writing)

## The template

Copy this verbatim, then fill each `{placeholder}` and resolve each `<!-- note -->`. The template is
markdown, so it drops straight into a `.md` file.

````markdown
# GOAL - {Title Case mission name}

> Read this whole file before starting. Execute the Work List top to bottom. After EVERY item:
> set its status + append one Run Log line. This file - not your memory - is the source of truth.

## STOP CONDITION - read before ending ANY turn (the /goal evaluator checks THIS file)

**This goal is NOT complete - and you MUST NOT stop, summarize, or hand back - until EVERY row in
the Work List has a TERMINAL status.**

- **Terminal (a row may end here):** `DONE` - `GAP` (not implemented / out of scope - cite the code
  fact) - `BLOCKED` (proven impossible in code or a hard infra failure you cannot fix - cite
  `file:line` or the exact error).
- **Non-terminal (work remains - keep going):** `TODO` - `IN-PROGRESS` - `PARTIAL`. The words
  **"deferred" / "next session" / "focused session" / "later" are BANNED as a status.** Large or
  messy is not a reason to defer - slice it, timebox it, annotate honestly, mark it `DONE`/`PARTIAL`
  with a concrete note, and move to the next row.
- **Do NOT write a completion summary while any row is non-terminal.** A "Summary"/"final status"
  written early makes this file read as _met_ and lets you quit with work undone. Write the closing
  summary ONLY when the Work List has zero `TODO`/`IN-PROGRESS`/`PARTIAL` rows.
- **On every Stop attempt:** re-read this section, scan the Work List, pick the topmost non-terminal
  row, and execute it. Repeat until none remain.

## Mission

{1-2 sentences: the single objective and what "success" concretely delivers.}

## Locked decisions (do not re-litigate)

- {Decision already made - the agent must NOT reopen it. One bullet each. Delete the list only if
  there are genuinely none.}

## Environment bootstrap

<!-- Idempotent; re-verify every run. Delete/deactivate this section only for a pure-analysis goal. -->

- {Step to bring the world up + how to check it's up + what to do if it's down.
  "`pwsh ./setup.ps1` if the toolchain is missing; sanity gate: `just deps && just test` both exit 0; there is no server"}

## Hard prohibitions / guardrails

- {git commit? push? staging? - state explicitly, e.g. "NEVER git commit/push/stage; all work stays
  in the working tree."}
- {External posts - GitHub PR/issue / email / any service: allowed or forbidden?}
- {Destructive ops, files/dirs that are off-limits, "touch only X".}
- {Any project house-rule that applies. "public repo: no internal IPs, hosts, company names or personal paths", "run `just scan` before any push"}

## What counts as a REAL blocker

- **Real (may mark `BLOCKED`):** {code facts. a template that fails `scripts/check-config.mjs` at a named file and key that cannot be fixed without a design decision, a referenced plugin or script missing at `file:line`, or a hard infra failure you tried once to fix and couldn't.}
- **NOT a blocker (keep working):** "it's late", "it's complex", "needs a focused session",
  {"a stale `node_modules` (-> delete it and `just deps`, continue)".}

## Definition of Done

Per item - an item is `DONE` only when:

- [ ] {check 1}
- [ ] {check 2}
- [ ] {evidence recorded - the concrete proof line. "the pasted `just test` summary line", "the `just scan` exit code", "a report path"}

Global goals:

- **G1** {checkable outcome}
- **G2** {checkable outcome}

<!-- add G3.. as needed; each must be verifiable, not aspirational -->

## Work List

<!-- CHOOSE ONE of the two forms below and delete the other. -->

<!-- FORM 1 - KNOWN, enumerable list: one row per unit of work. -->

| #   | Item   | Status |
| --- | ------ | ------ |
| 1   | {item} | `TODO` |
| 2   | {item} | `TODO` |
| ... | ...    | `TODO` |

<!-- FORM 2 - UNKNOWN size: a discovery sweep enumerates the list first, then a Task Template. -->

### Goal 0 - Discovery sweep - `TODO`

Enumerate every unit of work into the table below BEFORE executing any of them. {How to discover:
grep/glob/a structured scan of the sources.} Append one row per item found; set each to `TODO`.

| #                       | Item | Status |
| ----------------------- | ---- | ------ |
| _(populated by Goal 0)_ |      |        |

### Task Template (copy for each row when you start it)

```text
### {id} - {item name} - `TODO`
- [ ] {DoD check 1}
- [ ] {DoD check 2}
- [ ] Evidence: {proof}
```

## Resume protocol

<!-- 🚨 THREE selectors exist in this template. This is the tie-break. Do not remove it. -->

**Precedence, highest first — when they disagree, the higher one wins:**

1. **The ledger** (`{topic}-state.jsonl`) — the set of completed `item`s. It is append-only and
   written *after* work completes, so it cannot claim something finished that was not.
2. **Work List statuses** in this file — a human-readable mirror. A row can be left `IN-PROGRESS` by
   a process that died mid-item, so it can be WRONG in both directions.
3. **The STOP CONDITION's "topmost non-terminal row"** — a stopping rule, not a work selector. It
   decides *whether you may stop*, never *what to do next*.

Concretely: compute `next = WorkList − {every item in the ledger}`. If a row says `DONE` but is
absent from the ledger, **redo it** (the status was written before the ledger line, and the run may
have died between). If a row says `TODO` but IS in the ledger, **skip it** and correct the status.

- Statuses in this file are a mirror of the ledger — not conversation memory, and not authoritative
  over it.
- On every (re)start, crash, or context compaction: re-read STOP CONDITION → Work List → continue
  from the first non-terminal row.
- Set a row to `IN-PROGRESS` the moment you start it, so a resumed run knows where you died.
- After EVERY item (not in batches): set its status + append one Run Log line.

## Hard budget

<!-- Fill BOTH numbers. An unattended run with no ceiling runs until someone wakes up. -->

- **Max iterations:** `{N}` — count every loop pass in the ledger's `iteration` field.
- **Max wall-clock:** `{H}h` from the first ledger line's timestamp.
- On hitting EITHER ceiling: stop immediately, write the Morning briefing from whatever the ledger
  holds, and mark every unmet criterion `NOT DONE` with its blocker. Do **not** grant yourself an
  extension, and do not start one more iteration "to finish cleanly".
- This exists because stall detection only fires on **zero** movement across two iterations. A run
  that makes a little movement every pass never trips it and will burn the whole night.
## Concurrency

<!-- Fill this in. "Serial" is a valid answer, but it must be a DECISION, not an omission. -->

- **Mode:** `serial` | `parallel, batch of {N}`
- **Why:** {what forces the choice — see below}

Items may run **in parallel** only when they are genuinely independent. Serialize when any of these
is true, and say which one:

- two items touch the **same file** (they will conflict — shard by file, never by rule)
- they share a **single stateful resource**: one dev/test server, one port, one DB row-range
- one item's output is another's input
- the work mutates shared infrastructure (migrations, deploys, branch state)

When parallel: dispatch as **multiple Agent tool calls in a single message**, batch of `{N}`
(4-8 is the useful range), each subagent scoped to its own item and forbidden from touching another
item's files. Each subagent appends its OWN ledger line on completion.

**🚨 Parallel REQUIRES the set-based resume below.** Concurrent items finish out of order, so the
last ledger line is not the high-water mark. A cursor-based resume plus parallelism silently skips
work. If you are not confident the ledger records an `item` per line, run serial.

## Durable state ledger

<!-- Machine-readable twin of the Run Log. A cold session must be able to resume from THIS alone. -->

- After EVERY iteration, append exactly ONE JSON line to
  `.claude/checklist/{topic}/{topic}-state.jsonl` - one object per line, appended, never rewritten.
- Each line carries: `iteration` (the number); **`item`** (the Work-List row this line completed -
  its id or slug, and the field the SET-based resume reads); `hypothesis` (what this iteration was
  testing); `action` (what you did); `command` (the exact command you ran, verbatim); `result` (its
  raw output / exit code - trimmed, never paraphrased); `criteria` (every exit criterion you
  checked, each marked `pass` or `fail`).
- On startup, READ this file FIRST - before any other work.
- **🚨 Resume by SET, never by cursor.** Read the WHOLE ledger, collect every `item` seen, and work
  the complement against the Work List. Do NOT "continue from the last line" — that assumes items
  completed in order, false the moment anything runs concurrently, and fragile even serially (a torn
  final write, a duplicated line). Every ledger line MUST therefore carry an `item` field naming the
  Work-List row it completed.
- Assume the reader has lost everything: a fresh session with zero context must be able to continue
  from this file alone. This exists because a long autonomous run has died with its parent process
  before and had to restart from zero.

```text
{"iteration":3,"item":"{work-list id}","hypothesis":"...","action":"...","command":"...","result":"...","criteria":{"G1":"fail"}}
```

## Stall detection

- If TWO consecutive iterations produce no measurable movement on any exit criterion, STOP looping.
- Movement = a criterion flipped `fail` -> `pass`, or its blocker changed into a different, more
  specific one. A new theory, a re-read file, or the same command run again is NOT movement.
- On the second stalled iteration, write a `BLOCKED` entry naming the exact wall - the literal error
  text, the environment constraint, or the missing credential. Name it; do not summarize it.
- Do NOT thrash. Burning dozens of exploratory commands without converging is the failure mode this
  rule exists to cut off - one named wall is worth more than twenty more probes.
- **Repeated-approach / flip-flop guard.** Record a one-line `approach` with every ledger entry.
  If an item's next attempt repeats an approach already tried - or flips back to one already
  abandoned (A, then B, then A again) - with no new evidence, that is a stall even if the files
  changed: name the wall instead of trying it a third time. Never "pass" by weakening the check
  or the test. (Adapted from claude-code-templates
  cli-tool/components/loops/engineering/anti-spin-build-loop.md @ 8b1f883, MIT,
  (c) 2025 Daniel (San) Avila.)

## Morning briefing

On completion - or when the run's budget is exhausted - produce a briefing with three STRICTLY
separated sections. Never blend them:

- **PROVEN DONE** - each met criterion + the actual command output that proves it (pasted, not
  described).
- **NOT DONE** - each unmet criterion + its specific blocker (the literal error / constraint).
- **DECISIONS I MADE FOR YOU** - every judgment call the developer might want to override: an
  approach picked over another, a rename, a skipped edge case, an assumption you had to make.

Never mark a criterion met from reasoning. A criterion is met ONLY from a verification command's
real exit code and output - if you didn't run it, it goes under NOT DONE. The briefing is an
output, never a permission to stop early: the STOP CONDITION still governs when the run may end.

## Run Log (append-only - one timestamped line per item)

<!-- format: "- {YYYY-MM-DD HH:MM} | {item id} | {what happened + evidence}" -->

- {first line goes here}
````

## Field guidance

- **STOP CONDITION** - keep it verbatim; only adjust the terminal-status _names_ if this goal needs
  a different vocabulary. It must stay checkable by re-reading the file.
- **Mission** - success must be stateable as something observable. If the answer was fuzzy in
  interrogation, it isn't ready to write.
- **Environment bootstrap** - only for goals that touch a running system. For an unattended run,
  make each step idempotent and give the up/down check + the recovery action inline.
- **Work List** - Form 1 when the developer handed you a finite list; Form 2 when the count is
  unknown or must be derived. Never leave the count implicit - Goal 0 makes it explicit before work
  starts, which is what makes "EVERY row terminal" a real bar.
- **Definition of Done** - the per-item checklist is what stops "looks done" from passing. Always
  include an **evidence** line (a pasted result / a report path), never just a checkbox.
- **Guardrails** - for an unattended run, default to the safe side: no commit/push, no external
  posts, unless the developer explicitly authorized them in interrogation.

## Worked example (compact)

Goal: make every `config/**/*.json` template pass a new "no provider without a route" check.
Targets: `config/config.template.json`, `config/routes/routes.template.json`, `scripts/check-config.mjs`.
Bootstrap: `just deps`; sanity gate `just test` exits 0. Locked: placeholders only, no new dependency.
Blocker: only a design question the spec does not answer. Not a blocker: a stale `node_modules`.
Work list: (1) extend the check, (2) fix any template it flags, (3) run `just test` and `just scan`.
Evidence: the pasted `just test` summary line and the `just scan` exit code per row.

## The handoff block to print after writing

```text
Wrote .claude/checklist/{topic}/{topic}-goal.md
Run it in a fresh instance (Fable):
  /goal Work through @.claude/checklist/{topic}/{topic}-goal.md until the STOP CONDITION at the
  top is met. Follow every rule in it; update statuses + Run Log after each item.
```
