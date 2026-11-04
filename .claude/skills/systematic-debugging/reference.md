# systematic-debugging - reference

Heavy reference for the `systematic-debugging` agent. Read the section you need.

## Contents

1. Observability first (where to look before reading code)
2. Trap catalogue (Phase 0 detail)
3. Flaky tests: taxonomy, repeat loop, stabilisation
4. Root-cause tracing (backwards through the call chain)
5. Finding a polluting test (`find-polluter.sh`)
6. `git bisect run` with an environment-aware wrapper (exit 125)
7. Defence in depth (after the root cause is fixed)
8. Condition-based waiting (instead of sleeps)

---

## 1. Observability first

For anything that happened in the running app (not a unit test), look at evidence in this order
before forming a hypothesis:

1. **The first error, not the last.** The log around the first failure's timestamp (+/- 2
   minutes); in a browser, the console and the network tab (Playwright MCP
   `browser_console_messages` / `browser_network_requests`). there are none; read the script output.
2. **The stored state.** Read the row, the file, the cache entry the feature wrote - read-only.
   A flash message or a rendered page is not evidence of what was stored. no data store.
3. **Change correlation.** Anything within ~30 minutes before the first error: a commit
   (`git log --since="2 hours ago"`), a deploy, a config or env edit, a dependency or tool bump, a
   restored backup that replaced local data.

Only then read code.

## 2. Trap catalogue

Each of these produces a wrong conclusion regularly. Check the relevant ones before believing a
symptom.

| Symptom | Likely real cause | Check / fix |
|---|---|---|
| Behaves as if your change is not there | A long-running process (server, watcher, worker, REPL) loaded the old code | Restart it; confirm with a log line printed at startup |
| Live check shows markup/behaviour that no longer exists in source | Another session committing: pre-commit hooks stash unstaged files while they run | `git log` first, clear caches, re-run |
| Whole suite red with hundreds of failures | Two test runs at once sharing a sandbox, temp dir or database | Re-run ALONE; give each run a per-process sandbox |
| "Access is denied" on rename / delete (Windows) | Another process holds the file open (an editor, an indexer, a second process) | Environment flake; retry. Code writing shared files needs retry + an in-place fallback |
| "database is locked" / busy | SQLite (or any single-writer store) under concurrent processes | Bounded, jittered retry; never let a lock fail OPEN |
| Script hangs for minutes in automation | An interactive prompt (a REPL after a script, an ssh host-key prompt, a credential helper) | Close stdin (`< /dev/null`), pass batch/non-interactive flags |
| Browser assertion reads the previous state | The UI updates on the next animation frame; a background automated window runs ~1 fps | Wait for the condition, never a fixed short pause |
| A promise/await never settles after a network hiccup | The framework only rejects on some failure paths | Hook the failure path explicitly and keep a watchdog |
| Paths "do not exist" from Git Bash | MSYS rewrote `/c/...` or `<rev>:<path>` | Hand native tools `C:/...`; `MSYS_NO_PATHCONV=1` for `<rev>:<path>` |
| Encoding garbage / "Unexpected token" in PowerShell | Windows PowerShell 5.1 read a BOM-less UTF-8 file as ANSI | See the `powershell-windows` skill |
| Remote host suddenly refuses ssh | A rate limiter (e.g. ufw limit) banned the burst; retrying extends the ban | Stop for several minutes; batch probes into ONE connection |
| A test touched real data | The test escaped its sandbox | `find-polluter.sh`; sandbox first, impossible fixtures |

none recorded yet; append one row each, with the date.

Never start a paid run or spend a vendor quota just to reproduce a bug - fake the HTTP layer or the
external binary instead.

## 3. Flaky tests

### 3.1 Measure the flake rate first

Repeat with a loop (most runners have no built-in repeat):

```bash
passes=0; fails=0
for i in $(seq 1 20); do
  if just test <selector> >"$TEMP/run-$i.log" 2>&1; then passes=$((passes+1)); else fails=$((fails+1)); echo "fail on run $i (see $TEMP/run-$i.log)"; fi
done
echo "$passes passed, $fails failed out of 20"
```

`just test` takes no selector yet and has no random-order flag.
Keep the failing runs' output. Make sure NOTHING else runs the suite meanwhile.

### 3.2 Taxonomy

1. **Timing / async race** - passes locally, fails under load or in CI. Asserting before an async
   update lands; a background job assumed finished; event ordering. Fix: wait for the condition
   (section 8), never a longer sleep.
