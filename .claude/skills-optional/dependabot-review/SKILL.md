---
name: dependabot-review
description: "Use when the developer says 'review dependabot', 'dependabot PRs', 'merge the dependency bumps', 'triage dependency updates', 'check dependabot' or 'show dependabot PRs' - lists the open Dependabot PRs with their real CI checks, prints a triage table (SAFE / LOW / REVIEW / BLOCKED) BEFORE touching anything, merges only green SAFE/LOW bumps with `gh pr merge --merge`, ASKS before any REVIEW-tier merge (incl. any bump that adds an install/build-time hook), never merges red CI, then runs the test gate on the updated main."
model: sonnet
---

# dependabot-review

Triggers: "review dependabot", "dependabot PRs", "merge the dependency bumps", "triage dependency
updates", "check dependabot", "show dependabot PRs", "/dependabot-review".

**Your first action is the TRIAGE `Agent` call below - before any `gh`, Bash or text of your
own.** Discovery, the CI checks, the SAFE / LOW / REVIEW / BLOCKED rules (including the
install-script / build-hook REVIEW rule), merging and the post-merge proof live in the
`dependabot-review` agent (`.claude/agents/dependabot-review.md`). The approvals stay HERE, because
the agent cannot ask the developer.

1. **Triage (always first):**

```
Agent(subagent_type: "dependabot-review", model: "sonnet",
      description: "Triage Dependabot PRs",
      prompt: "MODE: TRIAGE. Developer said: <their words verbatim>.")
```

2. **Show the triage table** the agent returned, exactly. For "check dependabot" / "show dependabot
   PRs" / any DRY RUN request, stop here.
3. **Approvals (stay here).** SAFE and LOW with green checks are approved by a merge request itself.
   For EACH REVIEW-tier PR under `ASK:` (a major, a base image, a security PR, a new install/build
   hook ...), ask the developer with its reason and changelog link and wait for an explicit yes or
   no. BLOCKED is never merged and never asked about. An `ASK: next batch?` is asked the same way.
4. **Merge the approved set:**

```
Agent(subagent_type: "dependabot-review", model: "sonnet",
      description: "Merge approved Dependabot PRs",
      prompt: "MODE: MERGE. APPROVED: #<n>, #<n>, ... Developer said: <their words verbatim>.")
```

5. **Relay** the agent's Step 6 report (Merged / Asked / Skipped / Main / Deploy). Any new `ASK:` in
   it goes back to step 3. Never merge yourself, never `--admin`, never route around a denied
   merge tool.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/` (inert). Its agent ships beside it as `agent.md` so
it is NOT loaded while the skill is inert. When the skill is enabled (moved to `.claude/skills/`,
e.g. by `/ground-project` once `.github/dependabot.yml` exists), move `agent.md` to
`.claude/agents/dependabot-review.md` in the same step - the hand-off above names that path - and
resolve its `[GROUND: ...]` markers (ecosystems, check names, framework pins, test gate, deploy).
