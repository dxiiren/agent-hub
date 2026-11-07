# Benchmarks, concurrency and change notes

> Moved out of the README so the front page stays short. Measured values and history; nothing here is needed to install or use the hub.

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

## Changes 07-11 (round F fixes)

- **No writer touches a tracked template.** `writeJsonKeepEol` / `writeAtomic` refuse any `*.template.json`; `provider add/remove` write `routes.local.json` (next to the template, or in the hub home under `AGENT_HUB_NO_LOCAL=1`) and only READ the template when no local file exists yet.
- **Relative `--cwd` / `--home` are resolved against the caller** before they reach the daemon (a relative `--cwd .` once ran an agent in `C:\Windows\System32`).
- **Gate scratch folders are lazy and removed.** One `agent-hub-gate-*` folder per process, made on first scan and removed on exit (before: two folders per process at import, 8,561 left in `%TEMP%`). `agent-hub cleanup` removes the old `agent-hub-gitleaks-*` / `agent-hub-nohooks-*` ones (exact name, empty, older than 10 min).
- **One run dir and one laptop port.** Run dir = `<PASEO_HOME or ~/.paseo>/run`; the laptop port comes from `LAPTOP_PORT`, else the laptop provider record in Paseo's config, else 8089, so `laptop-agent --check` from a shell agrees with the daemon.
- **`cleanup`:** `--dry-run` also previews the orphan-shell reap and the temp cleanup; `--stale-projects` removes Paseo projects whose folder is gone (absolute paths that no longer exist only); `--paseo-defaults` lists keys equal to Paseo's default (any writer; removing one changes no behaviour) and only `--paseo-defaults --yes` removes them (daemon stopped).
- **`doctor` warns when qodercli is not the pinned 1.1.81** and prints the fix command; `just update` never moves a pinned tool.
- **Live key-proxy test** (`scripts/test/key-proxy-live.test.mjs`): `provider add --key` through the CLI in a temp home, the real launcher, and probes of the proxy (wrong secret, host, path, endpoint all refused; only the stub upstream sees the key).

## Changes 06-11

- **Self-hosted providers in the Usage panel.** Every provider in the Paseo config that has an OpenAI-compatible endpoint (the base URL in its launch command, or the laptop llama.cpp launcher's local port) gets a card in Paseo's Usage panel: endpoint up/down (`GET <base>/models`, 4 s timeout, cached 60 s) with the served model id, tokens in/out and task count for today and the last 7 days from the usage feed (read-only twins counted with their base), and running/queued requests when you add a Prometheus URL in `config/hub.local.json` as `"metricsUrls": { "<provider>": "http://host:port/metrics" }` (vLLM, SGLang and llama.cpp series are understood; skipped when absent). Green when up, red when down; there is no plan percentage because these servers have no quota. API keys are used for the probe and never shown. Code: `plugins/usage-otel/server/selfhosted-usage.mjs`.
- **Usage stack without Docker on Windows.** `just up` and the logon task now run the collector, Prometheus and Grafana as native processes (`deploy/usage/native.ps1`): binaries, data and generated configs live in `%LOCALAPPDATA%\agent-hub\usage`, downloaded once with SHA-256 verification (`native.ps1 install`, also run on first start). Same pinned versions, same configs, rules and dashboard as `compose.yaml`; ports stay 3000, 9090, 4317 and 4318. `USAGE_MODE=native|docker` (environment or `deploy/usage/.env`) picks the mode: native is the default on Windows, `docker` (compose.yaml) is for servers and Linux. `just doctor` probes the active mode and fails when the collector, Prometheus or Grafana is down.

## Changes 05-11

- **Laptop watchdog false-idle kill fixed.** The two laptop llama-server deaths during the benchmark (21:36, 21:45) were the hub watchdog judging a freshly started agent idle and stopping the shared server. Idle is now based on in-flight markers and shared last-use state, and CPU is not judged while the model loads (a5acf73, 3d9a87e).
- **Acceptance run, 18-way burst.** 18 simultaneous tasks finished with no loss; slots are now Codex 3, Claude 2, Qoder 4, office cluster 6, office single GPU 3, laptop 1. `agent-hub route` retries a start up to 6 times with backoff and jitter on `DAEMON_UNREACHABLE`, runs `--gate` itself in the real folder, and the gate fails closed outside a git work tree.
- **Plugin hooks no longer block.** The gate plugin runs in the background and skips agents that are gone; the usage plugin no longer awaits the Qoder poller in the turn-before hook and polls the account only when the session transcript has no credits. Hooks now stay inside Paseo's 30 s RPC limit (2ebfef6).
- **OTLP 5 s timeout.** MCP and OTLP calls from the usage plugin time out after 5 s, and an OTLP outage is logged once instead of on every turn.
- **Usage stack starts itself.** Docker Desktop and the usage stack (collector, Prometheus, Grafana) come up on logon and on `just up`; `just doctor` now fails when the collector, Prometheus or Grafana is down (f8c7519).
- **Qoder pinned to 1.1.81.** The hub uses qodercli 1.1.81 with a private config directory, because 1.1.83 ignores the tier model over ACP (served `auto`, no credits). Benchmarks check the pin before every cell.
- **Daemon password hash at bcrypt cost 4.** The daemon bcrypt-checked the bearer token on every MCP request inside its single event loop; at cost 4 MCP calls stop saturating it.
- **Laptop server fixes.** The model server and its reaper start outside the launcher's process tree (Paseo ends an agent with a tree kill that took the server along), and `-ot token_embd.weight=<device>` keeps the embedding table on the card (working set 1.4 GB -> 0.84 GB, same speed). `--cache-ram 0` (the host prompt cache had grown llama-server to 3.5 GB of RAM) and the launcher never starts a second server while one is still loading.
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

