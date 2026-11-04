"""Cases for no_force_push.py - run: python .claude/hooks/test_no_force_push.py (exit 1 on any miss)."""
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("nfp", os.path.join(os.path.dirname(os.path.abspath(__file__)), "no_force_push.py"))
nfp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nfp)

BLOCK = [
    "git push --force origin main", "git push -f", "git push origin main -f", "git push origin main --force",
    "git push --force-with-lease", "git push --force-with-lease=main:abc", "git push --force-if-includes --force-with-lease",
    "git push -nf x", "git push -fn x", "git push -vf x", "git push -qf x", "git push -uf x", "git push -fu x",
    "git push -uvf x", "git push -unf x", "git push -vqf x", "git push -qnf x",
    "git push origin +main", 'git push origin "+main"', "git push origin '+main:main'", "git push origin +HEAD:refs/heads/main",
    "git push --mirror origin", "git push --delete origin b", "git push -d origin b", "git push origin :b", "git push --prune origin",
    "git -C . push -f x", "git -C some/dir push --force x", "git -c a=b push -f x", "git --no-pager push -f x",
    "git --git-dir .git push -f", "git --work-tree=. push -f x", "/usr/bin/git push -f", "git.exe push --force=yes",
    "cd x && git push --force", "echo a; git push -fu origin x", "true || git push -f", "(git push -f)",
    "env git push -f", "command git push -f", "xargs git push -f", "nohup git push --force",
    "bash -c 'git push -f origin x'", 'sh -c "git push --force"', "eval 'git push -f'",
    "git -c remote.origin.push=+refs/heads/*:refs/heads/* push origin", "git -c alias.p='push -f' p",
    "git config alias.fp 'push -f'", "git config --global alias.fp 'push --force'",
    "git config remote.origin.push +refs/heads/main:refs/heads/main",
    "git push --mirr origin", "git push --dele origin y", "git push --force-w origin x", "git push --forc x",
    "F=--force; git push origin HEAD:x $F", "git push origin x $(echo --force)", "git push origin x `echo -f`",
    "echo -f | xargs git push origin HEAD:x", "git send-pack --force ../bare.git HEAD:refs/heads/x",
    "git send-pack ../bare.git +HEAD:refs/heads/x", "git config alias.zz \"push --force\"",
    "git config set alias.zz \"push -f\"",
    "git push --m origin", "git push --mi origin", "git -c remote.origin.mirror=true push origin",
    "git config remote.origin.mirror true && git push origin", "git push @a origin main",
    "$a=@('-f'); git push @a origin main",
    "git send-pack --force ../bare.git main", "git config remote.origin.mirror true",
    "git remote add --mirror=push bk ../bare.git", "git remote add --mirror bk ../bare.git",
    "M=true git --config-env=remote.origin.mirror=M push origin", "git --config-env remote.origin.mirror=M push origin",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.mirror GIT_CONFIG_VALUE_0=true git push origin",
    "git p\\ush -f origin main",
    "git config -f .git/config remote.origin.mirror true", "git config --type bool remote.origin.mirror true",
    "git config --file x remote.origin.push +refs/heads/a:refs/heads/a", "git config --local alias.q 'push -f'",
    "GIT_CONFIG_PARAMETERS=\"'remote.origin.mirror'='true'\" git push origin", "git pu`sh --force origin topic",
    "git config remote.origin.MIRROR true", "bash -c 'cd ../o && git config remote.origin.mirror true'",
    "git -c remote.o.mirror=true push o",
    "git fetch origin\n# History was rewritten, so we've to overwrite the remote\ngit push --force-with-lease origin feat\n# Verify it's there\ngit log origin/feat -1",
    "cd repo # it's the worktree\ngit push --delete origin old-branch # remove the PR's branch",
    "bash -s <<'EOF'\ngit push --force origin x\nEOF", "sh <<EOF\ngit push origin :old\nEOF",
    "cmd /c \"git push --force origin x\"", "cmd.exe /c \"git push --delete origin x\"", "cmd //c \"git push -f origin x\"", "git push origin feat/a `\n  --force-with-lease",
    "git push origin feat/a `\r\n  --force", "cat <<'EOF'\nhello\nEOF\ngit push -f origin x", "git push -u origin feat/x \\\n  --force-with-lease",
    "powershell -Command \"git push --force origin x\"", "iex 'git push -f origin x'", "$env:GIT_CONFIG_PARAMETERS=\"'remote.o.mirror'='true'\"; git push o",
]
ALLOW = [
    "git push", "git push -u origin feat/x", "git push --follow-tags", "git push -v origin main", "git -C . push origin main",
    "git status && git push -u origin HEAD", "git commit -m 'force push fix' && git push", "git push --dry-run origin main",
    "git push -q", "git push --set-upstream origin x", "git push --tags", "git -c color.ui=never push origin main",
    "bash -c 'git push origin x'", "git config alias.st status", "git config remote.origin.push refs/heads/main",
    "git fetch --force", "git pull -f", "gh pr merge --merge", "git log --format=%H -n1 && git push origin main",
    "git push -u origin \"$(git branch --show-current)\"", "git push -u origin \"$(git rev-parse --abbrev-ref HEAD)\"",
    "git push --porcelain origin main", "git push --no-verify origin x", "git push --tags origin",
    "ls | xargs echo && git push origin main",
    "git remote add origin https://example.invalid/x.git", "git remote -v", "git config remote.origin.url x",
    "git --config-env=user.name=N commit -m x",
    "git add scripts/state-mirror.sh", "git commit -m 'docs: mirror notes'", "git log -- scripts/state-mirror.sh",
    "git config --get remote.origin.url", "git config -f .gitmodules submodule.x.url y",
    "git -C web status -- ../docker/server/state-mirror.sh", "git -C x add state-mirror.sh",
    "git -c core.quotepath=off log --oneline -5 -- docker/server/state-mirror.sh",
    "git -c user.email=a@b.c commit -m 'fix(scripts): state-mirror.sh skips logins'",
    "git push -u origin $(git branch --show-current)", "git push origin feature/x 2>&1 | tail -5",
    "git push -u origin fix/state-mirror-logins", "git push -u origin feat/x\nrm -rf node_modules/.cache",
    "git push -u origin feat/x\ndocker compose up -d", "git push -u origin feat/x\ngh pr create --fill -d",
    "git push -u origin feat/x\ngh pr create --title 'feat: x' --body \"$(cat <<'EOF'\n## Summary\n- x\nEOF\n)\"",
    "git commit -m 'docs: the hook refuses git push --force'",
    "git commit -F - <<'EOF2'\nfix: guard refuses git push --force now\nEOF2",
    "gh pr create --title x --body-file - <<'EOF'\nrefuses git push -f and git push --mirror\nEOF",
    "git push -u origin feat/x\ngh pr create --body-file - <<EOF\n- git push --force is refused\nEOF\necho ok",
    "git status # what's changed?\ngit push -u origin feat/x # it's ready", "echo '#not a comment' && git push origin x",
    "git log --grep='#12' --oneline", "cat <<EOF > notes.md\ngit push --force is refused here\nEOF",
]
miss = [c for c in BLOCK if not nfp.check(c)] + [c for c in ALLOW if nfp.check(c)]

