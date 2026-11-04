# Audit protocol - prompts, lenses, dimensions, log format

## Contents

- [The auditor prompt spine](#the-auditor-prompt-spine)
- [Layer 1 - cross-set audit](#layer-1---cross-set-audit)
- [Layer 2 - re-verify](#layer-2---re-verify)
- [Layer 3 - targeted confirm](#layer-3---targeted-confirm)
- [Layer 4 - per-document lenses](#layer-4---per-document-lenses)
- [Universal audit dimensions](#universal-audit-dimensions)
- [Audit log format](#audit-log-format)

## The auditor prompt spine

Every auditor prompt carries these five parts. Omit one and the findings degrade.

```text
1. ROLE + TARGET   You are an adversarial {requirements|architecture|process} auditor.
                   Read fully, word by word: {absolute paths}.
2. DOMAIN CONTEXT  {What the product is, the stack, platform, budget, users, constraints.}
                   {Where the documents sit relative to each other.}
3. ALREADY FIXED   {Point at the audit log.} Do NOT re-report resolved findings - hunt NEW
                   defects and seams the fixes left behind.
4. DIMENSIONS      {The numbered lens for this auditor - see below.}
5. OUTPUT          Verdict line first ({vocabulary}), then findings as
                   [SEVERITY: BLOCKER/MAJOR/MINOR] file §section - issue - suggested fix.
                   Be specific and skeptical. No padding, no praise. Under ~{N} lines.
```

Every auditor is the `audit-docs` agent (`.claude/agents/audit-docs.md`, read-only tools),
with the round named as `LAYER: CROSS-SET | RE-VERIFY | CONFIRM | PER-DOCUMENT`. Explicit
`model: "sonnet"` on every spawn. Multiple auditors go out in ONE message.

## Layer 1 - cross-set audit

One agent, every document. Dimensions:

1. **Cross-document consistency** - every number, enum, threshold, time and rule must match
   everywhere it appears. List each contradiction with both locations.
2. **Stage traceability** - every requirement has downstream coverage; every "open question"
   is answered somewhere; nothing was silently dropped between documents.
3. **Internal logic** - contradictions and under-specification a builder or QA would trip on.
   Probe the edges explicitly: tie-breaks, expiry semantics, concurrency, day boundaries,
   what a state can never reach, what a metric cannot count.
4. **Arithmetic and domain math** - recompute every formula, both directions where symmetric.
   Verify the success metric actually implies the goal under the system's own mechanics.
5. **Document-type completeness** - what a document of this type must carry and does not.
   Flag only gaps with practical consequence; no enterprise boilerplate for its own sake.
6. **Feasibility red flags** - anything technically wrong or unbuildable as specified.

## Layer 2 - re-verify

Same agent, after the fix pass. It keeps its findings context, so the prompt is short:

```text
All findings were accepted and a fix pass applied {+ any decisions the developer made}.
Key mechanisms introduced: {list them, so the agent knows what to inspect}.
Please RE-READ the revised documents and verify skeptically:
1. For each earlier finding: is it actually resolved IN THE TEXT (cite the section) or
   UNRESOLVED?
2. Did the fixes introduce NEW contradictions? Probe specifically: {name the seams you suspect}.
3. Any leftover stale text from the old wording?
Return: verdict, then per-finding status (RESOLVED @ section / UNRESOLVED / REGRESSION), then
new findings with severity.
```

Naming the seams you suspect is not leading the witness - it is directing scarce attention at
the joins the fix pass actually touched.

## Layer 3 - targeted confirm

Same agent, only the round-2 fixes, item by item, with a per-item pass/fail one-liner. Cheap,
and it closes the loop honestly instead of assuming.

## Layer 4 - per-document lenses

One agent per file, all dispatched together. Give each the spine plus its lens.

| Document | Lens |
| --- | --- |
| Discovery / kickoff notes | Currency: does anything here now mislead a new reader after later decisions? Are supersession markers present? Are all carried-forward questions answered somewhere? |
| BRD / charter | Are objectives measurable *as stated*? Recompute the success metric's implications. Are scope boundaries unambiguous? Is any material risk missing (dependency limits, vendor/model drift, environment loss, measurement bias)? |
| PRD / product spec | Is every acceptance criterion objectively testable? Flag any adjective doing load-bearing work. Does any Must depend on a Should? Do PRD numbers still match the FSD's refinements? |
| FSD / behavior spec | Walk the state machine: is any reachable situation undefined? Recompute every formula both directions. Verify timezone/DST math at both states. Does every field get used, and every rule have a field? Could two implementations diverge anywhere? |
| TDD / technical design | Field-by-field schema diff against the behavior spec. Concurrency and blocking-call holes. Is every integrity mechanism specified precisely enough to implement twice identically? Is every Must assigned to a milestone? Does anything depend on something scheduled later? |
| Index / tracker | Do all links resolve and all statuses match the linked files? Do the counts reconcile? Is the headline claim stronger than the evidence? |
| The audit log itself | Sample at least 10 claimed resolutions INCLUDING every blocker and verify each exists in the current text. Do the counts reconcile with the listed rows? Are the caveats consistent with the claims? |
| Research appendices | Internal consistency; whether downstream citations kept the hedges; whether a superseded recommendation is marked; load-bearing claims that are single-source estimates presented as fact. |

**Every layer-4 auditor also applies the silence lens and ends with a ruling.** Attack what the
document is SILENT about: states, inputs and failures the system can reach that the text never
mentions (empty / loading / error / max-truncation / expired / concurrent / dependency down), and
behaviour written only for the happy path - counted as unwritten when the uncovered cases need
different handling or recovery. Before a clean ruling, picture the support tickets the day after
launch: three concrete "when the user does X during Y, Z is undefined" scenarios, each checked.
Ruling per document: **Approve** (0 blocker, 0 major) / **Conditional** (0 blocker, >= 1 major -
list them) / **Reject** (>= 1 blocker). Adapted from claude-code-templates
`cli-tool/components/skills/productivity/devil/SKILL.md` @ 8b1f883, MIT, (c) 2025 Daniel (San)
Avila.

## Universal audit dimensions

Useful on any document set, in any domain:

- **Numbers**: every threshold has one home, a unit, and a rounding rule.
- **Enums**: spelled identically in prose, schema, and code contracts.
- **Time**: storage vs display, DST, day boundaries, what "expired" means.
- **Money/risk math**: recompute; check the anchor price/quantity is defined.
- **Failure paths**: every dependency has a defined down-behavior, and it is visible not silent.
- **Ambiguity**: whenever two events cannot be ordered, the resolution is stated and pessimistic.
- **Traceability**: every claim from research keeps its hedge; every requirement has an owner.
- **Implementability**: could two competent builders produce diverging systems from this text?

## Audit log format

`audits/{YYYY-MM-DD}-{topic}.md`:

```markdown
# Adversarial Review - {date}

> Independent audit of {scope} by fresh reviewer agents. Original verdict: **{verdict}**.
> {Resolution status.} {What the reviewer assessed as structurally sound.}

## Blockers (N) - status

| # | Finding | Resolution |
| --- | --- | --- |
| B1 | {defect} | {what changed, where} |

## Majors (N) - status
{same table}

## Minors (N)
{one line each, or a dense paragraph with doc anchors}

## Round 2 - re-verify
{verdict; per-finding status; the new findings the fix pass introduced, and their fixes}

## Round 3 - targeted confirm
{per-item pass/fail}

## Layer 4 - per-document audits
{totals; one line per document with its ruling (Approve / Conditional / Reject); then the
 sharpest findings per document, silence-lens findings included}

## Caveats
{What was applied without independent re-verification. What a round did not sample.
 The standing rule: substantive changes re-run an audit before a build depends on them.}
```

Rules for the log: give every finding a stable id so later rounds can reference it; make the
count chain reconcile with the rows actually listed; never state a verdict stronger than the
rounds support; carry the caveats into the tracker README so the headline cannot outrun them.
