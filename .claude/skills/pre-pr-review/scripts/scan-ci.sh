#!/usr/bin/env bash
# scan-ci.sh - CI/CD supply-chain checks for this project (GitHub Actions workflows, any
# Dockerfile/compose file, lockfiles, committed .env files). Stack-neutral; ships with the kit.
#
# Adapted from cli-tool/components/skills/security/supply-chain-guard/scripts/scan-ci.sh in
# claude-code-templates (https://github.com/davila7/claude-code-templates @ 8b1f883, MIT License,
# Copyright (c) 2025 Daniel (San) Avila), via two downstream project copies. Only the
# CI/Dockerfile/lockfile/.env checks were kept; the npm/PyPI IOC scanners live in the optional
# supply-chain-audit skill instead.
# Changes from upstream: multi-line `permissions:` blocks are parsed, every package.json up to 3
# levels deep is checked, the committed-.env check runs `git -C` on a native path (cygpath -m) so
# it works under Git Bash on Windows, CRLF is handled, findings carry file:line + severity, and the
# exit code is 1 only for CRITICAL/HIGH.
# Workflow-level hygiene: no top-level `permissions:` block (the token then gets the repo default,
# often read-write) is MEDIUM; a workflow with no top-level `concurrency:` is LOW. The
# least-privilege default and the concurrency rule come from claude-code-templates
# cli-tool/components/agents/security/github-actions-expert.md @ 8b1f883 (MIT, (c) 2025 Daniel
# (San) Avila).
#
# Usage: bash .claude/skills/pre-pr-review/scripts/scan-ci.sh [--root <dir>]
#   --root <dir>  project root to scan (default: git toplevel of the cwd, else cwd)
# Exit:  1 if any CRITICAL or HIGH finding, else 0 (2 on a usage error).

set -euo pipefail

usage() {
  sed -n '/^# Usage:/,/^# Exit:/p' "$0" | sed 's/^# \{0,1\}//'
}

ROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || { echo "scan-ci: --root needs a directory" >&2; exit 2; }
      ROOT="$2"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "scan-ci: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$ROOT" ]]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
[[ -d "$ROOT" ]] || { echo "scan-ci: not a directory: $ROOT" >&2; exit 2; }
ROOT="$(cd "$ROOT" && pwd)"

# Native form of a path for native Windows tools (git.exe); identity elsewhere.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

N_CRIT=0; N_HIGH=0; N_MED=0; N_LOW=0

finding() {
  local sev="$1"; shift
  case "$sev" in
    CRITICAL) N_CRIT=$((N_CRIT + 1)) ;;
    HIGH)     N_HIGH=$((N_HIGH + 1)) ;;
    MEDIUM)   N_MED=$((N_MED + 1)) ;;
    LOW)      N_LOW=$((N_LOW + 1)) ;;
  esac
  printf '[%s] %s\n' "$sev" "$*"
}
note() { printf '[INFO] %s\n' "$*"; }

rel() { local p="$1"; printf '%s\n' "${p#"$ROOT"/}"; }

# Actions whose tags were force-pushed to malicious commits. "owner/repo|why".
COMPROMISED_ACTIONS=(
  "aquasecurity/trivy-action|76 of 77 tags poisoned 2026-03-19 (GHSA-69fq-xp46-6x23)"
  "aquasecurity/setup-trivy|all tags poisoned 2026-03-19 (GHSA-69fq-xp46-6x23)"
  "checkmarx/kics-github-action|tags poisoned 2026-03-23"
  "checkmarx/ast-github-action|v2.3.28 compromised 2026-03-23"
  "tj-actions/changed-files|all tags repointed (CVE-2025-30066)"
  "reviewdog/action-setup|tag compromised (CVE-2025-30154)"
)

# Regexes kept in variables so bash [[ =~ ]] needs no quoting tricks.
RE_COMMENT='^[[:space:]]*#'
RE_USES="^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*[\"']?([^\"'[:space:]#]+)"
RE_SHA='^[0-9a-f]{40}$'
RE_PERM='^([[:space:]]*)permissions:[[:space:]]*(.*)$'
RE_PERM_ITEM='^[[:space:]]*([A-Za-z_-]+):[[:space:]]*["'"'"']?write'
RE_PRT='(^|[^A-Za-z0-9_])pull_request_target([^A-Za-z0-9_]|$)'
RE_HEAD_REF='(ref|repository)[[:space:]]*:.*(github\.event\.pull_request\.head\.|github\.head_ref|refs/pull/)'
RE_NPM='(^|[^A-Za-z0-9_./-])npm[[:space:]]+(ci|install|i)([[:space:]]|$)'
RE_TRIVY_IMG='aquasec/trivy:v?0\.69\.[456]([^0-9]|$)'
RE_LEAD='^([[:space:]]*)'
RE_TOP_CONC='^concurrency:'

