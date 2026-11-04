#!/usr/bin/env sh
# Agent Hub daemon as a systemd user unit. Usage: service.sh install|uninstall|start|stop|status
set -u
ACTION="${1:-}"
UNIT=agent-hub
HOME_DIR="${AGENT_HUB_HOME:-$HOME/.paseo}"
DIR="$HOME/.config/systemd/user"
have() { command -v "$1" >/dev/null 2>&1; }
if ! have systemctl || ! systemctl --user show-environment >/dev/null 2>&1; then
  case "$ACTION" in
    start) paseo daemon start --home "$HOME_DIR"; exit $? ;;
    stop) paseo daemon stop --home "$HOME_DIR"; exit $? ;;
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
ExecStart=$PASEO daemon run --home $HOME_DIR
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNITEOF
    systemctl --user daemon-reload && systemctl --user enable "$UNIT" && echo "[OK] unit $UNIT enabled"
    have loginctl && loginctl enable-linger "$(id -un)" 2>/dev/null && echo "[OK] linger on: starts at boot without a login" ;;
  uninstall) systemctl --user disable --now "$UNIT" 2>/dev/null; paseo daemon stop --home "$HOME_DIR" 2>/dev/null; rm -f "$DIR/$UNIT.service"; systemctl --user daemon-reload; echo "[OK] unit removed" ;;
  start) systemctl --user start "$UNIT" && echo "[OK] started" ;;
  stop) systemctl --user stop "$UNIT" && echo "[OK] stopped" ;;
  status) systemctl --user status "$UNIT" --no-pager ;;
  *) echo "usage: service.sh install|uninstall|start|stop|status"; exit 2 ;;
esac
