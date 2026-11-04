# Spec 001: agent-hub

Status: draft v1 (sanitised for the public repo). Hosts, URLs and credentials appear only as placeholders such as `<OFFICE_QWEN_URL>`, `<LAPTOP_LLAMA_URL>`, `<GITEA_URL>`.

## 1. Problem

A team runs several AI coding agents (Claude Code, Codex, Qoder, OpenCode, Qwen Code) and several model backends (subscription CLIs, an office GPU server, a laptop model). Today a Claude session sits in the middle of every delegated task, which costs tokens and ties delegation to one client. Usage is scattered, and nobody sees tokens or credits per model in one place.

## 2. Goal

Any AI client hands a task to any agent provider through one daemon and gets a short verdict plus a diff back, with a gate on the result and one usage view. Nothing in the glue is specific to one client.

## 3. Requirements

- R1. Laptop model: it loads 100% on the GPU (the model plus a 32k KV cache fit in 8 GB of VRAM, no CPU or RAM offload).
- R2. The laptop model is a real agent backend (driven by Qwen Code), not only a summary fallback.
- R3. Teammates use the same system. The repo is published, and each user configures their own `codex`, `qodercli`, `claude` or other CLI logins.
- R4. Adopt an existing tool instead of inventing one. Forking a close fit is allowed. v1 is a thin layer on the Paseo daemon: plugins, config and scripts, zero core diff.
- R5. Any client can drive it, two doors: the MCP door (daemon `/mcp/agents`) and the CLI door (`paseo run`, `wait`, `logs`).
- R6. The Claude lead in the middle goes: a client dispatches straight to a provider.
- R7. Process is spec-kit: `specs/<id>/` with spec, plan and tasks, approved per file.
- R8. One usage view (section 4, D10-D13) shows tokens per model across every agent and provider, and credits where a provider bills in credits.
- R9. Runs per developer on a laptop, and later on one shared server with a container per developer behind a login proxy.
- R10. Works on Windows and Linux (install scripts for both).
- R11. Data rule: customer data may go to any configured provider; credentials never go into a prompt. A secret scan enforces it on the daemon side.
- R12. Security: the daemon binds to loopback and goes remote only with a password. Full-access mode runs only inside a throwaway git worktree. Our tools never call a provider's admin endpoint.

## 4. Decisions (numbered, final for v1)

- D1. Base tool: Paseo (Apache-2.0). Repo name `agent-hub` (the Paseo trademark is not used). Public on GitHub, mirrored privately to the team forge.
- D2. Repo shape: scaffolded from the team skeleton (`setup.ps1`, `justfile` with `just install`, README, numbered `.docs/`, `.claude/` kit) plus a Linux `setup.sh`.
- D3. Laptop stack: llama.cpp `llama-server` plus Qwen Code, Qwen3.5-9B UD-Q4_K_XL, q8_0 KV, 32k context. A pre-flight refuses the launch when the GPU is not visible, a heavy-run lock exists, or available RAM is under 3 GB. OpenCode is a second harness on the same server.
- D4. Office model: a SGLang server (`<OFFICE_QWEN_URL>`) reached through Qwen Code over ACP with the OpenAI environment; a second route extends the Codex provider with `OPENAI_BASE_URL` (needs `/v1/responses`).
- D5. Providers: Codex (model chosen per task type), Claude (clean config), Qoder (`qodercli --acp`), Qwen Code (ACP, per-user auth), OpenCode (`OPENCODE_DISABLE_MODELS_FETCH=1` and its own config), laptop model, office model.
- D6. Routing: one small file maps task type to a default provider and model; the caller can override per task; a busy or failed default moves to the next entry. Defaults come from a bench on two task sets.
- D7. Gate: the caller supplies it; otherwise the repo default from the routing file runs, plus a secret scan and a diff-size and path check. Two failures and the task goes back to the caller. It is a plugin on the daemon hook `agent.turn.after` (a notification, so a follow-up, not a veto).
- D8. Verdict: at most 10 lines, with the diff stat, stored in agent labels. MCP clients poll `get_agent_status` and read the labels; CLI users use `paseo wait`.
- D9. Forge: branch checkout works; PR checkout is not supported upstream for Gitea or Forgejo. The gate plugin pushes the branch and runs `tea pr create` itself; each developer runs `tea login add` once.
- D10. Usage stack: OTel collector on each laptop (allow-list only, strips `user.email`), Prometheus, Grafana. Counts only, never prompts. Rows are tagged with provider, model, developer, day and calling client. Everyone sees everyone.
- D11. Usage sources: Claude Code, Codex and Qwen Code over OTLP (Qwen Code metrics only, prompt logging off); OpenCode through an export poller; Qoder through a credits poller; SGLang and llama-server through `/metrics`. A source with neither tokens nor credits is listed "not captured".
- D12. Subscription limit percentages (5-hour and weekly) stay in the existing usage monitor and are shown next to the tokens.
- D13. Slot use per provider is a dashboard panel with no numeric target.
- D14. Statusline feed: every task carries the caller's session id; the daemon exposes per-session usage per provider (tokens, credits, estimated cost) through a fast local read path (append-only local file or `GET /usage?session=<id>`), never a Grafana query, so a status line with a 60 ms budget can use it.
- D15. Shared server: one daemon per developer in its own container (own logins), behind a login proxy. True in-process multi-user is deferred.
- D16. Install: `install.ps1` (Task Scheduler) and `install.sh` (systemd), with no-sleep, password, config template, `tea login`, pinned versions of the daemon and CLIs, and a `doctor` command.
- D17. Upkeep: a rebase job per daemon release runs the 5x5 matrix and opens a PR for human approval. Plugin ranges are pinned with `requirements.paseo`.
- D18. Privacy of the spec: this public spec uses placeholders; the full internal plan stays private.
- D19. Build order: W0 first and alone, then every piece in parallel (one agent per piece), merged in one batch.

## 5. Out of scope for v1

Plugin tools visible to top-level MCP callers (optional, needs a one-line upstream patch). In-process multi-user. Any proxy that sits in front of subscription CLIs (it breaks their login).

## 6. Acceptance (the done-bar; all four must hold)

- A1. 5x5 matrix: each of the five clients sends one task to a different provider through the daemon and gets verdict plus diff back; every client works at least once. Scripted, raw results saved.
- A2. Gate pass: the 7 laptop tasks pass 7/7 and the 10-task code-edit set passes at least 9/10, both through the daemon; one try each.
- A3. Delegation cost: Claude cost per delegated task is at or below the baseline of the previous setup, with zero Claude-lead tokens. Measured as total cost including cache reads, on the same tasks.
- A4. Usage view: live for every source, each source live or listed "not captured", shown by a dashboard screenshot plus a per-source check.

Every number comes from a run on the exact commit, with raw lines and screenshots in the PR body. After all four hold, run 7 days stable before the old pool is removed.
