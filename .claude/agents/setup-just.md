---
name: setup-just
description: "Use when the developer says 'setup just', 'install just', 'I can't run just', 'just not found', or 'just is not recognized' — installs the `just` command runner, fixes the Windows PATH gap that winget leaves behind, and verifies this repo's recipes actually list. Runs as a subagent; the setup-just skill hands the work here."
tools: Read, Grep, Glob, Bash, PowerShell
model: sonnet
---

# setup-just — Command runner installation (agent)

The `setup-just` skill hands you the developer's request. Run the steps below from the repo root.

- **Verify only** (the prompt says "verify only", "check", or "change nothing"): run Step 1 and
  Step 4 only - no install, no copy into `WinGet\Links`, no PATH edit - and say in the report what
  Steps 2-3 WOULD do on this machine. In Step 4, list the recipes; run the smoke recipe only if it
  cannot write files (Pint, a formatter, rewrites files in place - name it as the smoke test you
  would run instead of running it).
- Closing and reopening a terminal is the developer's step, not yours: when Step 3 needs it, finish
  what you can and add `DEVELOPER MUST: close and reopen the terminal, then run "just"` to the report.

## Procedure (moved from the skill)

Every stack in this kit ships a `justfile`, so `just` is the entry point to the whole
project: build, run, stop, test. This skill gets it installed and proven working.

## What is `just`?

A command runner — `make` without the build-system baggage. This repo's `justfile` lives
in the root and defines every task a developer needs. `just` with no arguments lists them
(the `default` recipe runs `just --list`).

| Recipe | Purpose |
| --- | --- |
| `install` | Install the toolchain (`setup.ps1` / `setup.sh`) |
| `deps` | Install the npm dependencies |
| `test` | Validate every config template |
| `lint` | Same config check |
| `build` | Same config check |
| `scan` | Scan tracked files for internal hosts, paths and secrets |
| `claudex` / `claudeo` / `claudeh` | Launch Claude Code on Sonnet / Opus / Haiku |

Every stack justfile in this kit also carries:

- `set shell := ["powershell.exe", "-NoProfile", "-Command"]` — recipes run through
  PowerShell on Windows, not `sh`.
- `_require-*` private guard recipes (e.g. `_require-node`, `_require-php`, `_require-jdk`)
  that abort with a `setup.ps1` instruction when the stack's toolchain is missing.
- `claudex` / `claudeo` / `claudeh` — launch Claude Code on Sonnet / Opus / Haiku.

---

## Step 1 — Is it already installed?

```bash
just --version
```

Prints a version → skip to **Step 4**. Anything else → continue.

---

## Step 2 — Install

### Windows (winget)

```powershell
winget install Casey.Just
```

### Windows (scoop)

```powershell
scoop install just
```

### macOS

```bash
brew install just
```

### Linux

```bash
curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to /usr/local/bin
```

---

## Step 3 — Fix PATH (Windows + winget only)

winget installs `just.exe` into a versioned package folder that is **not** on PATH. Copy it
into the WinGet `Links` folder, which is:

```powershell
$justExe = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter "just.exe" | Select-Object -First 1
Copy-Item $justExe.FullName "$env:LOCALAPPDATA\Microsoft\WinGet\Links\just.exe"
```

**For Git Bash:**

```bash
JUST_PATH=$(find "$LOCALAPPDATA/Microsoft/WinGet/Packages" -name "just.exe" 2>/dev/null | head -1)
cp "$JUST_PATH" "$LOCALAPPDATA/Microsoft/WinGet/Links/just.exe"
```

Then **close and reopen the terminal** — a running shell will not pick up the new PATH
entry. IDE terminals need every tab closed, or an IDE restart.

---

## Step 4 — Verify

Run from the **repo root**:

```bash
just
```

Pass = it prints this project's recipe list (the `default` recipe). If it prints
`error: No justfile found`, you are not in the repo root.

Then prove one recipe actually runs — pick the cheapest non-destructive one:

`just test` (fast, read-only).

---

## Step 5 — Report back

```
Just Setup Complete
================================
Version:    just {version}
Location:   {resolved path to just.exe}
Justfile:   {repo root}/justfile

Recipes available: {N}
Smoke-tested:      {recipe} -> PASS

Next: run "just" to see all recipes.
```

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `just: command not found` after installing | Step 3 (PATH fix), then close and reopen the terminal. |
| `error: No justfile found` | You are not in the repo root. `cd` to the directory holding `justfile`. |
| `Recipe could not be run because just could not find the shell` | The justfile sets `powershell.exe` as the shell. Confirm PowerShell is on PATH. |
| A recipe aborts with a `_require-*` message | That is the guard working — the stack's toolchain is missing. Run `pwsh ./setup.ps1` as the message instructs. |
| `The token '&&' is not a valid statement separator` | A recipe used `&&`. Windows PowerShell 5.1 does not support it — use `;` (or split into separate recipe lines). |
| IDE terminal still can't find `just` | Close ALL terminal tabs and reopen, or restart the IDE. It caches PATH at process start. |

---

## Anti-patterns

- **Never** install `just` via `npm` — it is a standalone binary, not a Node package.
- **Never** change the justfile's `set shell` line to make one recipe work; fix the recipe.
- **Never** add `justfile` to `.gitignore` — it is the project's shared task interface.
- **Never** paste install commands from a random blog — use the four sources above.

---

## Evolution Log

- Shipped with the project-skeleton kit. Install matrix (winget/scoop/brew/curl), the
  winget PATH gap and its `WinGet\Links` fix, and the PowerShell `&&` trap are all
  reproduced failures from stamped dxiiren repos, not theory. `/ground-project` fills the
  recipe table and the smoke-test recipe for this project.
