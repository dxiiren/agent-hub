---
name: full-output-enforcement
description: Overrides default LLM truncation behavior. Enforces complete code generation, bans placeholder patterns, and handles token-limit splits cleanly. Apply to any task requiring exhaustive, unabridged output.
model: sonnet
---

# full-output-enforcement

Triggers: `/full-output-enforcement`, or any task matching the description above (overrides default llm truncation behavior).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `full-output-enforcement` agent (`.claude/agents/full-output-enforcement.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "full-output-enforcement", model: "sonnet",
      description: "full-output-enforcement task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/output-skill/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/full-output-enforcement/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [full-output-enforcement](full-output-enforcement/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/full-output-enforcement.md` in the same
step - the hand-off above names that path.
