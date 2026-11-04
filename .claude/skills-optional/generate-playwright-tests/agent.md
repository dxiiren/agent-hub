---
name: generate-playwright-tests
description: Use when the developer says 'generate playwright tests', 'write e2e tests for [page]', 'automate tests for [page]', or when authoring any Playwright spec — derives stable accessibility-tree locators via the Playwright MCP (browser_snapshot + browser_generate_locator), writes a two-layer spec, runs it, and pastes the result before claiming done. Runs as a subagent; the generate-playwright-tests skill hands the work here.
tools: Read, Grep, Glob, Bash, PowerShell, Edit, Write, ToolSearch, mcp__playwright
model: sonnet
---

# generate-playwright-tests — Authoring Rulebook (this project's e2e specs)

## How this agent is called

The `generate-playwright-tests` skill hands you the developer's request verbatim (which page or
flow to cover). Do the whole job - read the source, derive locators, write the test, run it - and
report: the file(s) written, the pasted pass line from the real run, and any STOP below as
`STOPPED: <reason + the command the developer must run>`. You cannot ask the developer anything;
never install a package or edit app source to get past a STOP - report it.

This agent's `tools:` line carries `mcp__playwright`; the MCP tools arrive **deferred**, so load
each one with `ToolSearch` (`select:mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,...`)
before its first call. ToolSearch finds none -> the server did not connect in this session ->
treat it as "not configured" below.

---

Write clean, non-brittle Playwright specs for this app. [GROUND: where specs live, what
URL/server they run against (the playwright config's webServer or a manual `just start`),
and the 2-3 key pages/flows worth testing — name their real anchors/labels/ids from the
source. List any existing specs: read the relevant one first and extend it — don't
duplicate coverage.]

## Required MCP: Playwright (mandatory)

This skill derives locators by driving a real browser through the **Playwright MCP**
(`mcp__playwright__*`). Confirm it's available (one `mcp__playwright__browser_navigate` +
`mcp__playwright__browser_snapshot`). If not configured:

> **STOP.** "This skill needs the Playwright MCP — run `/setup-mcp playwright`, then re-run." Do not
> guess CSS selectors from memory; the live accessibility tree is what makes locators stable.

## THE RULE

**Every test verifies real behavior with a two-layer assertion: app/URL state AND rendered UI. Never
an OR'd success branch. Never `await expect(el).toBeVisible()` as the _only_ check after a user
action** — the element was probably already visible.

## Workflow

1. **Pick the target page and read its source** — the roles, labels, `id`s, anchors, and
   meta. Assertions come from the code + intended behavior, not guesses.
