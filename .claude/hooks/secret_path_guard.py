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
# keys: any ssh key name (id_rsa/dsa/ecdsa/ed25519/xmss with any suffix, any extensionless id_*, id_*.ppk/pem/key), *.ppk;
# credentials with an optional leading dot (~/.claude/.credentials.json)
PLAIN = re.compile(r"^(?:\.env(?:\..*)?|.*\.(?:pem|key|ppk|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519|xmss).*|id_[^.]*|id_.*\.(?:ppk|pem|key)|\.?credentials.*)$", re.I)
SAMPLES = (".env", ".env.local", ".env.production", "server.pem", "server.key", "server.ppk", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials.json", ".credentials.json")


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


VARREF = re.compile(r"\$\{[^}]*\}|\$[A-Za-z_]\w*")
ASSIGN = re.compile(r"(?:^|[;&|\s])(?:export\s+|declare\s+|local\s+|typeset\s+)?([A-Za-z_]\w*)=(\"[^\"]*\"|'[^']*'|[^\s;&|]*)")
SUBST_WORDS = re.compile(r"\benv\b|\.env|pem|\bkey|id_|cred|ppk|secret|passw", re.I)


def _expand_assignments(command: str) -> str:
    """Expand simple in-command assignments (`x=.e; cat ${x}nv`) so the real name is scanned; chains are followed a few passes."""
    vals = {m.group(1): m.group(2).strip("'\"") for m in ASSIGN.finditer(command)}
    out = command
    for _ in range(4):
        prev = out
        for k, v in vals.items():
            out = re.sub(r"\$\{" + re.escape(k) + r"\}|\$" + re.escape(k) + r"(?![A-Za-z0-9_])", lambda _m, v=v: v, out)
        if out == prev:
            break
    return out


def _var_glued(command: str) -> str | None:
    """A variable glued to a name fragment (`${x}nv`, `$a.pem`) can build a secret name from a value we cannot see (set earlier, exported):
    fail closed when the last path component, with each variable as a wildcard, could be a secret file name."""
    for tok in re.split(r"[\s;|&<>()'\"=,:@`]+", command):
        comp = tok.rsplit("/", 1)[-1]
        if not VARREF.search(comp) or re.fullmatch(r"(?:\$\{IFS\}|\$IFS)+", comp):
            continue
        glob = VARREF.sub("*", comp.replace("${IFS}", " ")).lower()
        if len(glob.replace("*", "")) >= 2 and any(fnmatch.fnmatchcase(s, glob) for s in SAMPLES):
            return tok
    return None


def blocked(command: str, _depth: int = 0) -> str | None:
    if _subst_glued(command):  # what a substitution prints is unknown: fail closed on secret-ish tokens
        return "command substitution inside a path-like token"
    expanded = _expand_assignments(command)
    for text in (command, expanded):
        for m in SUBST.finditer(text):  # a standalone substitution: scan its body, block secret-ish words (nested ones are found inner-first)
            body = m.group(0)[2:-1] if m.group(0).startswith("$(") else m.group(0)[1:-1]
            if _depth < 5 and blocked(body, _depth + 1):
                return "command substitution: " + body[:40]
            if SUBST_WORDS.search(body):
                return "command substitution mentions a secret-ish word: " + body[:40]
    glued = _var_glued(command)
    if glued:
        return glued
    for base in {command, expanded}:
        for text in _variants(base):
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
