---
name: design-taste-frontend
description: Anti-slop frontend skill for landing pages, portfolios, and redesigns. The agent reads the brief, infers the right design direction, and ships interfaces that do not look templated. Real design systems when applicable, audit-first on redesigns, strict pre-flight check.
model: sonnet
---

# design-taste-frontend

Triggers: `/design-taste-frontend`, or any task matching the description above (anti-slop frontend skill for landing pages, portfolios, and redesigns).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `design-taste-frontend` agent (`.claude/agents/design-taste-frontend.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "design-taste-frontend", model: "sonnet",
      description: "design-taste-frontend task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/taste-skill/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/design-taste-frontend/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [design-taste-frontend](design-taste-frontend/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/design-taste-frontend.md` in the same
step - the hand-off above names that path.
