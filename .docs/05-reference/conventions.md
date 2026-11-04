# Conventions for this project family

Every project scaffolded from `project-skeleton` follows the same onboarding contract:
one idempotent `setup.ps1`, one `justfile`, one numbered `.docs/` set, and one `.claude/`
kit (skills + statusline + memory + MCP stub). This file is the source of truth for the
invariants, the token system, the per-stack boot-verify bar, and the git rules.

> At scaffold time `init.ps1` moves this file to `.docs/05-reference/conventions.md`
> (unmodified — see "Expected token locations" for why it is skipped during token fill).

## The scaffold, end to end

1. **`.\init.ps1`** — mechanical: picks the stack, copies its `setup.ps1` + `justfile`,
   fills the mechanical tokens everywhere, merges the gitignore block, deletes the
   scaffolding, prints next steps.
2. **`/ground-project`** (in Claude Code) — intelligent: reads the real code, fills every
   content token, grounds the skills' worked examples in this project's facts, enables
   qualifying optional skills, runs the skill audit to PASS, and boot-verifies.

### Step 0: the machine (`initial-setup.ps1`, once per laptop)

Both steps above assume a machine that already has Git, PowerShell 7, Node, Claude Code,
uv, just and gh. A brand-new laptop has none of them — it cannot even clone the skeleton.
`initial-setup.ps1` installs that set, and is the only script here that must run under
**Windows PowerShell 5.1**, because it runs before PowerShell 7 exists. Consequences:

- **No PS7-only syntax** in it — no `??`, no `?:` ternary, no `-Parallel`, no
  `$PSStyle`. The Pester suite re-parses the file with the 5.1 engine to enforce this;
  a pwsh-only check would never catch the breakage.
- **It is the only script that installs `Microsoft.PowerShell`.** A stack `setup.ps1`
  cannot: the documented way to run it is `pwsh ./setup.ps1`.
