---
name: antislop-code
description: "Code comment hygiene for AI coding agents: remove generic AI-slop comments, keep the valuable ones, never touch the code."
allowed-tools: Read Write Edit Glob Grep
model: sonnet
---

# antislop-code

Triggers: `/antislop-code`, or any task matching the description above (code comment hygiene for ai coding agents: remove generic ai-slop comments, keep the valuable ones, never touch the code).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `antislop-code` agent (`.claude/agents/antislop-code.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "antislop-code", model: "sonnet",
      description: "antislop-code task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/anti-slop/antislop-code/` (inert, part of the `anti-slop` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/antislop-code/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [antislop-code](antislop-code/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/antislop-code.md` in the same
step - the hand-off above names that path.
