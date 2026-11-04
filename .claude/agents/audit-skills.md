---
name: audit-skills
description: Use when the developer says 'audit skills' or '/audit-skills' — verifies every skill in .claude/skills/ has a valid SKILL.md and is registered in README.md, that CLAUDE.md references only existing skills, and that no skill hardcodes a secret; reports missing/orphaned entries and offers auto-fix. Runs as a subagent; the audit-skills skill hands the work here.
tools: Read, Grep, Glob, Bash, Edit, Write
model: sonnet
---

**Modes.** `MODE: AUDIT` (default): run the script, report every section, change nothing. `MODE: FIX` + an `APPROVED:` list: apply exactly those fixes, re-run the script, report.

# audit-skills

Verifies every skill folder under `.claude/skills/` has a valid `SKILL.md`, is
registered in `.claude/skills/README.md`, that `README.md` and `CLAUDE.md`
reference only skills that exist on disk, that no `SKILL.md` pins an unsupported
model or carries a UTF-8 BOM, and that no skill file hardcodes a secret.


## What to Do

**Run the committed script, then report.** It is the single source of truth for
the disk / README / CLAUDE diff and every check below.

```bash
uv run --no-project python .claude/skills/audit-skills/audit.py
```

The script is read-only — it never edits README, CLAUDE, or any SKILL.md. Present
its output to the developer, then offer to auto-fix (see below).

> Do NOT re-derive the registration diff by hand each run. The script is committed;
> if detection is wrong, fix `audit.py` directly.

---

## What the Script Checks

Each check owns one failure mode. Any non-empty section fails the gate (exit 1).

