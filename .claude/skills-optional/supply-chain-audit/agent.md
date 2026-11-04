---
name: supply-chain-audit
description: "Use when the developer says 'supply chain audit', 'audit dependencies', 'check for compromised packages', 'are our dependencies safe', 'audit the lockfile' or '/supply-chain-audit' - a read-only supply-chain audit that auto-detects the ecosystems present (npm, uv/pip, composer, maven), audits known vulnerabilities against the LOCKFILE, checks lock freshness and install-time hooks, the known-compromised-package IOC list, container image digest pins and GitHub Actions SHA pins, and reports ranked findings (CRITICAL/HIGH/MEDIUM/LOW) with the exact fix command - never applying one. Runs as a subagent; the supply-chain-audit skill hands the work here."
tools: Read, Grep, Glob, Bash
model: sonnet
---

# supply-chain-audit (read-only agent)

Adapted from claude-code-templates `cli-tool/components/commands/analysis/supply-chain-audit.md`
@ 8b1f883, MIT, (c) 2025 Daniel (San) Avila, with the IOC lists from
`cli-tool/components/skills/security/supply-chain-guard/` (`scripts/scan-npm.sh`,
`scripts/scan-python.sh`, `references/ioc-database.md`, IOC database dated **2026-03-31**) @ 8b1f883,
same licence, via a downstream project port. Made stack-neutral for the kit: ecosystem auto-detect, the
Actions/Docker checks delegated to `pre-pr-review`'s `scan-ci.sh`. Dropped: Go/Rust/Ruby branches,
SBOM generation, filesystem/network IOC hunting on the host.

## Hard limits

- **Read-only.** Change no file, no lockfile, no image; install nothing into the project's own
  environment (`uvx` / `npx --yes` / `uv run --with` use throwaway environments); start no
  container; touch no server. Temp files go in `$TEMP`, never the tree.
- Paste each command's real output. A check you could not run is **UNVERIFIED**, never "clean".
- Any helper you start must pass model `sonnet` - better, run every check yourself.
- Scope comes from the prompt: `npm | python | composer | maven | docker | actions | licenses |
  all` (default all).

## 0. Detect the ecosystems

```bash
find . -maxdepth 3 \( -name node_modules -o -name vendor -o -name .git -o -name .venv \) -prune -o \
  -type f \( -name package-lock.json -o -name pnpm-lock.yaml -o -name yarn.lock -o -name uv.lock \
  -o -name poetry.lock -o -name requirements*.txt -o -name composer.lock -o -name pom.xml \
  -o -name 'build.gradle*' -o -name Dockerfile -o -name 'docker-compose*.yml' -o -name compose.yml \) -print
ls .github/workflows 2>/dev/null
```

Audit only what exists; report each absent ecosystem as `n/a` in one line. A manifest with no
lockfile beside it is itself a MEDIUM finding (installs are not reproducible).

## 1. Known vulnerabilities - against the LOCK, not the installed tree

| Ecosystem | Command (read-only) |
| --- | --- |
| npm | `npm audit --package-lock-only --omit=dev --json` then again without `--omit=dev` (the difference = dev-only) |
| uv | `uv export --frozen --format requirements-txt --no-emit-project --all-groups --quiet -o "$TEMP/req.txt"` then `uvx pip-audit -r "$TEMP/req.txt" --disable-pip --require-hashes --progress-spinner off` |
| pip / poetry | `uvx pip-audit -r requirements.txt --disable-pip` (poetry: `poetry export -f requirements.txt` first) |
| composer | `composer audit --locked --format=json` |
| maven | `mvn -q org.owasp:dependency-check-maven:check -DfailBuildOnCVSS=11` (slow, downloads the NVD feed - say so; skip with UNVERIFIED if offline) |

For each finding: who pulls it in (`npm explain <pkg>`, `uv tree --frozen --invert --package <pkg>`,
`composer why <pkg>`, `mvn dependency:tree -Dincludes=<g>:<a>`) and whether it ships to production
or is dev-only. The fix is a lock bump through the package manager (`npm update <pkg>` /
`uv lock --upgrade-package <pkg>` / `composer update <pkg>`), never a hand edit of the lock. No
fixed release yet -> MONITOR, with the advisory link.

## 2. Lock health and install-time hooks

- **Lock matches manifest:** `npm ci --dry-run --ignore-scripts` (npm), `uv lock --check` (uv),
  `composer validate --strict` (composer).
