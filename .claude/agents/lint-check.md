---
name: lint-check
description: Use when the developer says 'lint check', 'run lint', 'check lint', 'run the quality suite', or 'lint everything' — runs the quality layers this project has (its stack gate, a leftover-placeholder grep, a debug-leftover grep) and reports pass/fail per layer. Runs as a subagent; the lint-check skill hands the work here.
tools: Read, Grep, Glob, Bash, PowerShell, Edit
model: sonnet
---

# lint-check — Quality layers (stack gate · placeholders · leftovers)

Run the honest quality layers for this repo and report pass/fail per layer. Run each
independently so one failure doesn't hide the others.

## What to Do

### 1 — Stack gate

```bash
just test   # runs scripts/check-config.mjs
```

Pass = exit 0 and no error lines. `just lint` and `just build` run the same check; there is no
separate linter yet, so do not add one.

### 2 — Leftover template placeholders

The onboarding kit stamps files from templates whose fill-in tokens are delimited by
doubled at-signs. The `@[@]` character class below matches that delimiter in files
without this skill file matching its own check:

```bash
grep -rnI "@[@]" --exclude-dir=node_modules --exclude-dir=vendor --exclude-dir=.git .
```

Pass = the only hits are the token table in `.docs/05-reference/conventions.md`
(documentation — expected). Any other hit is an unfilled kit placeholder token — fix it
at the source.

### 3 — Debug / draft leftovers

```bash
grep -rn "TODO\|FIXME\|XXX\|console\.log\|debugger\|lorem ipsum" scripts plugins config deploy
```

Pass = zero hits (grep exits 1). A hit is not automatically fatal — judge it: a
deliberate TODO with a follow-up is fine; a stray debug print shipped to the user is not.

---

## Reporting back

Report a per-layer table, then an overall verdict:

```
LAYER         TOOL                       STATUS
stack gate    check-config.mjs        PASS | FAIL (N errors)
placeholders  grep "@[@]"                PASS | FAIL (N hits)
leftovers     grep TODO/debug            PASS | FAIL (N hits, judged)
OVERALL: PASS | FAIL
```

- **stack gate** failures are fixed at the root cause in the source — never by weakening
  or suppressing the check.
- **placeholders** failures mean an unfilled template token from the onboarding kit —
  fill it with the real value (or run `/ground-project` if the scaffold was never
  grounded).
- **leftovers** hits require judgment — report each with its line and a verdict.

---

## Notes

- Run from the **repo root** — the paths above are root-relative.
- Do NOT introduce a new lint toolchain just to make this skill bigger — the layers
  mirror what the project actually has.
- run `just scan` and review `git diff`; there is no UI or server to reload.

## Evolution Log

- Shipped with the project-skeleton kit: the three-layer shape (stack gate +
  placeholder grep + leftover grep) proven across the stamped dxiiren repos, including
  the toolchain-less variant. `/ground-project` writes layer 1 and the scan paths for
  this repo.
