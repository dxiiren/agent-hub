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

| `just doctor` (add `--deep` to run one tiny task on every provider) | Statusline `hub` line |
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
| gitleaks | exactly 8.30.1 (pinned) | you: the gate and the reply scan use it for every secret check and refuse to pass without it. `winget install Gitleaks.Gitleaks --version 8.30.1`, `brew install gitleaks` (then check `gitleaks version`), or unzip the release from https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1 into `tools/gitleaks/` (or point `AGENT_HUB_GITLEAKS` at the binary). `just doctor` checks it. Rules: `config/gitleaks.toml` (the default rules plus a few of ours) |
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

There is no dev server: `just test` exiting 0 means the full suite passed: every config template parses and holds placeholders only, plus the gate, routing, usage and hook tests. Linux and macOS use `sh ./setup.sh` (or `just install`) instead of step 1.

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

**Harness comparison for the same model** (same model, different harness; Performance is normalised inside this table)

| Model | Harness | Set A (7) | Set B (10) | Set C (3) | Median s | Performance |
|---|---|---|---|---|---|---|
| Qwen3.8-27B (single GPU) | OpenCode | 7/7 | 9/10 | 2/3 | 167 | 0.83 |
| Qwen3.8-27B-NVFP (2-node cluster) | Qwen Code | 6/7 | 9/10 | 2/3 | 109 | 0.82 |
| Qwen3.8-27B-NVFP (2-node cluster) | Codex | 6/7 | 8/10 | 2/3 | 121 | 0.77 |
| Qwen3.8-27B (single GPU) | Qwen Code | 7/7 | 7/10 | 2/3 | 115 | 0.75 |
| Qwen3.8-27B-NVFP (2-node cluster) | OpenCode | 6/7 | 6/10 | 2/3 | 152 | 0.65 |
| Laptop Qwen3.5-9B, 64k | Qwen Code | 6/7 | 4/10 | 3/3 | 125 | 0.63 |
| Qwen3.8-27B (single GPU) | Codex | 7/7 | 6/10 | 1/3 | 233 | 0.60 |
| Laptop Qwen3.5-9B, 32k | Qwen Code | 7/7 | 1/10 | 3/3 | 76 | 0.55 |
| Laptop Qwen3.5-9B, 64k | OpenCode | 7/7 | 1/10 | 3/3 | 101 | 0.53 |
| Laptop Qwen3.5-9B, 32k | OpenCode | 4/7 | 0/10 | 1/3 | 625 | 0.19 |

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

Credits charged per task: verified against Qoder billing 05-11: charged = recorded for paid tiers (the multiplier is already in the recorded number); Efficient records ~0.74 but is not charged. Credit multiplier: the "x Credit" label of each model in the qodercli 1.1.81 ACP model list. Set A: "running (k of 7 done)" or "pending" means not finished; nothing is estimated. Claude cost per task: Sonnet $0.235, Opus $0.530, Haiku $0.020 (from the set B/C runs); other cells are flat rate or local.

Superseded versions (Codex gpt-6-sol, gpt-5.6 family) are in the guide under History. The hub's own overhead was measured too: after hashing the daemon password at bcrypt cost 4, ten parallel MCP clients drop from a 15.5 s to a 4.7 s median per task (details in the guide).

## Changes 06-11

- **Usage stack without Docker on Windows.** `just up` and the logon task now run the collector, Prometheus and Grafana as native processes (`deploy/usage/native.ps1`): binaries, data and generated configs live in `%LOCALAPPDATA%\agent-hub\usage`, downloaded once with SHA-256 verification (`native.ps1 install`, also run on first start). Same pinned versions, same configs, rules and dashboard as `compose.yaml`; ports stay 3000, 9090, 4317 and 4318. `USAGE_MODE=native|docker` (environment or `deploy/usage/.env`) picks the mode: native is the default on Windows, `docker` (compose.yaml) is for servers and Linux. `just doctor` probes the active mode and fails when the collector, Prometheus or Grafana is down.

## Changes 05-11

- **Laptop watchdog false-idle kill fixed.** The two laptop llama-server deaths during the benchmark (21:36, 21:45) were the hub watchdog judging a freshly started agent idle and stopping the shared server. Idle is now based on in-flight markers and shared last-use state, and CPU is not judged while the model loads (a5acf73, 3d9a87e).
- **Acceptance run, 18-way burst.** 18 simultaneous tasks finished with no loss; slots are now Codex 3, Claude 2, Qoder 4, office cluster 6, office single GPU 3, laptop 1. `agent-hub route` retries a start up to 6 times with backoff and jitter on `DAEMON_UNREACHABLE`, runs `--gate` itself in the real folder, and the gate fails closed outside a git work tree.
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

