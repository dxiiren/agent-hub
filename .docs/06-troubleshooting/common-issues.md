# Common Issues — Agent Hub

> **TL;DR** — real symptoms hit while setting up and verifying THIS project, each with
> its fix. If your problem isn't here, add it once you solve it.

### `just` or `node` not found right after setup

PATH updates only land in a new shell. Close and reopen PowerShell. No `just` yet: run `powershell -ExecutionPolicy Bypass -File install-just.ps1`.

### The daemon hangs (port open, no HTTP answer)

Paseo's own supervisor restarts a daemon that crashes, not one that hangs (08-11-2026: the worker stopped at 08:24 with the port still open and the hub was dead for 20 minutes). Three things now cover it:

- **Hang watchdog** (`scripts/daemon-watchdog.mjs`, Task Scheduler task `AgentHubWatchdog` every 2 min on Windows, `agent-hub-watchdog.timer` on systemd). It asks `/api/health` with a 10 s timeout. After 3 failures in a row it runs `service restart` and writes the reason to `<home>/restart-requests.log`. It restarts nothing while `<home>/deliberate-stop` exists (written by `just down`, removed by `just up`), and after 3 restarts in an hour it only logs `restart-backoff`. Its own log: `<home>/watchdog.log`. Install it alone with `service.ps1 watchdog-install` (`service.ps1 install` also does).
- **`service restart`** (`service.ps1 restart`, `service.sh restart`): stop then start, without the deliberate-stop marker. `stop` now recognises the real topology: the pid in `paseo.pid` is the supervisor and its child `daemon-worker.js` holds the port. It stops the supervisor first (so it cannot respawn the worker), then the worker, by exact pid. A process on the port that is not a descendant of the recorded pid is still refused.
- **RAM floor.** New routes wait below `minFreeRamGb` (1 GB in the owner's routes file). The value compared is Windows `\Memory\Available MBytes` (free plus standby, read through `Win32_PerfFormattedData_PerfOS_Memory` so it works in any language), not `FreePhysicalMemory`; Linux uses `MemAvailable`; both fall back to `os.freemem()` (`availableGb()` in `plugins/routing/budget.mjs`).

### A route is refused with `WORKSPACE_CAP` or the daemon answers slowly

Every workspace costs the daemon git work; over 20 the route refuses. `route` now runs `node plugins/routing/reaper.mjs --heal-cap` once and re-checks. By hand: `agent-hub cleanup`, or `node plugins/routing/reaper.mjs --sweep --idle 5m`. The reaper also archives finished agents that pin a local workspace, error agents without a route label, and duplicate records of a permanent folder (`--dedupe-permanent`; the folder is never touched). A driver's `agent-hub direct paseo` agent (label `route=direct`) still `running` after 3 h (`AGENT_HUB_DIRECT_MAX_S`, usually stuck on a permission) is stopped and archived. Cause history: 13-11 (102 leaked local workspaces), 09-11 hubfix (16 stuck Qwen agents held every slot).

### A route sits for 30 minutes after its agent finished

The gate secret scan used to start one gitleaks process per file (355 s on a 5,000-file folder) and nothing bounded it. Fixed 09-11 (batches of 4 MB, a deadline of the route's wait timeout, fail closed). A route that still hangs: `agent-hub route --status <agent id>`.

### A provider stays `error` after its host came back

Paseo takes one provider snapshot at boot and never refreshes it (an office Qwen unreachable for seconds at start stays `error`). The 10-minute reaper sweep now runs `paseo provider diagnostic <id>` for every enabled provider in `error`; by hand: `node plugins/routing/reaper.mjs --reprobe`. If the diagnostic still fails, curl the host: `curl -m 4 http://<host>:<port>/v1/models` on 8000-8010, 30000 and 11434. A host that pings but answers on no port is down (start the model server there), a changed port means repoint the config.

### The watchdog restarts a healthy daemon every few minutes

Two causes seen on 13-11: a remote-host provider in `error` counted as sick (a local restart cannot fix an office host: fixed, such providers are ignored), and the probe could not find `paseo.cmd` on Windows (exit 127 read as "does not answer"; fixed in `spawn-safe.mjs`). Read the alert: `HUB-ALERT.txt` now carries exit code, signal and stderr. The probe timeout is 60 s (`AGENT_HUB_WATCHDOG_LS_MS`). After a daemon restart, never kill hub processes by name pattern: use `agent-hub direct --kill --session <id>`; the daemon's command line has `--title=agent-hub-daemon`.

### A driver's LLM calls do not show in `agent-hub usage`

A bare `claude -p`, `codex exec` or `paseo run` is not counted. Use `agent-hub direct claude|codex|paseo --session <id> -- <tool args>` or `agent-hub route` (see [usage-direct.md](../../docs/usage-direct.md)).

### Qoder routes show 0 tokens in `agent-hub usage`

By design, not a bug: Qoder rows show `in 0 / out 0` and credits only. Checked 13-11-2026 with qodercli 1.1.81: the session transcripts under `~/.qoder/projects` and `~/.paseo/hub/qoder-home/projects` hold 128,050 assistant `usage` objects and not one has a non-zero `input_tokens`, `output_tokens` or `cache_*` field (they carry `credits`, `original_credits`, `billable` and a `context_usage_ratio`, an estimate of context fill, not a count); the `~/.qoder/logs/runs/*/qodercli.log` files contain no token field either, and the ACP session updates reach Paseo with the same zeros. So Qoder does not expose token counts anywhere we can read, and the hub records its credits instead. The `usage-missing` rule (`usage_recorded` in `plugins/usage-otel/bin/agent_hub_direct.py`, tested in `lanes_test.py`) therefore treats credits > 0 as recorded usage for Qoder only; every other provider with no tokens is still `usage-missing`. Re-check after a qodercli upgrade (the version is pinned at 1.1.81). Details: [usage-direct.md](../../docs/usage-direct.md).

### A route stalls on a provider that cannot start

Fixed 13-11-2026 (r4). `paseo provider ls` is the truth: a provider it lists as disabled, unavailable or error is skipped at once (the config file can only switch one off), the list is cached for 60 s, and a provider whose agent does not start within `startTimeout` (default 90 s, `AGENT_HUB_START_TIMEOUT`) is dropped and its slot released.

### `just test` fails

`scripts/check-config.mjs` names the template and the key. Templates must be valid JSON with placeholders only; fix the file and re-run.

### `just scan` reports a finding

The scan blocks internal host names, private IPs, personal paths and secrets in tracked files. Replace the value with a placeholder such as `<OFFICE_QWEN_URL>`.

## Related docs

| Doc | Why |
| --- | --- |
| [stack-notes.md](../05-reference/stack-notes.md) | The stack's known gotchas |
| [getting-started.md](../02-setup/getting-started.md) | The setup steps these issues occur in |
