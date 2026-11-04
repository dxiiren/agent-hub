---
name: audit-docs
description: "Use when the developer says '/audit-docs', 'audit the docs', 'are the docs up to standard', 'review my spec', 'check the requirements', or before any build starts from a written spec - runs layered adversarial audits (whole-set cross-check, then per-document deep dives) with fresh agents that never see the author's reasoning, verifies every claimed fix in the actual text, and records the trail in audits/ so the fix history cannot drift from what the documents say."
model: sonnet
---

# audit-docs - Adversarial layered audit of a document set

Triggers: "/audit-docs", "audit the docs", "are the docs up to standard", "review my spec",
"check the requirements"; automatically at the end of `/define-requirements`, before any code
exists; after any substantive documentation change a build relies on.

A specification is not done when it is written. It is done when an adversary who never saw the
author's reasoning has tried to break it and failed. The adversary is the **`audit-docs` agent**
(`.claude/agents/audit-docs.md`): every audit round is that agent, spawned fresh with
`Agent(subagent_type: "audit-docs", model: "sonnet", ...)` - never audited in your own context,
which is the author's. What stays HERE is the coordinator's part, because it decides with the
developer: choosing the target, triaging, asking about owner-owned decisions, applying fixes, and
recording the trail.

**Your first action is step A (list the target), then the step-B `Agent` call - you never write a
finding yourself.**

## The law this enforces

1. **Fresh eyes only.** An auditor must NOT be the author and must not receive the author's
   reasoning - only the documents, the domain context, and what earlier rounds already fixed.
2. **Findings must be provable** - file, section, defect, one-line fix.
3. **A fix pass is a change, and changes get audited.** Never stop after applying fixes - the
   re-verify round exists because fixes reliably introduce fresh contradictions.
4. **Claimed resolutions are verified in the text**, not trusted from a log.
5. **Report what was NOT verified.**

## The four layers

| Layer | What it does | When |
| --- | --- | --- |
| 1. Cross-set (`LAYER: CROSS-SET`) | ONE agent reads every document: contradictions between files, traceability gaps, arithmetic, internal logic, stale references | always |
| 2. Re-verify (`LAYER: RE-VERIFY`) | The SAME agent (`SendMessage` it) re-reads after the fix pass: is each finding resolved in the text, and did the fixes introduce new defects | always |
| 3. Targeted confirm (`LAYER: CONFIRM`) | The same agent checks ONLY the round-2 fixes | when round 2 found blockers |
| 4. Per-document (`LAYER: PER-DOCUMENT`) | ONE agent per file, each with its lens, plus the silence lens (what the spec is SILENT about: missing states, unhappy paths) and an **Approve / Conditional / Reject** ruling per document | before a build, or when the developer asks for thoroughness |

## Procedure

### A. Establish the target and the baseline

List the documents in scope. Read any existing audit log so the new round hunts NEW defects.
Note the domain context each auditor needs (product, stack, platform, constraints).

### B. Dispatch (the agent)

Build each prompt from the spine in
[`references/audit-protocol.md`](references/audit-protocol.md) - role + target paths, domain
context, what earlier rounds already fixed, the lens, the output format - and hand it off:

```
Agent(subagent_type: "audit-docs", model: "sonnet",
      description: "Audit layer <n>: <target>",
      prompt: "LAYER: <CROSS-SET|PER-DOCUMENT>. TARGET: <absolute paths>. DOMAIN CONTEXT: <...>.
               ALREADY FIXED: <audit log path or 'none'>. LENS: <from the protocol>.")
```

Layer 4: one call per document, ALL in a single message. Never tell an auditor what the author
intended, and never paste the developer's own request into the prompt - both prime it out of the
finding. The prompt carries the spine fields only.

### C. Triage and fix (stays here)

- **BLOCKER** / **MAJOR** - fix now. **MINOR** - fix if cheap, else record the decision.
- Apply fixes exactly as prescribed unless the prescription is itself wrong - say so in one line
  and fix it your way.
- Where a finding touches a decision the developer owns (a metric, a schedule, a scope boundary),
  **ask the developer before changing it** (`AskUserQuestion`); everything technical is yours.

### D. Re-verify - mandatory

`SendMessage` the same auditor `LAYER: RE-VERIFY` with the decisions made and the mechanisms the
fix pass introduced (name the seams you suspect). Repeat (`LAYER: CONFIRM`) until a round returns
only minors; apply those and stop.

### E. Record the trail

Write `audits/{date}-{topic}.md`: verdict per round, each per-document ruling, every finding with
its resolution, counts that reconcile with the rows listed, and the honest caveats (what was
applied without independent re-verification, what a round did not sample). Add a revision row to
the set's tracker/README and state the standing rule: **substantive changes re-run an audit
before a build depends on them.**

### F. Report

Lead with the verdict and the sharpest finding, then the per-document rulings, then the caveats.
If the set is genuinely clean, say so and say what "clean" was measured against.

## Anti-patterns

- Auditing your own work in the same context that wrote it - always the agent.
- Telling the auditor what the author intended.
- Accepting "resolved" from a log without opening the file.
- Stopping after the fix pass because the fixes "were simple".
- A count chain in the log that does not reconcile with the listed rows.
- Rewriting a dated snapshot to match a later decision instead of marking it superseded.
- Reporting a clean verdict while a whole layer was skipped, unsaid.

## Evolution Log

- Distilled from the dxiiren-trading requirements audit (2026-08-21): four layers over eleven
  documents. Round 1 returned FAIL on a full-looking spec (six blockers); round 2 proved rule 3
  (the fix pass introduced a new blocker and seven contradictions); layer 4 found eight more
  blockers the whole-set rounds missed; the meta-audit caught the log over-claiming its own count
  chain - hence rules 4 and 5.
- 2026-10-03: converted - every audit round is the read-only `audit-docs` agent; triage, owner
  questions, fixes and the trail stay here. Layer 4 gained the silence lens (attack what the spec
  is SILENT about: missing states, unhappy paths, the three-support-tickets gate) and an Approve /
  Conditional / Reject ruling per document, adapted from claude-code-templates
  `cli-tool/components/skills/productivity/devil/SKILL.md` @ 8b1f883, MIT, (c) 2025 Daniel (San)
  Avila.
