---
name: test-all-mcp
description: "Use when the developer says 'test all mcp', 'check mcp status', 'are the mcps working', 'mcp health check', 'test the mcp servers', or 'which mcps are up' — builds the MCP roster from the real config, then in the LIVE session calls each enabled server's smoke-test tool from checks/ and reports a per-server PASS/FAIL/SKIP table. Also the home for the per-server .txt check prompts that setup-mcp writes."
model: sonnet
---

# Test All MCP — live MCP health check

Triggers:

- "test all mcp" / "test the mcp servers" / "test every mcp"
- "check mcp status" / "mcp status" / "which mcps are up"
- "are the mcps working" / "mcp health check"
- Or names one server: "test the github mcp" / "check context7" (run just that row).

**Your first action is the `Agent` call below - before any Bash, Read, ToolSearch or MCP call of your
own.** The roster, the live smoke calls and the verdicts live in the `test-all-mcp` agent
(`.claude/agents/test-all-mcp.md`). A subagent can call the session's MCP tools (measured
2026-10-03), so hand it the whole job - do not run the checks yourself:

```
Agent(subagent_type: "test-all-mcp", model: "sonnet",
      description: "MCP health check",
      prompt: "<the developer's request verbatim; name the one server if they named one>")
```

Relay the agent's status table and its `N PASS / M FAIL / K SKIP` line as it returns them; point any
FAIL at `/setup-mcp <server>`.

## Keeping this skill in sync

Coverage is the set of `checks/*.txt`. A new server needs its `checks/<server>.txt` AND an
`mcp__<server>` entry on the `tools:` line of `.claude/agents/test-all-mcp.md` - without that entry
the agent cannot see the server and reports it SKIP.
