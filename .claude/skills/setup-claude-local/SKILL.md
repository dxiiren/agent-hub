---
name: setup-claude-local
description: Use when the developer says 'setup claude local', 'install claude-local', 'run claude on the local model', 'use our vLLM with claude code', 'claude-local not found', or 'just claudel fails' - installs the claude-local launcher (Claude Code on a self-hosted vLLM model through a local shim), proves it with a live print-mode run, and reads the shim log before calling anything a defect.
model: sonnet
---

# setup-claude-local — Claude Code on the self-hosted model

Triggers: "setup claude local", "install claude-local", "run claude on the local model", "use our
vLLM with claude code", "claude-local not found", "just claudel fails", "claude local 400".

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
install, the live print-mode proof, the shim-log read and the troubleshooting table live in the
`setup-claude-local` agent (`.claude/agents/setup-claude-local.md`). Hand the work to it - do not
run `claude-local` or the installer yourself:

```
Agent(subagent_type: "setup-claude-local", model: "sonnet",
      description: "Set up / verify claude-local",
      prompt: "<the developer's request verbatim, plus any server URL, endpoint name, model and context they gave; say VERIFY ONLY when they asked to check without changing anything>")
```

**The one question stays here.** If the agent returns `NEED: server base URL ...`, ask the
developer for it (never guess an address), then call the agent again with the same prompt plus
their answer.

Relay the agent's "claude-local Setup Complete" block (or the failure and its fix) as it returns
it, including any `DEVELOPER MUST` line (e.g. close and reopen the terminal).
