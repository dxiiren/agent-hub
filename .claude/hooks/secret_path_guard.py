#!/usr/bin/env python3
"""PreToolUse hook: block Bash/PowerShell commands that reference secret files (.env, *.pem,
*.key, id_rsa*, credentials*), which the Read/Edit deny rules cannot cover via cat/grep/curl.
Fails closed: unparsable input exits 2. Exit 2 = blocked.
text guard = guardrail, not a sandbox; residual risk documented (see docs: a text scan of shell commands always has differentials)."""
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
_MAX_CMD = 64 * 1024
_MAX_VALUE = 4096
_MAX_TEXTS = 64
# With a variable reference present, none of these constructs is analysed: the command is blocked outright (false positives accepted, rephrase).
_NO_ANALYSIS = re.compile(
    r"(?:^|[;&|(\s])(?:function|for|while|until|trap|eval|source|read|mapfile|readarray|getopts|let|alias|printf\s+-v)(?![\w-])"
    r"|(?:^|[;&|(\s])\.\s"                                  # `. file`
    r"|\w\s*\(\s*\)"                                       # name() { ...; }
    r"|(?:^|[;&|(\s])(?:declare|typeset|local|export|readonly)\s+-[A-Za-z]*n"  # nameref, any option cluster
    r"|(?:^|[;&|(\s])(?:declare|typeset|local)(?![\w-])"
    r"|\$\{[^}]*[^\w}][^}]*\}|\$\{!"                         # ${x:-w} ${x-w} ${x:=w} ${x+w} ${x#p} ${x%p} ${x/p/r} ${!x}
    r"|\$\(\(|\$\["                                        # arithmetic
    r"|\w=\(|\w\[[^\]]*\]=|\$\{\w+\[")                      # arrays
_REF = re.compile(r"\$\{(\w+)\}|\$(\w+)")
_ANYREF = re.compile(r"\$[{\w]")


def _unanalysable(command: str) -> str | None:
    """Fail-closed pre-check: a variable reference next to a construct the text scan cannot follow, or a reference to a variable assigned LATER."""
    if not _ANYREF.search(command):
        return None
    m = _NO_ANALYSIS.search(command)
    if m:
        return "variable reference combined with a shell construct that cannot be analysed: " + m.group(0).strip()[:30]
    first: dict[str, int] = {}
    for am in ASSIGN.finditer(command):
        first.setdefault(am.group(1), am.start(1))
    for r in _REF.finditer(command):
        n = r.group(1) or r.group(2)
        if n in first and r.start() < first[n]:
            return "reference to variable " + n + " before it is assigned"
    return None


def _expand_assignments(command: str) -> str | None:
    """Pass 1: expand in-command assignments the way the shell does, strictly left to right, each value against what is already set
    (`a=.e; a=${a}nv; cat $a` -> `cat .env`; an unset name stays literal). References inside assignment text are expanded too, so
    `name=<expanded>` is scanned. Sizes are checked BEFORE every substitution (4x the original, floor 1 KB, cap 64 KB; value cap 4 KB);
    over the cap returns None and the caller blocks."""
    if len(command) > _MAX_CMD:
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
        if m.group(1):
            raw = m.group(2)
            val = raw.strip("'\"")
            if not raw.startswith("'"):
                parts, p = [], 0
                for r in _REF.finditer(val):
                    parts.append(val[p:r.start()]); p = r.end()
                    parts.append(env.get(r.group(1) or r.group(2), r.group(0)))
                    if sum(map(len, parts)) > _MAX_VALUE:
                        return None
                parts.append(val[p:]); val = "".join(parts)
            if len(val) > _MAX_VALUE:
                return None
            env[m.group(1)] = val
            if not put(m.group(0)[: len(m.group(0)) - len(raw)] + val):
                return None
        elif not put(env.get(m.group(3) or m.group(4), m.group(0))):
            return None
    return "".join(out) if put(command[pos:]) else None


def _expand_all(command: str) -> list[str] | None:
    """Pass 2, order independent: every possible value of every assigned variable (all assignments, any order), cap-checked.
    None = over a cap (blocks)."""
    if len(command) > _MAX_CMD:
        return None
    limit = min(_MAX_CMD, max(4 * len(command), 1024))
    vals: dict[str, set[str]] = {}
    for m in ASSIGN.finditer(command):
        v = m.group(2).strip("'\"")
        if len(v) > _MAX_VALUE:
            return None
        vals.setdefault(m.group(1), set()).add(v)
    texts = {command}
    for _ in range(4):
        changed = False
        for name, values in vals.items():
            pat = re.compile(r"\$\{" + re.escape(name) + r"\}|\$" + re.escape(name) + r"(?![A-Za-z0-9_])")
            nxt: set[str] = set()
            for t in texts:
                if not pat.search(t):
                    nxt.add(t)
                    continue
                changed = True
                for v in values:
                    if len(t) + len(pat.findall(t)) * len(v) > limit:  # checked before substituting
                        return None
                    nxt.add(pat.sub(lambda _m, v=v: v, t))
                if len(nxt) > _MAX_TEXTS:
                    return None
            texts = nxt
        if not changed:
            break
    return list(texts)


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


def _scan(text: str, depth: int) -> str | None:
    for m in SUBST.finditer(text):  # a standalone substitution: scan its body, block secret-ish words (nested ones are found inner-first)
        body = m.group(0)[2:-1] if m.group(0).startswith("$(") else m.group(0)[1:-1]
        if depth < 5 and blocked(body, depth + 1):
            return "command substitution: " + body[:40]
        if SUBST_WORDS.search(body):
            return "command substitution mentions a secret-ish word: " + body[:40]
    for v in _variants(text):
        for tok in SPLIT.split(v):
            if _hit(tok):
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
    why = _unanalysable(command)
    if why:
        return why
    left_to_right = _expand_assignments(command)
    every = _expand_all(command)
    if left_to_right is None or every is None:
        return "variable expansion grows without bound"
    for text in [command, left_to_right, *every]:
        hit = _scan(text, _depth)
        if hit:
            return hit
    glued = _var_glued(command)
    return glued


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