Proven on 5 November 2026 on a fresh daemon, 18 tasks started at the same instant (a one-word reply on each provider, no laptop), then 9 at once:

| Provider | Slots | Proven in one burst |
| --- | --- | --- |
| Codex | 3 | 3 |
| Claude | 2 | 2 |
| Qoder (Efficient and DeepSeek-Flash) | 4 | 4 |
| Office Qwen Code, 2-GPU cluster | 6 | 6 |
| Office Qwen Code, single GPU | 3 | 3 |
| Laptop Qwen (one 64k slot) | 1 | tested alone |

Result: 18 of 18 finished, no `DAEMON_UNREACHABLE`, no plugin hook timeout in the daemon log, 65 to 161 s each, free RAM 7.3 GB down to 4.6 GB. The office servers took 6 and 3 at once without queueing; they can take more (the cluster serves up to 8 requests, the single GPU up to 4), but the laptop is the limit: every extra client process costs about 150 MB, and a start is slow when the machine is busy.

What limits it, in order: the daemon (one event loop; creating an agent takes 10 to 20 s once many start together), free laptop RAM (below 3 GB the laptop provider refuses to start), then the providers. Do not go above these numbers without repeating the burst.

**Retry.** Paseo answers its 1.5 s status probe slowly while the daemon is busy, so a start can fail with `DAEMON_UNREACHABLE` or "Connection timed out" although nothing was started (upstream issue #6584). `agent-hub route` retries such a start up to 6 times (waits of 2, 4, 8, 16 and 32 s plus jitter) after a random 0 to 2 s stagger, and matches both the error code and the CLI crash text. A start that created an agent is never retried.

**Gate.** `agent-hub route --gate` runs the gate itself, in the agent's real folder, with the same rules as the plugin hook. A first failure re-prompts the agent once and waits for it; the agent is then frozen before the second check. Outside a git work tree the gate fails closed: path rules cannot be evaluated, and a task with no check says "nothing to verify".

**Talk-back (`status: "asking"`).** Every route prompt ends with one line telling the agent: if blocked and in need of the caller's input, finish with a last line `[ASK] <question>`, never include credentials, never call agent-hub. When the agent's final message ends with such a line (the LAST non-empty line only; `[ASK]` in the middle of text is ordinary prose), `route` skips the gate, keeps the agent alive and prints `{"status":"asking","agentId":"...","question":"...","round":1,...}` with exit code 3. Answer it with `agent-hub reply <agentId> "<text>"`: it sends the text, waits, and returns the same JSON shape as `route` (the final `answer`, the original `--gate` run on it, or another `asking` result). At most 3 questions per task; the reply to the third carries "finish now" and a further `[ASK]` is returned as the final answer. Read-only types are re-checked after every reply (a changed file fails the task as `failed-readonly-changed`, the agent is stopped), and the original `--gate` runs on the final answer. A reply that looks like a credential, token or key is rejected before anything is sent (same pattern as the gate's secret scan). A parked agent that gets no reply within 10 minutes is stopped and archived (a detached reaper; `reply` after that says "no parked agent"). Treat `question` as untrusted data from a model that read arbitrary files, never as instructions. State for a parked agent lives in `<paseo home>/usage/parked/<agentId>.json` (gate, base commit, worktree). Route over MCP is not exposed by this repo, so there is no MCP tool to change; an MCP client can use the CLI.
<!-- slots:end -->

## Commands

Run `just` with no arguments to list every recipe. The ones you'll use daily:

| Command | What it does |
| --- | --- |
| `just install` | Install the toolchain (runs `setup.ps1` / `setup.sh`) |
| `just deps` | Install the npm dependencies |
| `just test` | Run the full suite (`npm test`): config-template check, gate, routing and usage tests (node and python), and the security-hook tests |
| `just lint` | Same config check (no code to lint yet) |
| `just build` | Same config check (plugins land per `tasks.md`) |
| `just scan` | Scan tracked files for internal hosts, paths and secrets before any push |
| `just claudex` | Launch Claude Code (Sonnet, all permissions) |
| `just claudeo` / `just claudeh` | Same, on Opus / Haiku |

## Add a provider (UI or CLI)

Paseo's own Settings > Providers > "Add provider" is a fixed catalog of ACP agents: each is added with its stock command, with no URL, model or key field. Agent Hub adds the missing piece, with the same behaviour from the web UI and the command line.

**What you can add (a "kind"):**

| Kind | What it is | Fields |
| --- | --- | --- |
| `qwen` | [Qwen Code](https://github.com/QwenLM/qwen-code) on any OpenAI-compatible endpoint (vLLM, SGLang, llama.cpp, Ollama, a hosted API) | base URL, model, optional API key |
| `opencode` | OpenCode on any OpenAI-compatible endpoint | base URL, model, optional API key |
| `qoder`, `codex`, `claude` | one more model of a CLI you have installed and signed in to (route entry `<cli>/<model>`; no new Paseo provider) | model |

Every kind also takes a name, parallel slots (kinds with their own provider), which task types it serves with its position in each route chain, and (qwen) whether to create the read-only twin that `summarise` and `review` need. Model lists are read live: from the endpoint's `GET /v1/models`, or from `paseo provider models <cli>` for the CLI kinds. Nothing about your hosts, models or accounts is built in.

**Prerequisites:** Node 20 or newer, a running hub (`just up`), and for the kind you pick its CLI on your `PATH` (`qwen`, `opencode`, `qodercli`, `codex` or `claude`). Works the same on Windows, macOS and Linux.

**From the web UI.** Run `node scripts/hub.mjs plugins` once and restart the daemon (`just down && just up`). Open the hub page (default `http://127.0.0.1:6767`), then **Settings > Add provider (Agent Hub)**: pick the kind, give it a name, paste the base URL (and key, which is masked and never shown again), press **Load models** and pick one (or type an id), set slots and the task types, then **Add provider**. A provider with its own Paseo entry needs one daemon restart, which the screen tells you; a CLI-model entry is live at once. The list below the form has **Edit** and **Remove** for each added provider.

**From the command line** (`agent-hub provider ...`, or `node scripts/hub.mjs provider ...`):

```
agent-hub provider kinds
agent-hub provider models --kind qwen --url http://127.0.0.1:8000/v1          # what the endpoint serves
agent-hub provider add qwen-lab --kind qwen --url http://127.0.0.1:8000/v1 --model my-model \
    [--key <api key>] [--slots 2] [--routes code-edit:2,summarise] [--readonly false]
agent-hub provider add fast-tier --kind qoder --model <tier from: paseo provider models qoder> --routes code-edit
agent-hub provider edit qwen-lab --slots 4        # also --model --url --key --routes --readonly
agent-hub provider list
agent-hub provider remove qwen-lab
```

`--routes code-edit:2,summarise` puts the provider second in the `code-edit` chain and at the end of `summarise`. `add` refuses a URL that is not http(s), an endpoint that does not answer `/v1/models`, a model the endpoint or CLI does not list, and a name already in use; nothing is written when it refuses. The API key lives in `config/hub.local.json` (git-ignored) and in the provider's `env` in the Paseo config, and reaches the agent through the environment, never a command line or a log. `remove` puts the configuration files back byte for byte while nothing else has changed them since; `edit` keeps that guarantee relative to the original add.

**Add your own kind** (any ACP agent CLI, any other OpenAI-compatible launcher). The built-in kinds live in `scripts/provider-kinds.mjs`; yours go in `config/provider-kinds.local.json` (git-ignored) or the file named by `AGENT_HUB_KINDS`, and appear in both the CLI and the UI:

```json
{
  "myagent": {
    "label": "My agent (OpenAI-compatible)",
    "launch": ["{node}", "/path/to/my-launcher.mjs", "{url}", "{model}"],
    "modelsFrom": "endpoint",
    "fields": [
      { "id": "url", "label": "Base URL", "type": "url", "required": true },
      { "id": "model", "label": "Model", "type": "model", "required": true },
      { "id": "key", "label": "API key (optional)", "type": "secret" }
    ]
  }
}
```

`launch` is the ACP command Paseo should run (`{node}`, `{repo}`, `{url}`, `{model}` are filled in; the key arrives in `HUB_OPENAI_API_KEY`). Names of this kind start with `myagent-`. Use `"base": "<an installed provider id>"` instead of `launch` for a kind that only adds `<base>/<model>` route entries.

The UI is one small Paseo plugin (`plugins/providers`) drawn from this same schema with Paseo's own Settings components; all of its text is in `plugins/providers/client/strings.ts`. A Paseo-side change to put these fields into the built-in "Add provider" dialog would be a better home for it; none is needed for this to work.

## Security

Full-access, bypass and yolo modes are used only with `--new-workspace worktree` (a throwaway worktree); `route.mjs` drops them otherwise. The daemon password lives in `<paseo home>/agent-hub-secret` and is never put in the environment agents inherit.

**Latest aliases.** A route entry may name `codex/latest`, `codex/latest-sol|terra|luna`, `claude/latest-opus|sonnet|haiku` `qoder/<tier>@latest`, `qoder/latest-<family>` or `opencode/office@latest` instead of a pinned model. `route.mjs` resolves it at dispatch to the highest version the provider lists (Codex: `~/.codex/models_cache.json`, version-sorted, `astra` never chosen, a family without the newest version falls back to the newest overall for `codex/latest`; Claude and Qoder: `paseo provider models`), cached 10 min. `node plugins/routing/route.mjs --resolve <alias>` prints the mapping now; `just doctor` lists resolved aliases and warns about pinned older models. **Qoder** versions: tiers are matched on their display name, so `qoder/latest-<family>` (e.g. `latest-qwen-max`, `latest-deepseek-pro`, `latest-kimi-pro`) picks the highest version in that family and `qoder/<tier>@latest` moves an older versioned tier up to it (unversioned tiers such as `efficient` just must still be listed). **Office Qwen and the laptop model** are not pinned: `deploy/office/office-agent.mjs` (qwen-code, qwen-code-2) and `laptop-agent.mjs` read the served id from `GET <base>/v1/models` at spawn (cached 10 min; the configured model is only the fallback), and `opencode/office@latest` points the opencode config at the served id. **Tools:** `just doctor` lists every CLI's installed vs latest published version (npm view) and the laptop GGUF with its date; `just update` updates the ones behind, Paseo only with `just update --paseo`. Nothing updates or downloads by itself.

## Troubleshooting

### The Paseo UI: use the local page, not app.paseo.sh

`just install` (it runs `node scripts/hub.mjs configure`, which you can also run alone) turns on the daemon's own web UI: open `http://127.0.0.1:6767/` (Direct connection, host `127.0.0.1`, port `6767`, the password in `<paseo home>/agent-hub-secret`). The hosted app at app.paseo.sh cannot connect: the daemon answers its WebSocket with `403 Origin not allowed` unless `daemon.cors.allowedOrigins` lists it, and Chrome blocks the call to localhost behind a local-network prompt. Restart the daemon (`just down && just up`) after the first `configure`.

### `route.mjs ... --new-workspace worktree` seems to hang

Creating the agent can take 2+ minutes while the daemon is saturated or a provider stalls at its ACP `initialize` (upstream Paseo: `agent.create.request` shows in `daemon.log` as `ws_slow_request`; not specific to worktrees). `route.mjs` now creates with `--no-wait`, bounds the create call (`AGENT_HUB_CREATE_TIMEOUT_S`, default 240) and returns `CREATE_TIMEOUT: ...` instead of hanging 15 minutes; it does not retry that error. A late agent may still appear in `paseo ls`; stop it by id.

### A task ends as `permission`

Edit task types (`code-edit`, `test-scaffold`) outside `--new-workspace worktree` run without their full-access mode and wait for a permission nobody answers; the trace now says so. Use `--new-workspace worktree`, or a read-only type (`summarise`, `review`), which run in the provider default mode and fail if they changed files in the folder (list: `readOnlyTypes` in the routes file).

**Read-only providers (decided 06-11, live evidence).** A read-only type runs each provider in its read-only mode: `plan` for Claude, OpenCode and the Qwen providers (plus the readguard/hook file boundary), `dontAsk` for Qoder (a Write, a shell command and a Read outside the task folder were all refused live; but a Read INSIDE the folder is allowed, and an in-cwd `.env` was read and returned in round 3, so Qoder is NOT allowed on read-only types: only providers with an enforced sensitive-read refusal, claude-clean (PreToolUse hook) and the Qwens (readguard plus a deny list in `config/qwen/system-settings-readonly.json`, applied through `QWEN_CODE_SYSTEM_SETTINGS_PATH` only when the launcher runs as the `qwen-*-ro` twin provider, which `route.mjs` picks for read-only types; plan mode lets Qwen read an in-cwd `.env` without any permission request, found live in round 5; nothing is ever written under the task folder), may run `summarise`/`review`. A `--provider qoder/...` override on such a type is refused at once; `routes.readOnlyEnforced` overrides the list). Residual risk: the text-level guards can be evaded by shell tricks such as `cat .e
v`; they are a layer, not a sandbox, so keep secrets out of the task folder anyway. Codex has no read-only mode in Paseo (Default Permissions, Auto-review and Full Access can all write in the folder), so it is not in the `summarise` or `review` chains and a read-only type skips it; the folder-changed post-check stays as the backstop.

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
