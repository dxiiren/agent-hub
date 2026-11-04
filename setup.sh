#!/usr/bin/env sh
# Agent Hub setup for Linux and macOS: the counterpart of setup.ps1.
# Idempotent: installs nothing that is already present.
# Usage: sh ./setup.sh [--check|--dry-run]   (both only report; no changes)
set -u

DRY=0
case "${1:-}" in --check|--dry-run) DRY=1 ;; esac

ok()   { printf '[OK] %s\n' "$1"; }
inst() { printf '[INSTALL] %s\n' "$1"; }
miss() { printf '[MISSING] %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

if have apt-get; then PM=apt; elif have dnf; then PM=dnf; elif have brew; then PM=brew; else PM=none; fi
SUDO=""; [ "$(id -u)" -ne 0 ] && have sudo && SUDO="sudo"

pm_install() { # $1=tool $2=package
  if [ "$DRY" -eq 1 ]; then inst "$1 would be installed via $PM ($2)"; return; fi
  case "$PM" in
    apt) $SUDO apt-get install -y "$2" ;;
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

if have claude; then ok "claude present"; else miss "claude (optional: npm install -g @anthropic-ai/claude-code)"; fi

if [ -f .mcp.json ]; then ok ".mcp.json present (left untouched)"
elif [ -f .mcp.json.stub ]; then
  if [ "$DRY" -eq 1 ]; then inst ".mcp.json would be copied from .mcp.json.stub"
  else cp .mcp.json.stub .mcp.json && ok "created .mcp.json from stub (git-ignored)"; fi
fi

[ "$DRY" -eq 1 ] && echo "[INFO] dry run: nothing changed"
echo "[NEXT] just deps && just test"
