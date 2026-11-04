---
allowed-tools: Read, Glob, Grep, Bash(git:*), Bash(just test:*), Bash(just lint:*), Bash(mktemp:*), Bash(chmod:*), Bash(cat:*)
argument-hint: <failing test, page or behaviour>
description: Find the commit that broke something - reproduce narrowly, read recent history, and git-bisect in a throwaway worktree off main with an exit-125-aware wrapper around `just test <selector>`
---

# Regression triage

Find the commit that introduced: **$ARGUMENTS**

Adapted from claude-code-templates `cli-tool/components/commands/testing/regression-triage.md`
@ 8b1f883, MIT, (c) 2025 Daniel (San) Avila, via a downstream project port; made stack-neutral for the kit:
the bisect command is `just test <selector>`, and environment failures are classified as "cannot
test" (exit 125) instead of "bad".

## 0. Never in the owner's tree

Work in a fresh worktree, so nothing checked out by another session moves:

```bash
W="$(mktemp -d)/triage"
git fetch origin main
git worktree add --detach "$W" origin/main
cd "$W" || exit 1
```

Then the project's bootstrap there: `just deps` (`npm install`). Local data stores and git-ignored state are absent in the worktree, which is what
you want. Remove it at the end (`git worktree remove "$W"`).

## 1. Reproduce narrowly

Treat `$ARGUMENTS` as a description, not a command. Turn it into ONE validated test selector
(a test id, a file, or a name filter - `just test` takes no selector yet; use the template path) and run it:

```bash
just test <selector>
```

If `just test` takes no selector (the skeleton's own recipe runs the whole Pester suite), use the
runner's narrow form instead everywhere below - for the skeleton:
`pwsh -NoProfile -Command "Invoke-Pester -Path tests -FullNameFilter '*<name>*' -CI"` - `-CI` is
what makes it exit non-zero on a failing test (without it Pester prints `Failed: 1` and exits 0,
so a bisect would call every commit good) - and say which form you used.

No test reproduces it? Write the smallest failing one first (that is the fix's test anyway), then
continue. Already failing on `origin/main` before the suspect window? Then it is not a regression -
say so.

## 2. Read the history before bisecting

```bash
git log --oneline --decorate -20 -- <paths the failure touches>
git show --stat <commit>
git show <commit> -- <path>
```

A single obvious commit? Confirm it by checking out its parent in the worktree and running the
selector - done.

## 3. Bisect (only if the window is unclear and the test is deterministic and fast)

The wrapper separates "broke" from "could not run". `git bisect run` treats 0 as good, 1-127
(except 125) as bad, and **125 as skip**. A commit whose dependencies do not install, or whose
runner errors before running a test (collection/import/compile errors, a missing tool), is 125 -
not a failure.

```bash
WRAP="$(mktemp -d)/bisect.sh"
cat > "$WRAP" <<'SH'
#!/usr/bin/env bash
# BISECT_SELECTOR=<selector> bisect.sh - exit 0 good, 1 bad, 125 cannot test
out="$(just test "$BISECT_SELECTOR" 2>&1)"; code=$?
[ "$code" -eq 0 ] && exit 0
# Environment / could-not-run signatures -> skip. Extend per stack.
if printf '%s' "$out" | grep -qiE 'command not found|cannot find module|modulenotfound|no tests? (found|ran|collected)|could not resolve|compilation failed|error: recipe .* could not be run|access is denied|database is locked|address already in use'; then
  exit 125
fi
exit 1
SH
chmod +x "$WRAP"
git bisect start HEAD <known-good-sha>
BISECT_SELECTOR="<selector>" git bisect run "$WRAP"
git bisect reset
```

(The wrapper reads its inputs from `BISECT_*` environment variables, never from positional shell arguments: Claude Code replaces a dollar sign followed by a digit inside a command file with the words the developer typed, which silently turned the selector into one of those words.)

Node exits 1 for a failed check and 9 for an invalid argument; map an unreadable or missing script (exit 1 with a module-not-found message) to 125. If the bootstrap
changes between commits, run it inside the wrapper first and `exit 125` when it fails.

## 4. Report

- the failing selector and its error, trimmed;
- the first bad commit (`git show --stat`) and the line(s) that cause it;
- the minimal fix and the test that must pass after it;
- every skipped (125) commit and why.

Do not fix it here, do not commit, do not push. Destructive git (`reset --hard`, `branch -D`,
force) is out of bounds; `git bisect reset` and the worktree removal are the only cleanup.
