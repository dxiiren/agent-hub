---
name: imagegen-frontend-mobile
description: Elite mobile app image-generation skill for creating premium, app-native screen concepts and flows. Designed for iOS, Android, and cross-platform mobile products. Prioritizes clean hierarchy, comfortably readable text, strong multi-screen consistency, controlled color palettes, non-generic creative direction, textured surfaces, image-led composition, tasteful custom iconography, and clean phone mockup framing. By default, screens should be shown inside a subtle premium iPhone or similar phone mockup with a visible frame, while the main focus stays on the app content itself. This skill generates images only. It does not write code.
model: sonnet
---

# imagegen-frontend-mobile

Triggers: `/imagegen-frontend-mobile`, or any task matching the description above (elite mobile app image-generation skill for creating premium, app-native screen concepts and flows).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `imagegen-frontend-mobile` agent (`.claude/agents/imagegen-frontend-mobile.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "imagegen-frontend-mobile", model: "sonnet",
      description: "imagegen-frontend-mobile task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/imagegen-frontend-mobile/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/imagegen-frontend-mobile/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [imagegen-frontend-mobile](imagegen-frontend-mobile/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/imagegen-frontend-mobile.md` in the same
step - the hand-off above names that path.
