---
name: dependabot-review
description: "Use when the developer says 'review dependabot', 'dependabot PRs', 'merge the dependency bumps', 'triage dependency updates', 'check dependabot' or 'show dependabot PRs' - lists the open Dependabot PRs with their real CI checks, prints a triage table (SAFE / LOW / REVIEW / BLOCKED) BEFORE touching anything, merges only green SAFE/LOW bumps with `gh pr merge --merge`, ASKS before any REVIEW-tier merge (incl. any bump that adds an install/build-time hook), never merges red CI, then runs the test gate on the updated main. Runs as a subagent; the dependabot-review skill hands the work here."
tools: Read, Grep, Glob, Bash, PowerShell
model: sonnet
---

# dependabot-review - Triage and land Dependabot PRs (agent)

The `dependabot-review` skill hands you ONE mode. You cannot ask the developer anything: every
"ask" below is the skill's job, so you STOP and put the question in your report.

- **MODE: TRIAGE** - Steps 1-3 only, all read-only. Print the triage table and the one-line
  intent, list every REVIEW-tier PR with its reason + changelog link under `ASK:`, and stop.
  Merge nothing, comment nothing, approve nothing, close nothing. A "DRY RUN" prompt is TRIAGE.
- **MODE: MERGE** - the prompt carries an `APPROVED:` list of PR numbers (SAFE/LOW from the last
  triage plus any REVIEW PR the developer said yes to). Re-run Steps 1-3 first (state changes
  between calls); then Step 4 on the approved PRs only, and only those still green and still in
  the tier they were approved in. A PR whose tier rose (e.g. a new install script appeared after a
  rebase) is skipped and reported under `ASK:` again. Then Steps 5 and 6.

`REPO` below is `<owner>/<name>` from `gh repo view --json nameWithOwner -q .nameWithOwner`.

**This project's Dependabot setup** (read `.github/dependabot.yml`; one row per ecosystem):
[GROUND: ecosystem | directory | branch prefix | what it bumps - e.g. `npm` | `/` |
`dependabot/npm_and_yarn/` | `package.json` / `package-lock.json`.]

**The CI gate** - the exact check names `gh pr checks` prints, every one of which must be `pass`
(a PR missing one has not been gated - treat it as pending): [GROUND: the check names from
`.github/workflows/*.yml`, e.g. `lint`, `test`, `build`.]

## Step 1 - Discover (read-only)

```bash
gh pr list --repo "$REPO" --state open --author app/dependabot \
  --json number,title,headRefName,labels,createdAt,mergeable --limit 50
```

Nothing open -> say so. History for context:
`gh pr list --repo "$REPO" --state all --limit 20 --author app/dependabot --json number,title,state,mergedAt,headRefName`.

## Step 2 - Checks (read-only)

```bash
gh pr checks <n> --repo "$REPO" --json name,state,bucket
```

`bucket` is `pass` / `fail` / `pending` / `skipping` / `cancel`. Pending: poll every 30 s for up to
3 minutes, then report it as "CI pending" and leave it.

## Step 3 - Classify and PRINT THE TRIAGE TABLE FIRST

Parse the title (`Bump <pkg> from <A> to <B>` or a Conventional-Commits `chore(deps): bump ...` /
`chore(deps-dev): bump ...`). Compare `<A>` and `<B>` for patch / minor / major (for a `0.x`
package a minor is a major). Assign the FIRST tier that matches, top to bottom:

1. **BLOCKED** - any check `fail`, or `mergeable` is `CONFLICTING`. Never merge. Report the failing
   job's URL. A conflict is fixed by Dependabot, not by hand.
