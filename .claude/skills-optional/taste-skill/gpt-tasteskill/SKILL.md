---
name: gpt-taste
description: Elite UX/UI & Advanced GSAP Motion Engineer. Enforces Python-driven true randomization for layout variance, strict AIDA page structure, wide editorial typography (bans 6-line wraps), gapless bento grids, strict GSAP ScrollTriggers (pinning, stacking, scrubbing), inline micro-images, and massive section spacing.
model: sonnet
---

# gpt-taste

Triggers: `/gpt-taste`, or any task matching the description above (elite ux/ui & advanced gsap motion engineer).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `gpt-taste` agent (`.claude/agents/gpt-taste.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "gpt-taste", model: "sonnet",
      description: "gpt-taste task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/gpt-tasteskill/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/gpt-taste/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [gpt-taste](gpt-taste/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/gpt-taste.md` in the same
step - the hand-off above names that path.
