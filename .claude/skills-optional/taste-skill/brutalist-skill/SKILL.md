---
name: industrial-brutalist-ui
description: Raw mechanical interfaces fusing Swiss typographic print with military terminal aesthetics. Rigid grids, extreme type scale contrast, utilitarian color, analog degradation effects. For data-heavy dashboards, portfolios, or editorial sites that need to feel like declassified blueprints.
model: sonnet
---

# industrial-brutalist-ui

Triggers: `/industrial-brutalist-ui`, or any task matching the description above (raw mechanical interfaces fusing swiss typographic print with military terminal aesthetics).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `industrial-brutalist-ui` agent (`.claude/agents/industrial-brutalist-ui.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "industrial-brutalist-ui", model: "sonnet",
      description: "industrial-brutalist-ui task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/brutalist-skill/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/industrial-brutalist-ui/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [industrial-brutalist-ui](industrial-brutalist-ui/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/industrial-brutalist-ui.md` in the same
step - the hand-off above names that path.