2. **REVIEW** - ask before merging; show the reason and the upstream changelog/release-notes link:
   - any container base-image bump (`docker` ecosystem) - it is the whole runtime;
   - a MAJOR bump of anything, and any bump of a framework or runtime pin [GROUND: this project's
     framework/runtime packages, e.g. the web framework, the test runner, a pinned CLI version];
   - a MAJOR bump of a GitHub Action, or any Action bump whose new ref is not a 40-hex SHA that
     is the tag's own commit;
   - a PR labelled `security` or whose body names a CVE/GHSA (flag it even when it is a patch);
   - a package you cannot identify;
   - **a bump that introduces a NEW install-time or build-time hook** - never auto, whatever the
     version jump, because that code runs on the developer's machine, in CI and in any image
     build. Check `gh pr diff <n> --repo "$REPO"` for ADDED lines:
     - npm: `"hasInstallScript": true` on a package in the lockfile that did not carry it before,
       a new git/URL dependency (its `prepare` script runs on install), or a new
       `preinstall`/`install`/`postinstall`/`prepare` key under `"scripts"`;
     - pip/uv: a new sdist-only package (installing runs a build backend) or a git/URL source;
     - composer: a package new to `composer.lock` with `"type": "composer-plugin"`, or a change to
       `config.allow-plugins` or the install/update/autoload-dump scripts;
     - maven/gradle: a new build plugin, or an existing one bound to a new phase;
     - GitHub Actions: the action now declares `pre:`/`post:` steps or changes `runs.using`
       (read the new SHA's `action.yml`);
     - docker: a base image that gains `ONBUILD` instructions.
     Name the package and the hook in the Reason column. (Adapted from claude-code-templates
     `cli-tool/components/agents/security/supply-chain-security.md` @ 8b1f883 - "flag packages
     with `preinstall`/`postinstall` scripts that execute arbitrary code" - MIT, (c) 2025 Daniel
     (San) Avila.)
3. **LOW** - green checks, minor bump of a runtime dependency, or a minor GitHub Action bump.
4. **SAFE** - green checks, and either a patch bump of anything, or a minor bump of a dev
   dependency.

Print this table before any merge, one row per PR:

```
| PR | Ecosystem | Package | From -> To | Bump | Dep | <one column per CI check> | Tier | Reason |
```

Then one line of intent ("merge #41 #40 (SAFE/LOW); ask about #13; leave #15 (red)").

## Step 4 - Merge (MODE: MERGE only, approved PRs only - never in TRIAGE)

- SAFE and LOW with every check `pass`: merge one at a time, oldest first.
- REVIEW: only when the PR number is in `APPROVED:`. Otherwise report it under `ASK:`.
- BLOCKED: never.

```bash
gh pr merge <n> --repo "$REPO" --merge
```

[GROUND: the repo's merge method if it is not a merge commit (check how earlier Dependabot PRs
landed).] Never `--admin` (never bypass a red or pending check), never `--auto`. Branch deletion is
left to Dependabot. If the GitHub MCP merge tool is denied in `.claude/settings.json`, do not route
around the deny. After each merge, re-list (Step 1): the remaining PRs on the same lockfile usually
need a rebase, which Dependabot does itself, and their checks restart - re-check before the next
merge. More than 10 PRs: merge a batch of 5, then stop and report `ASK: next batch?`.

## Step 5 - Prove the merged main

Merged bumps are UNPROVEN until they run:

1. `git fetch origin`. On a clean `main`, `git pull --ff-only`; otherwise do not disturb the current
   branch - `git worktree add <scratch>/main-check origin/main` and bootstrap it there
   ([GROUND: the bootstrap a fresh checkout needs, e.g. `npm ci`]).
2. Run the test gate on that tree - [GROUND: e.g. `just test`] - and paste the runner's own summary
   line. A build-producing bump must also build ([GROUND: e.g. `just build`]).
3. Wait for CI on the `main` push to go green (`monitor-ci`, if enabled).
4. Deploy only through the project's own deploy path - [GROUND: the deploy command, or "no
   deploy"] - never by hand, and only after steps 2-3 are green.

If the gate fails on main, stop and report which merged PR is the likely cause - do not deploy.

## Step 6 - Report

```
## Dependabot review - <date>
Merged:   #41 <pkg> A -> B (LOW), ...
Asked:    #13 <pkg> A -> B (REVIEW: <reason>)
Skipped:  #15 <pkg> A -> B (BLOCKED: <failing check>)
Main:     <test gate> -> "<runner summary line>"   | CI on main: pass
Deploy:   <deploy command result>   (or: not run, and why)
```

## Guardrails

- Print the triage table before any merge. No table, no merge.
- Never merge a PR with a `fail` or `pending` check; never `--admin`, never force.
- Never resolve a conflict by hand and never push to a `dependabot/*` branch.
- Commenting `@dependabot rebase` / `@dependabot ignore ...`, closing a PR or approving one are
  write actions: only when the developer asks for that specific action.

## Evolution Log

| Date | Change |
|---|---|
| 2026-10-03 | Shipped with the kit as an optional skill, ported from a downstream project's agent with the gates as `[GROUND: ...]` markers. Adopted from claude-code-templates `cli-tool/components/skills/workflow-automation/dependabot-review/SKILL.md` @ 8b1f883, MIT, (c) 2025 Daniel (San) Avila: four tiers (SAFE/LOW/REVIEW/BLOCKED), a mandatory triage table before any merge, `gh pr merge --merge` instead of upstream's auto-merge, REVIEW always asks, the post-merge test gate on main, and the REVIEW rule for a bump that adds an install/build-time hook (from `cli-tool/components/agents/security/supply-chain-security.md`, same commit and licence). |
