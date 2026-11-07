# Agent Hub reaper

Archives (and so ends the CLI process tree of) agents nobody uses any more, every 5 minutes:

- agents of a route process that is dead (ledger `run/agents-<pid>.json`),
- agent-hub agents idle, error or closed for over 20 minutes (not `--keep`, not parked),
- route agents still running past the route's time limit plus 5 minutes.

Same logic by hand: `agent-hub cleanup --older-than 20m` (parallel) or `node plugins/routing/reaper.mjs --once`.
