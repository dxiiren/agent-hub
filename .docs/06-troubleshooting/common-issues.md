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

### `just test` fails

`scripts/check-config.mjs` names the template and the key. Templates must be valid JSON with placeholders only; fix the file and re-run.

### `just scan` reports a finding

The scan blocks internal host names, private IPs, personal paths and secrets in tracked files. Replace the value with a placeholder such as `<OFFICE_QWEN_URL>`.

## Related docs

| Doc | Why |
| --- | --- |
| [stack-notes.md](../05-reference/stack-notes.md) | The stack's known gotchas |
| [getting-started.md](../02-setup/getting-started.md) | The setup steps these issues occur in |
