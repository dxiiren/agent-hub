# Skills Catalog — `agent-hub`

Project development skills for Agent Hub. Each lives in its own directory with a
`SKILL.md`. **Follow the relevant skill before writing code.** Run `/audit-skills` to verify
every skill here is registered and that `CLAUDE.md` references only existing skills.

Model tiers: `sonnet` (floor) · `opus` (deep reasoning / generation).

**Every skill hands its procedure to an agent.** Each `SKILL.md` is a thin shim whose first action is 
`Agent(subagent_type: "<name>", model: "sonnet")`; the procedure lives in `.claude/agents/<name>.md` (`model: sonnet`). 
Interactive steps (owner approval, AskUserQuestion) stay in the shim; `verify-before-claim` maps to `verifier`. 
An optional skill keeps its agent beside it (`skills-optional/<name>/agent.md`) until `/ground-project` enables it. 
A skill a production app loads byte-for-byte is runtime-locked (never shimmed; list it in `audit.py` `RUNTIME_LOCKED`). 
`/audit-skills` FAILS (NO_AGENT) on a skill without its agent. `.claude/agents/` must never ship in an image. 

Re-sweeping aitmpl for new things to adopt: see [`AITMPL-RESWEEP.md`](../../AITMPL-RESWEEP.md).

> Freshly scaffolded? Run [ground-project](ground-project/SKILL.md) first — it resolves the
> grounding markers in the skills below against this project's real code and enables
> the applicable optional skills.

## Scaffolding

| Skill                                       | What it does                                                                                                                                       | Model |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| [ground-project](ground-project/SKILL.md)   | One-time grounding pass after `init.ps1`: fills content tokens, grounds skills in the real code, enables optional skills, audits, and boot-verifies. | opus  |

## Toolchain

| Skill                             | What it does                                                                                                             | Model  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| [setup-just](setup-just/SKILL.md) | Install the `just` command runner, fix the Windows winget PATH gap, and verify this repo's recipes list and run.         | sonnet |
| [setup-claude-local](setup-claude-local/SKILL.md) | Install the `claude-local` launcher (Claude Code on a self-hosted vLLM model through a local shim), prove it with a live print-mode run, and read the shim log before calling anything a defect. | sonnet |

## Git

| Skill                           | What it does                                                                                                                                                             | Model  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| [commit](commit/SKILL.md)       | Conventional-Commits stage + message flow (stale-lock preflight, `git add -A` fast path, scoped stage-by-name). Never auto-commits, never amends, no attribution footer. | sonnet |
| [create-pr](create-pr/SKILL.md) | Push the current branch and open a **GitHub** PR into `main` via `gh` / GitHub MCP, with a clean Summary/Changes/Testing body and no attribution footer.                 | opus   |

## Quality & Review

| Skill                                               | What it does                                                                                                                    | Model  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ |
| [verify-before-claim](verify-before-claim/SKILL.md) | Spawn a fresh adversarial verifier subagent that must prove the change works with live evidence before anything is called done. | opus   |
| [pre-pr-review](pre-pr-review/SKILL.md)             | Self-review the branch diff against this project's stack checklist + a boot check; report to `workspace/reports/pr/`.           | opus   |
| [lint-check](lint-check/SKILL.md)                   | Run this project's quality layers (stack gate, kit-placeholder grep, debug-leftover grep); report pass/fail per layer.          | sonnet |
| [audit-docs](audit-docs/SKILL.md)                   | Layered adversarial audit of a document set (cross-set → re-verify → per-document), with the fix loop and an `audits/` trail.   | opus   |
| [systematic-debugging](systematic-debugging/SKILL.md) | Root cause before any fix: live state first, one hypothesis, test-first fix, stop after three failed fixes; ships `find-polluter.sh`. | opus   |
| [test-driven-development](test-driven-development/SKILL.md) | Red seen, then green, never commit red; infra acceptance tables and source-level guard tests proven with a mutant. | opus   |

## MCP tooling

| Skill                                 | What it does                                                                                                  | Model  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| [setup-mcp](setup-mcp/SKILL.md)       | Registry-driven MCP setup / onboarding (reads `setup-mcp/registry.json`; wires stub + secret + enable tiers). | opus   |
| [test-all-mcp](test-all-mcp/SKILL.md) | Live per-server smoke-test sweep → PASS/FAIL/SKIP table (prompts in `test-all-mcp/checks/`).                  | sonnet |

## Maintenance

| Skill                                 | What it does                                                                                                     | Model  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| [audit-skills](audit-skills/SKILL.md) | Verify every skill has a valid, registered `SKILL.md` (no BOM, valid model, no hardcoded secret) via `audit.py`. | sonnet |
| [claude-md-refactor](claude-md-refactor/SKILL.md) | Split a bloated `CLAUDE.md`: invariants + links stay, write-ups move to `.docs/`, every rule mapped to the test/hook that enforces it. | opus   |
| [powershell-windows](powershell-windows/SKILL.md) | PS 5.1 / pwsh 7 / Git Bash traps for every `.ps1` and justfile recipe, plus `scan.ps1` (incl. a real 5.1 parse). | opus   |

## Planning & handoff

| Skill                                       | What it does                                                                                                        | Model  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------ |
| [sharpen-prompt](sharpen-prompt/SKILL.md)   | Rewrite a fuzzy request into a brief with a pasteable definition of done before starting work.                      | opus   |
| [define-requirements](define-requirements/SKILL.md) | New project or capability: interrogate + research in parallel, then write Discovery → BRD → PRD → FSD → TDD into `.docs/00-requirements/`. | opus   |
| [define-goal](define-goal/SKILL.md)         | Interrogate until a goal is unambiguous, then write a stop-proof `{topic}-goal.md` for the built-in `/goal` runner. | opus   |
| [claude-transfer](claude-transfer/SKILL.md) | Pointer-based session-handoff brief to `workspace/reports/transfers/claude/`.                                       | sonnet |
| [llm-transfer](llm-transfer/SKILL.md)       | Self-contained master prompt for an external LLM → `workspace/reports/transfers/{tool}/`.                           | sonnet |

## Optional skills (in `.claude/skills-optional/` — not active)

`/ground-project` moves a skill from `skills-optional/` into `skills/` (and adds its row
above) when its prerequisite exists in this project. Unused ones stay in `skills-optional/`
as inert reference — they are not loaded and not audited.

| Skill (in skills-optional/) | Enable when |
| --- | --- |
| monitor-ci | CI workflow files exist (`.github/workflows/` or equivalent) |
| generate-playwright-tests | a Playwright dependency/config exists |
| fix-typecheck | a typecheck script or `tsconfig.json` exists |
| fix-phpstan | phpstan/larastan in `composer.json` |
| update-or-create-docs | always recommended once `.docs/` has real content |
| audit-pagespeed | the project ships a **web page on a public URL** (PageSpeed cannot reach `localhost`) |
| supply-chain-audit | a lockfile or dependency manifest exists (`package-lock.json`, `uv.lock`, `composer.lock`, `pom.xml`, ...) or a `Dockerfile` / `.github/workflows/` |
| dependabot-review | `.github/dependabot.yml` exists |
