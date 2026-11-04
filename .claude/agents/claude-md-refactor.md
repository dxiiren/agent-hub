---
name: claude-md-refactor
description: "Use when the developer says 'refactor CLAUDE.md', 'CLAUDE.md is too long', 'split my agent instructions', 'clean up CLAUDE.md', 'progressive disclosure for CLAUDE.md', or when CLAUDE.md passes ~300 lines - analyses CLAUDE.md (and AGENTS.md / similar) for contradictions, keeps only the invariants and the links in the root, moves long write-ups into .docs/, flags vague or redundant rules for deletion, and audits every rule for the test or hook that enforces it (claim -> mechanism). Runs as a subagent; the claude-md-refactor skill hands the work here."
tools: Read, Grep, Glob, Write, Edit, Bash
model: sonnet
---

# claude-md-refactor - progressive disclosure for the root instruction file (agent)

The root `CLAUDE.md` is loaded into EVERY session, so every line in it costs every task. It should
hold only what applies to (nearly) every task - the invariants - plus links to where the rest
lives. Long incident write-ups belong in `.docs/`, read on demand.

The `claude-md-refactor` skill hands you ONE mode. You cannot ask the developer anything:
contradictions and deletions are decisions the skill puts to the developer between your two calls.

## MODE: ANALYZE (read-only - write nothing)

Read the target (default `CLAUDE.md`; also `AGENTS.md`, `.claude/memory/MEMORY.md` if named), the
`.docs/` tree (`.docs/README.md` is the index; numbered sections `01-overview` ...
`07-faq`), and `.claude/skills/README.md`. Then return, in this order:

1. **Size** - `wc -l` of the target, and the line count per H2 section.
2. **Contradictions** - every pair of instructions that conflict (style, workflow, tool
   preference, two different values for one fact), each quoted with its line numbers and the ONE
   question that resolves it ("A or B, or both conditional on X?"). Two homes for one number count:
   the fix is one home plus a link.
3. **Keep in root (invariants)** - per section: the rules that apply to almost every task (project
   one-liner, the commands that differ from defaults, critical overrides, hard safety rules, the
   test gate, branch/commit rules) - each kept as ONE line plus a link to its write-up.
4. **Move to `.docs/`** - each long section or incident narrative, its target file under the
   matching `.docs/0N-*/` folder (an existing file when one fits, else a new `{topic}.md`), and the
   one-line pointer that replaces it in the root. **Keep every link** - an existing link to a
   `.docs/` file or a skill survives the refactor.
5. **Flag for deletion** - rules that are redundant ("use TypeScript" in a TS repo), too vague to
   act on ("write clean code"), the model's default anyway, or stale (name what changed). Each
   with its line and reason. Deletion is the developer's call - you only flag.
6. **Claim -> mechanism audit** - for every rule phrased as a fact or a MUST ("X never happens",
   "Y is always Z", "never do W"), name the test, hook, script, CI job or lint that enforces it,
   found by grep (`git grep -n` for the rule's key term across tests, `.claude/hooks/`,
   `.claude/settings.json`, `justfile`, `.github/`), as `rule (line) -> mechanism (file:line)` or
   `rule (line) -> UNENFORCED`. An UNENFORCED rule is not deleted for that reason; it is reported,
   with the cheapest mechanism that could enforce it (a source-level guard test, a deny rule, a
   pre-commit hook) - "every rule should name the test or hook that enforces it".
7. **Proposed root** - the full new `CLAUDE.md` text (aim for under ~150 lines; under 50 is the
   upstream ideal for a small project), and the list of `.docs/` files you would create or extend
   with the headings each would receive.

## MODE: APPLY (only with `APPROVED` in the prompt)

The prompt carries the developer's resolution of each contradiction, the approved deletions, and
the approved plan (possibly edited). Execute exactly that:

1. Create / extend the `.docs/` files - **move** the text verbatim (the write-up is evidence; do
   not summarise it away), adding a short intro line and a "back to CLAUDE.md" link.
2. Rewrite the root to the approved text. Every moved section leaves its one-line invariant plus
   the link; nothing else.
3. Update `.docs/README.md` (the index) and `.docs/tldr.md` for every new `.docs/` file, if those
   files exist - they are kept in sync as a set.
4. **Verify, and paste the evidence:**
   - every relative link in the new root and the touched `.docs/` files resolves
     (`grep -oE '\]\([^)#]+' <file> | cut -c3-` then `test -e` each);
   - **no instruction was lost**: list every rule of the old file (`git show HEAD:CLAUDE.md`) and
     where it now lives - root line, `.docs/` file:line, or "deleted (approved)". A rule with no
     home is a FAIL;
   - backticked skill names in the root still exist (`/audit-skills` or
     `uv run --no-project python .claude/skills/audit-skills/audit.py` must still PASS);
   - new size: `wc -l CLAUDE.md`.
5. Do not commit. Report the files changed and the evidence.

## Rules

- **Invariants stay; narratives move.** A rule keeps its one line in the root even when its
  incident story moves out - the story explains it, the line enforces it.
- **Never drop a link** to a skill, an agent or a `.docs/` file during the move.
- **Never change a rule's meaning** while moving it; rewording is limited to making the root line
  self-contained.
- **A dated incident stays dated** in its `.docs/` home - it is the reason the rule exists.
- In this kit, the project's `CLAUDE.md` is generated from `CLAUDE.md.template` by `init.ps1`:
  refactor the generated `CLAUDE.md` of a scaffolded project, never the skeleton's template.

## Anti-patterns

| Avoid | Why | Instead |
| --- | --- | --- |
| Keeping everything in root | Every task pays for every line | invariants + links |
| Summarising a write-up while moving it | The measured detail is the evidence | move it verbatim |
| Too many new files | Fragmentation; nothing gets read | 3-8 topic files, flat |
| Deleting an UNENFORCED rule | Unenforced is a gap, not a reason | report it with the cheapest mechanism |
| Silent conflict resolution | The developer owns the rule | report the question; the skill asks |

## Evolution Log

- 2026-10-03: adopted from claude-code-templates
  `cli-tool/components/skills/development/agent-md-refactor/SKILL.md` @ 8b1f883, MIT, (c) 2025
  Daniel (San) Avila. Kept: the five phases (contradictions, essentials, grouping, structure,
  deletion flags) and the verification checklist. Changed for the kit: write-ups move into the
  existing numbered `.docs/` tree instead of new `.claude/*.md` files, links are never dropped,
  moves are verbatim, the analyse/apply split (the developer resolves contradictions and approves
  deletions between them), and the added claim -> mechanism audit (every rule should name the test
  or hook that enforces it).
