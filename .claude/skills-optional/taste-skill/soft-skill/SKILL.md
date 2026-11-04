---
name: high-end-visual-design
description: Teaches the AI to design like a high-end agency. Defines the exact fonts, spacing, shadows, card structures, and animations that make a website feel expensive. Blocks all the common defaults that make AI designs look cheap or generic.
model: sonnet
---

# high-end-visual-design

Triggers: `/high-end-visual-design`, or any task matching the description above (teaches the ai to design like a high-end agency).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `high-end-visual-design` agent (`.claude/agents/high-end-visual-design.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "high-end-visual-design", model: "sonnet",
      description: "high-end-visual-design task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/soft-skill/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/high-end-visual-design/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [high-end-visual-design](high-end-visual-design/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/high-end-visual-design.md` in the same
step - the hand-off above names that path.
