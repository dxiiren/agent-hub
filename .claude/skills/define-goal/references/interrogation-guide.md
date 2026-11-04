# Interrogation guide - question banks, the confirm loop, and the answer->section map

The `define-goal` procedure is a guided interrogation. This file supplies the probes for each goal
type, the exact confirm-loop wording, and how each answer lands in the goal file.

## Contents

- [How to run the interrogation](#how-to-run-the-interrogation)
- [Universal probes (every goal)](#universal-probes-every-goal)
- [Per-goal-type question banks](#per-goal-type-question-banks)
- [The confirm loop (verbatim)](#the-confirm-loop-verbatim)
- [Answer -> template-section map](#answer---template-section-map)

## How to run the interrogation

- **One theme per round.** React to each answer before moving on. If an answer is vague ("make it
  cleaner", "fix the sections"), drill in until it's checkable ("these 3 named targets", "each
  passes its named verification command").
- **Use `AskUserQuestion` for discrete choices** (goal type, attended/unattended, commit-or-not,
  known-list vs sweep) and free-form for specifics (paths, counts, DoD checks).
- **Never assume the safe answer silently** - for an unattended run, if the developer didn't say
  "may commit", _ask_; don't just forbid it without confirming.
- **Detect hidden ambiguity.** The two most common gaps: (1) an uncheckable success criterion, and
  (2) an unknown-size work-list with no discovery plan. If either is present, you are not done.

## Universal probes (every goal)

Ask these regardless of type:

1. State the goal in one line. What does "done" concretely deliver?
2. Is the work a **known finite list**, or must it be **discovered first**? If discovered - by what
   (grep / glob / a structured scan of the sources)? Roughly how many items?
3. What proves **one** item is done? (Push for an evidence artifact - a pasted `just test` summary line, a `just scan` exit code, a report path - not just a feeling.)
4. Attended or unattended? If unattended - nobody answers questions mid-run; every decision must be
   pre-answered in the file.
5. May it `git commit` / `push` / stage? May it open a GitHub PR/issue or touch any external
   service? Any destructive ops or off-limits paths?
6. What is a **real** blocker for this goal (a code fact), versus something it must push through?
7. What must it read/follow - reference files, `/skill-name` playbooks - and where do artifacts +
   reports go?
8. Any decisions already locked that it must **not** reopen?
9. **Hard budget** — what is the max number of iterations, AND the max wall-clock? Both, as numbers.
   ("Until it's done" is not an answer; an unattended run with no ceiling runs until someone wakes
   up. Stall detection only fires on ZERO movement, so a run inching forward never trips it.)
10. **Measurable movement** — for THIS goal, what counts as an iteration having moved a criterion?
    (A row changing status? A test count rising? A new file written?) This is what the stall
    detector compares two consecutive iterations against, so a vague answer disables it.
11. **Morning briefing** — who reads it, and where does it land? What would they need to see to
    decide the run was worth it — and to override a judgment call it made at 3am?
12. **Concurrency** — can the work-list items run at the SAME time, or must they be serial? Probe
    for what would collide: two items touching the same file · a single shared server / port / DB ·
    one item's output feeding another. Serial is a fine answer but must be a DECISION with a named
    reason. If parallel: batch size, and what each subagent is forbidden from touching.
    **Coupled to the ledger:** parallel items finish OUT OF ORDER, so the goal file must record an
    `item` per ledger line and resume by SET. If that cannot be guaranteed, the answer is serial.

Probes 9-12 fill the goal file's `Hard budget`, `Durable state ledger`, `Stall detection` and
`Morning briefing` sections. The template ships those headings unconditionally, so skipping these
probes produces **empty headings** — which read as covered and are worse than absent.

## Per-goal-type question banks

Add these on top of the universal probes.

### Unattended sweep (overnight)

- What's the environment bootstrap, and how is each step verified up / recovered if down?
- What's the per-item timebox before it annotates and moves on (so one item can't eat the night)?
- Which interactive gates get pre-answered to an override (e.g. "auto-approve triage", "never open a
  PR overnight", "pick the next row, never your own order")?
- Where does it write progress so a compaction mid-night doesn't lose the place?

### Audit / review

- Read-only, or may it fix what it finds? If fix - same guardrails as a change goal.
- What's the scoring/verdict rubric, and where does the report go?
- Is the target list the whole codebase (-> discovery sweep) or a named set?

### Migration / refactor sweep

- What's the before->after transformation, stated concretely enough to apply uniformly?
  "inline provider URL -> `<OFFICE_QWEN_URL>` placeholder" or "raw JSON read -> a validated helper"
- Isolation: do items touch shared files (-> serialize) or disjoint ones (-> can batch)?
- What's the per-item verification (`just test`, `just scan`, a targeted grep) that proves the change is safe?

### Bugfix batch

- Is each bug independently reproducible? What's the repro + the fix-verified check per bug?
- Root-cause required, or is a scoped workaround acceptable (and logged as such)?

### Research

- What question must be answered, and what makes an answer _trustworthy_ (sources, cross-checks)?
- What's the deliverable shape (a cited report? a decision + rationale?) and where does it land?

> No deployment bank - this repo has no hosted deployment target; `deploy/` scripts are run by hand on a laptop, usage host or server. A 'deploy' goal is out of scope here; if that ever changes, add the bank back with the real environment's health-verify.

## The confirm loop (verbatim)

After assembling the full spec, present it back in full (every template section, filled), then ask:

> "Here's the complete goal as I understand it. Is this **100% correct and complete**? Point at
> anything ambiguous, missing, wrong, or under-specified - or say 'confirmed' and I'll write it."

- Any correction -> revise -> **re-present the whole spec** -> ask again.
- Only an explicit "confirmed" / "100%" / "that's it" / "ship it" ends the loop and unlocks writing.
- Never shortcut with "this seems clear enough" - the loop existing is what makes the goal reliable.

## Answer -> template-section map

| Interrogation answer                                   | Lands in `{topic}-goal.md` section                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| One-line goal + what success delivers                  | **Mission**                                                                                     |
| Allowed terminal statuses + the global done bar        | **STOP CONDITION** + **Definition of Done** (global)                                            |
| Known list vs discover-first + count + how to discover | **Work List** (Form 1 table, or Form 2 Goal-0 sweep)                                            |
| What proves one item done + evidence artifact          | **Definition of Done** (per-item checklist)                                                     |
| commit/push/PR/destructive answers                     | **Hard prohibitions / guardrails**                                                              |
| Decisions already made, not to reopen                  | **Locked decisions**                                                                            |
| Bootstrap / sanity-gate to bring up                    | **Environment bootstrap**                                                                       |
| Real-blocker (code fact) vs banned excuse              | **What counts as a REAL blocker**                                                               |
| Reference files / skills / output paths                | woven into **Mission**, **Environment bootstrap**, **guardrails**, and per-item DoD as relevant |
| Where progress is tracked                              | **Resume protocol** + **Run Log**                                                               |
| Max iterations + max wall-clock (probe 9)              | **Hard budget**                                                                                 |
| What counts as measurable movement (probe 10)          | **Stall detection** + the `criteria` field of each **Durable state ledger** line                |
| Who reads the briefing + where it lands (probe 11)     | **Morning briefing**                                                                            |
| Serial vs parallel + batch size + collisions (probe 12) | **Concurrency** — and forces the ledger's per-line `item` field |
