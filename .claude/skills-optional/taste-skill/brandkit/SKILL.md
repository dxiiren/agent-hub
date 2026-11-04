---
name: brandkit
description: Premium brand-kit image generation skill for creating high-end brand-guidelines boards, logo systems, identity decks, and visual-world presentations. Trained for minimalist, cinematic, editorial, dark-tech, luxury, cultural, security, gaming, developer-tool, and consumer-app brand systems. Optimized for intentional logo concepting, refined composition, sparse typography, strong symbolic meaning, premium mockups, art-directed imagery, and flexible grid layouts.
model: sonnet
---

# brandkit

Triggers: `/brandkit`, or any task matching the description above (premium brand-kit image generation skill for creating high-end brand-guidelines boards, logo systems, identity decks, and visual-world presentations).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `brandkit` agent (`.claude/agents/brandkit.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "brandkit", model: "sonnet",
      description: "brandkit task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/brandkit/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/brandkit/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [brandkit](brandkit/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/brandkit.md` in the same
step - the hand-off above names that path.
