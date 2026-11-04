# test-driven-development - reference

Read by the `test-driven-development` agent before the first test.

## Contents

1. Running tests in this repo
2. The infra behaviour/acceptance table
3. Source-level guard tests
4. Proving RED with a mutant
5. A bug fix, start to finish

---

## 1. Running tests in this repo

there is no test runner yet. The only gate is `just test`, which runs `scripts/check-config.mjs`; plugin tests land per `specs/001-agent-hub/tasks.md`. New tests use Node's built-in `node:test` and the full gate stays `just test`.

The skeleton's own suite: `just test` -> Pester 5 under `pwsh` running `tests/init.Tests.ps1`.
Each `Describe` copies the skeleton to a fresh `%TEMP%` folder and runs `init.ps1` there, so the
working tree is never scaffolded - a new test follows the same copy-first shape. Narrow run:
`pwsh -NoProfile -Command "Invoke-Pester -Path tests -FullNameFilter '*<name>*' -Output Detailed"`.
Pester's own summary line (`Tests Passed: N, Failed: M ...`) is what goes in the report.

## 2. The infra behaviour/acceptance table

Use it when there is no natural unit test: scripts, recipes, CI, container files, installers.
Write it **before** the change. Number the rows; each is an observable behaviour plus the exact
command that proves it, run against the real tool.

| # | Behaviour | Proof command | Result |
| --- | --- | --- | --- |
| 1 | the installer refuses to run twice | run it, run it again | 2nd run exits 1, "already installed" |
| 2 | ... and leaves the first install untouched | hash the installed files before/after row 1 | same hashes |
| 3 | a missing required value fails BEFORE touching anything | run without it in a temp copy | exit 1, temp copy unchanged |

Every row must pass before you call it done. A row you could not run is **UNVERIFIED**, never a
pass. Then add a guard test (section 3) so the rows cannot quietly regress.

## 3. Source-level guard tests

When load-bearing lines live in a script or config that has no harness of its own, guard them
with a test that reads the **source** and asserts the lines are still there - in whatever test
framework the project has (the skeleton's Pester suite already does this: it parses
`initial-setup.ps1` with the 5.1 parser).

- A header comment that says **why** each line matters, with the date and what went wrong, and
  states plainly what the guard cannot prove ("it cannot prove the service starts - only a live
  run does that").
- Assert the file exists first; normalise `\r\n` to `\n`.
- **Scope each assertion to the part that matters.** Extract the recipe body, the `case` arm or
  the `if` branch first, then assert inside it - a whole-file "contains" passes even after the
  line moves out of the branch it has to live in.
- Strip comments before asserting something is **absent** (help text mentions the thing it
  forbids).
- Assert **order** where order is the behaviour (the refusals come before the first side effect).
- Put the failure reason in the assertion message.

A guard complements the acceptance table and never replaces it: the table proves the behaviour
once; the guard keeps it from quietly regressing.

## 4. Proving RED with a mutant

A guard written against code that already exists passes on its first run, which proves nothing.
To see it fail for the right reason, feed it a **mutant**: the real source with exactly the
regression it guards against applied **in memory** (a string replace on the loaded text). Never
edit the real file to do this.

The red run must show every **mutant row fails on the assertion written for it** and every
**real row passes**. Paste that output, then delete the mutant case, point the test back at the
real file, and run green. A mutant row that passes means the assertion is too loose (usually a
whole-file contains) - tighten it and re-run.

## 5. A bug fix, start to finish

1. Reproduce the bug by hand once; note the exact input and the wrong output.
2. Step 0: what does the OLD code do with the test's inputs - and can the red run reach real data?
3. Write the test with impossible fixtures; run it narrow; see it fail with the wrong output you
   noted (that is the "right reason").
4. Fix at the root cause (the `systematic-debugging` skill when the cause is not obvious).
5. Narrow green, full suite green (alone), lint clean on the test file.
6. Hand back `NEXT: verify-before-claim` with the requirement and changed files.

Adapted from claude-code-templates `cli-tool/components/skills/development/test-driven-development/`
@ 8b1f883, MIT, (c) 2025 Daniel (San) Avila.
