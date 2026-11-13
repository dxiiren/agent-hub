# Counting every LLM call: `agent-hub direct`, launch guard, auto-archive, daemon marker

Written 13-11-2026 after a fleet drove `claude -p` and `paseo run` directly and its usage never showed in `agent-hub usage`.
Rule: **every LLM call a driver script makes goes through `agent-hub route` or `agent-hub direct`**, always with a session id.

## 1. `agent-hub direct` (the supported fast path)

```
agent-hub direct claude|codex|paseo --session <id> [--dev D] [--client C] -- <tool args>
agent-hub direct --list                       # live wrapped runs (~/.paseo/run/direct/<wrapper pid>.json)
agent-hub direct --kill --session <id>        # stops ONLY the child PIDs this wrapper recorded for that session
```

- `claude`: runs `claude <args> --output-format json`, prints the `result` text, exit code passed through. Reads `total_cost_usd`, `usage`, `modelUsage` and writes one record (provider `claude-headless`, task `direct`) to `usage.jsonl` and `sessions/<id>.jsonl`.
- `codex`: adds `--json` and sums `turn.completed` token usage (provider `codex-direct`).
- `paseo`: only for `run`; injects `--label session=<id>,dev=<D>,caller=<C>,route=direct`, so the reaper and the usage board see the agent.
- A call that returned no usage (failed, 403) writes no record.
- Env: `AGENT_HUB_SESSION`, `AGENT_HUB_DEV`, `AGENT_HUB_CLIENT`, `AGENT_HUB_USAGE_DIR`; test overrides `AGENT_HUB_DIRECT_CLAUDE|CODEX|PASEO` (path of a fake binary).
- Check: `agent-hub usage --session <id>` shows `claude-headless`; `agent-hub usage --all` lists it.

### How a driver script must start workers

```bash
# one worker, counted under the driver's session
agent-hub direct claude --session w3-api-docs --dev akmal --client dreview -- \
  -p "$PROMPT" --model sonnet --strict-mcp-config
# a hub agent started by hand, labelled (never a bare `paseo run`)
agent-hub direct paseo --session w3-api-docs -- run --provider codex/terra --cwd "$WT" "$PROMPT"
# bulk or gated work: use route (picks the provider, counts it, reaps it)
agent-hub route code-edit "<task>" --cwd "$WT" --session w3-api-docs --gate "<real test command>"
```

Rules: pass `--session` (or set `AGENT_HUB_SESSION` once in the driver); headless claude always `--strict-mcp-config`; to stop workers, `agent-hub direct --kill --session <id>`, never by process-name pattern.
If a script cannot be changed, put the line `agent-hub-direct-ok` in the script, or `AGENT-HUB-DIRECT-OK: <reason>` in the command, and say why in the PR.

## 2. Launch guard (Claude Code hook)

`~/.claude/hooks-local/direct-launch-guard/guard.py` (PreToolUse, Bash|PowerShell) refuses a bare `claude -p`, `codex exec` or `paseo run`, in the command text and in the python/node/ps1 script the command runs.
Allowed: `agent-hub direct|route`, `agent_hub_direct`, the two opt-out markers above. Switch (owner only): `DIRECT_LAUNCH_GUARD=off`. Blocks are logged to `~/.claude/logs/fleet-cap.jsonl` as kind `unlogged-direct`; the fleet-cap guard also logs (never blocks) a headless claude with no agent-hub ancestor. Self-test: `python guard.py --selftest`.
Read-only and text tools (`grep`, `rg`, `echo`, `printf`, `cat`, `git log|grep|diff|show`, `sed -n`, `find` without `-exec`) carry launch words as data, so `grep claude -p x` and `git log --grep claude -p` pass; a `find -exec` target, a `$(...)` substitution, text piped into a shell (`echo claude -p | sh`) or written to a script file, `rg --pre`, `sed e` and `git -c` are still checked. `python -c` is checked only when its code spawns a process (subprocess, os.system, popen, exec, getattr/__import__ ...), so printing `codex exec x` passes.

**Nested launches (runtime backstop):** `agent_hub_direct.py` exports `AGENT_HUB_DIRECT_SESSION` + `AGENT_HUB_DIRECT_PID` (the wrapper pid) and records the spawned child in `~/.paseo/run/direct/<wrapper pid>.json` (`child`). The `claude-fleet-cap` hook accepts the marker only when the headless claude IS that child (or its parent is, for a cmd/node shim), so a bare launch that the child itself starts (Bash tool, script) is refused and logged as `unlogged-direct` with `layer: runtime-backstop`, `nested: true`. Without a readable registry, nothing like claude/codex/a shell/an interpreter may sit between the run and the wrapper. The same "nothing in between" rule applies to the hub-ancestor and daemon rules.

## 3. Workspace cap auto-archive and error agents

- `route` over `AGENT_HUB_WORKSPACE_CAP` (default 20) no longer refuses at once: it runs `node plugins/routing/reaper.mjs --heal-cap` (archive idle local workspaces and sweep idle ones) once, re-checks, and refuses only if still over.
- The reaper also archives agents in `error` that have no route/type label (older than its `--older-than`); labelled route agents keep their own cleanup.
- Manual: `node plugins/routing/reaper.mjs --heal-cap [--home H]`, or `agent-hub cleanup`.

## 4. Daemon marker and safe kill filter

The daemon now starts as `node scripts/daemon-main.mjs --title=agent-hub-daemon --home <H>` (via `scripts/daemon-env.mjs`, only for `daemon run`; `AGENT_HUB_DAEMON_MARKER=0` restores the old launch). Its command line has no `@getpaseo` and no ` run `, so the old driver filter (`node.exe` + `@getpaseo` + ` run `) that killed the daemon on 11-11 no longer matches it. A driver must kill only PIDs it started itself (`agent-hub direct --kill --session <id>`); never match on `node.exe`. Takes effect at the next daemon restart; restart only when `paseo ls` shows no running agents.

## 4b. Qoder reports credits, never tokens

Qoder rows show `in 0 / out 0` and credits only. Checked 13-11-2026 with qodercli 1.1.81: the session transcripts under `~/.qoder/projects` and `~/.paseo/hub/qoder-home/projects` hold 128,050 assistant `usage` objects and not one has a non-zero `input_tokens`, `output_tokens` or `cache_*` field (they carry `credits`, `original_credits`, `billable` and a `context_usage_ratio`, an estimate of context fill, not a count); the `~/.qoder/logs/runs/*/qodercli.log` files contain no token field either, and the ACP session updates reach Paseo with the same zeros. So Qoder does not expose token counts anywhere we can read, and the hub records its credits instead. The `usage-missing` rule (`usage_recorded` in `plugins/usage-otel/bin/agent_hub_direct.py`, tested in `lanes_test.py`) therefore treats credits > 0 as recorded usage for Qoder only; every other provider with no tokens is still `usage-missing`. Re-check after a qodercli upgrade (the version is pinned at 1.1.81).

## 5. Backfill

`tools/usage_backfill_w3.py --logs <drive-log dir> --label w3-api-docs --out ~/.paseo/usage/usage-backfill-<date>.jsonl [--usage F] [--tz 8] [--dry]` writes a SIDECAR; `usage.jsonl` is never rewritten. `usage --session` merges tag lines (existing no-session records) and synthetic lines (`backfill:true`); `usage --all` adds only the synthetic lines. Undo = delete the sidecar file.
