---
name: define-requirements
description: "Use at the START of a new project or a major new capability - when the developer says '/define-requirements', 'new project', 'write the spec', 'do discovery', 'BRD/PRD/FSD/TDD', 'requirements pipeline', or describes something they want built when no spec exists yet. Interrogates round by round while background research agents work in parallel, then writes the five staged documents (Discovery -> BRD -> PRD -> FSD -> TDD) into .docs/00-requirements/ with dated research appendices, and hands off to /audit-docs before any code is written."
model: sonnet
---

# define-requirements - From a fuzzy idea to a build-ready spec

Triggers: "/define-requirements", "define requirements", "write the spec", "do discovery", "new
project", "I want to build {X}" with no spec in the repo, "BRD" / "PRD" / "FSD" / "TDD" /
"requirements pipeline".

Turn "I want to build X" into a **five-document pipeline a builder cannot misread**: Discovery ->
BRD -> PRD -> FSD -> TDD in `.docs/00-requirements/`, plus dated research appendices and an audit
trail. Every ambiguity left here becomes a wrong decision made unsupervised later.

**The interrogation stays here** - only this session can ask the developer. Research and drafting
live in the `define-requirements` agent (`.claude/agents/define-requirements.md`, MODE: RESEARCH /
MODE: DRAFT); hand those to it, do not research or write a stage document yourself. Your first
action is the kickoff round (step A).

## Golden rules (the ones that live in this session)

1. **Never draft a stage from half-answers.** Interrogate until that stage's questions are closed;
   the agent reports `GAPS`, and every gap comes back here as a question.
2. **Research runs in parallel with interrogation** - start the four RESEARCH agents in ONE
   message, in the background, before the first question round.
3. **Ask the question, not "please review this document".** You decide when a stage is closed
   (the agent's `STAGE CLOSED` + `GAPS` tell you); the developer answers only what you need.
4. **Audit before build** - `/audit-docs` runs over the finished pipeline, then re-verifies.
5. **Lock the look before the build (any product with a UI)** - clickable prototypes in step D.5,
   winners recorded in `DESIGN.md`.

## Procedure

### A. Kickoff - classify, then the why/YAGNI gate (one screen)

Ask with `AskUserQuestion` (max 4 questions per round; the first option carries your
recommendation, labelled "(Recommended)"):

- **Domain** - what the thing is, in the developer's terms.
- **Product type** - tool / service / platform / automation / analysis.
- **Users** - just the developer, a small group, or paying customers (drives auth, billing,
  support and ops scope more than any other answer).
- **Ambition** - weekend MVP / solid v1 / serious product / still exploring.

Then, in the SAME first interrogation round, the **why / YAGNI gate** - two questions every later
requirement is measured against:

- **Why?** What pain does this remove, for whom, and what happens if it is never built? No answer
  means there is nothing to spec yet - say so.
- **Simpler?** Is there a smaller thing - an existing tool, a script, a manual step - that gets
  most of the value? If yes, offer it as the recommended option.

Every later Must has to trace back to that "why"; anything that cannot is a Won't. (Adapted from
claude-code-templates `cli-tool/components/skills/productivity/requirements-clarity/SKILL.md` -
"Why? (YAGNI check) and Simpler? (KISS check)" - @ 8b1f883, MIT, (c) 2025 Daniel (San) Avila.)

React to the answers before the next round. Never open with a wall of questions.

### B. Fan out research - immediately, in the background

One message, four calls (background where available):

```
Agent(subagent_type: "define-requirements", model: "sonnet",
      description: "Research <topic>",
      prompt: "MODE: RESEARCH. Topic: <1 competitor landscape | 2 data/API feasibility |
               3 domain knowledge | 4 integration/tooling reality>. Domain: <...>.
               Kickoff answers: <verbatim>. Write research/0N-<topic>.md.")
```

### C. Interrogate - one theme per round

