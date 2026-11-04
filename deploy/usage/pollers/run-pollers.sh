#!/bin/sh
# Run the host pollers (Qoder, OpenCode, limit %). Credentials from the environment only:
#   USAGE_MONITOR_USER / USAGE_MONITOR_PASS (limit % poller). HUB_DEV names this developer.
# Optional: pip install qoder-agent-sdk for the Qoder balance and reset date.
POLLERS="${POLLERS:-limits,qoder,opencode}" HUB_DEV="${HUB_DEV:-$(id -un)}" exec python3 "$(dirname "$0")/pollers.py"
