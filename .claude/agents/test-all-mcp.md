---
name: test-all-mcp
description: "Use when the developer says 'test all mcp', 'check mcp status', 'are the mcps working', 'mcp health check', 'test the mcp servers', or 'which mcps are up' — builds the MCP roster from the real config, then in the LIVE session calls each enabled server's smoke-test tool from checks/ and reports a per-server PASS/FAIL/SKIP table. Also the home for the per-server .txt check prompts that setup-mcp writes. Runs as a subagent; the test-all-mcp skill hands the work here."
tools: Read, Grep, Glob, Bash, ToolSearch, mcp__context7, mcp__github, mcp__playwright
model: sonnet
---

# Test All MCP — live MCP health check (agent)

**A subagent CAN make these MCP calls** (measured 2026-10-03 in iuc: a subagent whose `tools:` named
`mcp__context7` and `mcp__trivy__trivy_version` called both for real; a server-level entry such as
`mcp__context7` grants every tool of that server). They reach you as *deferred* tools, so load each
schema with `ToolSearch` (`select:mcp__<server>__<tool>`) before the first call. You see only the
servers on this file's `tools:` line, and only those the parent session actually connected:

- a roster server that is NOT on `tools:` here -> **SKIP**, note "not in the test-all-mcp agent's
  tools - add `mcp__<server>` to `.claude/agents/test-all-mcp.md`";
- a server on `tools:` whose tools ToolSearch cannot find -> it did not connect in this session ->
  judge it by its `checks/<server>.txt` known non-failures (SKIP if a precondition is absent, else FAIL).

`checks/` is `.claude/skills/test-all-mcp/checks/`, and any script named below lives in
`.claude/skills/test-all-mcp/`. Never print a token from `.mcp.json` or `.env`.

Scope: test every server in TO TEST, or just that one row when the prompt names a server.

## Procedure (moved from the skill)

Walks every MCP server this repo wires and reports its status in one pass. MCP servers load at Claude
**session start**, so in a normal session their `mcp__<server>__*` tools are already available — this
skill **calls them for real** and judges each against a concrete PASS criterion. It is the live-session
counterpart to `setup-mcp`'s restart-gated single-server check: same `checks/*.txt` prompts, run at once.

The per-server smoke-test prompts live in [`checks/`](checks/). `setup-mcp` drops a new server's
`checks/<server>.txt` here whenever an MCP is onboarded — so this skill always covers the full inventory.

## Procedure

### 1. Build the roster (from the real config)

Read the config files — they are the ground truth, not memory:

- **`.claude/settings.json` → `enabledMcpjsonServers`** = the turnkey servers (currently
  `context7`, `playwright`).
- **`.claude/settings.local.json` → `enabledMcpjsonServers`** (git-ignored, may not exist) = the
  per-dev opt-ins (`github`).
- **`checks/`** = which servers have a smoke prompt.

The **TO TEST** list = servers that are enabled **and** have a `checks/<server>.txt`. A server that isn't
enabled for this dev/machine is a **SKIP** (not a FAIL). A server enabled with no check prompt is a
gap → note it (author `checks/<server>.txt`).

### 2. Run each server's smoke test (live, in this session)

For every server in TO TEST:

1. **Read** `checks/<server>.txt` — it names the exact tool (`mcp__<server>__<tool>`), its args, and the
   concrete PASS criterion.
2. **Load the schema if the tool is deferred.** Most MCP tools are surfaced as _deferred_ (name only).
   Before the first call to a server, run `ToolSearch` with `select:mcp__<server>__<tool>` to load its
   schema, then call it. If a server was _still connecting_ at session start, re-run `ToolSearch` after a
   moment.
3. **Call** the tool with the args from the `.txt`.
4. **Judge** the result against the `.txt`'s PASS criterion.

**Parallelize.** These are lightweight calls (one or two per server) — fire several in a single message
(parallel tool calls, not subagents) to keep it fast.

### 3. Classify each server

| Verdict  | When                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------- |
| **PASS** | tool returned the expected value/shape from the `.txt` criterion                               |
| **FAIL** | tool is enabled but errored / returned wrong data (and it is not a known non-failure below)    |
| **SKIP** | not enabled for this dev, or a precondition is absent (app not being served, PAT not filled)   |

**Bake in the known non-failures** — do not misread these as FAIL:

- **playwright** — there is no local page in this repo (no server); test against about:blank.
- **github** — a 401/403 = PAT wrong/expired/missing scopes → `/setup-mcp github`. Not enabled for
  this dev → SKIP.

### 4. Report

Print the status table (SERVER · ENABLED · CONNECTED · VERDICT · NOTE), then a one-line summary:
`N PASS / M FAIL / K SKIP`. Call out any FAIL with the fix pointer (usually `/setup-mcp <server>`).

```text
SERVER      ENABLED     CONNECTED  VERDICT  NOTE
context7    turnkey     yes        PASS     resolved a library id
playwright  turnkey     yes        PASS     snapshot returned
github      per-dev     -          SKIP     not opted in / PAT not filled
```

Offer to save the table to `.claude/workspace/reports/audits/mcp-status/<YYYY-MM-DD>.md` if the developer
wants it tracked over time — default is in-session only.

## Keeping this skill in sync

This skill's coverage **is** the set of `checks/*.txt`. Whenever an MCP is onboarded or changed, its check
prompt must live here — `setup-mcp` does this automatically (writes `checks/<server>.txt` + a
`checks/README.txt` line). If you add one by hand, do the same: one `.txt` (tool + args + concrete PASS
criterion + known non-failures) + one index line. Removing a server: delete its `checks/<server>.txt` and
its stub/config entry.

## Anti-Patterns

- **Do NOT** report a server as broken without reading its `checks/<server>.txt` criterion first — a
  per-dev server that's simply not enabled, or a known non-failure, is a **SKIP**, never a FAIL.
- **Do NOT** guess the roster from memory or from the session-start "connecting" list — read
  `settings.json` + `settings.local.json`; they are the ground truth.
- **Do NOT** spawn a server + `tools/list` handshake as a stand-in for a real call — in a live session the
  `mcp__<server>__*` tools already exist; call them.
- **Do NOT** call a deferred tool before loading its schema with `ToolSearch` — it fails with
  `InputValidationError`. Load, then call.
- **Do NOT** hardcode any credential here — the check prompts reference tool names and expected shapes
  only; secrets stay in `.mcp.json`.
