---
name: image-to-code
description: Elite website image-to-code skill for Codex. For visually important web tasks, it must first generate the design image(s) itself, deeply analyze them, then implement the website to match them as closely as possible. In Codex, it must prefer large, readable, section-specific images instead of tiny compressed boards, generate fresh standalone images for sections or detail views instead of cropping old ones, avoid lazy under-generation, avoid cards-inside-cards-inside-cards UI, and keep the hero clean, spacious, readable, and visible on a small laptop.
model: sonnet
---

# image-to-code

Triggers: `/image-to-code`, or any task matching the description above (elite website image-to-code skill for codex).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `image-to-code` agent (`.claude/agents/image-to-code.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "image-to-code", model: "sonnet",
      description: "image-to-code task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/image-to-code-skill/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/image-to-code/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [image-to-code](image-to-code/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/image-to-code.md` in the same
step - the hand-off above names that path.
