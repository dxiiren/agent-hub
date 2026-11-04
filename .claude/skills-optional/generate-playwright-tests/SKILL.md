---
name: generate-playwright-tests
description: Use when the developer says 'generate playwright tests', 'write e2e tests for [page]', 'automate tests for [page]', or when authoring any Playwright spec — derives stable accessibility-tree locators via the Playwright MCP (browser_snapshot + browser_generate_locator), writes a two-layer spec, runs it, and pastes the result before claiming done.
model: sonnet
---

# generate-playwright-tests

Triggers: "generate playwright tests", "write e2e tests for [page]", "automate tests for [page]", or authoring any browser / E2E test.

**Your first action is the `Agent` call below - before any Read, Bash or Playwright MCP call of your
own.** The rulebook (locators from the live accessibility tree, two-layer assertions, banned
patterns, run-and-paste) lives in the `generate-playwright-tests` agent
(`.claude/agents/generate-playwright-tests.md`); it can call the Playwright MCP itself. Hand the
work to it - do not write the test yourself:

```
Agent(subagent_type: "generate-playwright-tests", model: "sonnet",
      description: "Write a browser test",
      prompt: "<the developer's request verbatim: the page / flow to cover, and any behaviour they named>")
```

Relay the file(s) it wrote and the pass line it pasted from the real run. If it returned
`STOPPED: ...` (Playwright MCP or a test plugin missing), tell the developer the exact command it
named - do not install anything yourself.


## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/` (inert). Its agent ships beside it as
`agent.md` so it is NOT loaded while the skill is inert. When the skill is enabled (moved to
`.claude/skills/`, e.g. by `/ground-project`), move `agent.md` to
`.claude/agents/generate-playwright-tests.md` in the same step - the hand-off above names that path.
