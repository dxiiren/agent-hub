# Tasks 001: agent-hub (v1)

Order: W0 first and alone; then W1-W15 in parallel, one agent per piece, merged in one batch. W7+W8 share an agent; W9+W10 are a pair that agree on metric names first; W14 proves itself only after W2-W11 merge; W15 hook swaps wait for W9/W10. Every piece: local proof on the exact commit, raw result lines and PNG screenshots in the PR body. Hours in brackets are estimates.

| id | piece | files | proof |
|---|---|---|---|
| W0 | Scaffold from the skeleton, grounding pass, Linux `setup.sh` [5 h] | repo root | `just install` runs `setup.ps1` clean twice on Windows (second run all OK); Linux setup passes in a Linux container; skill audit passes |
| W1 | Specs, spec-kit files, licence and notice, sanitised config split [3 h] | `specs/001-agent-hub/`, `config/` | repo builds; the scan finds no internal host, IP or path |
| W2 | Qoder provider [1.5 h] | `config/` fragment | `paseo run --provider qoder` fixes the calculator task; status available |
| W3 | Qwen Code provider, per-user auth [1 h] | `config/` fragment | same task passes through the ACP provider |
| W4 | Office SGLang as a first-class provider [2 h] | `config/` fragment | task passes on the office model; `/v1/responses` probe result recorded |
| W5 | Laptop provider and pre-flight (GPU visible, no heavy-run lock, RAM >= 3 GB) [3 h] | `deploy/laptop/` | 7/7 laptop tasks pass through the daemon; refuses when the GPU is phantom or a heavy-run lock exists |
| W6 | External MCP reach (bind, password, five client configs), `injectIntoAgents=true`, clean Claude config [3 h] | `config/mcp/`, `config/claude-clean/` | the five clients reach `/mcp/agents` with the password from a second machine; RAM of a Claude agent measured with the clean config |
| W7 | Gate plugin: runner, secret scan, diff-size and path check, two-failure return, labels [14 h] | `plugins/gate` | three-case test (good diff, out-of-scope path, failing test) with raw lines; works from a Windows daemon |
| W8 | PR step: push plus `tea pr create`, `tea login` per developer [5 h] | `plugins/gate` | a real PR on a scratch forge repo, then deleted |
| W9 | Usage plugin: per-task numbers from last usage, usage source for limit windows [8 h] | `plugins/usage-otel` | a task from each provider appears in Prometheus with provider, model, developer, client |
| W10 | Usage stack: compose (collector, Prometheus, Grafana), allow-list and `user.email` strip, scrape jobs, Qoder / OpenCode / limit-% pollers, dashboard with slot-use panel [12 h] | `deploy/usage/` | marker-string test finds no prompt text in any output; every source live or listed "not captured" |
| W11 | Routing table, caller override, fallback [8 h] | `config/routes`, `plugins/routing` | a busy or failed default moves to the next entry; an override wins |
| W12 | Shared server: container per developer (image with codex, claude, qodercli, qwen, tea), login proxy, onboarding script [10 h] | `deploy/server/` | two developers log in, each sees only their own agents and logins; RAM per developer measured |
| W13 | `install.ps1` and `install.sh`: Task Scheduler and systemd, no-sleep, password, config template, `tea login`, pinned versions, `doctor` [6 h] | `install.*` | clean install and restart-after-reboot test on Windows and Linux |
| W14 | Rebase job and 5x5 matrix automation per daemon release [6 h] | `ci/` | the matrix runs on a new tag and reports |
| W15 | Statusline feed and dependents migration: per-session usage read path, hook and reader updates, text moves [16 h] | outside this repo plus `plugins/usage-otel` | unit test per changed hook; the status line shows non-zero laptop, office, Codex and Qoder numbers after one delegated task of each in the same session |

## Done-bar run (after the merged batch)

1. 5x5 any-AI matrix, scripted, raw results saved.
2. Gate pass: 7/7 laptop tasks and at least 9/10 on the code-edit set, one try each.
3. Claude cost per delegated task at or below baseline, zero Claude-lead tokens.
4. Usage dashboard live for every source; screenshot plus per-source check.

Then 7 days stable.
