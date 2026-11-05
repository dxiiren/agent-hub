# Resume: agent-hub deep guide
State: docs/index.html rebuilt (13 sections, SVG diagrams) on branch docs/deep-guide; built from scratch files in worktree/_junk/agent-hub-site (svg.py, head.html, b1-b3.html, build.py, shot.py).
Remaining:
1. Re-run `python build.py` then `python shot.py` in _junk/agent-hub-site; look at shots/ (arch, life, gate, usage at 1440 and 390); fix any overlap.
2. Run `git grep -nIiE "192\.168|kollect|akmal@|password=|token=" -- docs README.md` (must be clean).
3. Delete RESUME.md, commit, merge docs/deep-guide into main, push origin and gitea.
4. wait_for --http https://dxiiren.github.io/agent-hub/ (200 and new content); report SHA.
