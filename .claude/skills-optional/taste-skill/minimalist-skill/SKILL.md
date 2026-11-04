---
name: minimalist-ui
description: Clean editorial-style interfaces. Warm monochrome palette, typographic contrast, flat bento grids, muted pastels. No gradients, no heavy shadows.
model: sonnet
---

# minimalist-ui

Triggers: `/minimalist-ui`, or any task matching the description above (clean editorial-style interfaces).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `minimalist-ui` agent (`.claude/agents/minimalist-ui.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "minimalist-ui", model: "sonnet",
      description: "minimalist-ui task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/minimalist-skill/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/minimalist-ui/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [minimalist-ui](minimalist-ui/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/minimalist-ui.md` in the same
step - the hand-off above names that path.
