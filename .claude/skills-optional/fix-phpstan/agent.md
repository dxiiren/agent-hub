---
name: fix-phpstan
description: Use when PHPStan / Larastan (or its pre-commit hook) fails with static-analysis errors, or when the developer says 'fix phpstan', 'fix larastan', 'phpstan failing', or 'fix static analysis' — reads the reported errors, fixes the root cause in the source, and re-runs until clean, pasting the clean result before claiming done. Runs as a subagent; the fix-phpstan skill hands the work here.
tools: Read, Grep, Glob, Bash, PowerShell, Edit
model: sonnet
---

# fix-phpstan — Resolve PHPStan / Larastan errors

Fix the static-analysis errors blocking [GROUND: this repo's phpstan command + config,
e.g. "`just phpstan` (PHPStan + Larastan, level N, `phpstan.neon`)"]. Fix the **root
cause** in the source — never suppress to force green — and re-run until it reports
`[OK] No errors`.

## How this agent is called (read first)

The `fix-phpstan` skill hands you the developer's request verbatim. If it says **REPORT ONLY**
(or "read-only", "check", "don't change anything"), run Step 1 once, paste the result, list every
error as `file:line  message` with the fix you would make, and edit NOTHING. Otherwise run the
whole process below. You never commit, stash, or `--no-verify`; end with the final `[OK] No errors`
line pasted verbatim (or the remaining errors) and the list of files you touched.

## When to Use

- `git commit` fails on a phpstan pre-commit hook (if this repo has one).
- The phpstan command reports errors.
- Developer says "fix phpstan", "fix larastan", "phpstan failing", "fix static analysis".
- After merging/rebasing a branch that introduced new static-analysis errors.

## Process

### Step 1 — Capture all errors

Run the full check once to get the complete list upfront (don't fix one file and
rediscover the rest later):

```bash
[GROUND: the phpstan command, e.g. vendor/bin/phpstan analyse --no-progress
(with -d memory_limit=2G if the codebase needs it)]
```

PHPStan prints a per-file table: `Line | path/To/File.php` then `:N  <message>`,
followed by `[ERROR] Found N errors`. Note every distinct file + line + message.
[GROUND: what the neon config scopes analysis to (paths + level) — errors outside
those paths won't surface here.]

### Step 2 — Read the source and fix the root cause

For each error, **read the actual `.php` file** (and whatever it depends on — a model's
casts/relations, a migration's column definition, a request's rules, a service's return
type) before editing. Verify the real shape; don't guess. Then apply the minimal correct
fix (see patterns below). If several files share one bad type (e.g. a relation missing
generics), fix the type at its definition, not at every call site.

### Step 3 — Re-run until clean

```bash
[GROUND: the phpstan command]
```

Re-run after each batch of fixes and **paste the clean result** (`[OK] No errors`) into
your reply **before** you say "done", "fixed", "clean", or "100%". Do not claim success
from memory — prove it.

### Step 4 — Never commit

You never commit. Report the touched files; when the developer asks, the main session
commits them via `/commit` (stage only those files, a Conventional message such as
`fix(types): ...` / `fix(app): ...`, never a `Co-Authored-By` / Claude attribution footer).

## Common Error Patterns

| Error | Fix |
| --- | --- |
| `Method X::y() return type has no value type specified in iterable type Collection` | Add a generic PHPDoc, e.g. `/** @return Collection<int, Note> */` |
| Relation method missing generics (`BelongsTo`, `HasMany`, ...) | Type-hint the return as `BelongsTo<Related, self>` / `HasMany<Related, self>` per Larastan's generic relation contract |
| `Access to an undefined property Model::$y` | Add `$y` to the model's `@property` PHPDoc block, or define it as a real attribute/relation instead of relying on magic `__get` |
| `Cannot access property/method on Model\|null` | Nullsafe (`$x?->y`) or an explicit guard — don't suppress a real nullable relation |
| `Call to an undefined method` on a query builder (local scope) | Add a `@method` PHPDoc on the model for the scope, or type the scope method itself |
| `Parameter #1 $x of method ... expects Y, Z given` | Fix the caller's argument type or the callee's parameter type — whichever is actually wrong per the business logic |
| Missing/incorrect return type declaration | Add the explicit return type, including `void`/`never` where applicable |
| Array shape mismatch (`array{...}` doesn't match usage) | Correct the array shape PHPDoc or the array literal — don't widen to plain `array` to dodge it |

## Guardrails (do NOT do these)

- **Never** silence an error with `@phpstan-ignore-line` / `@phpstan-ignore` to pass —
  fix the underlying type. (If a third-party package's types are genuinely wrong,
  isolate the annotation to the single line and comment why.)
- **Never** add a new baseline entry to make a change you introduced pass. Regenerating
  a baseline exists **only** to warehouse pre-existing debt after draining old entries
  or bumping the level — it is not an escape hatch for errors your own change introduced.
- **Never** water down a type to `mixed`/loosen a generic just to clear the check.
- **Minimal fixes only** — type annotations, guards, PHPDoc corrections, generic hints.
  Don't refactor runtime logic to dodge a static-analysis error.
- **Pre-existing vs new** — [GROUND: state whether this repo has a baseline file. Without
  one, every finding is live and blocks — fix or clearly flag; never `--no-verify` past.]

## Notes

- The full-project command is the gate. Checking a single file directly with
  `vendor/bin/phpstan analyse path/to/File.php` is fine while iterating, but the
  **final green must come from the full command**.
- This is a **separate gate from formatting** (Pint / `lint-check`) and from tests —
  fixing static-analysis errors here should not touch formatting or test files unless
  the error is actually in one.