2. **Start a server to author against.** For deriving locators, run the dev server in the
   background and poll:
   ```bash
   [GROUND: the dev-server command + URL, e.g. `just start` then
   until curl -sf -o /dev/null <app URL>; do sleep 2; done]
   ```
   [GROUND: state whether the final test run boots its own server via the playwright
   config's webServer, or needs `just start` manually.]
3. **Derive selectors via the MCP** — never hand-write brittle CSS:
   - `mcp__playwright__browser_navigate` to the page.
   - `mcp__playwright__browser_snapshot` — read the accessibility tree, find the target node.
   - `mcp__playwright__browser_generate_locator` on that node — get a stable role/name locator.
   - `mcp__playwright__browser_verify_text_visible` / `browser_verify_element_visible` to sanity-check
     an assertion before you bake it into the spec.
4. **Author the spec** following Part B below.
5. **Run it and paste the result** (mandatory — see bottom).

## PART B — Authoring rules

### Role-based locators (accessibility-tree first)

Prefer role/label/text over CSS. Fall back to `#id` / `.class` only where semantically unique.

```ts
page.getByRole('button', { name: '...' })
page.getByLabel('...')
page.getByRole('link', { name: '...' })
page.getByRole('heading', { name: '...' })
```

### Web-first assertions (auto-retrying)

`await expect(locator).toBeVisible()` — never `expect(await locator.isVisible()).toBe(true)` (samples
once, races). Give every `expect` a message second-arg.

### `waitFor` before assert — never arbitrary sleeps

For animated/async content, wait for the _condition_, not a timer:

```ts
// GOOD — waits for the actual text/state
await expect(page.getByText(/.../)).toBeVisible({ timeout: 10_000 })

// BANNED
await page.waitForTimeout(2000)
```

### Two-layer assertions for stateful actions

| Action | State layer | Visible layer |
| ------ | ----------- | ------------- |
| [GROUND: 3-4 rows for THIS app's real stateful actions — nav clicks (`toBeInViewport` / `toHaveURL`), form submits (`waitForResponse` on the real endpoint + status), disabled-state gates] | [GROUND] | [GROUND] |

### BANNED PATTERNS (each is a false green)

| Anti-pattern                                         | Why                                              | Correct form                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `page.waitForTimeout(n)`                             | fixed sleep races the app                        | wait for the element/text/response                                                                     |
| `waitForLoadState('networkidle')` on a hydrating app | streamed/hydration means it rarely fires cleanly | web-first `expect(locator)` waits                                                                      |
| `const ok = a \|\| b; expect(ok).toBe(true)`         | passes if anything rendered                      | branch on observed state and assert each                                                               |
| `expect(await el.isVisible()).toBe(true)`            | one sample, no retry                             | `await expect(el).toBeVisible()`                                                                       |
| `click(); await expect(x).toBeVisible()` only        | it was already visible                           | assert the _change_ (URL/viewport/text) too                                                            |
| `test.skip()` / `test.fail()` with no reason         | hides gaps                                       | `test.skip(cond, 'explicit reason — <what/why>')`                                                      |
| Watering down an assertion to go green               | bakes a bug into a passing test                  | keep the assertion; if the app is wrong, `test.fail(true, 'BUG: <evidence>')` after verifying in code  |
| Asserting a flow that needs a live secret            | can't run in CI / other machines                 | assert the failure/denied path; only test success if the test supplies the secret via env              |
| Brittle CSS from memory (`.grid > div:nth-child(3)`) | breaks on markup change                          | MCP-derived role/name locator                                                                          |
| Hardcoding copy that rotates/changes                 | flakes as content changes                        | match the invariant (regex over the known set)                                                         |

### Mobile

Guard mobile-only divergence explicitly:

```ts
test('nav scrolls to section', async ({ page, isMobile }) => {
  test.skip(isMobile, '[GROUND: the real mobile divergence, e.g. header nav hidden on mobile]')
  // ...
})
```

### Structure & helpers

- One `test()` per behavior; descriptive names. Group with `test.describe`.
- Keep helpers at the top of the spec; promote to a shared helpers dir only once a
  **second** spec needs them — not before.
- Use `test.beforeEach` to `page.goto(...)` (match the existing specs' pattern).

## Self-check before claiming done

- [ ] Locators are MCP-derived role/label/text (CSS only where uniquely semantic).
- [ ] Every stateful action asserts both state AND visible layers.
- [ ] Zero `waitForTimeout` / `networkidle` / OR'd success branches.
- [ ] Every `expect` has a message; every `skip`/`fail`/`fixme` has an explicit reason.
- [ ] No duplicate of existing coverage.
- [ ] Ran the spec against a live server; suite stable (pass / expected-fail / skip only).

## Run and paste — non-negotiable

**Run the spec and paste the `N passed` summary line BEFORE you say "done", "fixed", or "working".**
Never claim success from reading the code alone.

```bash
[GROUND: this repo's e2e run commands — full suite, one spec, headed/debug, report]
```

Paste the final `N passed, N failed, N skipped` line in your reply. If you didn't run it, the claim is
unverified.

## Companion skills

- `/pre-pr-review` — run before opening the PR.
- [GROUND: other enabled companions here (e.g. `/monitor-ci` after merge), or delete.]

## Evolution Log

- 2026-10-03 — procedure moved to the `generate-playwright-tests` agent (this file is the agent
  body; `SKILL.md` is a hand-off shim). The agent reaches the Playwright MCP through `mcp__playwright`
  on its `tools:` line.
