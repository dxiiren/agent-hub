---
name: llm-transfer
description: "Use when the developer says '/llm-transfer', 'transfer to ChatGPT/Ollama/Gemini', 'hand this to another LLM', 'make a master prompt for an external LLM', or 'export context for an external LLM' - enters plan mode, gathers context, and assembles a self-contained master prompt for a cold, tool-less model; prints a copy-paste block and saves a .md to git-ignored .claude/workspace/reports/transfers/{tool}/."
model: sonnet
---

# llm-transfer - Master Prompt Handoff to an External LLM

Triggers: "/llm-transfer", "/llm-transfer {topic}", "transfer this to ChatGPT / Ollama / Gemini",
"hand this over to another LLM", "make a master prompt for an external LLM", "export context for an
external LLM".

The assembly lives in the `llm-transfer` agent (`.claude/agents/llm-transfer.md`). Hand the gathering,
assembling and saving to it - do not assemble the prompt yourself. Two steps stay here because only
this session can do them, and one after:

1. **Determine scope, target tool, AND mode** (interactive).
   - Scope: the `{topic}` argument, else infer from the current session/task.
   - Target tool + subdir: `gpt` (ChatGPT), `ollama`, `gemini`, `codex`, ...
   - Mode: **agentic** (Codex / opencode / Aider - has the repo, runs commands) -> orchestration
     brief; **cold** (browser / plain `ollama run`) -> self-contained master prompt.
   - If any of these is unclear - or it is ambiguous whether the target continues the work or gives
     a second opinion - ask **once**, one `AskUserQuestion` covering all of it.

2. **Write the session state** - the agent cannot see this conversation, so what you leave out does
   not exist for it: the objective and _why_; what is done, what was tried, what failed (exact error
   text, verbatim); where it stands right now; open questions; the files and commits involved
   (paths). For a second opinion, state the problem neutrally - do not pass on your conclusion.

```
Agent(subagent_type: "llm-transfer", model: "sonnet",
      description: "Assemble the external-LLM handoff",
      prompt: "Topic: <topic>. Target tool: <gpt|ollama|gemini|codex|...>. Mode: <cold|agentic>.
               Ask: <continue the work | second opinion>. Developer's request: <verbatim>.
               Session state: <the summary from step 2>.")
```

3. **Deliver and review.** Print the agent's fenced `text` block exactly as returned, then its
   `Saved:` and `Feed it:` lines. The handoff is final only once the developer accepts it: if they
   ask for a change, `SendMessage` the same agent (or start a fresh one with the same prompt plus) the correction (it rewrites the saved file)
   and print the new block. This review replaces the old plan-mode step - a subagent cannot enter
   plan mode.
