#!/usr/bin/env bash
# find-polluter.sh - run test files ONE AT A TIME and stop at the first one that creates or
# changes a watched path (a test escaping its sandbox). Stack-neutral: the runner is a template.
#
# Adapted from cli-tool/components/skills/development/systematic-debugging/find-polluter.sh in
# davila7/claude-code-templates @ 8b1f883 (MIT, Copyright (c) 2025 Daniel (San) Avila).
# Git-Bash safe: ASCII only, POSIX paths, no reliance on npm.
#
# Exit codes:
#   0  no polluter found (every file ran, every watched path unchanged)
#   1  polluter found (the file is printed; the loop stops there)
#   2  usage error / nothing to run
#   3  a watched path was ALREADY changing before any test ran (not a test's fault)

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: find-polluter.sh [options] -w PATH [-w PATH ...] <test-file-or-glob>...

Runs each test file alone, fingerprints the watched paths before and after, and stops at the
FIRST file that makes one appear, disappear or change.

Test files are paths relative to the repo root, or quoted globs of them (the script expands
them; ** is not supported - list directories instead).

Options:
  -w, --watch PATH    Path (relative to the repo root) to watch. Repeatable. Required: name the
                      real data/state paths a test must never touch (a data dir, .env, a cache).
  -r, --run TEMPLATE  Command that runs ONE test file; {} is replaced by the file path.
                      Default: 'just test {}'.
  -h, --help          Show this text.

Notes:
  - A red test does NOT stop the loop; only pollution does. Each file's exit code is printed.
  - Do not run this while another test run, a dev server or a worker is active: their writes
    would be blamed on whichever file happens to be running.
EOF
}

WATCH=()
RUNNER='just test {}'
PATTERNS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -w|--watch) [ $# -ge 2 ] || { echo "error: $1 needs a path" >&2; exit 2; }; WATCH+=("$2"); shift 2 ;;
    -r|--run)   [ $# -ge 2 ] || { echo "error: $1 needs a command" >&2; exit 2; }; RUNNER="$2"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    --)         shift; while [ $# -gt 0 ]; do PATTERNS+=("$1"); shift; done ;;
    -*)         echo "error: unknown option $1" >&2; usage >&2; exit 2 ;;
    *)          PATTERNS+=("$1"); shift ;;
  esac
done

if [ ${#PATTERNS[@]} -eq 0 ] || [ ${#WATCH[@]} -eq 0 ]; then
  usage >&2
  exit 2
fi
case "$RUNNER" in *'{}'*) ;; *) echo "error: --run template has no {} placeholder" >&2; exit 2 ;; esac

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ]; then
  echo "error: run this inside a git checkout" >&2
  exit 2
fi
cd "$ROOT" || exit 2

shopt -s nullglob
FILES=()
for pat in "${PATTERNS[@]}"; do
  # shellcheck disable=SC2206
  expanded=( $pat )
  [ ${#expanded[@]} -eq 0 ] && echo "warning: '$pat' matched nothing" >&2
  for f in "${expanded[@]}"; do
    [ -f "$f" ] && FILES+=("$f")
  done
done
shopt -u nullglob

TOTAL=${#FILES[@]}
if [ "$TOTAL" -eq 0 ]; then
  echo "error: no test files to run" >&2
  exit 2
fi

# Fingerprint one path: ABSENT, or a checksum over (relative name, type, size, mtime) of every
# entry under it. Catches creation, deletion and modification.
fingerprint() {
  local p="$1"
  if [ ! -e "$p" ]; then
    echo "ABSENT"
  elif [ -d "$p" ]; then
    find "$p" -printf '%P|%y|%s|%T@\n' 2>/dev/null | LC_ALL=C sort | cksum | cut -d' ' -f1,2
  else
    find "$p" -maxdepth 0 -printf '%s|%T@\n' 2>/dev/null | cksum | cut -d' ' -f1,2
  fi
}

snapshot() {
  local w
  for w in "${WATCH[@]}"; do
    printf '%s\t%s\n' "$w" "$(fingerprint "$w")"
  done
}

describe() {
  local p="$1"
  if [ ! -e "$p" ]; then
    echo "   (path is now ABSENT)"
  elif [ -d "$p" ]; then
    echo "   newest entries under $p:"
    find "$p" -mindepth 1 -printf '%T@ %y %P\n' 2>/dev/null | LC_ALL=C sort -rn | head -10 | sed 's/^/     /'
  else
    ls -la "$p" | sed 's/^/   /'
  fi
}

run_one() {
  local f="$1" cmd
  cmd="${RUNNER//\{\}/\"$f\"}"
  bash -c "$cmd" >/dev/null 2>&1
}

echo "find-polluter: $TOTAL test file(s), runner: $RUNNER"
echo "watching:"
for w in "${WATCH[@]}"; do echo "  - $w"; done
echo ""

# Baseline twice, one second apart: if a watched path moves on its own, nothing below means anything.
BASE="$(snapshot)"
sleep 1
BASE2="$(snapshot)"
if [ "$BASE" != "$BASE2" ]; then
  echo "ABORT: a watched path changed with NO test running."
  diff <(echo "$BASE") <(echo "$BASE2") || true
  echo "Stop the servers / workers / other test runs first, then retry."
  exit 3
fi

COUNT=0
for f in "${FILES[@]}"; do
  COUNT=$((COUNT + 1))
  BEFORE="$(snapshot)"
  START=$(date +%s)
  rc=0
  run_one "$f" || rc=$?
  SECS=$(( $(date +%s) - START ))
  AFTER="$(snapshot)"
  echo "[$COUNT/$TOTAL] $f  (test exit $rc, ${SECS}s)"

  if [ "$BEFORE" != "$AFTER" ]; then
    echo ""
    echo "FOUND POLLUTER: $f"
    while IFS=$'\t' read -r w fp; do
      old="$(printf '%s\n' "$BEFORE" | awk -F'\t' -v k="$w" '$1==k{print $2}')"
      if [ "$old" != "$fp" ]; then
        echo " changed: $w  ($old -> $fp)"
        describe "$w"
      fi
    done <<< "$AFTER"
    echo ""
    echo "Next: reproduce alone (${RUNNER//\{\}/$f}), then Phase 1: which line writes outside the sandbox?"
    exit 1
  fi
done

echo ""
echo "No polluter found: $TOTAL file(s) ran, watched paths unchanged."
exit 0
