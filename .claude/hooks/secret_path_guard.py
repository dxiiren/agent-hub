#!/usr/bin/env python3
"""PreToolUse hook: block Bash/PowerShell commands that reference secret files (.env, *.pem,
*.key, id_rsa*, credentials*), which the Read/Edit deny rules cannot cover via cat/grep/curl.
Fails closed: unparsable input exits 2. Exit 2 = blocked."""
import json
import re
import sys

SECRET = re.compile(
    r"""(?ix)(?:^|[\s/\'"=<>@:])
    (?:\.env(?:\.[\w.-]*)?|[\w.*?/\-]*\.(?:pem|key)|id_rsa[\w.*-]*|credentials[\w.*-]*)
    (?=$|[\s'"|;&)<>])""")
SAFE = re.compile(r"\.(?:example|sample|stub|template)$", re.I)


def blocked(command: str) -> str | None:
    for m in SECRET.finditer(command):
        if not SAFE.search(m.group(0).strip(" \t'\"=<>@:")):
            return m.group(0).strip()
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
