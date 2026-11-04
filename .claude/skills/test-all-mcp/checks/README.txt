MCP smoke-test prompts -- one .txt per server, for agent-hub.
Home: .claude/skills/test-all-mcp/checks/

Each .txt is a standalone copy-paste block: the exact tool (mcp__<server>__<tool>), its args, and a
concrete PASS criterion (expected value / shape) plus known non-failures.

TWO WAYS TO USE THESE
  A) LIVE SWEEP (all enabled servers at once) -- run the `test-all-mcp` skill ("test all mcp" /
     "check mcp status"). MCP tools load at session start, so a normal session can call them directly.
  B) SINGLE-SERVER, RESTART-GATED -- setup-mcp hands ONE .txt to the developer to paste into a FRESH
     session after wiring a new/changed MCP (the tools only appear after a Claude restart). Paste the
     response back for a PASS/FAIL judgement.

ROSTER (source of truth = the config files)
  Enabled where:
    Turnkey (committed .claude/settings.json -> enabledMcpjsonServers):
      context7, playwright
    Per-dev (git-ignored .claude/settings.local.json -> enabledMcpjsonServers):
      github (PAT)
  A server that isn't enabled for this dev/machine is a SKIP, not a FAIL.

FILES (3 server checks)
  Docs:
    context7.txt    -> version-specific library docs (remote HTTP, keyless) [turnkey]
  Browser:
    playwright.txt  -> browser automation [turnkey]
  Repo (per-dev):
    github.txt      -> GitHub identity + repo/PR (PAT) [per-dev]

PRECONDITIONS
  - Tool ids are mcp__<server>__<tool> (hyphens kept).
  - playwright: no local page -- use about:blank.
  - github needs a PAT in .mcp.json.

ADDING A SERVER
  setup-mcp writes a new server's <server>.txt here and adds a line above: one .txt (tool + args +
  concrete PASS criterion + known non-failures) + one line in this index. No code change needed.
