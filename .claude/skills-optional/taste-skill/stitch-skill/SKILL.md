---
name: stitch-design-taste
description: Semantic Design System Skill for Google Stitch. Generates agent-friendly DESIGN.md files that enforce premium, anti-generic UI standards — strict typography, calibrated color, asymmetric layouts, perpetual micro-motion, and hardware-accelerated performance.
model: sonnet
---

# stitch-design-taste

Triggers: `/stitch-design-taste`, or any task matching the description above (semantic design system skill for google stitch).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `stitch-design-taste` agent (`.claude/agents/stitch-design-taste.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "stitch-design-taste", model: "sonnet",
      description: "stitch-design-taste task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/stitch-skill/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/stitch-design-taste/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [stitch-design-taste](stitch-design-taste/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/stitch-design-taste.md` in the same
step - the hand-off above names that path.
