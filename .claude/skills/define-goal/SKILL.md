---
name: define-goal
description: "Use when the developer says '/define-goal', 'define a goal', 'write a goal file', 'set up an autonomous goal', or 'make a goal for /goal to run' - interactively interrogates the developer round by round until the objective is 100 percent unambiguous (never writing early), then writes a stop-proof {topic}-goal.md (checkable stop condition, fully enumerated work-list with terminal statuses, guardrails, resume protocol) into .claude/checklist/{topic}/ that the built-in /goal command runs autonomously in a fresh Fable instance."
model: sonnet
---

# define-goal - Author a stop-proof goal for autonomous `/goal` runs

Triggers: "/define-goal", "/define-goal {topic}", "define a goal", "write a goal file", "set up an
autonomous goal", "make a goal for /goal to run", "I want to run something overnight".

The interrogation stays here - only this session can ask the developer. Drafting, validating and
writing the goal file live in the `define-goal` agent (`.claude/agents/define-goal.md`); hand those
to it, do not assemble or write the file yourself. You produce one file,
`.claude/checklist/{topic}/{topic}-goal.md`, and print the `/goal` invocation; you never run the goal.

## The golden rule

**Do NOT write the file until the developer has EXPLICITLY confirmed the assembled spec is 100%
correct and complete.** The interrogation loop is the whole value - a goal written from half-formed
answers is a goal that fails at 3am. Keep asking. Only "confirmed" / "100%" / "that's it" / "ship
it" ends the questionnaire.

This skill does **not** use plan mode - the confirm-until-100% conversation _is_ the review gate.

## Procedure

### A. Kickoff (one screen)

Ask the developer for the one-line goal, then classify - use `AskUserQuestion` for the choices:

- **Goal type** - unattended sweep - audit - migration/refactor sweep - bugfix batch - research -
  other. (Picks the question bank in `references/interrogation-guide.md`.)
- **Attended or unattended?** Unattended (overnight, nobody answers questions) demands stricter
  guardrails and gate-overrides; attended can defer some decisions to you live.
- **Which instance runs it?** Usually a fresh Fable instance via `/goal`. Note the model so the goal
  file's effort/verbosity expectations match.

### B. Interrogate - extract the stop-proof essentials

Work the themes below one at a time (`AskUserQuestion` for discrete choices, free-form for
specifics). Do not batch them into one wall of questions - one theme per round, react to each
answer, drill in where an answer is vague. The per-type probes and the answer->section map live in
[`references/interrogation-guide.md`](references/interrogation-guide.md).

1. **Mission & success** - the single objective in 1-2 sentences; what "success" concretely
   delivers. If you can't state success as something checkable, keep asking.
2. **Work list & discovery** - is the work a **known enumerable list**, or must the agent
   **discover it via a sweep first**? What is one unit of work? Rough count? (This becomes the
   per-row status table, or a "Goal-0 discovery sweep" that populates it.)
3. **Definition of Done** - for ONE item, what proves it done (the per-item DoD checklist)? What are
   the allowed **terminal statuses** (e.g. `DONE` / `GAP` / `BLOCKED`)? What is the single global
   **STOP CONDITION**?
4. **Guardrails & locked decisions** - may it `git commit` / `push` / stage? May it open a PR /
   comment on GitHub, or touch any external service? Any destructive ops? What decisions are
   **locked** (do-not-relitigate)? Any **environment bootstrap** (`pwsh ./setup.ps1` if the toolchain is missing, then `just deps && just test` both exit 0 (no server))?
5. **Real-blocker definition** - what counts as a _genuine_ blocker (a code fact: a template that fails `scripts/check-config.mjs` at a named key, a missing referenced script at `file:line`, a hard infra failure it can't fix) versus a banned excuse ("it's
   late", "complex", "needs a focused session")? Code-ground it.
6. **Resources** - reference files/paths, skills to follow (`/skill-name`), and where work artifacts
   - reports go.

7. **Durability & budget** — mandatory for unattended runs, worth asking on every goal. What is the
   **hard budget**: max iterations AND max wall-clock? What counts as **measurable movement** on a
   criterion, so the stall detector can tell real progress from thrashing? Who reads the **morning
   briefing**, and where does it land? These three answers fill the goal file's `Durable state
   ledger`, `Stall detection` and `Morning briefing` sections. The template ships those headings, so
   an un-interrogated goal produces them **empty** — headings with nothing behind them, which is
   worse than absent because it reads as covered. A goal with no budget has no ceiling except the
   stall detector, and a loop making tiny movement never trips it.
8. **Concurrency** — can the work-list items run **at the same time**, or must they be serial? Ask
   what would collide: two items touching the same file · a single shared server/port/DB · one
   item's output feeding another. Serial is a fine answer, but it must be a *decision* with a named
   reason, not an omission. If parallel: what batch size, and what is each subagent forbidden from
   touching? **Coupled to the ledger:** parallel items complete out of order, so the goal file MUST
   record an `item` per ledger line and resume by SET, not by "the last line". If you cannot
   guarantee that, the answer is serial.

### B2. Draft - hand off to the agent

Once every theme has an answer, send them all - verbatim, no paraphrase - to the agent:

```
Agent(subagent_type: "define-goal", model: "sonnet",
      description: "Draft the goal spec",
      prompt: "MODE: DRAFT. Topic: <kebab-slug>. Path: .claude/checklist/<topic>/<topic>-goal.md.
               Kickoff: <type, attended/unattended, which instance>. Answers: <theme 1..8, verbatim>.")
```

### C. Reflect & confirm loop (the questionnaire that doesn't stop early)

Present the agent's draft - the **entire** assembled spec (every template section, filled) - and its
`GAPS` list. Any gap goes back to step B for that theme first.
Then ask, verbatim intent:

> "Here's the complete goal as I understand it. Is this **100% correct and complete**? Point at
> anything ambiguous, missing, wrong, or under-specified - or say 'confirmed' and I'll write it."

If the developer corrects anything -> revise -> **re-present the whole thing** -> ask again. Loop
until an explicit confirmation. Never shortcut this because the goal "seems clear enough".
On a correction, `SendMessage` the same agent (or start a fresh one) `MODE: DRAFT` with the answers plus the correction and present its new
whole draft. Never write or have it write before the explicit confirmation.

### D. Write & hand off

1. Confirm (or accept an override of) the path: default `.claude/checklist/{topic}/{topic}-goal.md`.
   `{topic}` is a short kebab-case slug of the mission - not "goal", not this skill's name.
2. After the explicit confirmation, hand the write to the agent:

   ```
   Agent(subagent_type: "define-goal", model: "sonnet",
         description: "Write the confirmed goal file",
         prompt: "MODE: WRITE. CONFIRMED by the developer. Path: <path>. Spec: <the confirmed spec, verbatim>.")
   ```

   (or `SendMessage` the drafting agent the same text).
3. Print the handoff block it returns exactly as returned.

See [`references/goal-template.md`](references/goal-template.md) and
[`references/interrogation-guide.md`](references/interrogation-guide.md); the stop-proof law and the
anti-patterns the agent validates against are in `.claude/agents/define-goal.md`.
