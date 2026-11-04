---
name: audit-pagespeed
description: Use when the developer says 'audit pagespeed', 'run pagespeed', 'check pagespeed insights', 'test on pagespeed.web.dev', 'are we 100', or 'why are we not 100' — drives pagespeed.web.dev with the Playwright MCP, lifts the full Lighthouse JSON for BOTH form factors straight off the page, and turns every failing audit into a source-mapped fix list tied to the metric it actually moves. Carries the full road-to-100 playbook (dead-weight audit, prototype discipline, variance math, the automated 100-hunt).
model: sonnet
---

# audit-pagespeed — real PageSpeed Insights scores, with the failing elements

Triggers: "audit pagespeed", "run pagespeed", "check pagespeed insights", "test on pagespeed.web.dev", "are we 100 on pagespeed", "why are we not 100".

**Your first action is the `Agent` call below** - before any Read, Bash or other tool call of
your own. The procedure (drive pagespeed.web.dev with the Playwright MCP, lift both form factors' Lighthouse JSON, map
each failing audit to source, the full road-to-100 playbook) lives in the `audit-pagespeed` agent
(`.claude/agents/audit-pagespeed.md`). Hand the work to it - do not run it yourself:

```
Agent(subagent_type: "audit-pagespeed", model: "sonnet",
      description: "PageSpeed audit",
      prompt: "MODE: <AUDIT|PLAN>. Developer said: <their words verbatim>. URL: <if named>.")
```

Relay its mobile / desktop category table, the source-mapped fix list and any screenshot paths.
Use MODE: PLAN when the developer asks for a dry run or no network.


## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/` (inert). Its agent ships beside it as
`agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled (moved to
`.claude/skills/`, e.g. by `/ground-project`), move `agent.md` to
`.claude/agents/audit-pagespeed.md` in the same step - the hand-off above names that path.
