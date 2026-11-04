#!/bin/sh
# First start seeds the config inside the dev's volume; every start runs the daemon in the foreground.
set -e
H=/home/paseo/.paseo
mkdir -p "$H" /home/paseo/work/repo
if [ ! -f "$H/config.json" ]; then
  # office SGLang as an OpenCode provider, only when HUB_OFFICE_URL is set
  if [ -n "$HUB_OFFICE_URL" ]; then
    M="${HUB_OFFICE_MODEL:-Qwen3.8-27B}"
    cat > /home/paseo/opencode.json <<J
{"\$schema":"https://opencode.ai/config.json","share":"disabled","autoupdate":false,"model":"office/$M",
"provider":{"office":{"npm":"@ai-sdk/openai-compatible","name":"Office Qwen","options":{"baseURL":"$HUB_OFFICE_URL","apiKey":"x"},"models":{"$M":{"name":"$M"}}}}}
J
    OC='{"opencode":{"env":{"OPENCODE_CONFIG":"/home/paseo/opencode.json","OPENCODE_DISABLE_MODELS_FETCH":"1","OPENCODE_DISABLE_TELEMETRY":"1"}}}'
  else
    OC='{}'
  fi
  cat > "$H/config.json" <<J
{"version":1,"daemon":{"listen":"0.0.0.0:6767","mcp":{"injectIntoAgents":true},"relay":{"enabled":false},"allowedHosts":true},
"agents":{"providers":$OC},"features":{"webUi":{"enabled":true}}}
J
fi
cd /home/paseo/work/repo
if [ ! -d .git ]; then
  git init -q -b main && git config user.email "${HUB_DEV:-dev}@agent-hub.invalid" && git config user.name "${HUB_DEV:-dev}"
  git commit -q --allow-empty -m init
fi
exec paseo daemon run --home "$H"
