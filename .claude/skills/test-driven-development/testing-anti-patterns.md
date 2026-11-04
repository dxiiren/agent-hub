# Testing anti-patterns

Load this before you write or change a test, add a mock or a fake, create a filesystem fixture,
or feel tempted to add a test-only method to production code.

**Core principle:** test what the code does, not what the mocks do. A green suite of mock-only
tests proves the mocks agree with each other.

## The iron laws

```
1. NEVER assert on mock behaviour
2. NEVER add test-only methods to production classes
3. NEVER mock without understanding the dependency's side effects
4. NEVER run a red test that can reach real data
```

## 1. Asserting on mock behaviour

A test that sets up a mock, calls the code, and then only checks "the mock was called once" proves
the call happened, not that anything useful did. Assert on the **outcome**: the row stored, the
file written (inside the sandbox), the response returned, the event emitted. If you cannot observe
an outcome without the mock, give the collaborator a stand-in that behaves like the real thing (a
fake binary that echoes what it was handed catches bugs a mock never will).

Gate: before any "was called" assertion, ask "if the real code did nothing useful, would this
still pass?" If yes, assert on the outcome instead.

## 2. Test-only methods in production

A `resetForTests()` on a service, or a public setter used only by a test. Put the helper in the
test tree (a base class, a fixture, a helper function) or inject the dependency. Production code
must not carry a method it could call by mistake.

Gate: before you add a method, ask "is anything except a test going to call this?"

## 3. Mocking without understanding

Faking a whole service "to be safe", when the method you faked had the side effect your test
depended on. Fake the **lowest** layer that is slow or external (the HTTP client, the queue, the
external binary) and keep the real code above it. Unsure? Run the test once against the real
implementation (sandboxed) and observe what it does.

Warning signs: "I'll mock this to be safe", mock setup longer than the test, a test that breaks
when you remove a mock it should not need.

## 4. Incomplete fakes

A fake HTTP response with only the one field this test reads. Downstream code that reads a field
you left out fails in production while the test stays green. Copy the **complete** shape from a
real, recorded response or the vendor's docs - every field the code could read.

## 5. Tests as an afterthought

"Implementation complete, tests to follow" is not complete. A test written after the code passes at
once and proves nothing. For a guard over code that already exists, prove its RED with a mutant
(`reference.md` section 4).

## 6. The destructive red

A red run executes the **old** code. A test for a delete/cleanup bug, built with the names or
timestamps of REAL files and run red before its sandbox existed, makes the old code delete those
real files. The fix, in this order:

1. **Isolation first.** Prove the path is a sandbox (a per-test temp dir) before writing behaviour
   tests. Anything that reaches disk, the network or a credential gets sandboxed first.
2. **Impossible fixtures.** 2001 dates, ids like 999999, names nobody would create. Never copy a
   value from real data, a log or a screenshot.
3. **Ask what the OLD code does** with these inputs before the first run.

The same applies to anything that spends money or rotates a credential: a test must never reach a
paid API, a real account or a production server.

## 7. Believing a red suite during a concurrent run

Two test runs at once, or another session committing (pre-commit hooks can stash unstaged files
while they run), produce phantom failures. Check `git log`, clear caches, re-run alone before you
debug.

## Quick reference

| Anti-pattern | Fix |
| --- | --- |
| Assert on mock calls | Assert on the stored outcome, or use a behaving stand-in |
| Test-only production method | Helper in the test tree, or inject the dependency |
| Mocking to be safe | Fake the lowest external layer only |
| Partial fake response | Copy the complete real shape |
| Tests after the code | Test first; mutant for existing code |
| Red run reaches real data | Sandbox first, impossible fixtures, think about the OLD code |
| Red suite during another run | Re-run alone before believing it |

Mocks are tools to isolate, not the thing under test. Green is still not proof: finish with
`verify-before-claim`.

Adapted from claude-code-templates
`cli-tool/components/skills/development/test-driven-development/testing-anti-patterns.md`
@ 8b1f883, MIT, (c) 2025 Daniel (San) Avila; sections 6-7 added from a downstream project's
incidents.
