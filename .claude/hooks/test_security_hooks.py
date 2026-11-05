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

print("FAIL: " + ", ".join(fails) if fails else "ALL PASS"); sys.exit(1 if fails else 0)
