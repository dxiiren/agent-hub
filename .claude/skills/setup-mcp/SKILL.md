---
name: setup-mcp
description: "Use when the developer says 'Setup {X} MCP', 'Add {X} MCP', 'Install {X} MCP', 'onboard an MCP', or names a capability/URL to wire up — the ONE MCP skill for this repo. Reads registry.json for the server's setup metadata and walks the committed-stub + git-ignored-secret + tiered-enable wiring. Also onboards a NEW server by adding a registry record (never authoring a per-server skill)."
model: sonnet
---

# Setup MCP — the one registry-driven MCP skill

Triggers: "Setup {X} MCP", "Add {X} MCP", "Install {X} MCP", "onboard an MCP for {capability}", or a capability / git URL to wire up.

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
registry reading, wiring and validation live in the `setup-mcp` agent (`.claude/agents/setup-mcp.md`).
Hand the work to it - do not wire anything yourself. What stays here is what only this session can
do: the developer's approval, any secret, and the post-restart verdict.

## 1 - Hand off

Pick the mode: "verify only" / "check" / "is X set up" -> `CHECK`; an already-registered server ->
`APPLY-A`; a new capability or a git URL -> `RESEARCH-B`. If unsure, send `APPLY-A`: the agent
answers `UNREGISTERED` without changing anything, and you continue with `RESEARCH-B`.

```
Agent(subagent_type: "setup-mcp", model: "sonnet",
      description: "Setup MCP (<mode> <X>)",
      prompt: "MODE: <CHECK|APPLY-A|RESEARCH-B|WIRE-B> <X>. Developer said: <their words verbatim>.
               <WIRE-B only: the approved verdict + record, verbatim from the RESEARCH-B report>")
```

## 2 - The developer's steps (stay here - a subagent cannot ask)

- **CHECK** - relay the report. Done - do not call the server's `mcp__*` tools yourself; the live
  check is `/test-all-mcp <server>`.
- **RESEARCH-B** - show the agent's verdict and proposed record, then get an explicit nod
  (`AskUserQuestion`: wire it / change something / stop) **before any wiring**. On a yes, hand off
  again with `MODE: WIRE-B` and the approved verdict. On a no, stop - nothing was changed.
- **Secret** - if the report says a placeholder or key must be filled, ask the developer to paste
  the value into `.mcp.json` themselves. If they give it to you in chat, write it into that file
  with Edit yourself. Never put a secret in an `Agent` prompt, in any committed file, or in a reply.
- **Verify (restart-gated)** - tell the developer to restart Claude, run
  `.claude/skills/test-all-mcp/checks/<server>.txt` (or `/test-all-mcp <server>`) in the fresh
  session and paste the result; judge PASS/FAIL against that file's criterion. Never claim the server
  works before they confirm it after the restart.

Relay the agent's `STATUS`, `CHANGED` and `DEVELOPER MUST` lines as it returns them.
