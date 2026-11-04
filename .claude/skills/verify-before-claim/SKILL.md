---
name: verify-before-claim
description: Use before saying a change is done, fixed, working or verified - spawns a FRESH adversarial verifier subagent that receives only the requirement and the changed-file list, and must prove the change works with live evidence. Also triggers on 'verify this', 'prove it', 'are you sure it works'.
model: sonnet
---

# verify-before-claim — adversarial proof before the claim

Before you tell the developer a change is done, hand it to a **fresh verifier that does
not know what you did**. You cannot verify your own work: you already believe it. The
verifier gets the requirement and the changed-file list — nothing else — and must break
it with live evidence or report PASS with the commands that prove it.

The agent definition lives at `.claude/agents/verifier.md`. The verification itself is ALWAYS
that agent, spawned with `Agent(subagent_type: "verifier", model: "sonnet", ...)` (step 3) - never
probed in your own context. What stays in this skill is the main-session part: deciding to
verify, assembling the two inputs, and acting on the verdict.

## Trigger

- You are about to say **"done"**, **"fixed"**, **"working"**, **"verified"**,
  **"that should do it"**, or ship any equivalent claim.
- The developer says: `"verify this"`, `"prove it"`, `"are you sure it works"`,
  `"did you actually test that"`.

Run it **before** the claim, not after the developer pushes back.

---

## 1 — Stop before the claim

The moment you are about to assert the change works, stop and run this protocol instead.

Do NOT skip it because the change is small, because the build went green, or because the
diff obviously does the right thing. Those are the three conditions under which the
shipped defects in step 5 shipped.

Skip it only when nothing was exercised at all — a docs-only edit with no behaviour
touched. Say plainly that you skipped it and why.

## 2 — Assemble the two inputs, and withhold everything else

The verifier's prompt contains **exactly two things**:

1. **The original requirement**, in the developer's own words. Quote it. Do not
   paraphrase it into your understanding of it, and do not narrow it to the part you
   worked on.
