#!/usr/bin/env bash
# Run a hook script with the payload on stdin. Fails CLOSED (exit 2) for git push/commit and
# secret-path commands when no interpreter or script is available; other commands pass.
# usage: run_hook.sh <script.py>
d="$(cd "$(dirname "$0")" && pwd)"; command -v cygpath >/dev/null 2>&1 && d="$(cygpath -m "$d")"
p="$(cat)"
top="$(git rev-parse --show-toplevel 2>/dev/null)" && cd "$top"
if [ -f "$d/$1" ]; then
  if command -v uv >/dev/null 2>&1; then printf '%s' "$p" | uv run --no-project python "$d/$1"; exit $?; fi
  for py in python3 python; do
    if command -v "$py" >/dev/null 2>&1; then printf '%s' "$p" | "$py" "$d/$1"; exit $?; fi
  done
fi
if printf '%s' "$p" | grep -Eiq 'git|\.env|\.pem|\.key|credentials'; then
  echo "hook $1 cannot run (script or python/uv missing): blocked, fail closed" >&2
  exit 2
fi
exit 0
