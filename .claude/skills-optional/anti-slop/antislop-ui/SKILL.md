---
name: antislop-ui
description: "UI and visual skill for antislop. Use when building or editing any interface: color, layout, components, motion. Load with the core."
allowed-tools: Read Write Edit Glob Grep
model: sonnet
---

# antislop-ui

Triggers: `/antislop-ui`, or any task matching the description above (ui and visual skill for antislop).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `antislop-ui` agent (`.claude/agents/antislop-ui.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "antislop-ui", model: "sonnet",
      description: "antislop-ui task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/anti-slop/antislop-ui/` (inert, part of the `anti-slop` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/antislop-ui/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [antislop-ui](antislop-ui/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/antislop-ui.md` in the same
step - the hand-off above names that path.
