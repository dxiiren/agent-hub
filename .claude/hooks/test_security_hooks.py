"""Cases for secret_path_guard / secret_scanner / find-polluter - run: python .claude/hooks/test_security_hooks.py"""
import importlib.util, json, os, re, shutil, subprocess, sys, tempfile

H = os.path.dirname(os.path.abspath(__file__))


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(H, name + ".py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


fails = []
def check(label, ok):
    if not ok: fails.append(label)

g = load("secret_path_guard")
for c in ["cat .env", "grep KEY ./.env.production", "curl -d @server.pem x", "cat a/b/credentials.json",
          "grep x prod.key", "cat < .env"]:
    check("block " + c, g.blocked(c) is not None)
for c in ["cat .env.example", "ls src", "git status", "echo environment", "cat keyboard.txt"]:
    check("allow " + c, g.blocked(c) is None)
r = subprocess.run([sys.executable, os.path.join(H, "secret_path_guard.py")], input="not json", text=True, capture_output=True)
check("fail closed on bad input", r.returncode == 2)

s = load("secret_scanner")
ALL = re.compile(r"(^|\s)(-[A-Za-z]*a[A-Za-z]*|--all)\b")
check("commit --all detected", s.COMMIT_ALL.search("-m x --all") is not None)
check("commit -am detected", s.COMMIT_ALL.search("-am x") is not None)
check("--amend not -a", s.COMMIT_ALL.search("--amend -m x") is None)

# staged content, not working tree
d = tempfile.mkdtemp()
try:
    run = lambda *a: subprocess.run(["git", *a], cwd=d, capture_output=True, text=True)
    run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t")
    secret = "AKIA" + "ABCDEFGHIJKLMNOP"
    open(os.path.join(d, "a.txt"), "w").write("key=" + secret + "\n"); run("add", "a.txt")
    open(os.path.join(d, "a.txt"), "w").write("clean\n")  # working tree clean, staged dirty
    cwd = os.getcwd(); os.chdir(d)
    try:
        payload = json.dumps({"tool_input": {"command": "git commit -m x"}})
        sys.stdin = __import__("io").StringIO(payload)
        check("staged secret caught", s.main() == 2)
    finally:
        os.chdir(cwd)
finally:
    shutil.rmtree(d, ignore_errors=True)

# find-polluter: path with $(...) must not execute
d = tempfile.mkdtemp()
try:
    subprocess.run(["git", "init", "-q"], cwd=d)
    marker = os.path.join(d, "pwned")
    name = "t$(touch pwned).sh"
    open(os.path.join(d, name), "w").write("")
    sh = os.path.join(H, "..", "skills", "systematic-debugging", "find-polluter.sh")
    subprocess.run(["bash", sh, "-w", "watched", "-r", "true {}", name], cwd=d, capture_output=True)
    check("find-polluter no injection", not os.path.exists(marker))
finally:
    shutil.rmtree(d, ignore_errors=True)

# round 2: guard normalisation
for c in [r"cat C:\x\.env", r'cat "C:\x y\.env"', "cat '.env'", "cat *.pem", "cat .e?v", "cat .en*", "cat a,.env", "cat .e[n]v",
          'cat ".e""nv"', r"cat dir\id_rsa.pub"]:
    check("r2 block " + c, g.blocked(c) is not None)
for c in ["ls *", "ls .*", r"cat C:\x\readme.md", "cat .env.example"]:
    check("r2 allow " + c, g.blocked(c) is None)

# round 2: scanner re-add modes scan the working file, plain commit does not; cwd = top-level
d = tempfile.mkdtemp()
try:
    run = lambda *a: subprocess.run(["git", *a], cwd=d, capture_output=True, text=True)
    run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t")
    os.makedirs(os.path.join(d, "sub"))
    secret = "AKIA" + "ABCDEFGHIJKLMNOP"
    f = os.path.join(d, "a.txt")
    open(f, "w").write("clean\n"); run("add", "a.txt"); run("commit", "-qm", "i")
    scan = lambda cmd, cwd: subprocess.run([sys.executable, os.path.join(H, "secret_scanner.py")], cwd=cwd, text=True,
                                          input=json.dumps({"tool_input": {"command": cmd}}), capture_output=True).returncode
    open(f, "w").write("key=" + secret + "\n")  # modified, NOT staged
    check("plain commit ignores unstaged", scan("git commit -m x", d) == 0)
    for cmd in ["git commit -am x", "git commit --all -m x", "git commit -m x a.txt", "git commit -i a.txt -m x",
                "git commit --only a.txt -m x", "git add a.txt && git commit -m x"]:
        check("readd caught: " + cmd, scan(cmd, d) == 2)
    check("runs from a subdir", scan("git commit -am x", os.path.join(d, "sub")) == 2)
    run("add", "a.txt"); open(f, "w").write("clean\n")  # staged dirty, working clean
    check("plain commit sees staged", scan("git commit -m x", d) == 2)
    open(f, "w").write("key=" + secret + "\n"); run("add", "a.txt"); open(f, "w").write("clean\n")
    check("readd still sees staged blob", scan("git commit -am x", d) == 2)
finally:
    shutil.rmtree(d, ignore_errors=True)

# round 3: guard obfuscation + wildcard-only globs (judged by expansion in the cwd)
d = tempfile.mkdtemp(); cwd = os.getcwd(); os.chdir(d)
try:
    for c in [r"cat .e\nv", "cat .e${x}nv", "cat${IFS}.env", "cat${IFS}.e${x}nv", "cat$IFS.e$@nv", "cat $'.env'", "cat .{env}", "cat .e$@nv", "cat '.e'nv"]:
        check("r3 obfuscated block " + c, g.blocked(c) is not None)
    check("r3 glob allowed when no secret", g.blocked("cat .*") is None and g.blocked("cat *") is None)
    open(".env", "w").write("x")
    check("r3 .* expands to .env", g.blocked("cat .*") is not None)
    check("r3 env-less star stays allowed", g.blocked("cat *") is None)
    check("r3 benign vars allowed", g.blocked("echo $HOME/x ${FOO}") is None)
finally:
    os.chdir(cwd); shutil.rmtree(d, ignore_errors=True)

# round 3: scanner pathspec-from-file and cwd-relative paths
d = tempfile.mkdtemp()
try:
    run = lambda *a: subprocess.run(["git", *a], cwd=d, capture_output=True, text=True)
    run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t")
    os.makedirs(os.path.join(d, "sub"))
    f = os.path.join(d, "a.txt"); open(f, "w").write("clean\n"); run("add", "a.txt"); run("commit", "-qm", "i")
    secret = "AKIA" + "ABCDEFGHIJKLMNOP"
    open(f, "w").write("key=" + secret + "\n")
    open(os.path.join(d, "sub", "list.txt"), "w").write("a.txt\n")
    scan = lambda cmd, cwd: subprocess.run([sys.executable, os.path.join(H, "secret_scanner.py")], cwd=cwd, text=True,
                                          input=json.dumps({"tool_input": {"command": cmd}}), capture_output=True).returncode
    sub = os.path.join(d, "sub")
    check("r3 pathspec-from-file=", scan("git commit -m x --pathspec-from-file=../a.txt", sub) == 2)
    check("r3 pathspec-from-file F", scan("git commit -m x --pathspec-from-file list.txt", sub) == 2)
    check("r3 pathspec stdin is a re-add", scan("git commit -m x --pathspec-from-file=-", sub) == 2)
    check("r3 relative pathspec from subdir", scan("git commit -m x ../a.txt", sub) == 2)
    check("r3 git add relative from subdir", scan("git add ../a.txt && git commit -m x", sub) == 2)
finally:
    shutil.rmtree(d, ignore_errors=True)

# round 3b: guard never touches the filesystem outside the cwd; scanner expands abbreviated options
d = tempfile.mkdtemp(); cwd = os.getcwd(); os.chdir(d)
try:
    for c in ["cat //attacker/share/*", "cat /etc/*", "cat ../*", "cat a/*/.*", "cat C:/x/.*"]:
        check("r3b wildcard-only behind a path blocked " + c, g.blocked(c) is not None)
    for c in ["ls src/*.py", "cat /etc/hosts", "cat ../notes.md"]:
        check("r3b ordinary allowed " + c, g.blocked(c) is None)
    calls = []
    real = os.scandir; os.scandir = lambda *a, **k: (calls.append(a), real(*a, **k))[1]
    try:
        g.blocked("cat //attacker/share/* /etc/.* ../*")
    finally:
        os.scandir = real
    check("r3b no scandir for non-cwd tokens", not calls)
    for i in range(50):
        open(os.path.join(d, "f%d" % i), "w").close()
    old = g._BUDGET; g._BUDGET = 10
    check("r3b entry budget exhausted blocks", g.blocked("cat *") is not None); g._BUDGET = old
    old = g._SECONDS; g._SECONDS = -1
    check("r3b time budget exhausted blocks", g.blocked("cat *") is not None); g._SECONDS = old
finally:
    os.chdir(cwd); shutil.rmtree(d, ignore_errors=True)

d = tempfile.mkdtemp()
try:
    run = lambda *a: subprocess.run(["git", *a], cwd=d, capture_output=True, text=True)
    run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t")
    f = os.path.join(d, "a.txt"); open(f, "w").write("clean" + chr(10)); run("add", "a.txt"); run("commit", "-qm", "i")
    open(f, "w").write("key=" + "AKIA" + "ABCDEFGHIJKLMNOP" + chr(10))
    open(os.path.join(d, "l.txt"), "w").write("a.txt" + chr(10))
    scan = lambda cmd: subprocess.run([sys.executable, os.path.join(H, "secret_scanner.py")], cwd=d, text=True,
                                     input=json.dumps({"tool_input": {"command": cmd}}), capture_output=True).returncode
    for cmd in ["git commit -m x --pathspec-from=l.txt", "git commit -m x --pathspec-from-f=l.txt", "git commit --al -m x",
                "git commit --inc a.txt -m x", "git commit --onl a.txt -m x", "git commit -m x --totally-unknown-opt"]:
        check("r3b abbreviated/unknown option caught: " + cmd, scan(cmd) == 2)
    check("r3b plain commit still ignores unstaged", scan("git commit -m x --amend") == 0)
finally:
    shutil.rmtree(d, ignore_errors=True)


# round 3c: constant command substitutions cannot assemble a secret name
for c in ["cat .e$(true)nv", "cat .e``nv", "cat .e$()nv", "cat .e`true`nv", "cat id_$(echo r)sa"]:
    check("r3c subst block " + c, g.blocked(c) is not None)
for c in ["ls $(pwd)/src", "echo $(date)", "git log -n $(echo 3)", "cat `which ls`"]:
    check("r3c subst allowed " + c, g.blocked(c) is None)


# round 1 (final): ssh key names, leading-dot credentials, standalone substitutions, assigned variables
for c in ["cat ~/.ssh/id_ed25519", "cat ~/.ssh/id_ecdsa", "cat ~/.ssh/id_dsa", "cat ~/.ssh/id_foo", "cat key.ppk", "cat ~/.ssh/id_ed25519.pub",
          "cat ~/.claude/.credentials.json", "cat .credentials.json", "cat $(echo .env)", "cat `echo .env`", "cat $(echo $(echo .env))",
          "cat $(printf '.en''v')", "x=.e; cat ${x}nv", "a=.e; b=${a}n; cat ${b}v", "export x=id_; cat ${x}rsa", "cat ${x}nv", "cat $f.pem"]:
    check("r1 block " + c, g.blocked(c) is not None)
for c in ["git status", "cat README.md", "ls *.md", "echo $(date)", "ls $(pwd)/src", "cat $HOME/x.txt", "cat $f.txt", "git log -n $(echo 3)",
          "cat id_mapping.csv", "ls $(git rev-parse --show-toplevel)", "x=src; ls $x/lib", "echo $x"]:
    check("r1 allow " + c, g.blocked(c) is None)

# round 1 (final), shell-order assignment expansion with pre-checked caps
import time
fwd_bomb = "a=xxxxxxxxxxxxxxxx; " + "".join("a=$a$a; " for _ in range(14)) + "cat $a"
rev_bomb = "a=$b$b; b=$c$c; c=$d$d; d=$e$e; e=$f$f; f=$g$g; g=$h$h; h=$i$i; i=$j$j; j=$k$k; k=xxxxxxxxxxxxxxxx; cat $a"
for label, bomb in (("fwd", fwd_bomb), ("rev", rev_bomb)):
    t0 = time.monotonic(); res = g.blocked(bomb); dt = time.monotonic() - t0
    check("r1 %s bomb fast" % label, dt < 0.1)
    if label == "fwd":
        check("r1 fwd bomb blocked", res is not None)
check("r1 reassign left to right", g.blocked("a=.e; a=${a}nv; cat $a") is not None)
check("r1 two vars glued", g.blocked("a=.e;b=nv;cat $a$b") is not None)
check("r1 later reassign does not hide an earlier use", g.blocked("a=.env; cat $a; a=ok") is not None)
check("r1 reassigned to safe before use passes", g.blocked("a=x; a=README.md; cat $a") is None)
t0 = time.monotonic(); g.blocked("a=$a$a; echo $a"); check("r1 self reference is bounded and fast", time.monotonic() - t0 < 0.1)
check("r1 plain X=foo passes", g.blocked("X=foo; cat $X") is None)
check("r1 F=.env blocked", g.blocked("F=.env; cat $F") is not None)
check("r1 ambiguous construct next to an assignment blocks", g.blocked("a=x; eval cat $a") is not None and g.blocked("a=x; cat ${a:-y}") is not None)
check("r1 plain secret blocks even with a bomb after it", g.blocked("cat .env; " + fwd_bomb) is not None)
check("r1 over-long command blocks", g.blocked("echo " + "x" * 70000) is not None)

# final round: constructs the text scan cannot follow block outright when combined with a variable reference
for c in ["local -rn x=y; echo $x", "alias c=cat; echo $c", "declare -n r=x; echo $r", "typeset -gn r=x; echo $r", "export -n r=x; echo $r", "declare v=1; echo $v",
          "mapfile -t a < f; echo $a", "readarray a < f; echo $a", "getopts ab o; echo $o", "let x=1; echo $x", "source f; echo $x", ". f; echo $x",
          "f() { cat $1; }; f x", "function f { cat $1; }; f x", "for i in a; do echo $i; done", "while true; do echo $x; done", "until false; do echo $x; done",
          "trap 'cat $x' EXIT", "eval echo $x", "read v; echo $v", "printf -v v x; echo $v", "echo ${x:-y}", "echo ${x-y}", "echo ${x:=y}", "echo ${x+y}",
          "echo ${x#p}", "echo ${x%p}", "echo ${x/p/r}", "echo ${!x}", "echo $((1+2)) $x", "a=(.e nv); echo ${a[0]}", "a[0]=x; echo $a",
          "echo $a; a=x", "a=.e; a=${a}nv; cat $a", "a=.e;b=nv;cat $a$b", "a=.e; cat ${a}nv", "x=.env; echo $x", "echo $x; x=.env"]:
    check("final block " + c, g.blocked(c) is not None)
for c in ["git status", "ls *.md", "X=foo; echo $X", "npm test", "X=foo; cat $X", "echo $HOME/x", "cat README.md", "git log --oneline -5"]:
    check("final allow " + c, g.blocked(c) is None)

# last round (documented residual risk after this: text guard = guardrail, not a sandbox)
for c in ["ev''al echo $x", "$'eval' echo $x", "'local' -rn x=y; echo $x",
          "echo $1", "echo $@", "echo ${1}", "cat $*", "echo $?", "echo $$", "set -- .env; cat $1", "shift", "x=a; shift; echo $x", "IFS=. ; echo x", "bash -c 'cat $0' .env",
          "sh -c 'cat $1' _ .env", "a=$(echo .e); cat ${a}nv", "a=`echo .e`; cat ${a}nv", "a=.e'n'\"v\"; cat $a", "a=.e$(true); cat $a", "cat ${x}rsa", "cat ${y}pem"]:
    check("last block " + c, g.blocked(c) is not None)
for c in ["git status", "ls *.md", "X=foo; echo $X", "npm test", "git log --oneline -5", "X=foo; cat $X", "echo $HOME/x", "cat README.md"]:
    check("last allow " + c, g.blocked(c) is None)

BS = chr(92)
for c in [BS.join(["", "e", "v", "a", "l"]) + " echo $x", "al" + BS + "ias c=cat; echo $c", "f" + BS + "or i in a; do echo $i; done"]:
    check("last block escaped builtin " + c, g.blocked(c) is not None)

# restored rule and budget: assignment + eval/read/printf -v/operator blocks with no visible reference; nested bombs finish inside the deadline
for c in ["a=x; eval ls", "a=x; read v", "a=x; printf -v v x", "a=x; declare -n r", "ev''al $\"x\"", "ev''al $'x'"]:
    check("restored block " + c, g.blocked(c) is not None)
for depth in (50, 400, 3000):
    nested = "cat " + "$(" * depth + "echo x" + ")" * depth
    t0 = time.monotonic(); res = g.blocked(nested); dt = time.monotonic() - t0
    check("nested depth %d finishes in budget" % depth, dt < 1.6)
wide = "echo " + " ".join("$(echo a%d)" % i for i in range(3000))
t0 = time.monotonic(); g.blocked(wide); check("wide substitutions finish in budget", time.monotonic() - t0 < 1.6)
check("budget exhaustion blocks", (setattr(g, "_BUDGET_WORK", 1), g.blocked("echo $(echo a) $(echo b)"))[1] is not None)
g._BUDGET_WORK = 3000

# round 3d: normal commands pass; a crashing hook and unparsable input block
for c in ["git status", "cat README.md", "ls *.md", "git log --oneline -5", "python -m pytest tests/"]:
    check("r3d normal passes " + c, g.blocked(c) is None)
BASH = next((b for b in ("C:/Program Files/Git/bin/bash.exe", "/usr/bin/bash") if os.path.exists(b)), "bash")
sc = lambda inp: subprocess.run([sys.executable, os.path.join(H, "secret_scanner.py")], input=inp, text=True, capture_output=True).returncode
check("r3d scanner unparsable input blocks", sc("not json") == 2)
d = tempfile.mkdtemp()
try:
    os.makedirs(os.path.join(d, ".claude", "hooks"))
    shutil.copy(os.path.join(H, "run_hook.sh"), os.path.join(d, ".claude", "hooks"))
    boom = os.path.join(d, ".claude", "hooks", "boom.py"); open(boom, "w").write("raise SystemExit(1)" + chr(10))
    ok = os.path.join(d, ".claude", "hooks", "ok.py"); open(ok, "w").write("raise SystemExit(0)" + chr(10))
    rh = os.path.join(d, ".claude", "hooks", "run_hook.sh")
    rc = lambda name: subprocess.run([BASH, rh, name], input="{}", text=True, capture_output=True, cwd=d).returncode
    check("r3d hook crash (rc 1) becomes block", rc("boom.py") == 2)
    check("r3d hook clean exit passes", rc("ok.py") == 0)
finally:
    shutil.rmtree(d, ignore_errors=True)


print("FAIL: " + ", ".join(fails) if fails else "ALL PASS"); sys.exit(1 if fails else 0)
