#!/usr/bin/env python3
"""Claude Code status line — single-line, minimalist.

Reads the statusline JSON payload from stdin and renders:
  time | project | model+effort | context (bar/%/tokens) | cost
  | session duration | Session limit | Week limit

Any missing field drops its segment silently — never crashes the line.
Docs: https://code.claude.com/docs/en/statusline.md
"""

import json
import os
import sys
import time

GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
DIM = "\033[2m"
RESET = "\033[0m"

SEP = f" {DIM}│{RESET} "


def pct_color(p):
    if p >= 90:
        return RED
    if p >= 70:
        return YELLOW
    return GREEN


def fmt_tokens(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 10_000:
        return f"{n / 1_000:.0f}k"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def fmt_span(seconds):
    """Compact span: 3d2h / 2h14m / 45m / 0m."""
    seconds = max(0, int(seconds))
    d, rem = divmod(seconds, 86_400)
    h, rem = divmod(rem, 3_600)
    m = rem // 60
    if d:
        return f"{d}d{h}h"
    if h:
        return f"{h}h{m}m"
    return f"{m}m"


def bar(pct, cells=5):
    filled = min(cells, round(pct / 100 * cells))
    return "▮" * filled + "▯" * (cells - filled)


def git_segment(cwd):
    """`branch`, plus `wt of <main project>` inside a linked git worktree; None outside git.

    The branch/worktree idea is adapted from claude-code-templates
    cli-tool/components/settings/statusline/worktree-context-statusline.py (@ 8b1f883, MIT,
    (c) 2025 Daniel (San) Avila) - plain text instead of its glyph, which renders double-width.
    """
    import subprocess

    def git(*args):
        out = subprocess.run(
            ["git", "-C", cwd, *args], capture_output=True, text=True, timeout=1
        )
        return out.stdout.strip() if out.returncode == 0 else ""

    try:
        branch = git("rev-parse", "--abbrev-ref", "HEAD")
        if not branch:
            return None
        if branch == "HEAD":
            branch = "@" + git("rev-parse", "--short", "HEAD")
        git_dir = os.path.abspath(os.path.join(cwd, git("rev-parse", "--git-dir")))
        common = os.path.abspath(os.path.join(cwd, git("rev-parse", "--git-common-dir")))
    except Exception:
        return None
    seg = branch
    if os.path.normcase(git_dir) != os.path.normcase(common):
        main = os.path.basename(os.path.dirname(common.rstrip("/\\")))
        seg += f" {DIM}wt of {main}{RESET}"
    return seg


def build(data):
    segs = []

    # 1. Current time (no clock emoji — wide glyphs break terminal redraw width)
    segs.append(time.strftime("%H:%M", time.localtime()))

    # 2. Project dir name
    project_dir = (data.get("workspace") or {}).get("project_dir")
    if project_dir:
        name = os.path.basename(project_dir.rstrip("/\\"))
        segs.append(f"{DIM}{name}{RESET}")

    # 2b. Git branch, and which project a linked worktree belongs to
    cwd = (data.get("workspace") or {}).get("current_dir") or os.getcwd()
    branch = git_segment(cwd)
    if branch:
        segs.append(branch)

    # 3. Model + effort
    model = (data.get("model") or {}).get("display_name")
    if model:
        part = model
        effort = (data.get("effort") or {}).get("level")
        if effort:
            part += f" {DIM}{effort}{RESET}"
        segs.append(part)

    # 4. Context window
    ctx = data.get("context_window") or {}
    used = ctx.get("used_percentage")
    if used is not None:
        c = pct_color(used)
        part = f"{c}{bar(used)} {used:.0f}%{RESET} ctx"
        total_in = ctx.get("total_input_tokens")
        size = ctx.get("context_window_size")
        if total_in is not None and size:
            part += f" {fmt_tokens(total_in)}/{fmt_tokens(size)}"
        if used >= 90:
            part += f" {RED}! run /compact{RESET}"
        segs.append(part)

    # 5-6. Cost, session duration
    cost = data.get("cost") or {}
    usd = cost.get("total_cost_usd")
    if usd is not None:
        segs.append(f"${usd:.2f}")
    duration_ms = cost.get("total_duration_ms")
    if duration_ms:
        segs.append(f"{DIM}up{RESET} " + fmt_span(duration_ms / 1000))

    # 7. Rate limits — names match the /usage screen
    limits = data.get("rate_limits") or {}
    now = time.time()
    for key, label in (("five_hour", "Session"), ("seven_day", "Week")):
        window = limits.get(key) or {}
        used_pct = window.get("used_percentage")
        if used_pct is None:
            continue
        c = pct_color(used_pct)
        part = f"{label} {c}{used_pct:.0f}%{RESET}"
        resets_at = window.get("resets_at")
        if resets_at:
            part += f" {DIM}({fmt_span(resets_at - now)}){RESET}"
        segs.append(part)

    return SEP.join(segs)


def main():
    # Windows defaults stdout to cp1252, which can't encode box chars
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    try:
        data = json.load(sys.stdin)
        line = build(data)
    except Exception:
        line = ""
    sys.stdout.write(line + "\n")


if __name__ == "__main__":
    main()
