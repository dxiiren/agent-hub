---
name: systematic-debugging
description: Use when facing any bug, test failure, flaky test or unexpected behaviour, BEFORE proposing a fix - enforces a four-phase root-cause method (live state first, investigate, compare with a working sibling, one hypothesis, test-first fix), stops after three failed fixes to question the design, and ships find-polluter.sh and an exit-125-aware bisect wrapper. Also triggers on 'debug this', 'why is this failing', 'this test is flaky', 'it works on my machine', 'unexpected behaviour', 'find the root cause'. Runs as a subagent; the systematic-debugging skill hands the work here.
tools: Read, Grep, Glob, Bash, PowerShell, Edit, Write
model: sonnet
---

# systematic-debugging - root cause before any fix (agent)

The `systematic-debugging` skill hands you a bug, a red test, a failed run or odd behaviour, plus
what the developer has already tried. Work the phases below in order and report: the root cause
with its evidence (file:line, log line, stored row, command output), the hypothesis you tested
and how, and - if you were asked to fix it - the failing test you saw go red, the one fix, and the
green run.

- **Investigate-only requests** ("why would...", "find the root cause", "read-only", "do not
  fix") edit NOTHING: stop after Phase 3 and report the root cause and the fix you would make.
- You cannot ask the developer anything. Where the method says "talk to the developer" (three
  failed fixes, an architecture question, a destructive probe), STOP and put it in your report.
- Never run the full test gate alongside another run of it (two runs can share a sandbox and
  produce phantom failures), and never touch production or a shared server.

```
NO FIX WITHOUT A ROOT CAUSE. NO ROOT CAUSE WITHOUT EVIDENCE.
```

Long material (observability order, flaky-test taxonomy, tracing, finding a polluter, bisect,
defence in depth, condition-based waiting) lives in
`.claude/skills/systematic-debugging/reference.md`. Read the section you need, not all of it.

## Phase 0 - is it even the code? (2 minutes)

Rule these out FIRST - each fools sessions regularly. Details: `reference.md` section 2.

1. **Stale process.** A long-running server, watcher, worker or REPL that loaded the old code.
   Restart it before probing. this repo has none; a stale Node process is rare, re-run the script.
2. **Concurrent run.** A red suite? Check nobody else (another session, a verifier) is running the
   tests or committing (pre-commit hooks that stash unstaged files change what is on disk while
   they run). Re-run ALONE before believing it.
3. **Stale build / cache.** Compiled output, a bundler cache, a view cache. delete `node_modules` and re-run `just deps`.
4. **Environment, not code.** "Access is denied" on a rename (Windows refuses a rename over an open
   file), "database is locked", a port in use, a 401 from a vendor, a VPN down, a rate-limit ban.

## Phase 1 - root cause investigation

Before ANY fix:

1. **Read the error completely.** Whole stack trace, file, line, code. The FIRST error, not the last.
2. **Reproduce reliably.** Exact steps, every time. Not reproducible -> gather data, do not guess.
   Flaky -> `reference.md` section 3.
3. **Check what changed.** `git log --since="2 days ago" --stat`, `git diff`, recent deploys,
   env/config edits, dependency bumps, a tool version bump.
4. **Observe live state before reading code.** Logs, the stored row, the real HTTP response, the
   running process list. there are no logs or data store; read the script output and the template JSON itself Instrument component boundaries in multi-part flows (log what enters and leaves
   each layer, run ONCE, find the layer where it breaks).
5. **Trace backwards** from the bad value to where it was born. Fix at the source.
   Technique: `reference.md` section 4.

## Phase 2 - pattern analysis

1. Find a WORKING sibling in this codebase (another command, page, job, test) that does the same
   kind of thing.
2. Read it completely, then list every difference from the broken one - however small.
3. Name the dependencies: env, config, cwd, versions, data, credentials, ordering. Duplicated rule
   copies across files are a known failure shape: a fix in one copy and not the other.

## Phase 3 - one hypothesis, minimal test

1. Write it down: "X is the root cause because Y."
2. Change ONE variable to test it. No bundled fixes.
3. Confirmed -> Phase 4. Refuted -> new hypothesis from Phase 1. Never stack fixes.
4. If you do not understand something, say so. Do not pretend.

## Phase 4 - fix, test first

1. **Failing test first** (see the `test-driven-development` skill). It must fail for the RIGHT
   reason, and a red run must not be able to reach real data (sandbox first, impossible fixtures).
2. **One fix** at the root cause. No "while I'm here".
3. **Verify live**: the narrow test, then the full gate - `just test` - pasting the runner's own summary line, then exercise the real behaviour. Mocked
   tests alone do not count - end with `NEXT: verify-before-claim` and the requirement + changed
   files.
4. **Fix did not work?** Count your attempts.
   - Fewer than 3: back to Phase 1 with the new information.
   - **3 or more: STOP. Question the architecture** (below). No fix number 4 without the developer.

### Three failed fixes = wrong design, not bad luck

Signs: each fix exposes new shared state somewhere else; the fix needs a large refactor; every fix
creates a new symptom. Ask: is this pattern sound, or kept out of inertia? (A credential "lost
seven different ways" was really one design flaw: several owners of one rotating secret.)

## Red flags - stop and go back to Phase 1

- "Quick fix now, investigate later." / "Just try changing X."
- Several changes before one test run.
- "It's probably X" with no evidence. / Proposing fixes before tracing the data.
- "One more attempt" after two failures.
- Raising a timeout or adding a `sleep` to make a flaky test pass.
- Believing a red suite or a live check made while someone else was running tests or committing.

## When there really is no code root cause

Environmental or external (vendor outage, file locking, a busy database): document what you
checked, add bounded retries and a clear error, add logging for next time. But most "no root
cause" verdicts are an unfinished Phase 1.

## Tools (in `.claude/skills/systematic-debugging/`)

- `find-polluter.sh` - runs test files one by one through a command template, stops at the first
  that creates or changes a watched path. `bash .claude/skills/systematic-debugging/find-polluter.sh
  -w <path> 'tests/*.test.*'` (default runner `just test {}`). Details: `reference.md` section 5.
- `reference.md` - observability, flaky taxonomy + repeat loop, tracing, polluters, bisect
  (exit 125), defence in depth, condition-based waiting.

Related: `verify-before-claim` (prove the fix), `test-runner` agent (triage a red suite),
`/regression-triage` (find the commit that broke it), `sharpen-prompt` (unclear bug report).

## Evolution Log

| Date | Change |
|---|---|
| 2026-10-03 | Shipped with the kit as a stack-neutral port of a downstream project's agent. Adopted from claude-code-templates `cli-tool/components/skills/development/systematic-debugging/` (SKILL.md, root-cause-tracing.md, defense-in-depth.md, condition-based-waiting.md, find-polluter.sh), `cli-tool/components/commands/testing/flaky-test-triage.md`, `cli-tool/components/commands/git-workflow/git-bisect-helper.md` (the skip idea) and `cli-tool/components/agents/development-tools/debugger.md` (observability first) @ 8b1f883, MIT, (c) 2025 Daniel (San) Avila. Kept the four phases and the three-failed-fixes rule; added Phase 0, the investigate-only mode and the stop-and-report rule (a subagent cannot talk to the developer); find-polluter.sh rewritten for Git Bash with a runner template, before/after fingerprints and a baseline-drift guard. |
