# Stack notes: Node scripts, no server

> **TL;DR** — The repo started from the `node-vite` stack but has no dev server, no port and no
> `just start`/`just stop`. `just` recipes run Node ESM scripts and work on Windows (PowerShell)
> and Linux (sh).

## Gotchas

- **Two shells:** the justfile sets `sh` as the shell and `powershell.exe` as the `windows-shell`.
  Keep recipe bodies to commands that mean the same in both (`npm`, `node`). Use `[windows]` and
  `[unix]` recipes when they differ (see `install`).
- **Setup scripts:** `setup.ps1` (Windows) and `setup.sh` (Linux, macOS; `--check` or `--dry-run`
  changes nothing). Both are idempotent.
- **Config templates** under `config/` hold only `<PLACEHOLDERS>`. Real values go in `*.local.*`
  files, which are git-ignored. `just test` fails on any literal URL in a template.
- **Scan before pushing:** `just scan` fails when a tracked file holds an internal host, IP, path
  or secret pattern.
- **Boot-verify:** `just deps` and `just test` exit 0. There is nothing to serve.

## Related docs

| Doc | Why |
| --- | --- |
| [conventions.md](conventions.md) | The invariants every kit file must keep |
