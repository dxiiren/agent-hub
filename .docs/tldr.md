# TL;DR — every doc in 30 seconds

> One section per document. Read this page first; follow a link only when you need the
> detail.

## [project-overview.md](01-overview/project-overview.md)

Agent Hub configures and extends the Paseo agent daemon so any AI client can hand a task to any agent provider and get a verdict plus a diff back. It ships config templates, a gate plugin, a usage plugin with an OTel/Prometheus/Grafana stack, a routing table and install scripts. It is Node >= 20 ESM scripts and JSON templates; there is no server to run.

---

## [getting-started.md](02-setup/getting-started.md)

Run `pwsh ./setup.ps1` once (idempotent), reopen PowerShell, then
`just deps` and `just test`.

---

## [workflow.md](03-development/workflow.md)

You live in `just test` and `just scan`; both must exit 0 before a push. Use `/commit` and `/create-pr`.

---

## [deployment.md](04-deployment/deployment.md)

There is no hosted service; the scripts under `deploy/` are run by hand on a laptop, a usage host or a server.

---

## [commands.md](05-reference/commands.md)

Run `just` with no arguments to list every recipe. The daily ones are `deps`, `test`, `scan` and `claudex`.

---

## [project-layout.md](05-reference/project-layout.md)

Code lives in `scripts/`, `plugins/` and `deploy/`; `config/` holds the templates.

---

## [conventions.md](05-reference/conventions.md)

The project-family contract this repo was scaffolded under: invariants (log tags, justfile
rules, docs structure), the token system, per-stack boot-verify, and git rules.

---

## [stack-notes.md](05-reference/stack-notes.md)

Field-proven gotchas for this project's stack — read before touching setup.ps1 or the
justfile.

---

## [common-issues.md](06-troubleshooting/common-issues.md)

The most common symptom is `just` or `node` not found after setup; open a new shell.

---

## [faq.md](07-faq/faq.md)

Why there is no `just start`, and where real URLs, keys and MCP secrets go.
