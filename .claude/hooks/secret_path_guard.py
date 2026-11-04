#!/usr/bin/env python3
"""PreToolUse hook: block Bash/PowerShell commands that reference secret files (.env, *.pem,
*.key, id_rsa*, credentials*), which the Read/Edit deny rules cannot cover via cat/grep/curl.
Fails closed: unparsable input exits 2. Exit 2 = blocked."""
import json
import re
import sys

import fnmatch

SAFE = re.compile(r"\.(?:example|sample|stub|template)$", re.I)
SPLIT = re.compile(r"[\s'\"=<>@:,;|&()`]+")
PLAIN = re.compile(r"^(?:\.env(?:\..*)?|.*\.(?:pem|key)|id_rsa.*|credentials.*)$", re.I)
SAMPLES = (".env", ".env.local", ".env.production", "server.pem", "server.key", "id_rsa", "credentials.json")


def _hit(tok: str) -> bool:
    name = tok.rsplit("/", 1)[-1]
    if not name or SAFE.search(name):
        return False
    if any(c in name for c in "*?["):
        # a glob made only of wildcards and dots (`*`, `.*`) is too broad to call a secret
        return bool(name.strip("*?[]./")) and any(fnmatch.fnmatchcase(x, name) for x in SAMPLES)
    return bool(PLAIN.match(name))


def blocked(command: str) -> str | None:
    cmd = command.replace("\\", "/")
    # check the text with quotes as separators and with quotes removed (".e""nv" joins up)
    for text in (cmd, re.sub(r"['\"]", "", cmd)):
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
