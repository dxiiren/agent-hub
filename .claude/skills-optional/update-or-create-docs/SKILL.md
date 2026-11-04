---
name: update-or-create-docs
description: Use when creating OR updating any .docs/ document — enforces style consistency and ensures .docs/README.md and .docs/tldr.md are always updated as a set.
model: sonnet
---

# Update or Create Docs

Triggers: "document X", "write a doc for X", "add to docs", "update the docs", or creating / updating any `.docs/` document.

**Your first action is the `Agent` call below - before any Read, Edit or Write of your own.**
The procedure (house style, the README + tldr sibling update, the `check-sibling-sync.py` gate)
lives in the `update-or-create-docs` agent (`.claude/agents/update-or-create-docs.md`). Hand the
work to it - do not write the doc yourself:

```
Agent(subagent_type: "update-or-create-docs", model: "sonnet",
      description: "Create or update a .docs/ doc",
      prompt: "<the developer's request verbatim, plus what changed in the code that the doc must now say>")
```

Relay the files the agent changed and its gate line (`SYNC OK`, or the missing siblings). If it
returned `NEEDS: <question>`, ask the developer that question and call the agent again with the
answer.


## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/` (inert). Its agent ships beside it as
`agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled (moved to
`.claude/skills/`, e.g. by `/ground-project`), move `agent.md` to
`.claude/agents/update-or-create-docs.md` in the same step - the hand-off above names that path.
