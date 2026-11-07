# Providers, accounts, security and aliases (full reference)

## Add a provider (UI or CLI)

Paseo's own Settings > Providers > "Add provider" is a fixed catalog of ACP agents: each is added with its stock command, with no URL, model or key field. Agent Hub adds the missing piece, with the same behaviour from the web UI and the command line.

**Where to find it in Paseo.** The kinds below are listed in Paseo's own Add provider list too: search `qwen`, `openai`, `ollama`, `vllm`, `sglang`, `lm studio`, `opencode`, `qoder`, `codex` or `claude`, press Add, and the Agent Hub form opens with that kind selected. Paseo 0.15.2 has no plugin hook for that list, so `just up` applies a small, reversible edit to the installed web bundle (`scripts/paseo-web-patch.mjs`, edits in `patches/paseo-0.15.2/web-bundle.json`): it runs only when the installed Paseo version and the bundle's sha256 both match (any other version: a warning, nothing touched, the form stays under Plugins > agent-hub-providers), never modifies the original bundle file, is idempotent, and `node scripts/paseo-web-patch.mjs restore` undoes it. The entries are generated from `scripts/provider-kinds.mjs` (your custom kinds included) into `agent-hub-catalog.json` next to the web UI each time. `AGENT_HUB_NO_WEB_PATCH=1` skips it.

**What you can add (a "kind"):**

