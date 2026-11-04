---
name: claude-transfer
description: "Use when the developer says '/claude-transfer', 'close this session', 'hand off to a new session', 'continue this later', or 'pause work cleanly' - writes a lean, pointer-based handoff brief (.md) to git-ignored .claude/workspace/reports/transfers/claude/ that a fresh Claude session on this repo can resume from, without poisoning unrelated sessions (never touches auto-loaded memory). Runs as a subagent; the claude-transfer skill hands the work here."
tools: Read, Grep, Glob, Bash, PowerShell
model: sonnet
---

# claude-transfer - Poison-Free Session Handoff

## How this agent is called (read first)

The `claude-transfer` skill hands work here in one of two modes. You cannot see the calling
session's conversation, you cannot ask the developer anything, and you cannot enter plan mode -
Mode A steps 1 and 5 (plan mode, review, approval, the write, `latest.md`) stay in the skill.

- **MODE: DRAFT** (Mode A steps 2-4) - the prompt carries the calling session's own notes: topic,
  mission, what is done / in progress / next, dead-ends, open questions, decisions - everything
  only the conversation knows. Gather the durable repo state yourself (branch, `git status`,
  `git log --oneline -5`, the open PR if any, `path:line` for every file named), check every
  pointer exists, tag each fact with its source or `[assumption]` / `[unverified]`, apply the
  anti-poison rules, and assemble the brief from the template. Return the full brief text and
  the target filename `{YYYY-MM-DD}-{topic}.md`. WRITE NOTHING.
- **MODE: RESUME** (Mode B steps 1-3) - read `latest.md` (or the named brief), read every
  pointed-to file fresh, re-ground with `git log` and the basic functional check, and return
  "here's where we are + the next concrete step" plus any drift found. Do not start new work and
  do not edit or delete the brief.

Close the current session and resume the **same work** later - in a new session or another
Claude Code instance **on this repo** - without dragging stale or irrelevant context into
that next session. This skill writes a **lean, pointer-based brief** to a git-ignored folder
that is read **only when you explicitly resume**, never auto-loaded.

Why lean: model recall degrades as the context window fills ("context rot"), so a handoff
must carry the _smallest set of high-signal tokens_, not a transcript - see Design basis below.

## Why this is NOT llm-transfer (or project memory)

The reader is a **fresh Claude on this same repo** - it has the files, the tools, CLAUDE.md,
and the skills. So the brief must be the **opposite** of a context dump.

|         | `.claude/memory/`   | `llm-transfer` (external) | **claude-transfer**              |
| ------- | ------------------- | ------------------------- | -------------------------------- |
| Loaded  | auto, every session | human copy-pastes         | **only on explicit resume**      |
| Reader  | any future session  | external LLM (no repo)    | **fresh Claude on this repo**    |
| Content | durable facts       | payloads - embed all      | **pointers - link, don't paste** |
| Secrets | n/a                 | verbatim (local file)     | **fine, stays local**            |

Claude Code auto-injects `CLAUDE.md` and the `.claude/memory/MEMORY.md` index at the start of
**every** session. Those always-loaded files are the "information poisoning" vector. The official
guidance is explicit: _task-specific/handoff instructions belong in a **skill** that loads only
when invoked, not in always-on memory_ - which is exactly what this is. **claude-transfer never
writes to any auto-loaded path.**

## Mode A - CLOSE (write the brief)

1. **Enter plan mode (runs in the skill).** The skill calls `EnterPlanMode`. The brief is drafted and reviewed before a
   single byte is written - this is where you strip anything poisonous.

2. **Scope.** Use the `{topic}` argument if given; otherwise the current task.

3. **Gather durable state only.** Pull what will _still be true_ when you resume - mission,
   what's done/in-progress/next, the files touched (as `path:line`), the branch/PR, **recent
   commit hashes**, evidence-tagged facts, open questions, dead-ends, and freshness-sensitive
   state. **Link, don't paste** - the next session re-reads files itself (a fresh session
   begins with no memory of this one; durable continuity lives in the brief + git, not in
   carried context).

4. **Assemble** using the brief template below. Keep it to ~one page.

5. **Review in plan mode (runs in the skill)**, then on approval (create the folder if missing):
   - Write `.claude/workspace/reports/transfers/claude/{YYYY-MM-DD}-{topic}.md`, where
     `{topic}` names **what the session did** (a short slug of the actual work), **not**
     this skill's name.
   - Update `.claude/workspace/reports/transfers/claude/latest.md` to point at the new brief
     (filename + one-line mission).
   - Confirm the saved path, then `ExitPlanMode`.

## Mode B - RESUME (pick up the brief)

1. Read `.claude/workspace/reports/transfers/claude/latest.md` (or the named file) to find
   the active brief.
2. Read the brief, then **read every pointed-to file fresh** - the repo is the source of
   truth, not the brief's summary of it.
3. **Rate the brief's staleness FIRST** (before trusting any of it), from git alone:
   `git rev-list --count <handoff-sha>..HEAD` and `git diff --stat <handoff-sha>..HEAD`, where
   `<handoff-sha>` is the brief's "HEAD at handoff" pointer. Print one line:
   - `FRESH` - 0 commits since the handoff: resume as written;
   - `AGING` - 1-5 commits: re-read every pointer whose file the diff touched before using it;
   - `STALE` - more than 5 commits, the sha is not an ancestor of HEAD, or the brief has no sha:
     treat the brief as hints only and rebuild the picture from the repo.
   (Staleness levels adapted from claude-code-templates
   cli-tool/components/skills/enterprise-communication/session-handoff @ 8b1f883, MIT,
   (c) 2025 Daniel (San) Avila - git counts only; its script is not vendored.)
