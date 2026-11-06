# Agent Hub providers

A Settings screen ("Add provider (Agent Hub)") in the Paseo web UI to add, edit and remove hub providers. Paseo's own "Add provider" dialog is a fixed catalog and takes no URL or model; this screen fills that gap.

- `index.client.tsx`: the screen, built from Paseo's own Settings components (the API key field is masked).
- `index.server.ts`: one RPC that runs `scripts/provider.mjs api` (the same code as `agent-hub provider add|edit|remove`), request on stdin so a key never reaches a command line.
- `client/strings.ts`: all UI text. The kinds and their fields come from `scripts/provider-kinds.mjs`, so a new kind needs no change here.

Install: `node scripts/hub.mjs plugins`, then restart the daemon once.
