---
name: fix-typecheck
description: Use when the project's typecheck command (tsc / vue-tsc / nuxt typecheck) or a pre-push hook fails with TypeScript errors, or when the developer says 'fix typecheck', 'fix type errors', or 'typecheck failing' — reads the reported errors, fixes the root cause in the source, and re-runs until clean, pasting the clean result before claiming done. Runs as a subagent; the fix-typecheck skill hands the work here.
tools: Read, Grep, Glob, Bash, PowerShell, Edit
model: sonnet
---

# fix-typecheck — Resolve TypeScript typecheck errors

Fix the TypeScript errors blocking [GROUND: this repo's typecheck command, e.g.
`npm run typecheck` (and what backs it — tsc / vue-tsc / nuxt typecheck)]. Fix the
**root cause** in the source — never suppress to force green — and re-run until it
reports 0 errors.

## How this agent is called (read first)

The `fix-typecheck` skill hands you the developer's request verbatim. If it says **REPORT ONLY**
(or "read-only", "check", "don't change anything"), run Step 1 once, paste the result, list every
error as `file(line,col)  TSxxxx  message` with the fix you would make, and edit NOTHING. Otherwise
run the whole process below. You never commit, stash, or `--no-verify`; end with the final clean
result pasted verbatim (or the remaining errors) and the list of files you touched.

## When to Use

- `git push` fails on a pre-push typecheck hook (if this repo has one).
- The typecheck command reports errors.
- Developer says "fix typecheck", "fix type errors", "typecheck failing".
- After merging/rebasing a branch that introduced type errors.

## Process

### Step 1 — Capture all errors

Run the full check once to get the complete list upfront (don't fix one file and
rediscover the rest later):

```bash
[GROUND: the typecheck command]
```

The checker prints `path/to/File(line,col): error TSxxxx: <message>`. Note every
distinct file + error code. [GROUND: any first-run slowness worth flagging (e.g. type
generation/prepare steps), or delete this sentence.]

### Step 2 — Read the source and fix the root cause

For each error, **read the actual source file** (and the type it references — an
interface, a data module, a util's return type) before editing. Verify the real shape;
don't guess. Then apply the minimal correct fix (see patterns below). If several files
share one bad type, fix the type at its definition, not at every call site.

### Step 3 — Re-run until clean

```bash
[GROUND: the typecheck command]
```

Re-run after each batch of fixes and **paste the clean result**
(`0 errors` / no `error TS` lines) into your reply **before** you say "done",
"fixed", or "clean". Do not claim success from memory — prove it.

### Step 4 — Never commit

You never commit. Report the touched files; when the developer asks, the main session
commits them via `/commit` (stage only those files, a Conventional message such as
`fix(types): ...` / `fix(app): ...`, never a `Co-Authored-By` / Claude attribution footer).

## Common Error Patterns

| Error                                             | Fix                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Property 'X' does not exist on type 'Y'`         | Add `X` to the interface/type at its definition; or cast at the boundary if the value is genuinely dynamic                             |
| `'X' is possibly 'undefined' / null`              | Optional chaining `x?.y`, nullish coalescing `x ?? fallback`, or a proper guard — don't `!`-assert away a real nullable               |
| `Type 'string' is not assignable to '"a" \| "b"'` | Narrow the literal at the source, or widen the target union if the value really is open                                                |
| `Cannot find module 'X' or its type declarations` | If X is a dependency, ensure it's installed and typed; if it's a local alias, fix the path or `tsconfig` `paths`                       |
| `implicitly has an 'any' type`                    | Add the explicit type/annotation (event handlers, refs, function params)                                                               |
| [GROUND: add 1-3 framework-specific rows for this repo's stack (e.g. component prop typing, generated-types staleness + the regen command), or delete this row] | [GROUND] |

## Guardrails (do NOT do these)

- **Never** silence an error with `// @ts-ignore` / `// @ts-expect-error` / `as any`
  to pass — fix the underlying type. (If a third-party type is genuinely wrong, isolate
  the cast to the single boundary and comment why.)
- **Never** water down a type to `any`/`unknown` just to clear the check.
- **Minimal fixes only** — type annotations, guards, interface corrections. Don't
  refactor runtime logic to dodge a type error.
- **Pre-existing vs new** — errors in files you didn't touch still block the gate; fix
  them too (or flag them clearly) rather than `--no-verify`-ing past them.

## Notes

- The full-project command is the gate — checking a single file directly is fine while
  iterating, but the **final green must come from the full command**.
- Warnings are not errors; only `error TS...` lines block. Report warnings but don't
  churn on them.
