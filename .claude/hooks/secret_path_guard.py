#!/usr/bin/env python3
"""PreToolUse hook: block Bash/PowerShell commands that reference secret files (.env, *.pem,
*.key, id_rsa*, credentials*), which the Read/Edit deny rules cannot cover via cat/grep/curl.
Fails closed: unparsable input exits 2. Exit 2 = blocked."""
import json
import re
import sys

import fnmatch
import glob
import os

SAFE = re.compile(r"\.(?:example|sample|stub|template)$", re.I)
SPLIT = re.compile(r"[\s'\"=<>@:,;|&()`]+")
PLAIN = re.compile(r"^(?:\.env(?:\..*)?|.*\.(?:pem|key)|id_rsa.*|credentials.*)$", re.I)
SAMPLES = (".env", ".env.local", ".env.production", "server.pem", "server.key", "id_rsa", "credentials.json")


def _hit(tok: str) -> bool:
    name = tok.rsplit("/", 1)[-1]
    if not name or SAFE.search(name):
        return False
    if any(c in name for c in "*?["):
        if any(fnmatch.fnmatchcase(x, name) for x in SAMPLES) and name.strip("*?[]./"):
            return True
        # wildcard-only globs (`*`, `.*`) are judged by what they expand to in the cwd
        try:
            found = glob.glob(tok)[:2000]
        except (OSError, ValueError):
            found = []
        return any(PLAIN.match(f.replace("\\", "/").rsplit("/", 1)[-1])
                   and not SAFE.search(f) for f in found)
    return bool(PLAIN.match(name))


def _variants(command: str) -> list[str]:
    """Texts to scan: obfuscation (`$`, `{}`, backslash escapes, quotes, empty vars) is peeled off."""
    cmd = command.replace("\\", "/")
    raw = re.sub(r"['\"]", "", command)          # backslashes kept as escapes, quotes joined
    no_esc = raw.replace("\\", "")               # drop escape backslashes
    no_var = re.sub(r"\$\{[^}]*\}|\$[@*#?!0-9]|\$[A-Za-z_]\w*", "", no_esc)  # `.e${x}nv`, `.e$@nv`
    ifs = re.sub(r"\$\{IFS\}|\$IFS(?![A-Za-z0-9_])", " ", no_esc)
    var_sp = re.sub(r"\$\{[^}]*\}|\$[@*#?!0-9]|\$[A-Za-z_]\w*", "", ifs)  # `cat${IFS}.e${x}nv`
    no_brace = re.sub(r"[{}$]", "", no_var)       # `.{env}`, `$'.env'`
    return [cmd, re.sub(r"['\"]", "", cmd), no_esc, no_var, var_sp, no_brace]


def blocked(command: str) -> str | None:
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
