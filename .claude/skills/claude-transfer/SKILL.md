---
name: claude-transfer
description: "Use when the developer says '/claude-transfer', 'close this session', 'hand off to a new session', 'continue this later', or 'pause work cleanly' - writes a lean, pointer-based handoff brief (.md) to git-ignored .claude/workspace/reports/transfers/claude/ that a fresh Claude session on this repo can resume from, without poisoning unrelated sessions (never touches auto-loaded memory)."
model: sonnet
---

# claude-transfer - Poison-Free Session Handoff

Triggers:

```text
/claude-transfer                 # close: write a brief for the current work
/claude-transfer close {topic}   # close: brief scoped to {topic}
/claude-transfer resume          # resume: read the latest brief and continue
/claude-transfer resume {file}   # resume: read a specific brief
close this session / continue this later / pause work cleanly
```

The procedure lives in the `claude-transfer` agent (`.claude/agents/claude-transfer.md`). Hand
the drafting and the re-grounding to it - do not do them yourself. Plan mode, the review, the
approval and the write stay HERE: a subagent cannot ask the developer, and it cannot see this
conversation, so you must hand it what only the conversation knows.

## CLOSE (write a brief)

1. Call `EnterPlanMode`.
2. Note, from THIS conversation, what only you know: topic (what the session did, never this
   skill's name), mission, DONE / IN PROGRESS / NEXT with their evidence, files touched,
   dead-ends, open questions, decisions pending, freshness-sensitive state. Raw notes are fine -
   the agent makes them lean and checks them against the repo.
3. Hand off:

   ```
   Agent(subagent_type: "claude-transfer", model: "sonnet",
         description: "Draft the handoff brief",
         prompt: "MODE: DRAFT. Topic: <topic>. Session notes: <the notes from step 2>")
   ```

4. Present the returned brief for review in plan mode (as the plan in `ExitPlanMode`) and strip
   anything the developer flags as poisonous.
5. On approval, write the approved text verbatim to
   `.claude/workspace/reports/transfers/claude/{YYYY-MM-DD}-{topic}.md` (create the folder if
   missing), point `latest.md` there (filename + one-line mission), and confirm the saved path.
   If the developer asked to print the brief instead, print it and write nothing. Never write to
   an auto-loaded path (`CLAUDE.md`, `.claude/memory/`).

## RESUME (pick up a brief)

```
Agent(subagent_type: "claude-transfer", model: "sonnet",
      description: "Re-ground from the handoff brief",
      prompt: "MODE: RESUME. Brief: <latest | the named file>.")
```

Relay "where we are + the next concrete step" and any drift it found, then continue the work from
that step - reading the pointed-to files yourself before you edit them.