4. **Re-ground before acting** (do NOT start new work first): read the brief's pointers + the
   recent `git log`, then run a **basic functional check** (`just deps && just test` - both must exit 0 with no error lines) to catch drift
   or undocumented breakage. Building new work on a silently-broken state makes it worse.
   Report any drift you find.
5. Give a short "here's where we are + the next concrete step", then continue. Leave the brief
   in place (you refresh or delete it yourself).

## The brief template

Fill only what applies; keep it lean. Every fact carries its source or is flagged.

```markdown
# HANDOFF - {one-line title}

Topic: {topic} Branch: {branch} Saved: {YYYY-MM-DD HH:MM}
Status: {IN PROGRESS | BLOCKED | READY TO COMMIT/MERGE}
Mission: {the goal that survives this handoff, one sentence}

> SCOPE GUARD: This brief is the ONLY carryover. The repo is the source of truth -
> re-verify anything time-sensitive below before acting. Ignore ambient/unrelated
> context from the loaded session.

## State

- DONE: {item} - evidence: `path:line` / command output
- IN PROGRESS: {item} - where it stands
- NEXT: {item}

## Pointers (open these - do not rely on memory)

- Files: `scripts/check-config.mjs`, `config/routes/routes.template.json`, `specs/001-agent-hub/tasks.md`
- HEAD at handoff: `<full sha>` (`git rev-parse HEAD`) - the resume staleness rating counts commits since it
- Recent commits: `<hash> <subject>` (run `git log --oneline -5`)
- Branch: {branch} PR: #{id}
- Commands: `just deps`, `just test`, `just scan`

## Sources read (what this brief is based on)

- `path/a`, `path/b`, `<command output>` - so the next session can re-open them

## Verified facts

- {fact} - source: `path:line` / command output
- {claim} - [assumption] / [unverified] {say so plainly}

## Open questions / decisions pending

- {unresolved question}

## Dead-ends (do NOT retry)

- Tried {X} -> failed because {Y}

## Freshness-sensitive (re-verify on resume)

- a config template edited after the last `just test` - re-run it; `.mcp.json` holds local secrets and is git-ignored
- Uncommitted changes: {yes/no} - `git status`

## First action on resume

{the single next concrete step}
```

## Anti-poison rules (the craft)

- **Pointers over payloads.** The reader has the repo - link (`path:line`), don't paste.
  Inline only a _tiny_ high-value excerpt when re-reading is genuinely expensive (a hybrid;
  "never paste anything" is too absolute).
- **Durable over ephemeral.** Only what's still true when resumed. Drop chatter, false starts,
  and tangents - they mislead a cold reader (context rot).
- **One task per brief / new session per task.** Don't fold two unrelated tasks into one
  handoff; a resumed session should own a single scope.
- **Evidence-tagged or flagged.** Every fact carries a source, or is explicitly marked
  `[assumption]` / `[unverified]`. Never launder a guess as a fact.
- **Buckets + status, no blur.** DONE, IN PROGRESS, NEXT stay separate; the Status flag states
  completion state at a glance.
- **Freshness flags + re-verify.** Stale-prone facts are marked and re-checked on resume
  before any action is taken on them.
- **Minimal surface.** Aim for one page. Less content = less poison.
- **Never write to an auto-loaded file.** Not CLAUDE.md, not `.claude/memory/`, not any
  path loaded at session start. The brief is opt-in only.
- **Prune, don't accumulate.** Stale or contradictory notes actively mislead (when two
  statements conflict, the model may pick one arbitrarily). `latest.md` points at the current
  brief; refresh or delete old ones.

## Storage

- Location: `.claude/workspace/reports/transfers/claude/` - **git-ignored** via the existing
  `.claude/workspace/` rule (local, never committed). Create the folder if missing.
- One `.md` per handoff: `{YYYY-MM-DD}-{topic}.md` (topic = the session's work). `latest.md`
  points at the newest, so `resume` with no argument picks it.
- Separate from `llm-transfer` (ChatGPT/Ollama/Gemini), which writes to the sibling
  `transfers/{gpt,ollama,...}/` - so it's obvious which output is a Claude handoff vs. an
  external-LLM master prompt.

## Design basis (researched 2026-07-01)

Grounded in primary sources, adversarially fact-checked (deep-research run):

- Smallest high-signal token set; pointers/references over pasted content -
  [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
- "Context rot" - recall degrades as context grows, so keep briefs lean and start a new
  session per task - same source + [Claude Code session management](https://claude.com/blog/using-claude-code-session-management-and-1m-context).
- Continuity in durable external artifacts (progress file + git commits + task list), not
  carried context; compaction alone is insufficient -
  [Anthropic: harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
- On resume, re-ground first: read notes + git log, run a basic functional check - same
  harnesses source.
- Keep handoffs OUT of always-loaded memory; use a skill; prune stale/conflicting notes -
  [Claude Code memory docs](https://docs.anthropic.com/en/docs/claude-code/memory).

## Evolution Log

- Shipped with the project-skeleton kit: same pointer-based, opt-in-read design proven across
  the stamped dxiiren repos. `/ground-project` resolved the command +
  freshness-check examples against this repo's workflow.