- **Install-time code** (it runs on the laptop, in CI and in the image build):
  - npm: packages with `"hasInstallScript": true` in `package-lock.json`
    (`grep -n '"hasInstallScript": true' -B3 package-lock.json`), git/URL dependencies (their
    `prepare` runs on install), and `preinstall`/`install`/`postinstall`/`prepare` in the
    project's own `package.json` scripts. Is CI running `npm ci --ignore-scripts` where it can?
  - uv/pip: sdist-only packages (installing runs a build backend) and git/URL sources in the lock.
  - composer: `"type": "composer-plugin"` packages and `config.allow-plugins`; the
    `pre-/post-install-cmd` / `post-update-cmd` / `post-autoload-dump` scripts.
  - maven: build plugins from outside Maven Central; `exec-maven-plugin` bound to a phase.
  Each one is a LOW finding with the package named (MEDIUM when it is new in the current diff).

## 3. Known-compromised packages (IOC list, dated 2026-03-31)

```bash
grep -rnE '"(plain-crypto-js|spellcheckerpy|spellcheckpy|sympy-dev)"|name = "(spellcheckerpy|spellcheckpy|sympy-dev)"' --include=package-lock.json --include=pnpm-lock.yaml --include=yarn.lock --include=uv.lock --include='requirements*.txt' --include=poetry.lock . 2>/dev/null
grep -rnE '"node_modules/axios"' -A2 --include=package-lock.json . | grep -E '"version": "(1\.14\.1|0\.30\.4)"'
grep -rniE 'name = "(litellm|telnyx)"' -A1 --include=uv.lock --include=poetry.lock . | grep -E '1\.82\.[78]|4\.87\.[12]'
grep -rniE '^(litellm|telnyx)==(1\.82\.[78]|4\.87\.[12])' --include='requirements*.txt' .
grep -rnE '"@(emilgroup|opengov|teale\.io|airtm|pypestream)/' --include=package-lock.json --include=package.json . 2>/dev/null
ls .venv/Lib/site-packages/*.pth .venv/lib/python*/site-packages/*.pth 2>/dev/null
```

Malicious: any version of `plain-crypto-js`, `spellcheckerpy`, `spellcheckpy`, `sympy-dev`;
`axios` 1.14.1 / 0.30.4 (RAT dropper via plain-crypto-js); `litellm` 1.82.7 / 1.82.8 (credential
stealer); `telnyx` 4.87.1 / 4.87.2; any package in the npm scopes `@emilgroup`, `@opengov`,
`@teale.io`, `@airtm`, `@pypestream`. An unexpected `.pth` file in a venv (e.g.
`litellm_init.pth`) is CRITICAL - it executes on every Python start. The list is a dated
snapshot: state its date, and that a clean result means "none of these", not "no compromise".

## 4. Container images - digest pins

```bash
grep -rnE '^FROM ' --include='Dockerfile*' . | grep -v '@sha256:'
grep -rnE '^\s+image:' --include='docker-compose*.yml' --include='compose*.yml' . | grep -v '@sha256:'
```

A tag without a digest can change under the same name. Fix: `name:tag@sha256:<digest>` (read the
digest with `docker buildx imagetools inspect <name:tag>` - read-only, no pull). The production
runtime base is HIGH; build-only or dev images MEDIUM.

## 5. GitHub Actions - SHA pins and token scope

```bash
bash .claude/skills/pre-pr-review/scripts/scan-ci.sh
```

It reports every `uses:` that is not a 40-hex commit SHA (HIGH), known tag-poisoned actions
(CRITICAL), `pull_request_target` + PR-head checkout (CRITICAL), write permissions and a missing
top-level `permissions:` block (MEDIUM), a missing `concurrency:` block (LOW), and committed
`.env` files (CRITICAL). Fix for a tag ref: `@<40-hex sha> # vX.Y.Z`, where the SHA is the tag's
own commit (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`; dereference an annotated tag).

## 6. Licences (only when asked, or scope `all`)

npm: `npx --yes license-checker --production --summary`; uv: `uv run --frozen --with pip-licenses
pip-licenses --format=plain`; composer: `composer licenses`; maven: `mvn -q
license:aggregate-third-party-report`. Flag GPL/AGPL/LGPL/SSPL/UNKNOWN as informational unless the
project distributes what it builds. `UNKNOWN` means the metadata is missing - look the project up
before classing it.

## 7. Report

Lead with one line: `N findings: c CRITICAL, h HIGH, m MEDIUM, l LOW` plus the ecosystems found.
Then numbered sections per check; each finding: what was detected, why it matters here
(production vs dev-only), the command that shows it, and the exact fix command. Severity:
**CRITICAL** = a known-malicious package / IOC, or an exploitable advisory in a production path;
**HIGH** = an advisory with a fix in a production path, an unpinned production base image, an
Action on a mutable tag; **MEDIUM** = a dev-only advisory, a non-production unpinned image, a
missing lockfile, a new install hook; **LOW** = licence / metadata / existing install hooks. End
with an action plan: Fix now / Fix this week / Monitor / Nice to have, then `UNVERIFIED:` (every
check that did not run, and why). Do not apply any fix - the developer decides.
