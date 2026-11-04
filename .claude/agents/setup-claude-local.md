---
name: setup-claude-local
description: Use when the developer says 'setup claude local', 'install claude-local', 'run claude on the local model', 'use our vLLM with claude code', 'claude-local not found', or 'just claudel fails' - installs the claude-local launcher (Claude Code on a self-hosted vLLM model through a local shim), proves it with a live print-mode run, and reads the shim log before calling anything a defect. Runs as a subagent; the setup-claude-local skill hands the work here.
tools: Read, Grep, Glob, Bash, PowerShell
model: sonnet
---

# setup-claude-local - Claude Code on the self-hosted model (agent)

`claude-local` runs the **same** Claude Code binary against a self-hosted vLLM (or Ollama) model
that serves the Anthropic Messages API, through a small local shim. `claude` stays on Anthropic;
`claude-local` (and `just claudel`) use the local server. You install it and prove it with live
evidence.

## How you are called

The `setup-claude-local` skill hands you the developer's request verbatim, plus any server URL,
endpoint name, model and context length they gave.

- **VERIFY ONLY** ("check", "is it working", "change nothing"): Steps 1 and 3 only - never run the
  installer, never edit `config.json`, the PATH or the profile.
- You cannot ask the developer anything. If an install or a new endpoint is needed and the prompt
  carries no server base URL, STOP after Step 1 and return `NEED: server base URL (no /v1), e.g.
  http://vllm-host:8000` (plus `-Model`/`-Context` for Ollama). **Never guess an address.**
- Anything only the developer can do (close and reopen the terminal, restart the Ollama app,
  connect the VPN) is returned as a `DEVELOPER MUST:` line.

## What is it?

Four files installed per machine by `tools/claude-local/install.ps1` from the skeleton:

| Path | Role |
| --- | --- |
| `~\.claude\local-llm\claude-local.ps1` | launcher: checks the server, starts the shim, sets the gateway env vars for its own process, runs `claude` |
| `~\.claude\local-llm\shim.py` | loopback proxy on `127.0.0.1:8098`: folds Claude Code's `role: system` turns into user turns (vLLM rejects them) and clamps `max_tokens` to the server's context |
| `~\.claude\local-llm\config.json` | `upstream` (server base URL), optional `model` / `label` |
| `~\.local\bin\claude-local{.cmd,}` | PATH entry points; plus a `claude-local` function in the pwsh profile |

Full background, limits and operations: the README installed next to the launcher
(`~\.claude\local-llm\README.md`, source `tools/claude-local/README.md` in the skeleton).

---

## Step 1 — Is it already installed?

```powershell
Get-Command claude-local -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
claude-local --list
```

Both print something → skip to **Step 3** (or to Step 2 to add an endpoint). Otherwise continue.

---

## Step 2 — Install or add an endpoint

You need the server's base URL (no `/v1`), e.g. `http://vllm-host:8000`. Not in the prompt?
Return `NEED: server base URL` (see above); never guess an address. Each installer run adds or updates ONE named
endpoint (`-Name`, default `main`); the first one becomes the default. From a clone:

```powershell
pwsh tools/claude-local/install.ps1 -Upstream http://vllm-host:8000
pwsh tools/claude-local/install.ps1 -Name ollama -Upstream http://127.0.0.1:11434 -Model qwen3.5:4b -Context 32768
pwsh tools/claude-local/install.ps1 -Name ollama -Default        # switch the default
```

Ollama rules: pin `-Model` (it lists every pulled model; the model must support tools) and
set `-Context` to the same value as `OLLAMA_CONTEXT_LENGTH` on the Ollama side, because Ollama
never reports it and truncates prompts silently when they exceed it.