Themes, in order (question banks: [`references/interrogation-guide.md`](references/interrogation-guide.md)):
pain and goal - trigger, inputs, outputs - authority and scope (incl. what is explicitly out) -
success, budget, timeline - behaviour edges (before the FSD: tie-breaks, expiry, ambiguity,
concurrency, failure modes, a dependency down) - build reality (before the TDD: runtime, storage,
hosting, what the developer knows, what must be reused). Answers may arrive mid-round or
contradict an earlier one: restate the delta in one line and continue - never silently drop a
changed decision.

### D. Draft each stage - then decide whether it is closed

When a stage's themes are answered, hand it to the agent with every answer verbatim:

```
Agent(subagent_type: "define-requirements", model: "sonnet",
      description: "Draft <stage>",
      prompt: "MODE: DRAFT. Stage: <Discovery|BRD|PRD|FSD|TDD>. Answers: <verbatim, every round>.
               Earlier stages: <paths>. Research: <paths>. Why/YAGNI answers: <verbatim>.")
```

`STAGE CLOSED: no` or any `GAPS` -> ask those questions (step C), then `SendMessage` the agent the
answers to revise. Move on only when the stage is closed.

### D.5 Prototype the UI - lock the look before code (skip for headless / CLI / API-only)

Work top-down, one decision at a time, each as a **self-contained clickable HTML artifact** (real
sample content, real fonts, inline styles, no build step) the owner reacts to:

1. **Design direction / palette** - 3-4 distinct identities on one page with a live switcher, each
   a real mock of the hero screen, not swatches. The owner picks one.
2. **Theme modes** - dark / light / both, up front (tokens, not literals).
3. **Per-page layout** - for each core screen, 2-3 genuinely different arrangements in the chosen
   palette; the owner picks per page. Enumerate every page.
4. Live data the owner recognises -> a **real snapshot** in the prototype, not lorem.

Record the winners in root `DESIGN.md` (palette as named tokens, type, motion, per-page layout),
then `SendMessage` the agent to fold them into the FSD screen specs.

### E. Audit - before anyone writes code

Run `/audit-docs` over the finished pipeline. Apply its findings, then re-verify. Record the trail
under `audits/` and bump the revision history in the tracker README.

### F. Hand off

State plainly what exists, what the success bar is, what is deliberately unresolved. Offer the two
real next actions: commit the pipeline (`/commit`), or turn it into an autonomous build
(`/define-goal`, whose work-list should mirror the TDD's build plan).

## Anti-patterns

- Researching or drafting in this session instead of the agent.
- Asking the developer to review a document instead of asking the question you need.
- Skipping the why/YAGNI gate because the idea "is obviously useful".
- Declaring the pipeline done without an independent audit.
- Marking a stage complete while its open questions have no downstream owner.

## References

- [`references/interrogation-guide.md`](references/interrogation-guide.md) - question banks,
  research-agent prompt templates, round mechanics, the answer-to-section map.
- [`references/stage-templates.md`](references/stage-templates.md) - the required shape of each
  document, the tracker README and a research appendix (read by the agent).

## Evolution Log

- Distilled from the dxiiren-trading pipeline (2026-08-21): a full Discovery-to-TDD spec built in
  one session with four parallel research agents and four audit layers. The expensive defects were
  arithmetic, anchor ambiguity and lifecycle holes - all caught by audit layers, not by drafting.
- UI cost, learned the hard way (dxiiren-trading, 2026-08-22): behaviour was nailed but the look
  was not, so the app was re-skinned live after the build. Hence step D.5 and `DESIGN.md`.
- 2026-10-03: split - interrogation, the stage-closed decision, prototypes and the audit stay
  here; research (MODE: RESEARCH) and drafting (MODE: DRAFT) moved to the `define-requirements`
  agent. Added the why/YAGNI gate to the first round (requirements-clarity) and "Context +
  Container diagrams are enough; Component only if it adds value" to the TDD stage, adapted from
  claude-code-templates `cli-tool/components/skills/creative-design/c4-architecture/SKILL.md`
  @ 8b1f883, MIT, (c) 2025 Daniel (San) Avila.