- **Native-command stderr is captured, not piped to `Out-Host`.** Under 5.1 any stderr
  line from a native command renders as a red `NativeCommandError` — `git clone`'s
  progress would make a successful clone look broken. Capture into a variable and print
  it only when `$LASTEXITCODE` says it failed. (The verbatim `Install-Winget` helper
  keeps its `| Out-Host`; winget's output is worth streaming.)
- **It carries no tokens** and never reaches the token fill: `init.ps1` removes it in the
  scaffolding-cleanup step, so a scaffolded project ships exactly one `setup.ps1`. The
  removal is `Test-Path`-guarded — bootstrapping from the web (`irm ... | iex`) means the
  file was never in the clone.

Scope rule: `initial-setup.ps1` installs what is needed to *start any project in this
family*. Anything stack-specific (PHP, JDK, w64devkit, Composer) belongs in the stack's
`setup.ps1`, never here.

Opt-in, same script: `-LocalLlmUpstream <url>` also installs **claude-local** from
`tools/claude-local/` — a launcher that runs the same Claude Code binary against a
self-hosted vLLM model (Anthropic-compatible `/v1/messages`) through a loopback shim,
reachable as `claude-local` and as the `just claudel` recipe every stack justfile carries.
`tools/claude-local/` is scaffolding: `init.ps1` removes it, and a scaffolded project
installs the launcher with `/setup-claude-local` from the skeleton's raw URL. The server
address is per machine (`~/.claude/local-llm/config.json`) and never lives in a repo.

## Scaffold self-test (Pester-locked)

Step 1's observable behavior is **locked by a Pester suite**: `tests/init.Tests.ps1`
(run `just test` in the un-initialized skeleton; needs Pester 5+ visible to `pwsh`).
It scaffolds a throwaway `%TEMP%` copy for **every stack in `stacks/`** and asserts:

- the shared steps, in full for a server stack (static) and a CLI stack (cli-java) —
  stack files at root, templates promoted, scaffolding removed, gitignore merged,
  content tokens preserved, `conventions.md` fill-skip;
- the per-stack token fill, one Describe per remaining stack from the `$stackMatrix`
  table — zero mechanical tokens left in the stack's `justfile`/`setup.ps1`, and every
  token that stack owns carrying the value actually passed;
- the failure paths — the already-scaffolded re-run guard, a missing required value,
  a missing `stacks/` folder (all exit 1), and `-FreshGit` producing a repo on `main`;
- `initial-setup.ps1` — that it parses under the **5.1 engine** (spawned explicitly:
  the suite's own pwsh host cannot catch 5.1-invalid syntax), carries no tokens,
  installs `Microsoft.PowerShell`, and verifies all eight tools. Plus a scaffold from a
  clone with the file deleted, proving init's removal step is a no-op when it is absent;
- `tools/claude-local/install.ps1` — that it installs into caller-supplied dirs (launcher,
  shim, README, a `config.json` holding the upstream, both PATH stubs, exactly one profile
  line even after a re-run) and parses under the 5.1 engine, because `initial-setup.ps1`
  runs it there.

**Adding a stack means adding its `$stackMatrix` row in the same commit** — one row of
arguments plus the regexes proving its own tokens got filled. Likewise, if you change
what `init.ps1` observably does, update the suite in the SAME commit and keep it green.
Never drive an invalid `-Stack` from a test: that prompt loops on a bad answer and
would hang the suite. A scaffolded project inherits none of this: init removes
`tests\init.Tests.ps1` during cleanup and the dev justfile is overwritten by the
stack's justfile.

## Token system

Tokens are delimited by doubled at-signs. Two tiers:

### Mechanical tokens (filled by `init.ps1`, across root + `.docs/` + `.claude/`)

| Token | Meaning |
|---|---|
| `@@PROJECT_TITLE@@` | Human title, Title Case of the project name (e.g. `Book Review`) |
| `@@REPO_SLUG@@` | Folder/repo name, kebab-case (e.g. `book-review`) |
| `@@PORT@@` | Assigned port (server stacks only; suggest 8200–8999, never 3000/8000/5173) |
| `@@MAIN_CLASS@@` | cli-java: class with `main()` · vbnet: WinForms project name (folder + exe base) |
| `@@SRC@@` | cli-cpp: source file name(s) · vbnet: solution file name incl. `.sln` |
| `@@DOCROOT@@` | php-plain/static: folder served (usually `.` — the trailing `\.` in the serve path is EXPECTED) |
| `@@PHP_MINOR@@` / `@@PHP_VS_TAG@@` | php stacks: `8.4` / `vs17` (drop to `8.3` / `vs16` only if the composer platform check fails on 8.4) |

### Content tokens (left unfilled by `init.ps1`; filled by `/ground-project`)

| Token | Lands in | Meaning |
|---|---|---|
| `@@WHAT_IT_IS@@` | CLAUDE.md, README, .docs | 1–3 sentence description of the app (read the code first) |
| `@@STACK_TABLE_ROWS@@` | CLAUDE.md | `\| Layer \| Tech \| detail \|` rows from a real repo reading |
| `@@LAYOUT_TREE@@` | CLAUDE.md + README | short annotated file tree |
| `@@TOOLCHAIN_SUMMARY@@` | CLAUDE.md | e.g. `Node LTS` / `PHP 8.4 + Composer` / `Temurin JDK` |
| `@@BOOTSTRAP_LINE@@` | CLAUDE.md | laravel → `` `just bootstrap`, then`` · node → `` `just deps`, then`` · static/cli → `run` |
| `@@DEV_GOTCHAS@@` | CLAUDE.md | bullet list of real gotchas hit during verify, or delete the token line if none |
| `@@PREREQ_ROWS@@` | README | one row per stack tool (installed-by column = `setup.ps1`) |
| `@@QUICKSTART_STEPS@@` | README | numbered commands after reopening the shell |
| `@@COMMANDS_ROWS@@` | README | rows for the daily recipes of THIS justfile |
| `@@TROUBLESHOOTING_H3S@@` | README | 2–4 `### Symptom` blocks from real verify friction |
| `@@LICENSE_SECTION@@` | README | `## License` section only if a LICENSE **file** exists — otherwise DELETE the token line |

### `[GROUND: ...]` markers

Skill files and `.docs/` placeholders carry bracketed `[GROUND: instruction]` markers where
a worked example, checklist row, scope table, or stack fact must come from THIS project's
real code. `/ground-project` resolves every one of them (replace the marker with grounded
content — never leave a marker in a finished file).

### Placeholder sweep

```bash
grep -rnI "@[@]" --exclude-dir=node_modules --exclude-dir=vendor --exclude-dir=.git .
```

`-I` skips binaries (jpg/pdf/mp4 coincidentally contain the byte pair; committed SQL dumps
legitimately contain MySQL `@@var` syntax — add `--exclude=*.sql` or eyeball those hits).
The self-excluding `@[@]` pattern is REQUIRED so docs that legitimately document the token
convention don't fail the sweep and the sweep command doesn't match itself.

**Expected token locations (the sweep may hit ONLY these):**

- In the un-initialized skeleton: `init.ps1` (holds the replacement strings),
  `CLAUDE.md.template`, `README.project.template`, `GROUNDING.md` (this token table),
  `stacks/**` (all files), `.docs/**` (placeholders), `.claude/memory/MEMORY.md`,
  `.claude/skills/**` and `.claude/skills-optional/**` (mechanical tokens + docs that
  reference content tokens), and the root dev `justfile` (a deliberate guard-marker
  comment: init's already-scaffolded guard is "root justfile with no doubled at-signs",
  so the skeleton's own justfile must carry one to keep init runnable).
  `tests/init.Tests.ps1` is deliberately NOT in this list — its token assertions use
  the sweep's self-excluding `@[@]` form.
- After `init.ps1`: only **content tokens** remain (in CLAUDE.md, README.md, `.docs/`)
  plus the literal tokens in `.docs/05-reference/conventions.md`'s token table —
  `init.ps1` deliberately skips this file so the documentation survives the fill.
- After `/ground-project`: only `.docs/05-reference/conventions.md`'s token table.

## Invariants (MUST NOT change)

1. **Log tags** exactly: `[OK]` Green, `[INSTALL]` Yellow, `[INFO]` Cyan/Yellow, `[WARN]`
   Yellow, `[FAIL]` Red, `[MISSING]` Red, `[NEXT]` Gray. Detail lines DarkGray.
2. **setup.ps1 error discipline:** `$ErrorActionPreference = 'Stop'` +
   `$PSNativeCommandUseErrorActionPreference = $false` prelude; every external call wrapped
   in the `$savedEAP` save/restore guard + `$LASTEXITCODE` check. If you ADD an external
   call, wrap it the same way — one flaky CLI must not abort the rest of setup.
3. **Helper functions** (`Test-Command`, `Refresh-Path`, `Install-Winget`, `Add-UserPath`)
   verbatim.
4. **justfile:** `set shell := ["powershell.exe", "-NoProfile", "-Command"]` ·
   `default: @just --list` · `[private] _require-*` guards that point at setup.ps1 ·
   section banners `# ─── X ───` · the `claudex`/`claudeo`/`claudeh` tail section verbatim.
5. **Summary comment LAST:** `just --list` displays the LAST comment line above a recipe —
   the final comment line above every recipe must be a self-contained one-line summary
   (multi-line rationale goes ABOVE it). Keep this true for recipes you add.
6. **`start`/`stop` stay PROJECT-SCOPED:** the process kill matches the command line
   against `{{justfile_directory()}}\` (trailing backslash so a sibling folder with a
   shared prefix can't false-match). Never `Stop-Process -Name`.
7. **Port discipline:** serve ONLY on the assigned port (never 3000/8000/5173). Vite:
   `--port {{port}} --strictPort`. node stacks: every URL in README/CLAUDE/docs uses
   `http://localhost:PORT` (Node ≥ 17 binds `[::1]` only on Windows); php/static stacks
   keep `http://127.0.0.1:PORT` (explicitly bound).
8. **`.docs/` folder names** exactly: `01-overview 02-setup 03-development 04-deployment
   05-reference 06-troubleshooting 07-faq` + `.docs/README.md` + `.docs/tldr.md`.
9. **Docs style:** no badges, no emoji, tables over prose, second-person imperative.
   Every doc opens with a `> **TL;DR** ...` blockquote and ends with a **Related docs**
   table. Content depth scales with repo size — structure never does.
10. **CLI stacks (no port):** the shared README/CLAUDE templates are server-shaped —
    replace the "app is now at http://..." / `just stop` sentences with build-run
    equivalents; keep every section heading.

## MAY adapt

- Add/remove numbered setup.ps1 steps the stack genuinely needs/lacks (renumber cleanly).
- justfile recipe list: add recipes for scripts that exist (`lint`, `test`, `format`),
  remove recipes whose underlying script doesn't exist. Every recipe keeps a summary
  comment line above it.

## Boot-verify per stack

Poll readiness with `curl.exe` (NEVER the PowerShell `curl` alias) every 2 s, max 120 s.

| Stack | Boot | Verified when | Stop |
|---|---|---|---|
| php-laravel | `just bootstrap` then `just start` | `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:PORT/` < 400 (200/302 ok, 500 fails) | `just stop` |
| php-plain | `just start` (`php -S`) | GET `/` or `/index.php` returns 200 + non-empty body (DB-needing pages may warn — note it) | `just stop` |
| node-vite / node-nuxt | `just deps` + `just build` exit 0, then `just start` | GET `http://localhost:PORT/` 200 with app HTML — MUST use `localhost`, not `127.0.0.1` | `just stop` |
| static | `just start` | GET `/index.html` 200 | `just stop` |
| cli-java | `just build` + `just run` | both exit 0, no stack trace; pipe `sample-input.txt` if the app reads stdin (create one with plausible values, commit it) | n/a |
| cli-cpp | `just build` + `just run` | same as cli-java | n/a |
| cli-jupyter | `just execute <small notebook>` | exit 0 | n/a |
| vbnet | `just build` then `just run` | build exits 0 (3 benign Framework-MSBuild warnings expected), exe process alive after ~5 s | `just stop` |

After stopping a server, confirm `Get-CimInstance Win32_Process` shows no process with the
repo path — filter by the server process name (`php.exe`/`node.exe`/`python.exe`) so your
own checking shell doesn't false-positive. Then re-run `pwsh ./setup.ps1` — it must be an
all-`[OK]` no-op.

Laravel DB rule: local `.env` gets `DB_CONNECTION=sqlite` + create
`database/database.sqlite`. NEVER edit committed `config/database.php`, `.env.example`
defaults, or migrations. Laravel+Vite: run `npm run build` once before verify
(manifest-not-found 500 otherwise).

## .gitignore

`init.ps1` merges `gitignore-block.txt` (the Claude per-dev secrets block) into
`.gitignore`. On top of that, ignore the build/output artifacts your stack generates
(cli-java/cli-cpp `out/`, cli-jupyter `.ipynb_checkpoints/`, vbnet `bin/ obj/ .vs/
*.user`) and any file the APP writes at runtime (check `git status` after boot-verify).
Never a tracked `.env` (`git ls-files .env` must be empty).

## Git rules (MANDATORY)

1. Before the first commit: `git config user.email "mohdakmal875@gmail.com"` and
   `git config user.name "akmal"` (repo-local).
2. **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:` ...).
3. **NO attribution trailers** — never `Co-Authored-By`, "Generated with Claude Code", or
   session links, in commit messages, PR bodies, or issue comments.
4. Stage kit files BY NAME; after committing, `git status --porcelain` must be clean. If a
   bootstrap generated a lockfile the repo never had, include it (deterministic installs).
5. App-source changes needed to boot go in a SEPARATE commit
   (`fix: minimal changes to boot locally`).
6. NEVER: force-push, amend pushed commits, history rewrite, `composer update`,
   `npm update`, framework upgrades, lock regeneration, migration edits, committing
   `.env`/secrets.