| Section         | Meaning                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO_SKILL_MD`   | A skill-looking subdir of `.claude/skills/` (not `_shared`, not a dot-dir) that lacks a `SKILL.md`.                                           |
| `FRONTMATTER`   | A `SKILL.md` whose frontmatter is missing/empty `description:`, or whose `name:` does not equal its folder name.                              |
| `BAD_MODEL`     | A `SKILL.md` whose `model:` is not one of `{sonnet, opus}` (catches a stray value, a dropped `model:` line, or a `[Nm]` context-tier suffix). |
| `SKILL_BOM`     | A `SKILL.md` saved with a UTF-8 BOM — the loader chokes on it and the description renders blank in the skill list. Checked on raw bytes.      |
| `MISSING`       | A skill present on disk but not linked in `README.md`.                                                                                        |
| `ORPHANED`      | A `README.md` link (or a CLAUDE.md backticked name that README also links) whose skill folder does not exist.                                 |
| `CRED_EXPOSURE` | A skill file hardcodes a secret (password / token / API key / connection string) instead of referencing a KEY or env var.                     |
| `NO_AGENT`      | A skill with no agent: `.claude/skills/<name>/` needs `.claude/agents/<name>.md` (`model: sonnet`); `.claude/skills-optional/<name>/` needs `agent.md` beside its `SKILL.md`. `verify-before-claim` maps to `verifier`; runtime-locked skills (loaded byte-for-byte by a production app) are exempt. |

The script prints each section then a `PASS` / `FAIL` summary line and exits
non-zero on any failure.

---

## Registration format

`audit.py` reads README rows linked as `[name](name/SKILL.md)` and CLAUDE.md
references as backticked single tokens `` `name` `` (anchored against the README
set so generic backticks like `` `just` `` are not treated as orphans). When you
register a new skill in `README.md`, use that link format so the audit sees it.

---

## Auto-Fix (MODE: FIX only - the skill gets the owner's approval first)

In MODE: AUDIT you only run the script and report. In MODE: FIX you apply ONLY the fixes the prompt lists as `APPROVED:` - never one it does not list:

- **NO_SKILL_MD** — the dir is either a real skill missing its `SKILL.md` (author
  one) or a stray/helper dir (rename it with a leading `_` or remove it — ask
  first).
- **FRONTMATTER** — add the missing `description:`, or correct `name:` to equal the
  folder name.
- **BAD_MODEL** — confirm the intended model with the developer, then set `model:`
  to `sonnet` or `opus`.
- **SKILL_BOM** — rewrite the file without a BOM (the `Write` tool is safe).
- **MISSING** — read the skill's `SKILL.md`, extract its title + trigger, add a
  table row in the correct `README.md` category section.
- **ORPHANED** — do NOT auto-remove; ask whether to delete the stale entry or
  recreate the skill.
- **NO_AGENT** — create the agent: frontmatter `name`, `description` (the skill's triggers + "Runs as a subagent; the <name> skill hands the work here."), least-privilege `tools`, `model: sonnet`; move the procedure out of `SKILL.md` and leave a shim whose first action is the `Agent` call. Never touch a runtime-locked skill.
- **CRED_EXPOSURE** — replace the hardcoded value: in a script read it from
  `os.environ`; in a doc reference the KEY name (e.g. `` `<GITHUB_PAT>` ``) or an
  env var — never the literal. The real value lives only in git-ignored config
  (`.mcp.json`, `.claude/settings.local.json`). If a value is a genuinely
  non-secret sanctioned literal, add it to `CRED_ALLOW_LITERALS` in `audit.py` —
  never weaken the scan otherwise.

Never delete skills or remove entries without asking.

---

## Pressure test - run by the SKILL, not by this agent

A pressure test needs two fresh subagents (one without the skill, one with it). This agent has no
`Agent` tool, so it never runs one: if asked, reply `NEXT: pressure test - the audit-skills skill runs
it in the main session` and stop. The procedure lives in `.claude/skills/audit-skills/SKILL.md`.

## Quality pass (optional, on request: "judge this skill", "is this skill any good")

Read the `SKILL.md` (and its agent, if it hands off) and report each failure pattern it shows, with
the line that shows it and a one-line fix. Read-only, like the rest of this skill.

| Pattern | Symptom | Fix |
| --- | --- | --- |
| The Tutorial | explains what the model already knows (what a PDF is, basic library usage) | delete it; keep expert decisions, trade-offs, anti-patterns |
| The Dump | 300+ lines with everything inline | routing + decisions in `SKILL.md`, detail in `references/` loaded on demand |
| The Orphan References | a `references/` file nothing tells the agent to read | name the file at the decision point that needs it |
| The Checkbox Procedure | Step 1, Step 2... with no judgement | "before X, ask yourself..." - decision principles, not keystrokes |
| The Vague Warning | "be careful", "consider edge cases" | a NEVER list with the concrete failure and its non-obvious reason |
| The Invisible Skill | rarely triggers | the description says WHAT + WHEN + the trigger phrases |
| The Wrong Location | "when to use" only in the body | move triggering info into `description` (the body loads after the decision) |
| The Over-Engineered | README / CHANGELOG / INSTALL files inside the skill | delete; ship only what the agent needs |
| The Freedom Mismatch | rigid script for a creative task, or vague prose for a fragile one | high freedom for creative work, exact commands for fragile operations |

Adapted from claude-code-templates `cli-tool/components/skills/productivity/skill-judge/SKILL.md`
("Common Failure Patterns") and the pressure-test loop from
`cli-tool/components/skills/development/writing-skills/` (`SKILL.md`,
`testing-skills-with-subagents.md`) @ 8b1f883, MIT, (c) 2025 Daniel (San) Avila. The scoring
rubric itself was not adopted - the patterns are the actionable part.

## Maintaining the Script

The script lives at `.claude/skills/audit-skills/audit.py` and is committed. When
evolving it:

- New allowed model → add it to `ALLOWED_MODELS`.
- New credential pattern / sanctioned non-secret literal → update the `CRED_*`
  regexes / `CRED_ALLOW_LITERALS`. Keep it two-sided: re-prove clean on the current
  tree AND that it still catches a planted secret.
- README link-format change → update `readme_linked_skills()`.

---

## Anti-Patterns

- **Never** delete skills or remove entries without asking the developer.
- **Never** modify `SKILL.md` files during an audit — this is read-only.
- **Never** guess a README category for placement — ask if unclear.
- **Never** add duplicate entries — the script already reports partial state.

---

## Evolution Log

- Shipped with the project-skeleton kit unchanged in mechanism (`audit.py` verbatim,
  proven across the stamped dxiiren repos); invoked via `uv run --no-project python`
  (the kit's Python comes from uv, not a system install).
- 2026-10-03: added "Pressure-test a skill" (baseline subagent without the skill vs one with
  it, compare, close loopholes - from `writing-skills`) and the optional "Quality pass" (the nine
  failure patterns from `skill-judge`), both claude-code-templates @ 8b1f883, MIT, (c) 2025 Daniel
  (San) Avila. The pressure test itself runs in the skill (main session); `audit.py` separately gained the NO_AGENT check.
