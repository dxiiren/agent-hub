---
name: ground-project
description: "Use when the developer says '/ground-project', 'ground project', 'ground the kit', or 'finish scaffolding' — the one-time intelligent pass after init.ps1: reads the conventions doc + the project's real code, fills every remaining content token in CLAUDE.md/README/.docs, grounds the core skills' GROUND: ... markers in real code facts, enables qualifying optional skills, runs the skill audit to PASS, and boot-verifies the project."
model: sonnet
---

# ground-project — finish the scaffold with real code facts

Triggers: "/ground-project", "ground project", "ground the kit", "finish scaffolding".

**Your first action is the `Agent` call below** - before any Read, Bash or other tool call of
your own. The procedure (read conventions + real code, fill every content token, ground every marker in the skills
and agents, enable qualifying optional skills, audit to PASS, boot-verify) lives in the `ground-project` agent
(`.claude/agents/ground-project.md`). Hand the work to it - do not run it yourself:

```
Agent(subagent_type: "ground-project", model: "sonnet",
      description: "Ground the project",
      prompt: "<the developer's request verbatim; add PLAN ONLY if they asked for a dry run / no changes>")
```

Relay its summary (facts grounded on, files filled, optional skills enabled vs inert, audit result,
boot-verify evidence). Do NOT commit - the developer reviews, then `/commit`.
