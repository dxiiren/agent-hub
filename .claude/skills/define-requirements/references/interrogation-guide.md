# Interrogation guide - question banks, research prompts, round mechanics

How to extract a spec from a developer who knows what they want but has not said it yet.

## Contents

- [Round mechanics](#round-mechanics)
- [Question banks by theme](#question-banks-by-theme)
- [Research-agent prompt templates](#research-agent-prompt-templates)
- [Answer to section map](#answer-to-section-map)
- [Reading the answers](#reading-the-answers)

## Round mechanics

- **Max 4 questions per round**, one theme per round. More is a wall; the developer picks
  fast defaults and the spec inherits them.
- **Every option carries a real consequence**, not just a label. "SQLite" is useless;
  "SQLite - single user, zero admin, trivially backed up" lets them decide.
- **Put your recommendation first** and mark it "(Recommended)". You have the research; they
  have the intent. Silence on your part is not neutrality, it is abdication.
- **Offer the escape hatch** when a decision genuinely can be deferred: "decide in the TDD".
  Do not offer it for anything that changes what gets built.
- **React before continuing.** One line acknowledging what changed, then the next round.
- **Mid-round answers are normal.** Developers add constraints while you work ("actually use
  X", "budget is zero", "no fable"). Fold them in immediately and say what they displaced.
- **Never ask what the code can tell you.** Read the repo first; ask only what is in their
  head.

## Question banks by theme

### Kickoff (Discovery)

- What is this, in one sentence, in your words?
- Product shape: tool / service / platform / automation / analysis?
- Who uses it: only you / a small private group / paying customers / an internal team?
- Ambition: weekend MVP / solid v1 / serious product / still exploring?
- Why / YAGNI (same round): what pain does this remove, for whom, and what happens if it is never
  built? Is there something simpler (an existing tool, a script, a manual step) that gets most of
  the value? Every later Must traces back to this answer.

### Pain and goal (Discovery)

- What do you do today that this replaces? How long does it take?
- What goes wrong most often - is it time, consistency, missed events, or no feedback loop?
- When this works, what is different about your week?
- What would make you abandon it in month two?

### Trigger, inputs, outputs (Discovery -> PRD)

- Does it act on demand, on a schedule, on an event, or continuously?
- What raw material does it consume? Where does that come from today?
- What is the finished artifact - a report, a record, a notification, a file, an action?
- Who or what consumes that artifact, and where do they see it?

### Authority and scope (PRD)

- Who decides: the human every time, the system within rules, or a fixed rule set?
- What is explicitly NOT in v1? Name three things you can imagine wanting and are cutting.
- What must never happen, even by accident? (This becomes a hard guardrail, not a wish.)

### Success, budget, timeline (BRD)

- What single measurement proves this worked? Over what sample and what window?
- What running cost per month is acceptable - zero, under a small ceiling, or whatever it takes?
- When do you need v1 usable? What is the immovable date, if any?
- If the metric comes back negative, is that a failure or a finding?

### Behavior edges (FSD) - ask ALL of these

These are the questions that separate a spec from a wish. Adapt the nouns to the domain.

- **Tie-break**: two conditions become true in the same instant - which wins?
- **Ambiguity**: the data cannot tell which happened first - what is recorded? (Default:
  count it against the system; ambiguity must never flatter the metric.)
- **Expiry**: how long is an artifact valid, and what happens at the deadline - void, close,
  or carry over?
- **Cap and concurrency**: how many can be live at once? What happens to the one that would
  exceed it?
- **Day boundary**: when does "today" start and end for counting? (Calendar date is almost
  always wrong for anything session- or timezone-shaped.)
- **Dependency down**: the data source, the terminal, the API is unavailable - does the run
  fail, degrade, or get marked missed? Is that visible or silent?
- **Partial data**: a gap in the history - interpolate (never), pause, or skip? How is a
  stuck item surfaced?
- **Config change mid-flight**: does it apply to in-flight work, or only new work? Does it
  invalidate the measurement cohort?

### Build reality (TDD)

- Runtime and host: what machine actually runs this, and must it be awake?
- Storage: how much data, who reads it, does it need to survive the laptop?
- Is there an existing repo whose patterns should be reused? Copy the patterns, not the code.
- What is the one component you would be annoyed to hand-write? (Often the answer is a
  library or an existing service.)
- What must be locked so a later session cannot relitigate it?

## Research-agent prompt templates

Launch all four in ONE message. Each gets an explicit model. Each returns raw findings.

**Shared prompt spine** - every agent gets these lines:

```text
You are a {role} researching for {one-line product statement}.
Context: {platform, budget ceiling, user count, the developer's skill set}.
Return RAW STRUCTURED FINDINGS as markdown - this is data for a requirements document, not an
essay: tables where comparable, bullets otherwise, source URLs inline, under ~150 lines.
Flag anything you could NOT verify rather than smoothing over it.
```

1. **Competitor / prior-art** - "a table of 8-15 comparable tools (name, category, what it
   does, price, key strength, key weakness); the 5-10 most common user complaints with a
   source note each; the gaps a personal/bespoke build could exploit that a commercial product
   structurally cannot."
2. **Data / API feasibility** - "for each candidate source: cost, rate limits, granularity,
   history depth, realtime or delayed, the specific coverage this project needs, and auth
   type. Verify current pricing - published tier prices go stale fast. End with the best free
   stack and the best under-{budget} stack, with reasoning."
3. **Domain knowledge** - "the vocabulary and conventions a spec must use; the formulas with
   their units and a worked example; the standard lifecycle of the core object; known failure
   modes of tools in this space. Precision beats prose - the FSD will copy these definitions."
4. **Integration / tooling** - "for each candidate library/server/SDK: source URL, what it
   provides, maturity (stars, last commit, tests), platform constraints, and red flags. End
   with the most realistic stack for this use case, and correct me if my prior is wrong."

**Then**: write each verbatim into `research/0N-{topic}.md` under a header naming the producer
and the date, and state in the summary which claims are estimates rather than facts.

## Answer to section map

| Answer about | Lands in |
| --- | --- |
| what/who/why, pains, ambition | Discovery 1-4, BRD 1-3 |
| explicit non-goals, "never happens" | PRD non-goals, BRD scope, FSD guardrails |
| the success measurement | BRD 4 (authoritative), PRD metrics (cites), FSD dashboard (renders) |
| cost ceiling, timeline | BRD 6-7 |
| trigger, inputs, artifact | PRD features, FSD pipeline |
| every behavior-edge answer | FSD rules, state machine, error table |
| runtime, storage, reuse | TDD stack, schema, decision log |
| anything locked | PRD locked decisions + TDD decision log |

## Reading the answers

- **A vague answer is a real answer**: "not sure yet" means the decision belongs downstream -
  record it as an open question with an owner stage, do not invent a value.
- **A changed answer outranks an earlier one.** Restate the delta and patch every document
  that already encoded the old value in the same pass.
- **An answer that breaks the arithmetic is a finding**, not an instruction to comply
  silently: say what it implies in one sentence, offer the fix, then follow their call.
- **"Do whatever you think is best" is permission, not absence of a decision** - make the
  call, write it in the locked-decisions list, and name it in the handoff so it can be
  overridden knowingly.
