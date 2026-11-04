---
name: antislop-human
description: "Human and accessibility skill for antislop. Contrast, keyboard, focus, and states for real people. Includes the contrast checker."
allowed-tools: Bash(python *) Bash(python3 *) Read Write Edit Glob Grep
model: sonnet
---

# antislop-human

Triggers: `/antislop-human`, or any task matching the description above (human and accessibility skill for antislop).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `antislop-human` agent (`.claude/agents/antislop-human.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "antislop-human", model: "sonnet",
      description: "antislop-human task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/anti-slop/antislop-human/` (inert, part of the `anti-slop` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/antislop-human/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [antislop-human](antislop-human/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/antislop-human.md` in the same
step - the hand-off above names that path.