check_npm_and_image() {  # $1=file rel  $2=lineno  $3=line
  local r="$1" n="$2" l="$3"
  if [[ "$l" =~ $RE_NPM ]] && [[ "$l" != *--ignore-scripts* ]]; then
    finding LOW "$r:$n npm install/ci without --ignore-scripts (postinstall scripts run) - add it, or note why this project needs install scripts: ${l#"${l%%[![:space:]]*}"}"
  fi
  if [[ "$l" =~ $RE_TRIVY_IMG ]]; then
    finding CRITICAL "$r:$n references a compromised Trivy image (0.69.4-0.69.6)"
  fi
}

# ------------------------------------------------------------------
echo "== scan-ci: $ROOT"
echo "-- Phase 1: GitHub Actions workflows"

WF_DIR="$ROOT/.github/workflows"
WF_COUNT=0
if [[ -d "$WF_DIR" ]]; then
  for wf in "$WF_DIR"/*.yml "$WF_DIR"/*.yaml; do
    [[ -f "$wf" ]] || continue
    WF_COUNT=$((WF_COUNT + 1))
    r="$(rel "$wf")"
    n=0
    has_prt=0; prt_line=0
    head_lines=""
    in_perm=0; perm_indent=0; perm_line=0; perm_list=""
    top_perm=0; top_conc=0

    flush_perm() {
      if [[ $in_perm -eq 1 && -n "$perm_list" ]]; then
        local scope="job-level"; [[ $perm_indent -eq 0 ]] && scope="workflow-level"
        finding MEDIUM "$r:$perm_line $scope permissions grant write:${perm_list} (least privilege: grant write only where needed)"
      fi
      in_perm=0; perm_list=""
    }

    while IFS= read -r line || [[ -n "$line" ]]; do
      n=$((n + 1))
      line="${line%$'\r'}"
      [[ "$line" =~ $RE_COMMENT ]] && continue
      [[ -z "${line//[[:space:]]/}" ]] && continue

      # Continuation of a multi-line permissions: block?
      if [[ $in_perm -eq 1 ]]; then
        [[ "$line" =~ $RE_LEAD ]]; ind=${#BASH_REMATCH[1]}
        if [[ $ind -gt $perm_indent ]]; then
          if [[ "$line" =~ $RE_PERM_ITEM ]]; then
            perm_list="$perm_list ${BASH_REMATCH[1]}"
          fi
          continue
        fi
        flush_perm
      fi

      [[ "$line" =~ $RE_TOP_CONC ]] && top_conc=1
      if [[ "$line" =~ $RE_PERM ]]; then
        pind=${#BASH_REMATCH[1]}
        [[ $pind -eq 0 ]] && top_perm=1
        val="${BASH_REMATCH[2]%%#*}"
        val="${val//[[:space:]]/}"
        val="${val//\"/}"; val="${val//\'/}"
        if [[ -z "$val" ]]; then
          in_perm=1; perm_indent=$pind; perm_line=$n; perm_list=""
        elif [[ "$val" == "write-all" ]]; then
          finding MEDIUM "$r:$n permissions: write-all (every scope writable)"
        elif [[ "$val" == \{* ]]; then
          flow=""; rest="${val#\{}"; rest="${rest%\}}"
          IFS=',' read -r -a kvs <<< "$rest"
          for kv in "${kvs[@]}"; do
            [[ "$kv" == *:write ]] && flow="$flow ${kv%%:*}"
          done
          [[ -n "$flow" ]] && finding MEDIUM "$r:$n permissions grant write:$flow"
        fi
        continue
      fi

      if [[ "$line" =~ $RE_USES ]]; then
        spec="${BASH_REMATCH[1]}"
        case "$spec" in ./*|docker://*) continue ;; esac
        if [[ "$spec" != *@* ]]; then
          finding HIGH "$r:$n $spec has no @ref at all"
          continue
        fi
        action="${spec%@*}"; ref="${spec##*@}"
        repo="$(printf '%s' "$action" | cut -d/ -f1-2 | tr '[:upper:]' '[:lower:]')"
        pinned=0; [[ "$ref" =~ $RE_SHA ]] && pinned=1
        bad=0
        for entry in "${COMPROMISED_ACTIONS[@]}"; do
          if [[ "$repo" == "${entry%%|*}" ]]; then
            bad=1
            if [[ $pinned -eq 1 ]]; then
              note "$r:$n $action is SHA-pinned ($ref); confirm the SHA is a post-incident release commit - ${entry#*|}"
            else
              finding CRITICAL "$r:$n $action@$ref is a known tag-poisoned action and is NOT SHA-pinned - ${entry#*|}"
            fi
          fi
        done
        if [[ $pinned -eq 0 && $bad -eq 0 ]]; then
          finding HIGH "$r:$n $action@$ref is a mutable ref, not a 40-hex commit SHA"
        fi
        continue
      fi

      if [[ "$line" =~ $RE_PRT ]]; then
        has_prt=1; [[ $prt_line -eq 0 ]] && prt_line=$n
      fi
      if [[ "$line" =~ $RE_HEAD_REF ]]; then
        head_lines="$head_lines $n"
      fi
      check_npm_and_image "$r" "$n" "$line"
    done < "$wf"
    flush_perm

    if [[ $top_perm -eq 0 ]]; then
      finding MEDIUM "$r:1 no workflow-level permissions: block - GITHUB_TOKEN gets the repo default; add 'permissions: contents: read' at the top and widen per job only where needed"
    fi
    if [[ $top_conc -eq 0 ]]; then
      finding LOW "$r:1 no workflow-level concurrency: block - overlapping runs (or deploys) are not cancelled/serialised"
    fi

    if [[ $has_prt -eq 1 ]]; then
      if [[ -n "$head_lines" ]]; then
        finding CRITICAL "$r:$prt_line pull_request_target + checkout of the PR head (line(s)${head_lines}) runs untrusted code with a privileged token"
      else
        finding MEDIUM "$r:$prt_line pull_request_target trigger - keep checkout on the base ref"
      fi
    fi
  done
  note "scanned $WF_COUNT workflow file(s)"
else
  note "no .github/workflows directory"
fi

# ------------------------------------------------------------------
echo "-- Phase 2: Dockerfiles and compose files"

DOCKER_COUNT=0
while IFS= read -r df; do
  [[ -n "$df" ]] || continue
  DOCKER_COUNT=$((DOCKER_COUNT + 1))
  r="$(rel "$df")"
  n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    [[ "$line" =~ $RE_COMMENT ]] && continue
    check_npm_and_image "$r" "$n" "$line"
  done < "$df"
done < <(find "$ROOT" -maxdepth 3 \
           \( -name node_modules -o -name vendor -o -name .git \) -prune -o \
           -type f \( -name Dockerfile -o -name 'Dockerfile.*' -o -name '*.dockerfile' \
                      -o -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' \
                      -o -name compose.yml -o -name compose.yaml \) -print 2>/dev/null | sort)
note "scanned $DOCKER_COUNT Dockerfile/compose file(s)"

# ------------------------------------------------------------------
echo "-- Phase 3: lockfiles"

PKG_COUNT=0
while IFS= read -r pj; do
  [[ -n "$pj" ]] || continue
  PKG_COUNT=$((PKG_COUNT + 1))
  d="$(dirname "$pj")"
  if [[ -f "$d/package-lock.json" || -f "$d/yarn.lock" || -f "$d/pnpm-lock.yaml" || -f "$d/npm-shrinkwrap.json" ]]; then
    note "$(rel "$pj") has a lockfile"
  else
    finding MEDIUM "$(rel "$pj") has no lockfile - installs are not reproducible"
  fi
done < <(find "$ROOT" -maxdepth 3 \
           \( -name node_modules -o -name vendor -o -name .git \) -prune -o \
           -type f -name package.json -print 2>/dev/null | sort)
[[ $PKG_COUNT -eq 0 ]] && note "no package.json found"

# ------------------------------------------------------------------
echo "-- Phase 4: committed secrets files"

GIT_NATIVE="$(native_path "$ROOT")"
if command -v git >/dev/null 2>&1 && git -C "$GIT_NATIVE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  tracked_env=""
  while IFS= read -r -d '' tf; do
    base="${tf##*/}"
    case "$base" in
      .env|.env.*) ;;
      *) continue ;;
    esac
    case "$base" in
      *.example|*.sample|*.template|*.dist) continue ;;
    esac
    tracked_env="$tracked_env $tf"
  done < <(git -C "$GIT_NATIVE" ls-files -z)
  if [[ -n "$tracked_env" ]]; then
    finding CRITICAL ".env file(s) tracked in git:$tracked_env"
  else
    note "no real .env file is tracked in git"
  fi
  if [[ -f "$ROOT/.gitignore" ]]; then
    if ! grep -q '\.env' "$ROOT/.gitignore"; then
      finding MEDIUM ".gitignore has no .env pattern"
    fi
  else
    finding MEDIUM "no .gitignore at the scan root"
  fi
else
  note "not a git work tree - committed-.env check skipped"
fi

# ------------------------------------------------------------------
echo "== summary: CRITICAL=$N_CRIT HIGH=$N_HIGH MEDIUM=$N_MED LOW=$N_LOW"
if [[ $((N_CRIT + N_HIGH)) -gt 0 ]]; then
  echo "== FAIL (CRITICAL/HIGH present)"
  exit 1
fi
echo "== PASS (no CRITICAL/HIGH)"
exit 0
