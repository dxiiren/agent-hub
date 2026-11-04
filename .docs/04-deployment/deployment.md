# Deployment — Agent Hub

> **TL;DR** — there is no hosted service. Install scripts under `deploy/` set up a laptop, a usage stack and a server.

## Current state

Nothing deploys automatically. `deploy/laptop/` holds the laptop pre-flight, `deploy/usage/` the OTel/Prometheus/Grafana stack, and `deploy/server/` the server install. Each is run by hand on the target machine with its own values filled in from the `<PLACEHOLDER>` templates. The scripts land per `specs/001-agent-hub/tasks.md`.

## If this ever deploys

CI workflow files under `ci/` are not wired to a runner yet. Before they are: pick the runner, decide where real provider URLs and keys live (never in this repo), and make `just test` and `just scan` the required checks.

## Related docs

| Doc | Why |
| --- | --- |
| [usage-stack.md](usage-stack.md) | The OTel, Prometheus, Grafana stack and the host pollers |
| [shared-server.md](shared-server.md) | One Paseo container per developer behind a login proxy |
| [getting-started.md](../02-setup/getting-started.md) | The local "deployment" that actually exists |
| [conventions.md](../05-reference/conventions.md) | Git rules that protect main |
