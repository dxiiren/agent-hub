---
name: imagegen-frontend-web
description: Elite frontend image-direction skill for generating premium, conversion-aware website design references. CRITICAL OUTPUT RULE — generate ONE separate horizontal image FOR EVERY section. A landing page with 8 sections produces 8 images. Never compress multiple sections into one image. Enforces composition variety (not always left-text / right-image), background-image freedom, varied CTAs, varied hero scales (giant / mid / mini minimalist), narrative concept spine, second-read moments, and a single consistent palette across all images. Optimized for landing pages, marketing sites, and product comps that developers or coding models can accurately recreate.
model: sonnet
---

# imagegen-frontend-web

Triggers: `/imagegen-frontend-web`, or any task matching the description above (elite frontend image-direction skill for generating premium, conversion-aware website design references).

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
procedure lives in the `imagegen-frontend-web` agent (`.claude/agents/imagegen-frontend-web.md`). Hand the work to it - do not
run it yourself:

```
Agent(subagent_type: "imagegen-frontend-web", model: "sonnet",
      description: "imagegen-frontend-web task",
      prompt: "<the developer's request verbatim, plus the files/pages/brief involved; say AUDIT ONLY or PLAN ONLY when they asked to change nothing>")
```

Relay what the agent produced or changed, file by file, and any question it returned.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/taste-skill/imagegen-frontend-web/` (inert, part of the `taste-skill` bundle). Its agent ships
beside it as `agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled
(its folder moved AND renamed to `.claude/skills/imagegen-frontend-web/` - audit-skills requires the folder to equal the frontmatter `name:`; and add its catalog row `| [imagegen-frontend-web](imagegen-frontend-web/SKILL.md) | ... | opus |` to `.claude/skills/README.md`, or audit-skills reports it MISSING), move `agent.md` to `.claude/agents/imagegen-frontend-web.md` in the same
step - the hand-off above names that path.
