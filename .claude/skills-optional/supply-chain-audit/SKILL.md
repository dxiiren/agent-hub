---
name: supply-chain-audit
description: "Use when the developer says 'supply chain audit', 'audit dependencies', 'check for compromised packages', 'are our dependencies safe', 'audit the lockfile' or '/supply-chain-audit' - a read-only supply-chain audit that auto-detects the ecosystems present (npm, uv/pip, composer, maven), audits known vulnerabilities against the LOCKFILE, checks lock freshness and install-time hooks, the known-compromised-package IOC list, container image digest pins and GitHub Actions SHA pins, and reports ranked findings (CRITICAL/HIGH/MEDIUM/LOW) with the exact fix command - never applying one."
model: sonnet
---

# supply-chain-audit - read-only dependency and CI supply-chain audit

Triggers: "supply chain audit", "/supply-chain-audit", "audit dependencies", "check for compromised
packages", "are our dependencies safe", "audit the lockfile".

**Your first action is the `Agent` call below - before any Bash, Read or text of your own.** The
ecosystem auto-detect, the lock audits, the install-hook and IOC checks, the digest and SHA-pin
checks and the severity tiers live in the read-only `supply-chain-audit` agent
(`.claude/agents/supply-chain-audit.md`). Hand the work to it - do not run the audits yourself:

```
Agent(subagent_type: "supply-chain-audit", model: "sonnet",
      description: "Supply-chain audit",
      prompt: "Scope: <npm|python|composer|maven|docker|actions|licenses|all - default all>. Developer said: <their words verbatim>.")
```

Relay the agent's one-line count, the findings that need action, its action plan and every
`UNVERIFIED` line as returned. Applying a fix (a lock bump, a digest pin, a SHA pin) is a
separate request the developer makes after reading the report - the agent never applies one.

Attribution: adapted from claude-code-templates
`cli-tool/components/commands/analysis/supply-chain-audit.md` and
`cli-tool/components/skills/security/supply-chain-guard/` @ 8b1f883, MIT, (c) 2025 Daniel (San)
Avila.

## Optional skill: where the agent lives

This skill sits in `.claude/skills-optional/` (inert). Its agent ships beside it as `agent.md`
so it is NOT loaded while the skill is inert. When the skill is enabled (moved to
`.claude/skills/`, e.g. by `/ground-project` once a lockfile exists), move `agent.md` to
`.claude/agents/supply-chain-audit.md` in the same step - the hand-off above names that path. It
also calls `.claude/skills/pre-pr-review/scripts/scan-ci.sh` (a core skill, always present).
