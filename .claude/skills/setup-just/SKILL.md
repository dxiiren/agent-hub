---
name: setup-just
description: Use when the developer says 'setup just', 'install just', "I can't run just", 'just not found', or 'just is not recognized' — installs the `just` command runner, fixes the Windows PATH gap that winget leaves behind, and verifies this repo's recipes actually list.
model: sonnet
---

# setup-just — Command runner installation

Triggers: When the developer says any of: "setup just", "install just", "I can't run just", "just not found", "just is not recognized", "setup recipes".

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
install, PATH fix and verification live in the `setup-just` agent (`.claude/agents/setup-just.md`).
This holds for a verify-only check too: running `just --version` or `just` yourself, even once, is
a failure of this skill - hand it off:

```
Agent(subagent_type: "setup-just", model: "sonnet",
      description: "Set up just",
      prompt: "<the developer's request verbatim; say VERIFY ONLY when they asked to check without changing anything>")
```

Relay the agent's "Just Setup Complete" block (or its failure and fix) as it returns it, including
any `DEVELOPER MUST` line (e.g. reopen the terminal).
