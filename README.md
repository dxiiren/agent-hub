<!--
  AUDIENCE - answer this before filling the README, then delete this comment:
  Who will read this README, and what do they need to know first?
    - future you / a portfolio viewer -> what it does, the stack, how to run it, what you learned
    - teammates / new hires           -> setup, architecture, runbooks, who owns what
    - strangers (open source)         -> install, usage, contributing, licence
  Write for that reader and drop the sections they do not need (/ground-project resolves it).
  Adapted from claude-code-templates cli-tool/components/skills/productivity/crafting-effective-readmes
  ("Always ask: Who will read this, and what do they need to know?") at 8b1f883, MIT,
  (c) 2025 Daniel (San) Avila.
-->
# Agent Hub

Agent Hub configures and extends the [Paseo](https://github.com/getpaseo/paseo) agent daemon so that any AI client (Claude Code, Codex, Qoder, OpenCode, Qwen Code) can hand a task to any agent provider (Codex, Qoder, Claude, Qwen Code, an office SGLang server, a laptop llama.cpp server) and get a verdict plus a diff back. It adds provider config templates, a gate plugin (secret scan, diff-size and path check, two-failure return), a usage plugin with an OTel/Prometheus/Grafana stack, a routing table, a laptop pre-flight, and install scripts for Windows and Linux.

> **New developer? Start with [`.docs/tldr.md`](.docs/tldr.md)** — every doc summarised on one
> page. The full guide lives in [`.docs/`](.docs/README.md).

| Paseo web UI: agents and a task | Paseo web UI: diff of a finished task |
| --- | --- |
| ![Paseo web UI: workspace list with two finished demo tasks and the agent reply for the fix-percent task](docs/images/agents.png) | ![Paseo web UI diff view of a finished task: a three-line fix to calc.py](docs/images/task-result.png) |

| `just doctor` | Statusline `hub` line |
| --- | --- |
| ![just doctor output: daemon, MCP and every provider check passing, laptop provider disabled by the GPU guard](docs/images/doctor.png) | ![Claude Code statusline with a second line showing tokens per provider, credits and estimated cost for the session](docs/images/statusline.png) |

| Grafana usage dashboard (demo data) |
| --- |
| ![Grafana dashboard with tokens per provider, model and dev as bars, and a per-day stacked chart by provider](docs/images/grafana-usage.png) |

Screenshots are real captures from a throwaway demo daemon and demo data (the Paseo web UI, `just doctor`, the statusline script and Grafana); site: https://dxiiren.github.io/agent-hub/.

## Prerequisites

| Tool | Version | Installed by |
| --- | --- | --- |
| PowerShell + winget | Windows 10/11 stock | — (the only true prerequisites) |
| Node.js | >= 20 | `setup.ps1` / `setup.sh` |
| Git | any recent | `setup.ps1` / `setup.sh` |
| just | any recent | `setup.ps1` |
| Claude Code CLI | latest | `setup.ps1` (optional, for AI-assisted dev) |

## Quick start

No `just` yet? Run `powershell -ExecutionPolicy Bypass -File install-just.ps1`, open a new
terminal, then `just install` (it runs `setup.ps1`).

```powershell
# 1. One-time machine setup (idempotent — safe to re-run)
pwsh ./setup.ps1

# 2. Close and reopen PowerShell so PATH updates land

# 3. Install dependencies and validate every config template
just deps && just test
```

There is no dev server: `just test` exiting 0 means every config template parses and holds placeholders only. Linux and macOS use `sh ./setup.sh` (or `just install`) instead of step 1.

## Benchmarks

Measured 5 November 2026 through the installed hub: each task runs in a throwaway worktree and is judged by its own gate (never by the agent's say-so). Set A = 7 easy edits, set B = 10 hard code edits, set C = 3 tasks (log summary, test scaffold that must kill 3 mutants, code review). Latest version of each model is shown; most cells are n=1 or 2, so one task of difference is noise. Full method, per-tier Qoder credits, harness comparison and history are in the [guide](https://dxiiren.github.io/agent-hub/#bench).

Performance = 0.5·B + 0.2·A + 0.2·C + 0.1·Speed (A, B, C = pass rates; Speed = fastest median in this table / this row median, so the fastest row gets 1.0; a row with no set B result shows pending (needs B) and sorts last; if B exists but A or C was not run, that set drops out, the other weights are rescaled and the cell is marked with an asterisk). Sorted by Performance, highest first, ties by set B. Partial rows count the cells done so far and are marked (partial).

| Model | Harness | Set A (7) | Set B (10) | Set C (3) | Median s | Performance |
|---|---|---|---|---|---|---|
| Codex gpt-6.1-sol | Codex | 7/7 | 10/10 | 3/3 | 82 | 0.98 |
| Qoder Kimi-K3.1-Pro | Qoder | 7/7 | 9/10 | 3/3 | 87 | 0.92 |
| Claude Sonnet 5.5 | Claude | 5/7 | 10/10 | 3/3 | 80 | 0.92 |
| Claude Haiku 5.5 | Claude | 7/7 | 9/10 | 3/3 | 92 | 0.92 |
| Codex gpt-6-astra * | Codex | 6/7 | 10/10 | 3/3 | 136 | 0.92 |
| Qoder GLM-5.3 | Qoder | 6/7 | 9/10 | 3/3 | 70 | 0.91 |
| Qoder DeepSeek-Flash | Qoder | 7/7 | 10/10 | 2/3 | 83 | 0.91 |
| Qoder Fast | Qoder | 6/7 | 10/10 | 2/3 | 64 | 0.90 |
| Codex gpt-6.1-terra | Codex | 6/7 | 10/10 | 2/3 | 67 | 0.90 |
| Claude Opus 5.5 | Claude | 6/7 | 10/10 | 2/3 | 70 | 0.90 |
| Qoder Efficient | Qoder | 7/7 | 10/10 | 2/3 | 179 | 0.87 |
| Codex gpt-6-luna | Codex | 5/7 | 8/10 | 3/3 | 73 | 0.83 |
| Qwen3.8-27B-NVFP (2-node cluster) | Qwen Code | 6/7 | 9/10 | 2/3 | 109 | 0.81 |
| Qoder Qwen3.8-Flash | Qoder | 7/7 | 8/10 | 2/3 | 99 | 0.80 |
| Qoder MiniMax-M3.1-Flash | Qoder | 7/7 | 6/10 | 3/3 | 143 | 0.74 |
| Qwen3.8-27B (single GPU) | Qwen Code | 7/7 | 7/10 | 2/3 | 115 | 0.74 |
| Qoder Qwen3.8-Max | Qoder | 6/7 | 5/10 | 3/3 | 220 | 0.65 |
| Qwen3.5-9B laptop, 64k | Qwen Code | 6/7 | 4/10 | 3/3 | 125 | 0.62 |
| Qoder GLM-5.3-Flash | Qoder | 7/7 | 3/10 | 3/3 | 132 | 0.60 |
| Qoder DeepSeek-V4-Pro | Qoder | 6/7 | 4/10 | 2/3 | 132 | 0.55 |
| Qwen3.5-9B laptop, 32k (default) | Qwen Code | 7/7 | 1/10 | 3/3 | 76 | 0.53 |
| Qwen3.5-9B laptop, 64k | OpenCode | 7/7 | 1/10 | 3/3 | 101 | 0.51 |
| Qwen3.5-9B laptop, 32k | OpenCode | 4/7 | 0/10 | 1/3 | 625 | 0.19 |

* Benchmark only; not in routing unless the owner approves.

### Qoder tiers (qodercli 1.1.81)

Performance = 0.5·B + 0.2·A + 0.2·C + 0.1·Speed (A, B, C = pass rates; Speed = fastest median in this table / this row median, so the fastest row gets 1.0; a row with no set B result shows pending (needs B) and sorts last; if B exists but A or C was not run, that set drops out, the other weights are rescaled and the cell is marked with an asterisk). Sorted by Performance, highest first, ties by set B, then credits per task (cheaper first). Partial rows count the cells done so far and are marked (partial).

| Qoder tier | Set A (7) | Set B (10) | Set C (3) | Median s | Performance | Credit multiplier | Credits charged per task |
|---|---|---|---|---|---|---|---|
| Kimi-K3.1-Pro | 7/7 | 9/10 | 3/3 | 87 | 0.92 | 1.00x | 7.22 |
| GLM-5.3 | 6/7 | 9/10 | 3/3 | 70 | 0.91 | 0.80x | 8.34 |
| DeepSeek-Flash | 7/7 | 10/10 | 2/3 | 83 | 0.91 | 0.10x | 0.59 |
| Fast | 6/7 | 10/10 | 2/3 | 64 | 0.90 | 0.80x | 5.63 |
| Efficient | 7/7 | 10/10 | 2/3 | 179 | 0.87 | 0.00x | 0.00 (records ~0.74) |
| Qwen3.8-Flash | 7/7 | 8/10 | 2/3 | 99 | 0.80 | 0.10x | 0.78 |
| MiniMax-M3.1-Flash | 7/7 | 6/10 | 3/3 | 143 | 0.74 | 0.10x | 1.54 |
| Qwen3.8-Max | 6/7 | 5/10 | 3/3 | 220 | 0.65 | 0.50x | 14.22 |
| GLM-5.3-Flash | 7/7 | 3/10 | 3/3 | 132 | 0.60 | 0.10x | 0.63 |
| DeepSeek-V4-Pro | 6/7 | 4/10 | 2/3 | 132 | 0.55 | 0.50x | 2.93 |

Credits charged per task: verified against Qoder billing 05-11: charged = recorded for paid tiers (the multiplier is already in the recorded number); Efficient records ~0.34 but is not charged. Credit multiplier: the "x Credit" label of each model in the qodercli 1.1.81 ACP model list. Set A: "running (k of 7 done)" or "pending" means not finished; nothing is estimated. Claude cost per task: Sonnet $0.235, Opus $0.530, Haiku $0.020 (from the set B/C runs); other cells are flat rate or local.

Superseded versions (Codex gpt-6-sol, gpt-5.6 family) are in the guide under History. The hub's own overhead was measured too: after hashing the daemon password at bcrypt cost 4, ten parallel MCP clients drop from a 15.5 s to a 4.7 s median per task (details in the guide).

## Changes 05-11

- **Plugin hooks no longer block.** The gate plugin runs in the background and skips agents that are gone; the usage plugin no longer awaits the Qoder poller in the turn-before hook and polls the account only when the session transcript has no credits. Hooks now stay inside Paseo's 30 s RPC limit (2ebfef6).
- **OTLP 5 s timeout.** MCP and OTLP calls from the usage plugin time out after 5 s, and an OTLP outage is logged once instead of on every turn.
- **Usage stack starts itself.** Docker Desktop and the usage stack (collector, Prometheus, Grafana) come up on logon and on `just up`; `just doctor` now fails when the collector, Prometheus or Grafana is down (f8c7519).
- **Qoder pinned to 1.1.81.** The hub uses qodercli 1.1.81 with a private config directory, because 1.1.83 ignores the tier model over ACP (served `auto`, no credits). Benchmarks check the pin before every cell.
- **Daemon password hash at bcrypt cost 4.** The daemon bcrypt-checked the bearer token on every MCP request inside its single event loop; at cost 4 MCP calls stop saturating it.
- **Laptop server fixes.** `--cache-ram 0` (the host prompt cache had grown llama-server to 3.5 GB of RAM) and the launcher never starts a second server while one is still loading.
- **Routing order.** Codex, then Claude, then Qoder Efficient (free, 10/10 on set B), then DeepSeek-Flash, then the office Qwen3.8-27B-NVFP cluster, then the single-GPU Qwen3.8-27B. Qoder Efficient is free: charged 0.00 credits per task (it records about 0.7).
- **Laptop context 64k.** The laptop model now defaults to a 64k context (`LAPTOP_CTX=32768` goes back): Qwen Code passes 4/10 hard edits at 64k against 1/10 at 32k, and the whole 8 GB card peaks at 7.5 GB with every layer on the GPU. OpenCode was worse at both sizes (1/10 at 64k, 0/10 at 32k).
- **Benchmark refreshed.** Tables are A | B | C with a Performance column (0.5B + 0.2A + 0.2C + 0.1Speed), click-to-sort including Name, and the final laptop grid (Qwen Code and OpenCode at 32k and 64k).

<!-- slots:start -->
### Concurrency / slots

To be refreshed with the acceptance run (retry on `DAEMON_UNREACHABLE` and the measured slot numbers per provider).
<!-- slots:end -->

## Commands

Run `just` with no arguments to list every recipe. The ones you'll use daily:

| Command | What it does |
| --- | --- |
| `just install` | Install the toolchain (runs `setup.ps1` / `setup.sh`) |
| `just deps` | Install the npm dependencies |
| `just test` | Validate every config template (`scripts/check-config.mjs`) |
| `just lint` | Same config check (no code to lint yet) |
| `just build` | Same config check (plugins land per `tasks.md`) |
| `just scan` | Scan tracked files for internal hosts, paths and secrets before any push |
| `just claudex` | Launch Claude Code (Sonnet, all permissions) |
| `just claudeo` / `just claudeh` | Same, on Opus / Haiku |

## Security

Full-access, bypass and yolo modes are used only with `--new-workspace worktree` (a throwaway worktree); `route.mjs` drops them otherwise. The daemon password lives in `<paseo home>/agent-hub-secret` and is never put in the environment agents inherit.

**Latest aliases.** A route entry may name `codex/latest`, `codex/latest-sol|terra|luna`, `claude/latest-opus|sonnet|haiku` `qoder/<tier>@latest`, `qoder/latest-<family>` or `opencode/office@latest` instead of a pinned model. `route.mjs` resolves it at dispatch to the highest version the provider lists (Codex: `~/.codex/models_cache.json`, version-sorted, `astra` never chosen, a family without the newest version falls back to the newest overall for `codex/latest`; Claude and Qoder: `paseo provider models`), cached 10 min. `node plugins/routing/route.mjs --resolve <alias>` prints the mapping now; `just doctor` lists resolved aliases and warns about pinned older models. **Qoder** versions: tiers are matched on their display name, so `qoder/latest-<family>` (e.g. `latest-qwen-max`, `latest-deepseek-pro`, `latest-kimi-pro`) picks the highest version in that family and `qoder/<tier>@latest` moves an older versioned tier up to it (unversioned tiers such as `efficient` just must still be listed). **Office Qwen and the laptop model** are not pinned: `deploy/office/office-agent.mjs` (qwen-code, qwen-code-2) and `laptop-agent.mjs` read the served id from `GET <base>/v1/models` at spawn (cached 10 min; the configured model is only the fallback), and `opencode/office@latest` points the opencode config at the served id. **Tools:** `just doctor` lists every CLI's installed vs latest published version (npm view) and the laptop GGUF with its date; `just update` updates the ones behind, Paseo only with `just update --paseo`. Nothing updates or downloads by itself.

## Troubleshooting

### The Paseo UI: use the local page, not app.paseo.sh

`just configure` turns on the daemon's own web UI: open `http://127.0.0.1:6767/` (Direct connection, host `127.0.0.1`, port `6767`, the password in `<paseo home>/agent-hub-secret`). The hosted app at app.paseo.sh cannot connect: the daemon answers its WebSocket with `403 Origin not allowed` unless `daemon.cors.allowedOrigins` lists it, and Chrome blocks the call to localhost behind a local-network prompt. Restart the daemon after the first `configure`.

### `route.mjs ... --new-workspace worktree` seems to hang

Creating the agent can take 2+ minutes while the daemon is saturated or a provider stalls at its ACP `initialize` (upstream Paseo: `agent.create.request` shows in `daemon.log` as `ws_slow_request`; not specific to worktrees). `route.mjs` now creates with `--no-wait`, bounds the create call (`AGENT_HUB_CREATE_TIMEOUT_S`, default 240) and returns `CREATE_TIMEOUT: ...` instead of hanging 15 minutes; it does not retry that error. A late agent may still appear in `paseo ls`; stop it by id.

### A task ends as `permission`

Edit task types (`code-edit`, `test-scaffold`) outside `--new-workspace worktree` run without their full-access mode and wait for a permission nobody answers; the trace now says so. Use `--new-workspace worktree`, or a read-only type (`summarise`, `review`), which run in the provider default mode and fail if they changed files in the folder (list: `readOnlyTypes` in the routes file).

### `just: command not found` right after setup

PATH updates only land in a new shell. Close and reopen PowerShell, or run `powershell -ExecutionPolicy Bypass -File install-just.ps1` first.

### `just test` fails with a config error

`scripts/check-config.mjs` reports the template and the key. Templates must be valid JSON and contain only `<PLACEHOLDER>` values, never real hosts or secrets; fix the file and re-run.

### `just scan` flags a file

The scan blocks internal host names, private IPs, personal paths and secrets. Replace the value with a placeholder such as `<OFFICE_QWEN_URL>`.

More in [`.docs/06-troubleshooting/common-issues.md`](.docs/06-troubleshooting/common-issues.md).

## Project layout

```
agent-hub/
├── config/              JSON templates with <PLACEHOLDERS> (daemon config, MCP clients, routes, claude-clean settings)
├── scripts/             check-config.mjs (validates every template), scan.mjs (internal host/path/secret scan)
├── plugins/             gate and usage plugins (land per specs/001-agent-hub/tasks.md)
├── deploy/
│   ├── laptop/          laptop pre-flight and llama.cpp server setup
│   ├── usage/           OTel / Prometheus / Grafana stack
│   └── server/          server-side install
├── ci/                  CI workflow files
├── specs/001-agent-hub/ spec-kit: spec.md, plan.md, tasks.md
├── .specify/            spec-kit templates and scripts
├── .docs/               developer docs (start at tldr.md)
├── .claude/             Claude Code kit (skills, agents, hooks, settings)
├── justfile             daily recipes (Windows PowerShell and Linux sh)
├── setup.ps1 / setup.sh toolchain install (Windows / Linux)
├── package.json         Node >=20, ESM; test/lint/build/scan scripts
├── LICENSE / NOTICE     Apache-2.0; NOTICE credits Paseo
└── README.md / CLAUDE.md
```

## License

Apache-2.0, see [LICENSE](LICENSE). [NOTICE](NOTICE) credits Paseo, the agent daemon this repo configures and extends.