2. **The changed-file list**:

   ```bash
   git status --porcelain
   git diff --name-only
   ```

   (After a commit, use `git diff --name-only HEAD~1` or `git diff --name-only main...HEAD`
   for the branch's full set.)

**Deliberately withhold:** what you changed, which approach you picked, why you picked
it, what you already tested, and your own confidence. Any of it turns the verifier into a
reviewer of your story instead of a prober of the system. If the verifier asks, refuse
and tell it to verify the system.

## 3 — Spawn a FRESH verifier subagent

Spawn `verifier` as a **subagent** — a fresh context, not a section of your own reasoning.
Verifying inside your own context inherits your assumptions and defeats the whole point.

Prompt shape - always this exact call, with `model: "sonnet"` set explicitly (a subagent started
without one inherits the main session's model):

```
Agent(subagent_type: "verifier", model: "sonnet",
      description: "Verify <requirement in 3-5 words>",
      prompt: "REQUIREMENT (verbatim from the developer):
               <the quoted requirement>

               CHANGED FILES:
               <the file list from step 2>

               <this project's live-evidence bar from step 4 and the four failure modes from step 5>

               You are not told what was done or why. Prove it is broken.")
```

One verifier per requirement. If the developer asked for several independent things,
spawn one per thing so a PASS on one cannot cover a FAIL on another.

## 4 — Hand it this project's live-evidence bar

The verifier's toolbelt here is `Read`, `Grep`, `Glob`, `Bash`, and the `mcp__playwright__*`
browser tools. There are no infrastructure servers to lean on — every probe is a local
command or a real browser run.

Include in the prompt how this project is started and exercised:

there is no app or server. Live proof is `just deps && just test` exit 0 with the `scripts/check-config.mjs` summary line, plus `just scan` exit 0. There is no URL to probe.

none; there is no local URL.

nothing to stop (no server).

no data store.

`scripts/**/*.mjs`, `plugins/**`, `config/**/*.json`, `deploy/**`, `ci/**`, excluding `node_modules`.

The bar it must hold: real HTTP calls, real browser runs against the real app, real data
queries, real host commands. **Mocked unit tests alone are an automatic FAIL, and a
passing build is not behaviour.**

## 5 — Name the four failure modes it must sweep

State them in the prompt so no run quietly omits one. These have all shipped before:

| # | Failure mode | What the verifier must do |
| --- | --- | --- |
| 1 | Partial coverage | Grep the whole tree for the pattern the change addressed — prove no second call path, sibling file, or alternate entry point is still on the old behaviour |
| 2 | Over-application | Feed boundary values (empty, one character, shortest legal value, already-transformed input) and read back what actually came out |
| 3 | "Deployment present" read as "behaviour verified" | Drive the real user-facing path; the new string existing in the build output proves nothing |
| 4 | Happy path only | Exercise empty / zero rows / exactly one row / maximum, plus the error path |

Each must be reported explicitly — PASS, FAIL, or UNVERIFIED — even when clean.

## 6 — Take the verdict at face value

The verifier returns one of **PASS / FAIL / PARTIAL** plus a numbered evidence log where
every line is a command actually run and its actual output.

- **PASS** — you may now make the claim. Report the verdict and the evidence log
  **verbatim** alongside it. Never claim more than the log proves.
- **FAIL / PARTIAL** — you are not done. Fix the root cause, then re-run this protocol
  from step 2 with a **new** verifier. Do not argue the finding away, do not re-prompt the
  same verifier for a softer read, and do not report "done with a caveat".
- Any **UNVERIFIED** line stays UNVERIFIED in your report to the developer, with the
  blocker named. Never quietly upgrade it.

If the verifier could not run anything at all, say so in one line and mark the whole
change UNVERIFIED. That is the honest outcome, not a failure of the protocol.

### Acting on the findings (a FAIL, a `/code-review` finding, a Dependabot or PR comment)

1. **Read every finding before touching any.** If one is unclear, stop and clarify it
   first - findings are often related, and fixing the clear half first builds on a guess.
2. **Reproduce each one yourself** with the command its evidence names, and write down
   `REPRODUCED` or `NOT REPRODUCED` plus that command's output. A finding you cannot
   reproduce is not "wrong" yet - say what you could not run.
3. **Push back only with counter-evidence**, never with an opinion: the command and its
   output showing the finding does not hold here (wrong stack, the code path is unused -
   grep it, a prior owner decision recorded in CLAUDE.md). A rejected finding still goes to
   the next fresh verifier, which may disagree.
4. **One fix, one test, per finding**, in the order: breaks / security first, then simple,
   then structural. Re-run the gates after each, not once at the end.
5. **No performative replies.** State the fix and where it is ("Fixed: X in file:line"),
   not agreement. A reviewer suggesting a "proper" feature gets a usage grep first: an
   unused path is removed (YAGNI), not built out.
6. **Reply where the finding lives** - an inline PR comment is answered in its thread
   (`gh api repos/<owner>/<repo>/pulls/<pr>/comments/<id>/replies -f body=...`), not as a new
   PR comment.

---

## The verifier fans out — do not plan its probes

It splits the requirement into independent probes — *is it actually installed in every
layer that governs the session? · positive path · negative path · edge cases (untracked /
staged / empty / one-row / short values) · reach* — and dispatches them as concurrent
subagents, then decides the verdict itself from their raw evidence. Helpers gather
evidence; only the verifier votes.

**🚨 Two operational facts about the verifier agent, proven 13-8-2026:**

1. **Agent definitions load at SESSION START.** Editing the agent file mid-session has no effect on
   that session - both of that day's runs executed serially (759s, 904s) because the fan-out was
   added between them. Runtime speed of the fan-out is still **UNMEASURED**.
2. **A user-scope copy is a separate file, not a link.** Editing one silently leaves the other
   stale. Change the repo copy and re-copy it in the same turn.

Its helpers run on `sonnet` too - `verifier.md` tells it to pass `model: "sonnet"` on every helper.
So hand it the requirement and the changed-file list and let it plan its own coverage. Do
not pre-split the work, do not spawn your own helpers alongside it, and do not narrow its
scope to the part you think is risky. A serial verification of a real change took about 12
minutes and 40 tool calls; the fan-out exists to cut that, never to lower the bar of proof.
## Anti-patterns

- **Never** tell the verifier what you changed or why — that is the one input that
  invalidates the run.
- **Never** verify in your own context. Fresh subagent, every time.
- **Never** accept a green build, a clean lint run, a passing type-check, or "the file is
  deployed" as the evidence. None of those is behaviour.
- **Never** soften or re-word a FAIL when relaying it. Report the defect first, then what
  works.
- **Never** re-run the same verifier hoping for a better verdict. Fix the code, spawn a
  new one.
- **Never** claim done while an UNVERIFIED line stands.

## Evolution Log

- Shipped with the project-skeleton kit: the withhold-the-implementation shape (fresh
  verifier, two inputs only, live-evidence bar, four named failure modes, numbered
  evidence log) — every one of the four modes is a defect that shipped past a self-review
  first. `/ground-project` writes the start / probe / stop / data-store / source-glob
  facts for this repo.
- 2026-10-03: added "Acting on the findings", merged from `receiving-code-review` in
  claude-code-templates (`cli-tool/components/skills/development/receiving-code-review/`
  @ 8b1f883, MIT, (c) 2025 Daniel (San) Avila), via a downstream project's copy. Kept: read all
  before fixing, clarify first, reproduce against the codebase, one fix + one test each, YAGNI
  grep, reply in-thread. Tightened: every rejection needs counter-evidence output, and the next
  fresh verifier still runs - the "do not argue the finding away" rule above stands.
