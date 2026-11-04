---
name: design-taste-frontend-v1
description: The original v1 taste-skill, preserved for projects depending on its exact behavior. The current default is `design-taste-frontend` (v2 experimental), which is a substantial rewrite. Use this v1 install name only if you need exact backward compatibility.
model: sonnet
---

# design-taste-frontend-v1

Triggers: `/design-taste-frontend-v1`, or any task matching the description above (the original v1 taste-skill, preserved for projects depending on its exact behavior).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `design-taste-frontend-v1` agent (`.claude/agents/design-taste-frontend-v1.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "design-taste-frontend-v1", model: "sonnet",
      description: "design-taste-frontend-v1 task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/taste-skill-v1/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/design-taste-frontend-v1/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [design-taste-frontend-v1](design-taste-frontend-v1/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/design-taste-frontend-v1.md` in the same
step - the hand-off above names that path.
