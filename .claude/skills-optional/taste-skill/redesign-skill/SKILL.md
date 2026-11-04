---
name: redesign-existing-projects
description: Upgrades existing websites and apps to premium quality. Audits current design, identifies generic AI patterns, and applies high-end design standards without breaking functionality. Works with any CSS framework or vanilla CSS.
model: sonnet
---

# redesign-existing-projects

Triggers: `/redesign-existing-projects`, or any task matching the description above (upgrades existing websites and apps to premium quality).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `redesign-existing-projects` agent (`.claude/agents/redesign-existing-projects.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "redesign-existing-projects", model: "sonnet",
      description: "redesign-existing-projects task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/redesign-skill/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/redesign-existing-projects/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [redesign-existing-projects](redesign-existing-projects/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/redesign-existing-projects.md` in the same
step - the hand-off above names that path.
