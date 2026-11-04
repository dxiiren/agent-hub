---
name: claude-md-refactor
description: "Use when the developer says 'refactor CLAUDE.md', 'CLAUDE.md is too long', 'split my agent instructions', 'clean up CLAUDE.md', 'progressive disclosure for CLAUDE.md', or when CLAUDE.md passes ~300 lines - analyses CLAUDE.md (and AGENTS.md / similar) for contradictions, keeps only the invariants and the links in the root, moves long write-ups into .docs/, flags vague or redundant rules for deletion, and audits every rule for the test or hook that enforces it (claim -> mechanism)."
model: sonnet
---

# claude-md-refactor - split CLAUDE.md before it bloats

Triggers: "refactor CLAUDE.md", "CLAUDE.md is too long", "split my agent instructions", "clean up
CLAUDE.md", "progressive disclosure for CLAUDE.md", "/claude-md-refactor"; or `wc -l CLAUDE.md`
past ~300.

**Your first action is the ANALYZE `Agent` call below - before any Read or edit of your own.** The
analysis (contradictions, invariants, moves to `.docs/`, deletion flags, the claim -> mechanism
audit) and the approved rewrite live in the `claude-md-refactor` agent
(`.claude/agents/claude-md-refactor.md`). The decisions stay HERE, because the agent cannot ask the
developer.

1. **Analyze (read-only):**

```
Agent(subagent_type: "claude-md-refactor", model: "sonnet",
      description: "Analyze CLAUDE.md",
      prompt: "MODE: ANALYZE. Target: <CLAUDE.md, or the file the developer named>. Developer said: <their words verbatim>.")
```

2. **Decide with the developer (stays here).** Show the size line, then ask - one
   `AskUserQuestion` round per group, recommendation first:
   - each **contradiction**, with its resolving question;
   - the **deletion flags** (approve all / pick / none);
   - the **plan**: the proposed root and the `.docs/` moves (accept / adjust).
   Show the claim -> mechanism list as information: UNENFORCED rules are follow-up work (a guard
   test, a deny rule, a hook) the developer may ask for separately - never deleted for being
   unenforced. Nothing is written until the developer approves.
3. **Apply the approved plan:**

```
Agent(subagent_type: "claude-md-refactor", model: "sonnet",
      description: "Apply the approved CLAUDE.md refactor",
      prompt: "MODE: APPLY. APPROVED by the developer. Contradiction resolutions: <verbatim>. Approved deletions: <list or none>. Approved plan: <the root text + moves, with the developer's edits>.")
```

4. **Relay** the files changed, the no-instruction-lost table, the link check and the new line
   count. Offer `/commit`; never commit from here.
