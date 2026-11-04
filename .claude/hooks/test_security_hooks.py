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

print("FAIL: " + ", ".join(fails) if fails else "ALL PASS"); sys.exit(1 if fails else 0)
