#!/usr/bin/env sh
# Agent Hub daemon as a systemd user unit. Usage: service.sh install|uninstall|start|stop|status
set -u
ACTION="${1:-}"
UNIT=agent-hub
HOME_DIR="${AGENT_HUB_HOME:-$HOME/.paseo}"
LAUNCH="$(cd "$(dirname "$0")/../.." && pwd)/scripts/daemon-env.mjs" # allow-listed environment for the daemon and its agents
DIR="$HOME/.config/systemd/user"
case "$ACTION" in start|stop) [ -z "${AGENT_HUB_PASEO:-}" ] && [ "${AGENT_HUB_NO_RESTART_LOG:-}" != 1 ] && { node "$(dirname "$LAUNCH")/restart-log.mjs" "$ACTION" >/dev/null 2>&1 || true; } ;; esac
# scripts/daemon-ctl.mjs: verified stop, ready wait (HTTP + paseo ls), plugin check. Skipped under the fake-paseo test hook unless AGENT_HUB_CTL=1.
ctl() { if [ -n "${AGENT_HUB_PASEO:-}" ] && [ "${AGENT_HUB_CTL:-}" != 1 ]; then return 0; fi; node "$(dirname "$LAUNCH")/daemon-ctl.mjs" "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
# Put the Agent Hub kinds into Paseo's own Add-provider list (version+hash checked, idempotent, never fails the start).
if [ "$ACTION" = start ] && [ -z "${AGENT_HUB_NO_WEB_PATCH:-}" ] && [ -z "${AGENT_HUB_PASEO:-}" ]; then node "$(dirname "$LAUNCH")/paseo-web-patch.mjs" apply --quiet || true; fi
if [ "$ACTION" = start ] && [ -z "${AGENT_HUB_NO_SERVER_PATCH:-}" ] && [ -z "${AGENT_HUB_PASEO:-}" ]; then node "$(dirname "$LAUNCH")/paseo-server-patch.mjs" apply --quiet || true; fi
if ! have systemctl || ! systemctl --user show-environment >/dev/null 2>&1; then
  case "$ACTION" in
    start) node "$LAUNCH" "$(command -v paseo)" daemon start --home "$HOME_DIR" || exit $?; ctl ready && ctl plugins && echo "[OK] hub up"; exit $? ;;
    stop) paseo daemon stop --home "$HOME_DIR"; ctl stop; rc=$?; [ -z "${AGENT_HUB_PASEO:-}" ] && node "$(dirname "$LAUNCH")/hub.mjs" reap-laptop --now; exit $rc ;;
    status) paseo daemon status --home "$HOME_DIR"; exit $? ;;
    *) echo "[SKIP] no systemd user session here (container or non-systemd host): the daemon runs via 'just up'"; exit 0 ;;
  esac
fi
case "$ACTION" in
  install)
    PASEO="$(command -v paseo)" || { echo "[FAIL] paseo not on PATH"; exit 1; }
    mkdir -p "$DIR"
    cat > "$DIR/$UNIT.service" <<UNITEOF
[Unit]
Description=Agent Hub (Paseo daemon)
After=network-online.target

[Service]
ExecStart=$(command -v node) $LAUNCH $PASEO daemon run --home $HOME_DIR
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNITEOF
    systemctl --user daemon-reload && systemctl --user enable "$UNIT" && echo "[OK] unit $UNIT enabled"
    have loginctl && loginctl enable-linger "$(id -un)" 2>/dev/null && echo "[OK] linger on: starts at boot without a login" ;;
  uninstall) systemctl --user disable --now "$UNIT" 2>/dev/null; paseo daemon stop --home "$HOME_DIR" 2>/dev/null; rm -f "$DIR/$UNIT.service"; systemctl --user daemon-reload; echo "[OK] unit removed" ;;
  start) ctl heal; systemctl --user start "$UNIT" && ctl ready && ctl plugins && echo "[OK] hub up" ;;
  stop) systemctl --user stop "$UNIT"; ctl stop && echo "[OK] stopped"; [ -z "${AGENT_HUB_PASEO:-}" ] && node "$(dirname "$LAUNCH")/hub.mjs" reap-laptop --now; : ;;
  status) systemctl --user status "$UNIT" --no-pager ;;
  *) echo "usage: service.sh install|uninstall|start|stop|status"; exit 2 ;;
esac
