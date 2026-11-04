# Shared server (one Paseo container per developer)

> **TL;DR** — `deploy/shared/` runs one Paseo daemon per developer in its own container, volume and network, behind one login proxy (Caddy basic auth, one host name per dev). No Paseo core patch (decisions 24 and 51).

## Make it

```
cd deploy/shared
node gen.mjs dev1 dev2 dev3          # rewrites compose.yaml, Caddyfile, .env.template, env/<dev>.env.template
cp .env.template .env                 # one bcrypt hash per dev, in single quotes (they contain $)
cp env/dev1.env.template env/dev1.env # per dev: office URL, OTLP endpoint (no provider credentials)
docker run --rm caddy:2 caddy hash-password   # prints a hash for .env
docker compose up -d --build
```

Each dev opens `http://<dev>.<HUB_DOMAIN>:18080` (default `dev1.localhost`) and logs in with its proxy user. The same URL plus `/mcp/agents` is the MCP door for that dev's clients. The dev then logs in once to Codex, Claude, Qoder and Qwen Code inside the container (`docker exec -it agenthub-shared-<dev> codex login`, and so on); the logins live in that dev's volume only.

## Isolation

- Own volume (`/home/paseo`), own network `agenthub-shared-net-<dev>` (`10.79.<n>.0/24`). A dev container cannot reach another one.
- The proxy is the only published port, bound to `127.0.0.1` unless `HUB_BIND` says otherwise. Wrong credentials, or one dev's credentials on another dev's host name, get 401.
- Paseo itself has no password inside the container; the proxy login is the barrier. Add a Paseo password as a second layer before exposing it beyond a trusted LAN.

## Run it always

- `restart: unless-stopped` on every container: a crash restarts it with its agents and config intact (the volume).
- **Docker Desktop must start at logon** (Settings, General, "Start Docker Desktop when you sign in") and the machine must stay signed in or use auto-logon, or the containers do not come back after a reboot. `docker kill` counts as a manual stop and is not a restart test.
- Keep the host awake on AC (sleep and hibernate off) and set Windows Update active hours.

## Cost and limits

RAM per container is about 0.4 GB idle and about 1 GB with one running agent (measured in the spike). Five developers idle is about 2 GB; six to eight GB with an agent each. The image pins every CLI (`ARG` versions in `Dockerfile`); add the toolchains your team builds with (jdk, maven) there, because agents that cannot find python or a compiler stall on a permission prompt. Back up a dev's volume before changing the pinned Paseo version.

## Telemetry

`env/<dev>.env.template` points Claude Code at the usage stack (`OTEL_EXPORTER_OTLP_ENDPOINT`, `dev=<name>`). From a container the usage stack on the same host is `host.docker.internal:4317`.