2. **Order dependency / state pollution** - passes alone, fails in the suite (or the reverse). A
   test writing outside its sandbox; global/static state left modified; a shared fake reset
   mid-test. Verify: random order with a printed seed, then reproduce with that seed;
   `find-polluter.sh` for filesystem leaks.
3. **Clock / timezone** - fails near midnight, month end, DST, or in another timezone. Fix: an
   injected or frozen clock; impossible fixture dates (e.g. 2001).
4. **Resource contention** - "Access is denied", "database is locked", port in use. Fix:
   per-process names, retries with a fallback, never a hard-coded shared temp name.

### 3.3 Stabilise, then certify

- Never fix a flake by raising a sleep or a timeout, skipping it, or weakening the assertion.
- After the fix: 50 consecutive passes with the loop (stop on first failure), one random-order run
  of the enclosing file, then the full gate ALONE.
- Report: flake rate before, the root cause (category + mechanism), the change, the certification.

## 4. Root-cause tracing

Symptoms appear deep in the stack; the cause is higher up.

1. Observe the symptom ("a file appeared in the real data directory").
2. Find the immediate cause (which function wrote it).
3. Ask what called it, with what value.
4. Keep going up until the value's origin (a test that never overrode a setting).
5. Fix at the origin, then add defence in depth (section 7).

If you cannot trace by reading, instrument right BEFORE the dangerous operation: log the value,
the cwd, the environment name and a stack trace, run once, then remove the instrumentation.

## 5. Finding a polluting test

`find-polluter.sh` (this directory) runs test files one at a time through a command template and
fingerprints the watched paths (names, sizes, mtimes) before and after each. It stops at the first
file that makes a path appear, disappear or change, and exits 1. It first checks the paths are not
already changing on their own (a server, another run) and exits 3 if they are.

```bash
# runner template: {} is replaced by the test file (default: just test {})
bash .claude/skills/systematic-debugging/find-polluter.sh -w data -w .env 'tests/*.Tests.ps1'
bash .claude/skills/systematic-debugging/find-polluter.sh -r 'npx vitest run {}' -w storage 'tests/unit/*.test.ts'
```

Do not watch a directory the sandbox itself uses: every test touches it by design and the first
file is "found". One file at a time only: a polluter that needs two tests in a row shows up as
"none found" - then bisect the ORDER with the runner's random-order seed.

## 6. `git bisect run` with an environment-aware wrapper

`git bisect run` treats exit 0 as good, 1-127 (except 125) as bad, and **125 as "cannot test this
commit - skip"**. Mark a commit bad only when the CODE failed; when the environment failed (deps
out of step, a locked file, a missing tool), exit 125. The ready-made wrapper lives in
`/regression-triage` (`.claude/commands/regression-triage.md` section 3). Bisect in a separate
worktree (`git worktree add <scratch>/bisect <bad>`) so the running app and other sessions are not
disturbed.

## 7. Defence in depth

After fixing at the source, make the bug structurally impossible at each layer the value passes:

1. **Entry** - reject bad input at the boundary (validation, typed parsing).
2. **Business logic** - the operation refuses nonsense (check ownership before deleting).
3. **Environment guard** - refuse dangerous operations in tests (block stray network calls,
   sandbox every path a test can reach).
4. **Source-level guard test** - a test that fails the build if the load-bearing line drifts.
5. **Instrumentation** - a log line naming what happened, for next time.

## 8. Condition-based waiting

Wait for the condition, not for a guess at how long it takes:

```bash
for i in $(seq 1 60); do curl -fs "$URL/health" >/dev/null && break; sleep 2; done
```

- Browser checks (Playwright MCP `browser_wait_for`): wait for the text or element, never a bare
  pause.
- In test code: a `waitFor(condition, what, timeoutMs)` helper that polls every ~20 ms and throws
  `Timed out waiting for <what> after <n> ms`.
- A fixed delay is correct only when testing timing itself (a debounce, a lock TTL) - derive it
  from the known interval and comment why.

Adapted from claude-code-templates `cli-tool/components/skills/development/systematic-debugging/`
(root-cause-tracing.md, defense-in-depth.md, condition-based-waiting.md) and
`cli-tool/components/commands/testing/flaky-test-triage.md` @ 8b1f883, MIT, (c) 2025 Daniel (San)
Avila.
