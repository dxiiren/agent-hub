#!/usr/bin/env sh
# Agent Hub setup for Linux and macOS: the counterpart of setup.ps1.
# Idempotent: installs nothing that is already present.
# Usage: sh ./setup.sh [--check|--dry-run] [--no-service] [--no-mcp]   (check/dry-run only report; no changes)
set -u

DRY=0; NOSVC=0; NOMCP=0
for a in "$@"; do case "$a" in --check|--dry-run) DRY=1 ;; --no-service) NOSVC=1 ;; --no-mcp) NOMCP=1 ;; esac; done
HERE="$(cd "$(dirname "$0")" && pwd)"

ok()   { printf '[OK] %s\n' "$1"; }
inst() { printf '[INSTALL] %s\n' "$1"; }
miss() { printf '[MISSING] %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

if have apt-get; then PM=apt; elif have dnf; then PM=dnf; elif have brew; then PM=brew; else PM=none; fi
SUDO=""; [ "$(id -u)" -ne 0 ] && have sudo && SUDO="sudo"

pm_install() { # $1=tool $2=package
  if [ "$DRY" -eq 1 ]; then inst "$1 would be installed via $PM ($2)"; return; fi
  case "$PM" in
    apt) [ -n "${APT_UPDATED:-}" ] || { $SUDO apt-get update -qq && APT_UPDATED=1; }; $SUDO apt-get install -y "$2" ;;
    dnf) $SUDO dnf install -y "$2" ;;
    brew) brew install "$2" ;;
    *) miss "$1 (no supported package manager; install it by hand)"; return ;;
  esac
}

need() { # $1=tool $2=package
  if have "$1"; then ok "$1 present"; else miss "$1"; pm_install "$1" "${2:-$1}"; fi
}

need git git
need node nodejs
need npm npm
need just just
need ps procps   # Paseo spawns ps; a slim image without it dies at start

if have claude; then ok "claude present"; else miss "claude (optional: npm install -g @anthropic-ai/claude-code)"; fi

if [ -f .mcp.json ]; then ok ".mcp.json present (left untouched)"
elif [ -f .mcp.json.stub ]; then
  if [ "$DRY" -eq 1 ]; then inst ".mcp.json would be copied from .mcp.json.stub"
  else cp .mcp.json.stub .mcp.json && ok "created .mcp.json from stub (git-ignored)"; fi
fi

# ---- Paseo daemon (pinned)
PASEO_VERSION=0.15.0
HAVE_PASEO="$(paseo --version 2>/dev/null | head -n 1)"
if [ "$HAVE_PASEO" = "$PASEO_VERSION" ]; then ok "paseo $HAVE_PASEO present"
elif [ "$DRY" -eq 1 ]; then inst "paseo $PASEO_VERSION would be installed via npm (found: '${HAVE_PASEO}')"
else
  inst "paseo $PASEO_VERSION via npm"
  npm install -g "@getpaseo/cli@$PASEO_VERSION" 2>/dev/null || {
    npm install -g --prefix "$HOME/.local" "@getpaseo/cli@$PASEO_VERSION" && PATH="$HOME/.local/bin:$PATH" && export PATH
    echo "[INFO] installed under ~/.local: add ~/.local/bin to PATH"; }
  have paseo && ok "paseo $(paseo --version | head -n 1)" || { echo "[FAIL] paseo install failed"; exit 1; }
fi

# ---- agent CLIs: check only, each dev logs in to their own
for c in codex claude qodercli qwen opencode; do
  if have "$c"; then ok "agent CLI present: $c"; else echo "[SKIP] agent CLI not installed: $c (its provider is not registered)"; fi
done

if [ "$DRY" -eq 0 ]; then
  node "$HERE/scripts/hub.mjs" configure || exit 1
  if [ "$NOMCP" -eq 1 ]; then echo "[SKIP] --no-mcp: client MCP configs untouched"; else node "$HERE/scripts/hub.mjs" mcp add; fi
  if [ "$NOSVC" -eq 1 ]; then echo "[SKIP] --no-service: no systemd unit"; else sh "$HERE/deploy/service/service.sh" install; fi
fi

[ "$DRY" -eq 1 ] && echo "[INFO] dry run: nothing changed"
echo "[NEXT] just start && just doctor   (then: just deps && just test)"
