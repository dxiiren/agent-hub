#!/usr/bin/env python3
"""PreToolUse hook: block Bash/PowerShell commands that reference secret files (.env, *.pem,
*.key, id_rsa*, credentials*), which the Read/Edit deny rules cannot cover via cat/grep/curl.
Fails closed: unparsable input exits 2. Exit 2 = blocked."""
import json
import re
import sys

import fnmatch
import os
import time

SAFE = re.compile(r"\.(?:example|sample|stub|template)$", re.I)
SPLIT = re.compile(r"[\s'\"=<>@:,;|&()`]+")
PLAIN = re.compile(r"^(?:\.env(?:\..*)?|.*\.(?:pem|key)|id_rsa.*|credentials.*)$", re.I)
SAMPLES = (".env", ".env.local", ".env.production", "server.pem", "server.key", "id_rsa", "credentials.json")


_BUDGET = 5000  # max directory entries looked at per token
_SECONDS = 0.25  # wall-clock budget per token; running out blocks (fail closed)


def _expand(name: str) -> list[str] | None:
    """Plain wildcard name in the cwd, shell-like (dotfiles only for a leading dot).
    Bounded while expanding; None = budget exhausted (caller blocks)."""
    out: list[str] = []
    end = time.monotonic() + _SECONDS
    try:
        with os.scandir(".") as it:
            for n, e in enumerate(it):
                if n >= _BUDGET or time.monotonic() > end:
                    return None
                if (e.name[0] != "." or name[0] == ".") and fnmatch.fnmatchcase(e.name, name):
                    out.append(e.name)
    except OSError:
        pass
    return out


def _hit(tok: str) -> bool:
    name = tok.rsplit("/", 1)[-1]
    if not name or SAFE.search(name):
        return False
    if not any(c in name for c in "*?["):
        return bool(PLAIN.match(name))
    # glob in the last component: literal checks first, the filesystem only for a plain cwd name
    if name.strip("*?[]./"):
        return any(fnmatch.fnmatchcase(x, name) for x in SAMPLES)
    if "/" in tok or ".." in tok:
        return True  # wildcard-only name behind a path (absolute, UNC, ../, a/*/*): fail closed
    found = _expand(name)
    return found is None or any(PLAIN.match(f) and not SAFE.search(f) for f in found)


def _variants(command: str) -> list[str]:
    """Texts to scan: obfuscation (`$`, `{}`, backslash escapes, quotes, empty vars) is peeled off."""
    command = SUBST.sub("", command)  # a substitution (`$(true)`, backticks) is dropped before anything else
    cmd = command.replace("\\", "/")
    raw = re.sub(r"['\"]", "", command)          # backslashes kept as escapes, quotes joined
    no_esc = raw.replace("\\", "")               # drop escape backslashes
    no_var = re.sub(r"\$\{[^}]*\}|\$[@*#?!0-9]|\$[A-Za-z_]\w*", "", no_esc)  # `.e${x}nv`, `.e$@nv`
    ifs = re.sub(r"\$\{IFS\}|\$IFS(?![A-Za-z0-9_])", " ", no_esc)
    var_sp = re.sub(r"\$\{[^}]*\}|\$[@*#?!0-9]|\$[A-Za-z_]\w*", "", ifs)  # `cat${IFS}.e${x}nv`
    no_brace = re.sub(r"[{}$]", "", no_var)       # `.{env}`, `$'.env'`
    return [cmd, re.sub(r"['\"]", "", cmd), no_esc, no_var, var_sp, no_brace]


SUBST = re.compile(r"\$\([^()]*\)|`[^`]*`")
SECRETISH = re.compile(r"\.e|\.p|\.k|env|pem|key|id_|cred", re.I)


def _subst_glued(command: str) -> bool:
    """A command substitution touching a path-like token can assemble a secret name at run time
    (`.e$(true)nv`, `.e``nv`): fail closed when what is left of that token looks secret-ish."""
    for m in re.finditer(r"[^\s;|&<>()]*(?:\$\([^()]*\)|`[^`]*`)[^\s;|&<>()]*", command):
        left = SUBST.sub("", m.group(0))
        if left != m.group(0) and left.strip("'\"") and SECRETISH.search(left):
            return True
    return False


def blocked(command: str) -> str | None:
    if _subst_glued(command):  # what a substitution prints is unknown: fail closed on secret-ish tokens
        return "command substitution inside a path-like token"
    for text in _variants(command):
        for tok in SPLIT.split(text):
            if _hit(tok):
                return tok
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        command = str(payload["tool_input"]["command"])
    except (ValueError, KeyError, TypeError):
        print("secret_path_guard: unreadable hook input, blocked (fail closed)", file=sys.stderr)
        return 2
    hit = blocked(command)
    if hit:
        print(f"SECRET PATH GUARD: command references a protected secret path ({hit}); use the "
              "environment or the platform secret store instead.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
