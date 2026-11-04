# FAQ — Agent Hub

> **TL;DR** — short answers to the questions that actually come up on this project.

**Q: Why is there no app server (`just start`)?**

This repo configures and extends the Paseo daemon; it runs no server of its own. The checks are `just deps && just test`.

**Q: Where do real provider URLs and keys go?**

Outside the repo. Templates in `config/` hold `<PLACEHOLDERS>` only, and `just scan` blocks internal hosts and secrets.

**Q: Where do MCP secrets go?**

`.mcp.json` is git-ignored; the committed `.mcp.json.stub` holds placeholders.

**Q: Why do `lint` and `build` run the same check as `test`?**

There is no code to lint or compile yet. Plugins land per `specs/001-agent-hub/tasks.md`.

**Q: How do I add a just recipe?**

Add it to the `justfile` with a comment line above it, then add a row to [commands.md](../05-reference/commands.md).

## Related docs

| Doc | Why |
| --- | --- |
| [tldr.md](../tldr.md) | Every doc in 30 seconds |
| [conventions.md](../05-reference/conventions.md) | The rules behind several answers |
