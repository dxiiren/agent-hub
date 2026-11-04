# Common Issues — Agent Hub

> **TL;DR** — real symptoms hit while setting up and verifying THIS project, each with
> its fix. If your problem isn't here, add it once you solve it.

### `just` or `node` not found right after setup

PATH updates only land in a new shell. Close and reopen PowerShell. No `just` yet: run `powershell -ExecutionPolicy Bypass -File install-just.ps1`.

### `just test` fails

`scripts/check-config.mjs` names the template and the key. Templates must be valid JSON with placeholders only; fix the file and re-run.

### `just scan` reports a finding

The scan blocks internal host names, private IPs, personal paths and secrets in tracked files. Replace the value with a placeholder such as `<OFFICE_QWEN_URL>`.

## Related docs

| Doc | Why |
| --- | --- |
| [stack-notes.md](../05-reference/stack-notes.md) | The stack's known gotchas |
| [getting-started.md](../02-setup/getting-started.md) | The setup steps these issues occur in |
