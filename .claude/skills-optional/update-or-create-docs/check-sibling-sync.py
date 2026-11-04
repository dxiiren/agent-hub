#!/usr/bin/env python
"""check-sibling-sync.py -- enforce the .docs/ sibling update rule.

The update-or-create-docs SKILL.md hard rule: whenever ANY .docs/ document is
created or meaningfully updated, these two sibling files must be touched in the
same pass:
  1. .docs/README.md   (the index)
  2. .docs/tldr.md     (the 30-second summaries)

This script reads git state (staged + unstaged + untracked) for changes under
.docs/. If a meaningful .docs/ doc changed (any path under .docs/ OTHER than the
two siblings themselves), then BOTH siblings must also appear in the diff.
  * If a sibling is missing -> print the missing sibling(s) and exit 1.
  * Otherwise -> print 'SYNC OK' and exit 0.

Doctrine: stdlib only, ASCII-only output, argparse, fixed output, exit 0 ok / 1 fail.
Invoke as: uv run --no-project python .claude/skills/update-or-create-docs/check-sibling-sync.py
"""
import argparse
import os
import subprocess
import sys

DOCS_DIR = ".docs"
README = ".docs/README.md"
TLDR = ".docs/tldr.md"

REQUIRED = [README, TLDR]
SIBLINGS = set(REQUIRED)


def _repo_root():
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.decode("utf-8", "ignore").strip()
    except OSError:
        pass
    # fallback: three levels up from this file
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))


def _changed_paths(root):
    """Return the set of repo-relative paths that differ (staged + unstaged +
    untracked), normalized to forward slashes."""
    paths = set()
    cmds = [
        ["git", "diff", "--name-only"],            # unstaged tracked
        ["git", "diff", "--name-only", "--cached"],  # staged
        ["git", "ls-files", "--others", "--exclude-standard"],  # untracked
    ]
    for cmd in cmds:
        try:
            out = subprocess.run(
                cmd, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
        except OSError:
            continue
        if out.returncode != 0:
            continue
        for line in out.stdout.decode("utf-8", "ignore").splitlines():
            p = line.strip().replace("\\", "/")
            if p:
                paths.add(p)
    return paths


def main():
    ap = argparse.ArgumentParser(
        description="Check the .docs/ sibling update rule "
                    "(README.md + tldr.md move with every doc change).")
    ap.parse_args()

    root = _repo_root()
    changed = _changed_paths(root)

    # Did any meaningful .docs/ doc change? (any .docs/ path NOT one of the siblings)
    docs_doc_changed = sorted(
        p for p in changed
        if p.startswith(DOCS_DIR + "/") and p not in SIBLINGS
    )

    if not docs_doc_changed:
        print("SYNC OK")
        print("no .docs/ document changed (siblings not required).")
        return 0

    missing = sorted(r for r in REQUIRED if r not in changed)

    print("changed .docs/ document(s):")
    for p in docs_doc_changed:
        print("  - {0}".format(p))

    if missing:
        print("MISSING SIBLINGS (must be updated in the same pass):")
        for m in missing:
            print("  - {0}".format(m))
        return 1

    print("SYNC OK")
    print("all required siblings present in the diff.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
