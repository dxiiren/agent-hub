---
name: audit-skills
description: Use when the developer says 'audit skills' or '/audit-skills' — verifies every skill in .claude/skills/ has a valid SKILL.md and is registered in README.md, that CLAUDE.md references only existing skills, and that no skill hardcodes a secret; reports missing/orphaned entries and offers auto-fix.
model: sonnet
---

# audit-skills

Triggers: "audit skills", "/audit-skills", "check skills", "skills audit".

Your first action is the `Agent` call below - do not run the script yourself. The procedure lives in the `audit-skills` agent (`.claude/agents/audit-skills.md`):

```
Agent(subagent_type: "audit-skills", model: "sonnet",
      description: "Audit the skills",
      prompt: "MODE: AUDIT. <the developer's request verbatim>")
```

Relay its per-section report and the `RESULT:` line. If anything FAILs, ask the developer which fixes to apply (never delete a skill, remove an entry, or change a `model:` without a yes), then call the agent again with `MODE: FIX` and `APPROVED: <the fixes they said yes to>`.

SPLIT: stays here = asking which fixes to apply (deletions, orphan removal, model changes need a yes); agent = running `audit.py`, reporting, applying the approved fixes, re-running.

## Pressure test (on request: "pressure-test <skill>", or after writing a new skill)

The audit proves a skill is registered, not that it changes behaviour. Run this HERE, in the main
session - the `audit-skills` agent cannot spawn subagents:

1. Write one realistic task the skill exists for (with the pressure that tempts a shortcut).
2. `Agent(subagent_type: "general-purpose", model: "sonnet", prompt: "<task>. Do NOT load or read the
   <skill> skill.")` - the baseline. Note what it gets wrong.
3. `Agent(subagent_type: "<skill's agent>", model: "sonnet", prompt: "<the same task>")` - the treated run.
4. Keep the skill only if run 3 fixes what run 2 got wrong; otherwise sharpen its rules and repeat.
   Report both runs' key lines side by side.

(Adapted from claude-code-templates cli-tool/components/skills/development/writing-skills
(testing-skills-with-subagents.md) @ 8b1f883, MIT, (c) 2025 Daniel (San) Avila.)