# The hook AS WIRED in settings.json (a text pre-filter there once hid send-pack and git config from it)
import json
import shutil
import subprocess

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
settings = json.load(open(os.path.join(root, ".claude", "settings.json"), encoding="utf-8"))
wired = [h for h in settings["hooks"]["PreToolUse"] if "no_force_push" in json.dumps(h)]
if len(wired) != 1 or wired[0]["matcher"] != "Bash|PowerShell":
    miss.append("settings.json: no_force_push must be wired once with matcher Bash|PowerShell")
else:
    cmd = wired[0]["hooks"][0]["command"]
    env = dict(os.environ, CLAUDE_PROJECT_DIR=root)
    for tool, c, want in [("Bash", "git send-pack --force ../b.git main", 2), ("PowerShell", "git config remote.origin.mirror true", 2),
                          ("Bash", "git push -" + "f origin feature", 2), ("Bash", "git push -u origin main", 0), ("Bash", "ls -la", 0)]:
        payload = json.dumps({"tool_name": tool, "tool_input": {"command": c}})
        # Claude Code runs hook commands through bash (Git Bash on Windows) - so does this check. shutil.which
        # follows PATH; a bare "bash" makes Windows pick System32's WSL bash.exe first.
        got = subprocess.run([shutil.which("bash") or "bash", "-c", cmd], input=payload, text=True,
                             capture_output=True, env=env).returncode
        if got != want:
            miss.append(f"wired hook: {tool} {c!r} exit {got}, want {want}")
for c in miss:
    print("MISCLASSIFIED:", c)
print(f"{len(BLOCK)} block + {len(ALLOW)} allow cases + 5 wired-hook runs, {len(miss)} misclassified")
sys.exit(1 if miss else 0)
