#!/usr/bin/env python3
"""PreToolUse hook: refuse a `git commit` whose files carry a hardcoded secret.

Adapted from claude-code-templates `cli-tool/components/hooks/security/secret-scanner.py`
@ 8b1f883, MIT, (c) 2025 Daniel (San) Avila, via a downstream project port, for the kit (stack-neutral):

* never prints the matched value - only file, line and kind (the source echoed the secret into
  the transcript it was protecting);
* ASCII-only output (a Windows console is often cp1252; the source's emoji crashed it);
* provider patterns everywhere, but the GENERIC ones (password = "...", api_key = "...") skip
  `tests/`, whose fixtures hold throwaway credentials by design;
* adds the Claude OAuth token shape; drops the UUID, JWT and loose `cf...` patterns, which match
  hashes and identifiers.

Exit 2 blocks the tool call and shows stderr to Claude; exit 0 allows it. Wired in
`.claude/settings.json` behind a shell pre-filter, so only commands mentioning `git commit` pay
for the Python start-up.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

# (pattern, kind, generic?) - a generic pattern is skipped under tests/.
PATTERNS: list[tuple[str, str, bool]] = [
    (r"AKIA[0-9A-Z]{16}", "AWS access key id", False),
    (r"sk-ant-api\d{2}-[A-Za-z0-9\-_]{20,}", "Anthropic API key", False),
    (r"sk-ant-oat\d{2}-[A-Za-z0-9\-_]{20,}", "Claude OAuth token", False),
    (r"sk-proj-[A-Za-z0-9\-_]{32,}", "OpenAI project key", False),
    (r"\bsk-[A-Za-z0-9]{48,}", "OpenAI API key", False),
    (r"sk-or-v1-[0-9a-f]{64}", "OpenRouter API key", False),
    (r"AIza[0-9A-Za-z\-_]{35}", "Google API key", False),
    (r"\bgh[pousr]_[0-9A-Za-z]{36}\b", "GitHub token", False),
    (r"github_pat_[0-9A-Za-z_]{22,}", "GitHub fine-grained PAT", False),
    (r"glpat-[0-9A-Za-z\-_]{20,}", "GitLab token", False),
    (r"hf_[A-Za-z0-9]{34,}", "Hugging Face token", False),
    (r"xox[baprs]-[0-9A-Za-z\-]{10,}", "Slack token", False),
    (r"\b[0-9]{8,10}:[A-Za-z0-9_\-]{35}\b", "Telegram bot token", False),
    (r"-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----", "private key", False),
    (
        r"(?i)(?:mysql|postgres(?:ql)?|mongodb)://[^\s'\")]+:[^\s'\")]+@",
        "DB URL with password",
        False,
    ),
    (
        r"(?i)\b(?:api[_\-]?key|secret[_\-]?key|access[_\-]?token)['\"\s]*[=:]\s*['\"][0-9A-Za-z\-_]{20,}['\"]",
        "generic key",
        True,
    ),
    (r"(?i)\b(?:password|passwd)['\"\s]*[=:]\s*['\"][^'\"\s]{8,}['\"]", "hardcoded password", True),
]
_COMPILED = [(re.compile(p), kind, generic) for p, kind, generic in PATTERNS]

SKIP_NAMES = {
    ".env.example",
    ".gitignore",
    "uv.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "composer.lock",
}
SKIP_PARTS = ("node_modules/", "vendor/", ".git/", "__pycache__/", ".venv/")


def _git(*args: str) -> str:
    out = subprocess.run(["git", *args], capture_output=True, text=True, check=False)
    return out.stdout if out.returncode == 0 else ""


def _candidates(command: str) -> list[str]:
    """Files the commit will carry: already staged, plus what a chained `git add` / `-a` adds."""
    files = [
        f for f in _git("diff", "--cached", "--name-only", "--diff-filter=ACM").splitlines() if f
    ]
    commit = re.search(r"git(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+commit\s+(.*)", command)
    if commit and re.search(r"(^|\s)-\w*a", commit.group(1)):
        files += [f for f in _git("diff", "--name-only").splitlines() if f]
    for part in re.split(r"&&|;|\|\|", command):
        add = re.match(r"\s*git(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+add\s+(.+)", part)
        if not add:
            continue
        args = add.group(1).split()
        if any(a in (".", "-A", "--all") for a in args):
            for line in _git("status", "--porcelain").splitlines():
                if len(line) > 3:
                    files.append(line[3:].strip().strip('"'))
        else:
            files += [a for a in args if not a.startswith("-")]
    seen: list[str] = []
    for f in files:
        f = f.replace("\\", "/")
        if f not in seen and os.path.isfile(f):
            seen.append(f)
    return seen


def _skip(path: str) -> bool:
    if os.path.basename(path) in SKIP_NAMES or any(p in path for p in SKIP_PARTS):
        return True
    try:
        with open(path, "rb") as fh:
            return b"\0" in fh.read(2048)
    except OSError:
        return True


def _scan(path: str) -> list[tuple[int, str]]:
    in_tests = path.startswith("tests/")
    hits: list[tuple[int, str]] = []
    with open(path, encoding="utf-8", errors="ignore") as fh:
        for number, line in enumerate(fh, 1):
            for pattern, kind, generic in _COMPILED:
                if generic and in_tests:
                    continue
                if pattern.search(line):
                    hits.append((number, kind))
    return hits


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    command = str(payload.get("tool_input", {}).get("command", ""))
    if not re.search(r"git(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+commit", command):
        return 0
    findings = [
        (path, n, kind)
        for path in _candidates(command)
        if not _skip(path)
        for n, kind in _scan(path)
    ]
    if not findings:
        return 0
    print("SECRET SCANNER: commit blocked - possible secret(s), values not shown:", file=sys.stderr)
    for path, number, kind in findings[:30]:
        print(f"  {path}:{number}  {kind}", file=sys.stderr)
    if len(findings) > 30:
        print(f"  ... and {len(findings) - 30} more", file=sys.stderr)
    print(
        "Move the value to a git-ignored .env (or the platform's secret store) and read it from "
        "the environment. A false positive in a test fixture belongs under tests/ (generic "
        "patterns are skipped there).",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