A scaffolded project no longer carries `tools/` (init.ps1 removes it), so install from the
skeleton's raw URL instead:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/dxiiren/project-skeleton/main/tools/claude-local/install.ps1))) -Upstream http://vllm-host:8000
```

Pass = the installer ends with `claude-local installed.`, one `[OK] * name -> url` line per
endpoint (the `*` marks the default) and a `[OK]` line per step. A `[WARN] ... not reachable`
line is fine when the VPN is down; the launcher re-checks. Then the developer must **close and reopen the terminal** (new PATH entry and profile function) -
return that as a `DEVELOPER MUST:` line; in this process call the launcher by its full path
(`~/.local/bin/claude-local.cmd`) for Step 3.

---

## Step 3 — Verify with a live run

First the roster, then print mode, which exercises the whole chain (launcher → shim → server →
tool call) without a TUI. Repeat the print-mode run with `-e <name>` for each endpoint that matters:

```powershell
claude-local --list
claude-local -p "Use the Bash tool to run: echo hello-from-local . Then tell me the exact output." --allowedTools "Bash(echo:*)" --output-format json
claude-local -e ollama -p "Use the Bash tool to run: echo hello-from-local . Then tell me the exact output." --allowedTools "Bash(echo:*)" --output-format json
```

Pass = `--list` shows the endpoint `up` with a model and context, and the JSON has
`"is_error":false`, `"num_turns":2` and a result quoting `hello-from-local`. The grey first
line names the endpoint, model, context length and shim URL; a yellow line means the default
was down and the launcher fell back.

Then read the shim log — it is the source of truth for what was sent:

```powershell
Get-Content ~\.claude\local-llm\logs\shim.log -Tail 5
```

A healthy line looks like `POST /v1/messages?beta=true model=... stream=True msgs=2 tools=62 folded_system=1 prompt=27271(129ms) => 200 3285B 4.3s`.

---

## Step 4 — Report back

```
claude-local Setup Complete
================================
Upstream:   {url from config.json}
Model:      {id from the grey launch line}
Context:    {max_model_len} tokens (baseline prompt ~{prompt=N from shim.log})
Shim:       http://127.0.0.1:8098  (pid {logs/shim.pid})

Live run:   claude-local -p ... -> is_error false, tool call round-trip PASS

Next: claude-local   (or: just claudel)
```

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `no endpoint reachable` / `endpoint 'x' ... is unreachable` | The server is down or on the VPN. `claude-local --list` shows which ones answer; `ping` is not a liveness test, `/v1/models` is. |
| `no endpoint configured` | Re-run `install.ps1 -Upstream <url>`, or set `LOCAL_LLM_UPSTREAM` for the shell. |
| Ollama answers but never calls a tool, or "forgets" the system prompt; launcher prints a red `Ollama runs ... with a 4096-token context` line; `shim.log` has a `WARNING ... context_length=4096` | Ollama truncated the prompt to its `num_ctx`. The Windows tray app picks a VRAM-based default (4096) and ignores shell exports and per-request `num_ctx`. Run `[Environment]::SetEnvironmentVariable('OLLAMA_CONTEXT_LENGTH','32768','User')`, restart the Ollama app, and keep the endpoint's `-Context` at the same number. `/api/ps` shows the effective `context_length` once a model is loaded. |
| Ollama answers very slowly | Another model server (a vLLM container) already holds the GPU memory, so Ollama runs on CPU. Stop one of them; an 8 GB laptop GPU fits one at a time. |
| `API Error: 400 ... role ... 'user' or 'assistant'` | Claude Code is talking to vLLM **without** the shim. Check `ANTHROPIC_BASE_URL` is `http://127.0.0.1:8098` in the session (`claude-local` sets it; a stale `claude` alias does not). |
| `The model ... does not exist` (404) | The model id must match `/v1/models` exactly. Clear a stale `model` in `config.json` or `LOCAL_LLM_MODEL`. |
| `Prompt is too long` before you typed anything | The first request already exceeds the server's `max_model_len`: MCP tool schemas dominate (`tools=N` in `shim.log`; 11 servers = 230 tools = ~113k tokens). Relaunch with `claude-local --no-mcp` (drops every MCP server), or pass a small `--mcp-config` to keep one or two, and trim a CLAUDE.md over 40k chars. The real fix is a larger `--max-model-len` on the server. |
| `Context limit reached` right after the first reply | The project's `.claude/settings.json` `env` pins `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (e.g. 100000) for Anthropic's window, which Claude Code reserves out of the small local one. The launcher passes its own caps via `--settings` (outranks project settings); confirm `shim.log` shows `max_tokens` equal to the launcher's cap, not the project's. |
| `shim did not come up` | Read `~\.claude\local-llm\logs\shim.err`. Usually Python missing: `uv python install` or install Python 3. |
| `claude-local` not found after install | New PATH entry / profile function need a **new** terminal. IDE terminals: close all tabs or restart the IDE. |
| The classifier keeps denying actions in auto mode | The local model judges permissions too. Use `claude-local --permission-mode default`. |

---

## Anti-patterns

- **Never** call the endpoint a defect from a truncated tool call — check `finish_reason`
  and `max_tokens` first; a clamped `max_tokens` shows in `shim.log`.
- **Never** point plain `claude` at the local server by exporting `ANTHROPIC_BASE_URL`
  globally — every session would lose Anthropic. The launcher scopes it to one process.
- **Never** commit the server address into the skeleton — it is per machine, in `config.json`.
- **Never** edit `shim.py` in `~\.claude\local-llm\` directly; change `tools/claude-local/`
  in the skeleton and re-run the installer.

---