| Kind | What it is | Fields |
| --- | --- | --- |
| `qwen-code` | [Qwen Code](https://github.com/QwenLM/qwen-code) on any OpenAI-compatible endpoint (vLLM, SGLang, llama.cpp, Ollama, a hosted API) | base URL, model, optional API key |
| `opencode` | OpenCode on any OpenAI-compatible endpoint (no key field: OpenCode runs without a hub launcher, so its agent could read a key) | base URL, model |
| `local-llama` | a local model the hub runs itself: it starts your `llama-server` (any llama.cpp build with `--device` and `--load-mode`) on the first task and stops it after an idle time, on Windows, macOS or Linux | llama-server program, GGUF file, model name, optional port, context size, GPU device, idle minutes, lock-file pattern |
| `qoder`, `codex`, `claude` | one more model of a CLI you have installed and signed in to (route entry `<cli>/<model>`; no new Paseo provider) | model |

**Local model (`local-llama`).** The server is started with every layer on one GPU device and `--load-mode none` (no mmap), so the weights are not kept in system RAM; it is not started at all when the NVIDIA GPU is missing or already used by another process (a clear `LAPTOP-REFUSED` message, the router falls back to the next provider), and it is stopped after the idle minutes so GPU memory and RAM come back. Only a server the hub started itself is ever stopped. Example: `agent-hub provider add laptop-qwen --kind local-llama --bin /path/llama-server --modelFile /path/model.gguf --model my-alias --routes summarise`. A non-CUDA `--device` skips the NVIDIA check. `agent-hub provider migrate` turns an older Qwen provider that points at the machine's own laptop port (with `llamaServer`/`laptopModel` in `config/hub.local.json`, or `LLAMA_SERVER_BIN`/`LAPTOP_MODEL_PATH`) into this kind with the same name, slots and routes; `migrate --undo` restores the exact old files.

Every kind also takes a name, parallel slots (kinds with their own provider), which task types it serves with its position in each route chain, and (qwen) whether `summarise` and `review` may run on it. There is one Paseo entry per endpoint: the Qwen launcher offers a session mode "read-only" itself. A fresh install has NO providers (nothing is preconfigured); an older install's seeded Qwen entries are converted by `agent-hub provider migrate` (run by `setup`; `--undo` restores the exact old bytes). Model lists are read live: from the endpoint's `GET /v1/models`, or from `paseo provider models <cli>` for the CLI kinds. Nothing about your hosts, models or accounts is built in.

**Prerequisites:** Node 20 or newer, a running hub (`just up`), and for the kind you pick its CLI on your `PATH` (`qwen`, `opencode`, `qodercli`, `codex` or `claude`). Works the same on Windows, macOS and Linux.

**From the web UI.** Run `node scripts/hub.mjs plugins` once and restart the daemon (`just down && just up`). Open the hub page (default `http://127.0.0.1:6767`), then **Settings > Add provider (Agent Hub)**: pick the kind, give it a name, paste the base URL (and key, which is masked and never shown again), press **Load models** and pick one (or type an id), set slots and the task types, then **Add provider**. A provider with its own Paseo entry needs one daemon restart, which the screen tells you; a CLI-model entry is live at once. The list below the form has **Edit** and **Remove** for each added provider.

**From the command line** (`agent-hub provider ...`, or `node scripts/hub.mjs provider ...`):

```
agent-hub provider kinds
agent-hub provider models --kind qwen-code --url http://127.0.0.1:8000/v1          # what the endpoint serves
agent-hub provider add qwen-lab --kind qwen-code --url http://127.0.0.1:8000/v1 --model my-model \
    [--key <api key>] [--slots 2] [--routes code-edit:2,summarise] [--readonly false] [--label "Display name"]
agent-hub provider add fast-tier --kind qoder --model <tier from: paseo provider models qoder> --routes code-edit
agent-hub provider edit qwen-lab --slots 4        # also --model --url --key --routes --readonly
agent-hub provider list
agent-hub provider remove qwen-lab
```

The provider list shows each added provider as "<Kind> <host>" (for example `Qwen Code 10.0.0.5`, or `Qwen Code local` for localhost) unless you pass `--label`. `--routes code-edit:2,summarise` puts the provider second in the `code-edit` chain and at the end of `summarise`. `add` refuses a URL that is not http(s), an endpoint that does not answer `/v1/models`, a model the endpoint or CLI does not list, and a name already in use; nothing is written when it refuses. The API key (qwen-code kind) lives in `config/hub.local.json` (git-ignored) and in the provider's `env` in the Paseo config, and goes only to the hub's launcher (`deploy/office/office-agent.mjs`), which keeps it in a small local auth proxy and starts the agent with the key removed from its environment: the agent and its shell commands never see it, and it is never on a command line or in a log. The same launcher also strips every environment variable whose name ends in `API_KEY`, `TOKEN`, `PAT`, `SECRET`, `PASSWORD` or `CREDENTIALS` from the agent's environment, so an agent that runs `env` does not see the daemon's own secrets either. `remove` puts the configuration files back byte for byte while nothing else has changed them since; `edit` keeps that guarantee relative to the original add.

**Add your own kind** (any ACP agent CLI, any other OpenAI-compatible launcher). The built-in kinds live in `scripts/provider-kinds.mjs`; yours go in `config/provider-kinds.local.json` (git-ignored) or the file named by `AGENT_HUB_KINDS`, and appear in both the CLI and the UI:

```json
{
  "myagent": {
    "label": "My agent (OpenAI-compatible)",
    "launch": ["{node}", "/path/to/my-launcher.mjs", "{url}", "{model}"],
    "modelsFrom": "endpoint",
    "fields": [
      { "id": "url", "label": "Base URL", "type": "url", "required": true },
      { "id": "model", "label": "Model", "type": "model", "required": true },
      { "id": "key", "label": "API key (optional)", "type": "secret" }
    ]
  }
}
```

`launch` is the ACP command Paseo should run (`{node}`, `{repo}`, `{url}`, `{model}` are filled in; the key arrives in `HUB_OPENAI_API_KEY`, so your launcher must keep it from the agent: reuse `startAuthProxy` and `scrubKeyEnv` from `plugins/routing/office.mjs`, or take no key field). Names of this kind start with `myagent-`. Use `"base": "<an installed provider id>"` instead of `launch` for a kind that only adds `<base>/<model>` route entries.

The UI is one small Paseo plugin (`plugins/providers`) drawn from this same schema with Paseo's own Settings components; all of its text is in `plugins/providers/client/strings.ts`. A Paseo-side change to put these fields into the built-in "Add provider" dialog would be a better home for it; none is needed for this to work.

### Multiple accounts

Every kind in `scripts/provider-kinds.mjs` declares how it separates accounts (`account` in the schema; the Settings form shows it, or the reason it cannot):

| Kind | Separation | One-time sign-in for a new account | Plan usage in the Usage panel |
|---|---|---|---|
| Claude | `CLAUDE_CONFIG_DIR` per account (set on that provider only) | `CLAUDE_CONFIG_DIR=<dir> claude auth login` | 5-hour and weekly % from the account's own login |
| Codex | `CODEX_HOME` per account | `CODEX_HOME=<dir> codex login` | 5-hour and weekly % from the account's own login |
| Qoder | `--config-dir <dir>` on the provider command | `qodercli --config-dir <dir> login` | tokens and tasks only |
| Qwen Code, OpenCode, custom endpoint kinds | no login: another account is another entry with its own Base URL and/or API key | none | endpoint status, tokens and tasks |

```
agent-hub provider add claude-work --kind claude --account work --model <id> --routes code-edit
# prints the one-line sign-in command for the new, empty account folder; run it once yourself
agent-hub provider add claude-home --kind claude --account home --account-dir D:\accounts\home --model <id>
agent-hub provider remove claude-work            # the account folder (its login) is kept
agent-hub provider remove claude-work --purge    # ... or deleted with it
```

The hub never asks for, stores or automates a password: you sign in once with the CLI itself. The folder defaults to `~/.agent-hub/accounts/<kind>/<account>` (`AGENT_HUB_ACCOUNTS_DIR` moves it). An account is its own provider (own slots, own route entries `<name>/<model>`), so more accounts means more parallel tasks. Account providers serve code-edit style tasks; read-only task types (`summarise`, `review`) stay on the providers with an enforced sensitive-read guard. The Usage panel shows one card per kind with a Total line and one line per account (the default login first); an account that is not signed in shows "not logged in". Restart the daemon after adding (`just down && just up`) so Paseo loads the new provider; Paseo lists an account's models once it knows the provider, until then the base provider's list is shown.

The model is never a guess: the form (and `agent-hub provider models --kind K [--link URL]`) fills a list from the endpoint's `/v1/models` or from the CLI, with its tier and cost text; `add` without `--model` prints that list. A custom id is the last option of the list.

## Security

**Agents get an allow-listed environment.** Every way of starting the daemon (`just up`, the `AgentHub` scheduled task, the systemd unit) goes through `scripts/daemon-env.mjs`, which builds the daemon's environment from an allow-list: OS basics (`PATH`, `SystemRoot`, `TEMP`, `HOME`/`USERPROFILE`, `APPDATA`, `LANG`/`LC_*`, `XDG_*` ...), the hub's own and Paseo's own names, by exact name only (no prefix wildcards for the hub or Paseo, so an unlisted `PASEO_*` or `AGENT_HUB_*` name is dropped); a value that is a URL with `user:pass@` is always dropped. Codex, Claude, Qoder, OpenCode and Qwen agents inherit that environment, so an agent (or injected text it reads) that runs `env` sees none of the tokens of the shell that started the hub. The agent CLIs keep working because they read their logins from their own config dirs. If a CLI genuinely needs another variable (a proxy, `NODE_EXTRA_CA_CERTS`), list it in `config/hub.local.json` as `"daemonEnvAllow": ["HTTPS_PROXY", "NODE_*"]` (a trailing `*` is a prefix) or in `AGENT_HUB_ENV_ALLOW=HTTPS_PROXY,NODE_*`; a name listed exactly there is passed even if it looks like a credential (a `*` prefix entry still skips credential-looking names), so list only what you mean to share. Restart the daemon after changing it. The Docker images take their environment from the container's own env file, which is yours.

Full-access, bypass and yolo modes are used only with `--new-workspace worktree` (a throwaway worktree); `route.mjs` drops them otherwise. The daemon password lives in `<paseo home>/agent-hub-secret` and is never put in the environment agents inherit.

**Latest aliases.** A route entry may name `codex/latest`, `codex/latest-sol|terra|luna`, `claude/latest-opus|sonnet|haiku` `qoder/<tier>@latest`, `qoder/latest-<family>` or `opencode/office@latest` instead of a pinned model. `route.mjs` resolves it at dispatch to the highest version the provider lists (Codex: `~/.codex/models_cache.json`, version-sorted, `astra` never chosen, a family without the newest version falls back to the newest overall for `codex/latest`; Claude and Qoder: `paseo provider models`), cached 10 min. `node plugins/routing/route.mjs --resolve <alias>` prints the mapping now; `just doctor` lists resolved aliases and warns about pinned older models. **Qoder** versions: tiers are matched on their display name, so `qoder/latest-<family>` (e.g. `latest-qwen-max`, `latest-deepseek-pro`, `latest-kimi-pro`) picks the highest version in that family and `qoder/<tier>@latest` moves an older versioned tier up to it (unversioned tiers such as `efficient` just must still be listed). **Office Qwen and the laptop model** are not pinned: `deploy/office/office-agent.mjs` (qwen-code, qwen-code-2) and `laptop-agent.mjs` read the served id from `GET <base>/v1/models` at spawn (cached 10 min; the configured model is only the fallback), and `opencode/office@latest` points the opencode config at the served id. **Tools:** `just doctor` lists every CLI's installed vs latest published version (npm view) and the laptop GGUF with its date; `just update` updates the ones behind, Paseo only with `just update --paseo`. Nothing updates or downloads by itself.


## Extra troubleshooting notes

### The Paseo UI: use the local page, not app.paseo.sh

`just install` (it runs `node scripts/hub.mjs configure`, which you can also run alone) turns on the daemon's own web UI: open `http://127.0.0.1:6767/` (Direct connection, host `127.0.0.1`, port `6767`, the password in `<paseo home>/agent-hub-secret`). The hosted app at app.paseo.sh cannot connect: the daemon answers its WebSocket with `403 Origin not allowed` unless `daemon.cors.allowedOrigins` lists it, and Chrome blocks the call to localhost behind a local-network prompt. Restart the daemon (`just down && just up`) after the first `configure`.

### `route.mjs ... --new-workspace worktree` seems to hang

Creating the agent can take 2+ minutes while the daemon is saturated or a provider stalls at its ACP `initialize` (upstream Paseo: `agent.create.request` shows in `daemon.log` as `ws_slow_request`; not specific to worktrees). `route.mjs` now creates with `--no-wait`, bounds the create call (`AGENT_HUB_CREATE_TIMEOUT_S`, default 240) and returns `CREATE_TIMEOUT: ...` instead of hanging 15 minutes; it does not retry that error. A late agent may still appear in `paseo ls`; stop it by id.

### A task ends as `permission`

Edit task types (`code-edit`, `test-scaffold`) outside `--new-workspace worktree` run without their full-access mode and wait for a permission nobody answers; the trace now says so. Use `--new-workspace worktree`, or a read-only type (`summarise`, `review`), which run in the provider default mode and fail if they changed files in the folder (list: `readOnlyTypes` in the routes file).

**Read-only providers (decided 06-11, live evidence).** A read-only type runs each provider in its read-only mode: `plan` for Claude and OpenCode, `read-only` for the Qwen providers (plus the readguard/hook file boundary), `dontAsk` for Qoder (a Write, a shell command and a Read outside the task folder were all refused live; but a Read INSIDE the folder is allowed, and an in-cwd `.env` was read and returned in round 3, so Qoder is NOT allowed on read-only types: only providers with an enforced sensitive-read refusal, claude-clean (PreToolUse hook) and the Qwens (readguard plus a deny list in `config/qwen/system-settings-readonly.json`, applied through `QWEN_CODE_SYSTEM_SETTINGS_PATH`: the Qwen launcher is an ACP proxy (`plugins/routing/acp-proxy.mjs`) that offers the session mode `read-only`, and when `route.mjs` selects it (`--mode read-only`, before the first prompt) it restarts qwen with those settings and keeps the same session id; there is no second "(read-only)" provider; plan mode lets Qwen read an in-cwd `.env` without any permission request, found live in round 5; nothing is ever written under the task folder), may run `summarise`/`review`. A `--provider qoder/...` override on such a type is refused at once; `routes.readOnlyEnforced` overrides the list). Residual risk: the text-level guards can be evaded by shell tricks such as `cat .e
v`; they are a layer, not a sandbox, so keep secrets out of the task folder anyway. Codex has no read-only mode in Paseo (Default Permissions, Auto-review and Full Access can all write in the folder), so it is not in the `summarise` or `review` chains and a read-only type skips it; the folder-changed post-check stays as the backstop.

### `just: command not found` right after setup

PATH updates only land in a new shell. Close and reopen PowerShell, or run `powershell -ExecutionPolicy Bypass -File install-just.ps1` first.

### `just test` fails with a config error

`scripts/check-config.mjs` reports the template and the key. Templates must be valid JSON and contain only `<PLACEHOLDER>` values, never real hosts or secrets; fix the file and re-run.

### `just scan` flags a file

The scan blocks internal host names, private IPs, personal paths and secrets. Replace the value with a placeholder such as `<OFFICE_QWEN_URL>`.

More in [`.docs/06-troubleshooting/common-issues.md`](.docs/06-troubleshooting/common-issues.md).

