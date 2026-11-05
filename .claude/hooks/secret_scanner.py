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
import shlex
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
    # unquoted `.env` lines (DB_PASSWORD=...) and JSON ("token":"..."): 16+ value chars holding a digit, so identifiers stay clean
    (r"(?i)(?:api[_\-]?key|secret|token|passw(?:or)?d)['\"]?\s*[=:]\s*['\"]?(?=[0-9A-Za-z\-_/+]*\d)[0-9A-Za-z\-_/+]{16,}", "unquoted or JSON secret", True),
]
COMMIT_ALL = re.compile(r"(^|\s)(-[A-Za-z]*a[A-Za-z]*|--all)\b")
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


_ORIG = [os.getcwd()]  # the hook's cwd before the chdir to the repo root
_TOP = [""]
_STAGED: set[str] = set()
_READD = [False]
_WORK: set[str] = set()  # paths whose working copy must be scanned too (re-added by the command)


def _texts(path: str) -> list[bytes]:
    """Every version the commit may carry: the staged blob, and the working file when re-added."""
    out: list[bytes] = []
    if path in _STAGED:
        r = subprocess.run(["git", "show", f":{path}"], capture_output=True, check=False)
        if r.returncode == 0:
            out.append(r.stdout)
    if path not in _STAGED or path in _WORK:
        try:
            with open(path, "rb") as fh:
                out.append(fh.read())
        except OSError:
            pass
    return out


_VALUE_OPTS = {"-m", "-F", "-C", "-c", "-t", "--message", "--file", "--author", "--date", "--template", "--reuse-message", "--reedit-message", "--cleanup", "--trailer", "-S", "--pathspec-from-file"}


def _abs(p: str) -> str:
    return p if os.path.isabs(p) else os.path.join(_ORIG[0], p)


def _rel(p: str) -> str:
    """A path typed in the command is relative to the original cwd; make it repo-root relative."""
    if not _TOP[0]:
        return p
    try:
        return os.path.relpath(_abs(p), _TOP[0]).replace("\\", "/")
    except ValueError:
        return p


def _pathspec_file(f: str) -> list[str]:
    """Pathspecs named in a --pathspec-from-file; `-` (stdin) cannot be read, so the commit is a re-add."""
    try:
        with open(_abs(f), encoding="utf-8", errors="ignore") as fh:
            text = fh.read().replace(chr(0), chr(10))
    except OSError:
        return []
    return [x.strip().strip(chr(34)).replace(chr(92), "/") for x in text.splitlines() if x.strip()]


_LONG = ("pathspec-from-file", "all", "include", "only", "amend", "no-verify", "quiet", "verbose", "signoff",
         "no-edit", "allow-empty", "allow-empty-message", "dry-run", "status", "no-status", "edit", "short",
         "branch", "porcelain", "long", "null", "no-post-rewrite", "squash", "fixup", "reset-author",
         "gpg-sign", "no-gpg-sign", "pathspec-file-nul", "untracked-files", "interactive", "patch")


def _canon(t: str) -> str:
    """git accepts abbreviated long options: expand them; an unknown long option is a re-add (fail closed)."""
    if not t.startswith("--") or t == "--":
        return t
    key, eq, val = t[2:].partition("=")
    names = _LONG + tuple(v[2:] for v in _VALUE_OPTS if v.startswith("--"))
    if key in names:
        return t
    hits = {f for f in names if len(key) >= 3 and f.startswith(key)}
    if len(hits) == 1:
        return "--" + hits.pop() + eq + val
    return "--all"  # unknown or ambiguous: scan the working files too


def _commit_args(rest: str) -> tuple[bool, list[str]]:
    """(re-adds files?, pathspecs) for the text after `git commit`."""
    try:
        toks = shlex.split(re.split(r"&&|;|\|\|", rest)[0])
    except ValueError:
        toks = rest.split()
    readd, paths, skip, dd, pf = False, [], False, False, False
    for t in map(_canon, toks):
        if skip:
            skip = False
            if pf:  # value of `--pathspec-from-file F`
                paths += _pathspec_file(t); pf = False
        elif t.startswith("--pathspec-from-file="):
            readd = True; paths += _pathspec_file(t.split("=", 1)[1])
        elif t == "--pathspec-from-file":
            readd = pf = skip = True
        elif dd or not t.startswith("-"):
            paths.append(t.replace("\\", "/")); readd = True
        elif t == "--":
            dd = True
        elif t in _VALUE_OPTS:
            skip = True
        elif t in ("--all", "--include", "--only") or (not t.startswith("--") and re.search("[aio]", t[1:])):
            readd = True
    return readd, paths


def _candidates(command: str) -> list[str]:
    """Files the commit will carry: already staged, plus what a chained `git add` / `-a` adds."""
    files = [
        f for f in _git("diff", "--cached", "--name-only", "--diff-filter=ACM").splitlines() if f
    ]
    _STAGED.update(f.replace("\\", "/") for f in files)
    commit = re.search(r"git(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+commit\s+(.*)", command)
    if commit:
        readd, paths = _commit_args(commit.group(1))
        if COMMIT_ALL.search(commit.group(1)) or readd:
            _READD[0] = True
            files += [f for f in _git("diff", "--name-only").splitlines() if f] + [_rel(x) for x in paths]
    for part in re.split(r"&&|;|\|\|", command):
        add = re.match(r"\s*git(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+add\s+(.+)", part)
        if not add:
            continue
        _READD[0] = True
        args = add.group(1).split()
        if any(a in (".", "-A", "--all") for a in args):
            for line in _git("status", "--porcelain").splitlines():
                if len(line) > 3:
                    files.append(line[3:].strip().strip('"'))
        else:
            files += [_rel(a) for a in args if not a.startswith("-")]
    seen: list[str] = []
    for f in files:
        f = f.replace("\\", "/")
        if f not in seen and (f in _STAGED or os.path.isfile(f)):
            seen.append(f)
    if _READD[0]:
        _WORK.update(seen)
    return seen


def _skip(path: str) -> bool:
    if os.path.basename(path) in SKIP_NAMES or any(p in path for p in SKIP_PARTS):
        return True
    return all(b"\0" in t[:2048] for t in _texts(path))


def _scan(path: str) -> list[tuple[int, str]]:
    in_tests = path.startswith("tests/")
    hits: list[tuple[int, str]] = []
    for blob in _texts(path):
        for number, line in enumerate(blob.decode("utf-8", "ignore").splitlines(), 1):
            for pattern, kind, generic in _COMPILED:
                if generic and in_tests:
                    continue
                if pattern.search(line) and (number, kind) not in hits:
                    hits.append((number, kind))
    return hits


def main() -> int:
    top = _git("rev-parse", "--show-toplevel").strip()
    if top:
        _TOP[0] = top
        os.chdir(top)
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        print("secret_scanner: unreadable hook input, blocked (fail closed)", file=sys.stderr)
        return 2
    ti = payload.get("tool_input", {}) if isinstance(payload, dict) else None
    if not isinstance(ti, dict) or not isinstance(ti.get("command", ""), str):
        print("secret_scanner: hook input has no usable tool_input.command, blocked (fail closed)", file=sys.stderr)
        return 2
    command = ti.get("command", "")
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


def _safe_main() -> int:
    """Any crash (null or deeply nested JSON, RecursionError, a bug) blocks with a clear message instead of a traceback and exit 1."""
    try:
        return main()
    except Exception as e:  # noqa: BLE001 - fail closed on everything, RecursionError included
        print("SECRET SCANNER: hook crashed (" + type(e).__name__ + "), blocked (fail closed)", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(_safe_main())
