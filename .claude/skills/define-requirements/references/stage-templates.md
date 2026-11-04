# Stage templates - the required shape of each document

Every document opens with a status blockquote and closes with its open questions routed to a
named later stage. Anything over ~100 lines carries a table of contents.

```markdown
> Status: **{DRAFT|COMPLETE}** · Date: {YYYY-MM-DD} · Previous: [{prev}](file) · Next: [{next}](file)
```

## Contents

- [00 Tracker README](#00-tracker-readme)
- [01 Discovery](#01-discovery)
- [02 BRD - the why](#02-brd---the-why)
- [03 PRD - the what](#03-prd---the-what)
- [04 FSD - how it behaves](#04-fsd---how-it-behaves)
- [05 TDD - how it is built](#05-tdd---how-it-is-built)
- [Research appendix](#research-appendix)
- [Section-quality bar](#section-quality-bar)

## 00 Tracker README

The index a new reader hits first. Sections:

1. **Status header** - overall state, revision number, date, where to go after the pipeline.
2. **Pipeline diagram** - a mermaid `flowchart LR` of the five stages.
3. **Stage table** - stage / linked document / status with date. Every row's link must resolve
   and every linked file's own status header must agree with the row.
4. **One-line product statement** - what it is, in one sentence a stranger understands.
5. **Success bar** - the BRD's pass/fail metric, quoted, with a pointer to its home section.
6. **Audit trail** - what audits ran, what they found, the standing rule that substantive
   changes re-run one, and any honest caveat about what was not re-verified.
7. **Revision history** - one row per revision: rev, date, what changed and why.
8. **Research appendices** - links, described as dated snapshots.

## 01 Discovery

1. **Product statement** - what it produces AND what it does when it produces nothing (the
   "no result" outcome is a first-class output; say so here).
2. **Stakeholder and users** - who, and what their day looks like.
3. **Pain points** - numbered, each with the honest note of whether v1 actually addresses it.
4. **Goals** - what success delivers, in the developer's terms.
5. **Constraints** - budget, platform, skills, time, hard rules (e.g. demo-only, no auto-send).
6. **Key decisions table** - `# | question | decision`, one row per thing settled in kickoff.
7. **Research findings summary** - 3-5 lines per appendix, each linked, hedges intact.
8. **Rough scope (MoSCoW draft)** - marked as a draft the PRD finalizes.
9. **Design principles** - the non-negotiables the research surfaced.
10. **Open questions carried forward** - routed `-> BRD` / `-> PRD` / `-> FSD` / `-> TDD`, and
    later back-annotated with where each was answered.

## 02 BRD - the why

1. **Executive summary** - problem, approach, why it succeeds, in one paragraph.
2. **Business problem** - the numbered pains plus why buying a solution does not work
   (cite the competitor appendix, keep its hedges).
3. **Objectives** - table `# | objective | measure`. Every measure must be something that can
   actually be counted; if it cannot, either find a proxy or mark the objective qualitative.
4. **Success metrics** - the authoritative pass/fail bar. **Show the arithmetic**: state the
   metric, then compute what it implies under the system's own mechanics, and name the sample,
   the window, and the tie-break when the window ends early. Record known measurement bias.
5. **Scope** - in / out / never. "Never" is a product boundary, not a backlog.
6. **Budget** - running cost ceiling and build cost, both explicit.
7. **Timeline** - milestones as a mermaid gantt; state the buffer separately from the estimate.
8. **Phase roadmap** - what this phase is, what the next phase would add, what is aspirational.
9. **Risks** - table `risk | impact | mitigation`. Include the ones nobody enjoys writing:
   dependency limits, model/vendor drift, environment loss, over-trusting the output.
10. **Assumptions** - each one falsifiable, each with when it gets checked.

## 03 PRD - the what

1. **Product overview** - one paragraph naming every terminal outcome, not just the happy one.
2. **Persona** - the real user, their constraints, their available hours.
3. **Locked decisions** - the table a later session may not relitigate.
4. **Feature list (MoSCoW final)** - Must / Should / Could / Won't, each feature one line with
   an ID. Verify no Must depends on a Should.
5. **User stories and acceptance criteria** - grouped in epics. **Every AC must be objectively
   testable**: no adjective may carry load ("simple", "respectable", "trusted"). Where the FSD
   will refine a rule, cite the FSD as the authority rather than restating a number.
6. **The scoring / decision model** (if the product judges anything) - the criteria table with
   what computes each one.
7. **Non-goals** - what the product deliberately does not do.
8. **Product metrics** - the BRD bar (cited, not restated), guard metrics, and the pace
   arithmetic that says when the sample will exist.
9. **Release plan** - mapped to the BRD milestones, with the buffer explicit.
10. **Open questions -> FSD**.

## 04 FSD - how it behaves

The largest document. QA writes test cases from this and must never need to ask a question.

1. **Conventions** - time storage/display and DST handling, units and precision, the day
   boundary, any market/domain windows, the reference anchor every formula uses, and any
   deliberate deviation from a research convention (state it as deliberate, with the reason).
2. **Screens** - one subsection each: what it shows, which data backs each element, what the
   empty and error states look like. Only display data that exists somewhere in the TDD schema.
3. **The pipeline** - a mermaid flowchart of the main flow, every branch ending in a named
   verdict, followed by numbered functional requirements (P1, P2, ...) for atomicity,
   concurrency, and where facts come from.
4. **Field-level spec** - a table `field | type | validation`. Every rule states its bound and
   its failure verdict. Include server-stamped metadata fields, so every rule stays re-checkable
   from the record alone.
5. **Grammar / typed vocabulary** - if the product accepts a structured condition, define it as
   a small grammar of typed predicates with an evaluation convention (which bar, closed or
   forming, inclusive or exclusive) and an arming rule (when evaluation starts, and what makes
   a predicate invalid at creation).
6. **Rule definitions** - each criterion's pass/fail threshold, its data source, and which ones
   are hard guardrails whose failure overrides everything else.
7. **Business rules** - R1, R2, ... : gates, caps, exposure limits, sizing formulas,
   immutability, closed-period behavior, and how a settings change propagates.
8. **Lifecycle and adjudication** - a mermaid `stateDiagram-v2` with a canonical enum, followed
   by J1, J2, ... rules: catch-up determinism, ambiguity resolution, terminal vs non-terminal
   states, what each state contributes to which metric, gap and boundary handling, precedence
   when two events land in the same interval.
9. **Scheduled behavior** - anchors (computed, not hard-coded, when they track an external
   clock), tolerance, what "missed" means versus "skipped", and which target each run serves.
10. **Error states** - table `condition | behavior`. One row per failure mode the design can
    actually produce, including the boring ones (credential read fails, quota exhausted,
    resource paused upstream, retry semantics).
11. **Settings** - default and bounds per setting, plus which ones invalidate a measurement
    cohort when changed.
12. **Open items -> TDD**.

## 05 TDD - how it is built

1. **Architecture overview** - C4 **Context** and **Container** views as mermaid diagrams whose
   every node has an edge, plus one paragraph naming the load-bearing idea (usually: one shared
   domain module, several consumers, so a rule cannot disagree with itself). Context + Container
   are enough; add a **Component** view only where it adds value a builder needs (a module with
   non-obvious internal boundaries), never Code-level. (Adapted from claude-code-templates
   `cli-tool/components/skills/creative-design/c4-architecture/SKILL.md` @ 8b1f883, MIT,
   (c) 2025 Daniel (San) Avila.)
2. **Stack** - table `layer | choice | rationale`. Pin versions where a break is known; name
   the compatibility gates that must be checked at build time.
3. **Repository layout** - a tree with a comment per directory.
4. **Component design** - one paragraph per component: what it does, and the platform-specific
   traps it must handle (blocking calls off the event loop, subprocess quirks, file locking).
5. **External invocation contract** - exact command lines, permission scopes, the file contract
   for results (never parse prose), the failure-hard check, and retry policy with its budget.
6. **Integrations** - one row per external server/API: what it provides, what it must NOT
   provide (scope fences enforced by construction beat allowlists), and concurrency rules.
7. **Database schema** - one bullet per table with every column. Diff it field-by-field against
   the FSD: every FSD field has a column or a stated derivation, and every column traces to an
   FSD rule. Include integrity mechanisms (triggers, hash chains) with a canonicalization spec
   precise enough to implement twice identically.
8. **Background processing** - the loop, its interval, what it reads, why re-running is safe.
9. **Scheduling and process model** - what runs, how many processes, and the flags that matter
   (worker counts, reload behavior, grace times).
10. **Security and NFRs** - exposure, secrets, scope fences, data placement (keep the record of
    truth outside any agent-writable tree), backups with a restore check, performance targets,
    reliability, maintainability.
11. **Testing strategy** - state the methodology (test-first for logic modules), then enumerate
    the buckets: unit per module with one fixture per lifecycle path, validator rejection tests
    per rule, integration with a stubbed external tool, **live verification** (mocks prove
    nothing), and an integrity audit.
12. **Build plan** - milestone table with technical scope; every Must feature assigned; audit
    gates named.
13. **Decision log** - table `# | decision | choice | alternative rejected`, including the ones
    made under audit pressure with their date.

## Research appendix

```markdown
# Research: {topic}

> Produced by research agent, {date}. {What it feeds.} Facts verified as of that date.
> {If superseded: **Snapshot only - section N was superseded by {doc} decision {id}**; do not
> build the architecture below.}
```

Then the raw findings: tables where comparable, bullets otherwise, URLs inline, estimates
labelled as estimates. Never edit the findings later to match a decision - append a pointer.

## Section-quality bar

Before calling any section done:

- [ ] Every number has a unit and exactly one authoritative home.
- [ ] Every enum is spelled identically everywhere it appears.
- [ ] Every rule names its failure outcome.
- [ ] Every claim that came from research keeps the hedge the research gave it.
- [ ] Nothing an implementer needs is implied rather than stated.
