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


_COMB = re.compile(ASSIGN.pattern + r"|\$\{(\w+)\}|\$(\w+)")
_AMBIGUOUS = re.compile(r"\beval\b|\bread\b|printf\s+-v|\b(?:declare|typeset|export)\s+-n|\$\{[^}]*[^\w}][^}]*\}|\$\{!")
_MAX_CMD = 64 * 1024
_MAX_VALUE = 4096


def _expand_assignments(command: str) -> str | None:
    """Expand in-command assignments the way the shell does: strictly left to right, each value expanded against what is already set
    (`a=.e; a=${a}nv; cat $a` -> `cat .env`; a name not set yet stays literal, as in the shell). The size is checked BEFORE every
    substitution: past 4x the original (floor 1 KB, cap 64 KB), a value over 4 KB, or an ambiguous construct (eval, read, `${a:-x}`, indirection)
    next to an assignment returns None and the caller blocks."""
    if len(command) > _MAX_CMD:
        return None
    if ASSIGN.search(command) and _AMBIGUOUS.search(command):
        return None
    limit = min(_MAX_CMD, max(4 * len(command), 1024))
    env: dict[str, str] = {}
    out: list[str] = []
    size = pos = 0

    def put(text: str) -> bool:
        nonlocal size
        size += len(text)
        out.append(text)
        return size <= limit

    for m in _COMB.finditer(command):
        if not put(command[pos:m.start()]):
            return None
        pos = m.end()
        if m.group(1):  # assignment: the value is expanded against the values set so far, the text itself stays as written
            val = m.group(2).strip("'\"")
            sq = m.group(2).startswith("'")  # single quotes: no expansion
            if not sq:
                parts, p = [], 0
                for r in re.finditer(r"\$\{(\w+)\}|\$(\w+)", val):
                    parts.append(val[p:r.start()]); p = r.end()
                    parts.append(env.get(r.group(1) or r.group(2), r.group(0)))
                    if sum(map(len, parts)) > _MAX_VALUE:
                        return None
                parts.append(val[p:]); val = "".join(parts)
            if len(val) > _MAX_VALUE:
                return None
            env[m.group(1)] = val
            if not put(m.group(0)):
                return None
        else:
            name = m.group(3) or m.group(4)
            ref = m.group(0)
            if not put(env.get(name, ref)):
                return None
    if not put(command[pos:]):
        return None
    return "".join(out)


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
    if len(command) > _MAX_CMD:
        return "command too long to inspect"
    if _subst_glued(command):  # what a substitution prints is unknown: fail closed on secret-ish tokens
        return "command substitution inside a path-like token"
    for text in _variants(command):  # the unexpanded command first: a plain secret path always blocks, whatever expansion does next
        for tok in SPLIT.split(text):
            if _hit(tok):
                return tok
    expanded = _expand_assignments(command)
    if expanded is None:
        return "variable expansion grows without bound"
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
