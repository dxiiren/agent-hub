---
name: powershell-windows
description: Use when writing or editing any PowerShell in this repo - a *.ps1 (init.ps1, initial-setup.ps1, a stack's setup.ps1, tools/*, the Pester suite), a justfile recipe (the justfile shell is powershell.exe 5.1), or a one-liner handed to a developer - and when a .ps1, a Pester test or a just recipe fails with 'parameter or', 'Unexpected token', 'call depth overflow', mangled quotes, a BOM, or a wrong exit code. Lists the PS 5.1 / pwsh 7 / Git Bash traps, the 5.1-vs-7 capability checklist, and ships scan.ps1 (incl. a real 5.1 parse of the files that must run there).
model: sonnet
---

# powershell-windows

Triggers: writing or editing any `*.ps1`, a `justfile` recipe or a PowerShell one-liner for a
developer; "scan the PowerShell", "review this .ps1", "/powershell-windows"; a `.ps1`, recipe or
Pester test failing with 'parameter or', 'Unexpected token', 'call depth overflow', mangled quotes,
a BOM, or a wrong exit code.

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
rules (which engine runs what, the PS 5.1 / pwsh 7 / Git Bash traps, the 5.1-vs-7 checklist, the
script skeleton) and `scan.ps1` live in the `powershell-windows` agent
(`.claude/agents/powershell-windows.md`). Hand the work to it - do not write the PowerShell or run
the scan yourself:

```
Agent(subagent_type: "powershell-windows", model: "sonnet",
      description: "PowerShell work (write / review / scan)",
      prompt: "<the developer's request verbatim, the files or recipe involved, any error text; say SCAN ONLY when they asked to check without changing anything>")
```

Relay the agent's `file:line RULE` findings and what it changed (or would change) as it returns them.

## Runs need the developer's words

Only an explicit request in the developer's own words to RUN a script is a run - and then the
prompt to the agent starts with `DEVELOPER ASKED TO RUN: "<their words>"`. "Make sure it works",
"check", "verify", "is it safe" are reviews and go to `powershell-review`, never to this agent.

## Reviews go to the read-only agent

A request to review, check, audit or explain a script (anything short of "write"/"edit"/"run") goes
to `powershell-review`, which has no shell at all:

```
Agent(subagent_type: "powershell-review", model: "sonnet", description: "Review <file>",
      prompt: "<the request verbatim + the file paths>")
```

Relay its findings. Do NOT run, dot-source or probe the reviewed file yourself either - not even
to "confirm" a finding; put such checks in its `DEVELOPER SHOULD RUN` list. Only an explicit
request to run a script is a run.
