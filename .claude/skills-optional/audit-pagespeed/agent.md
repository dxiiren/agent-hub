---
name: audit-pagespeed
description: Use when the developer says 'audit pagespeed', 'run pagespeed', 'check pagespeed insights', 'test on pagespeed.web.dev', 'are we 100', or 'why are we not 100' — drives pagespeed.web.dev with the Playwright MCP, lifts the full Lighthouse JSON for BOTH form factors straight off the page, and turns every failing audit into a source-mapped fix list tied to the metric it actually moves. Carries the full road-to-100 playbook (dead-weight audit, prototype discipline, variance math, the automated 100-hunt). Runs as a subagent; the audit-pagespeed skill hands the work here.
tools: Read, Grep, Glob, Bash, PowerShell, Edit, Write, ToolSearch, mcp__playwright
model: sonnet
---

# audit-pagespeed — real PageSpeed Insights scores, with the failing elements

Google's own scoring, on the deployed URL, for **mobile and desktop in one run** — then every
failing audit resolved down to the file that causes it. This skill also carries the
**road-to-100 playbook** learned the hard way (a full day, 40+ samples, 11 measured levers):
follow it in order and the next project gets there in hours, not a day.

## How this agent is called (read first)

The `audit-pagespeed` skill hands you the developer's request verbatim plus a MODE:

- **MODE: AUDIT** (default) - run Steps 1-3 on the deployed URL, map every failing audit to its
  source (Steps 4-5), and report in the format at the end. Apply source fixes only when the
  developer's request asked for them; otherwise the fix list IS the deliverable.
- **MODE: PLAN** - a dry run: open no browser and make no network call. Read the repo, name the
  target URL, the exact deep link, the extraction call and the likely failing audits / levers from
  Steps 4-6 for this codebase, and stop.

Never call the PSI REST API without a real `PAGESPEED_API_KEY` (Step 0), and never claim a 100
without the report-page screenshot. You have no Agent or Workflow tool: a long Step-8 hunt runs as
a Bash loop around the sampler script, or you report back that the main session should drive it.

## Prerequisites

- **Playwright MCP** (`mcp__playwright__*`). If a call fails with "not configured", stop and report:
  "The Playwright MCP isn't set up — run `/setup-mcp playwright`, then re-run."
- A **publicly reachable deployed URL**. PSI is a hosted service; it cannot see `localhost`.
  Target: [GROUND: this project's canonical production URL, e.g. `https://example.com`].

---

## Step 0 — Do NOT reach for the PSI REST API first

`pagespeedonline.googleapis.com/.../runPagespeed` looks like the clean path. Without an API key it
runs on a **shared anonymous quota that is usually already exhausted** (`429 Quota exceeded`).
**Drive the web UI instead** — no quota, and (Step 2) it hands you the same Lighthouse JSON the API
would. Use the REST API only if the developer has set a real `PAGESPEED_API_KEY`.

## Step 1 — Run the analysis

Deep-link straight to the result so no form interaction is needed:

```
https://pagespeed.web.dev/analysis?url=<URL-ENCODED-TARGET>&form_factor=mobile
```

Analysis takes **30–60 s**; `wait_for({text:'Performance'})` fires on the page *shell* — too early.
Wait for real scores. **One run covers both form factors.**

Two Google-side failure modes to expect (seen repeatedly): the desktop lane errors with
_"failed to retrieve the LHR"_ while mobile succeeds (treat desktop as optional per sample, retry
later), and whole-service degraded windows (stalls, absurd outliers like a desktop 78 after ten
100s). When PSI itself is sick, stop sampling and say so — don't diagnose the site with a broken
ruler.

## Step 2 — Extract the full Lighthouse JSON (the whole trick)

The rendered report is painful to scrape and truncates element tables. **The complete LHR for both
form factors is on `window`:**

```js
mcp__playwright__browser_evaluate({ function: `() => {
  const out = {};
  for (const [k, lhr] of [['mobile', window.__LIGHTHOUSE_MOBILE_JSON__],
                          ['desktop', window.__LIGHTHOUSE_DESKTOP_JSON__]]) {
    if (!lhr) { out[k] = null; continue; }
    const scores = {};
    for (const c of Object.keys(lhr.categories))
      scores[lhr.categories[c].title] = Math.round(lhr.categories[c].score * 100);
    const failing = [];
    for (const [id, a] of Object.entries(lhr.audits)) {
      if (a.score !== null && a.score < 1) failing.push({
        id, score: a.score, title: a.title, displayValue: a.displayValue,
        items: a.details?.items?.slice(0, 10),
      });
    }
    out[k] = { fetchTime: lhr.fetchTime, scores, failing };
  }
  return out;
}`, filename: 'lhr-both.json' })
```

Pass `filename:` so the payload lands in a file, then parse it with a short `node -e` script.
`fetchTime` is your freshness proof — PSI caches; identical fetchTime = one analysis served twice.
Failing a11y/BP items carry a `node` (`selector`, `snippet`, `nodeLabel`) — grep the repo for the
`nodeLabel` text to land on the source. Read the **whole** report including "unscored" insights:
they name real causes (a non-composited `text-shadow` animation on the LCP element was found there,
not in any scored audit).

## Step 3 — The score math, including the 100-point endgame

**Performance = 0.30·TBT + 0.25·LCP + 0.25·CLS + 0.10·FCP + 0.10·SI** (each metric scored 0–1 on a
log-normal curve, sum ×100). INSIGHTS/DIAGNOSTICS are advisory — tie every fix to the metric it
moves, or it moved nothing. Never report "fixed 6 diagnostics" as progress.

**The endgame arithmetic — the single most important rule at the 99/100 knife-edge:**
Lighthouse **rounds each metric score to 2 decimals BEFORE weighting it** (the LHR audit `score` is
already `Math.round(raw*100)/100`). A tuned page bleeds ~0.1 point to clamping alone, and a
sub-100ms metric gain that looks like run-noise can be **decisive** by flipping a metric across an
`x.xx5` boundary. Worked example: mobile FCP 1373ms scores 0.9749 raw → clamps to **0.97**; with LCP
clamped to 0.99 the category is `0.10·0.97 + 0.10·1.00 + 0.25·0.99 + 0.30·1.00 + 0.25·1.00 = 0.9945
→ prints 99`, though unclamped it is 99.53 (a 100). So the goal is not "average ~0.99" — it is to
push the gating metric past its nearest boundary (FCP 0.975→0.98, LCP 0.995→1.00). Compute from raw
`numericValue`s AND simulate the clamp; the calculator (googlechrome.github.io/lighthouse/scorecalc)
shows already-rounded badges, hiding the exact digit that decides the point. Do NOT write off a
persistent 99 as VM noise until you have checked which metric sits on the boundary.

**Deterministic-ceiling detection — the single most valuable diagnostic:** collect 10+ samples and
look at the *clean* rolls (low TBT). If a metric repeats the **exact same millisecond value** run
after run (e.g. LCP = 1876ms thirteen times), that is not variance — it is a structural byte on the
simulated critical path, and no amount of re-rolling will print 100. Find the bytes (Step 4).
If clean rolls straddle 99/100 instead, you're at the rounding knife-edge — sample, don't operate.

The other three categories are pass/fail sums — clear every failing audit and they pin at 100.

## Step 4 — AUDIT FOR DEAD WEIGHT FIRST (the day-saver)

**Before optimizing how anything loads, verify it actually renders.** The costliest field lesson: a
site carried a complete self-hosted web-font pipeline — subset faces, two `<head>` preloads, ~35KB
on every cold visit — for a font that **never painted a single glyph** (a CSS-framework default
family utility on a root wrapper had overridden it since day one). That dead weight sat in the
pre-LCP window and WAS the deterministic mobile-99. Removing it: LCP −500ms, instant quad-100.

Run this on the live page before anything else:

```js
// In a mobile-emulated Playwright page, after load+3s:
() => ({
  lcpFont: getComputedStyle(document.querySelector('<LCP-selector>')).fontFamily,
  loadedFaces: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.weight),
  // For EVERY <link rel=preload>: does deleting the asset change any pixel?
})
```

- Webfont declared but `document.fonts` empty / computed family is the system stack → the font
  machinery is 100% dead weight. Delete it (faces, preloads, files). System-ui stacks are a
  *feature* for PSI: no font transfer, and **no font-swap LCP re-record** (a late web font re-stamps
  text LCP at swap time — the W3C LCP spec counts the repaint).
- Audit every `preload`/`modulepreload`/`prefetch` the same way: a hint for a resource not needed
  before LCP steals LCP bandwidth. SSR frameworks may emit a `modulepreload` per rendered chunk
  even for lazily-hydrated components — strip non-entry ones at the HTML-render hook; even
  `rel=prefetch` demotions steal bandwidth on the simulated 1.6Mbps pipe. (Chunk BYTES still
  download via the module graph — only hydration WORK defers; that is fine and optimal.)

## Step 4.5 — Tuned but still 99: profile pre-FCP, then ARBITRATE the throttled pipe

When every scored audit already looks clean (TBT ~20ms, CLS 0) and mobile still prints 99, the cost
hides where no scored audit reports it. This is the method that broke a stubborn, bit-exact mobile 99
into a consistent 100 (7/7 fresh samples) after a prior campaign wrongly declared the page optimal.

**A. Profile the pre-FCP main thread.** TBT only counts long tasks AFTER FCP, so pre-FCP CPU work is
invisible in the report. Trace it with the Chrome DevTools Protocol under PageSpeed's emulation
(Playwright + CDP): `Emulation.setCPUThrottlingRate {rate:4}`, `Network.emulateNetworkConditions
{latency:150, downloadThroughput:1.6*1024*1024/8}`, trace `devtools.timeline`/`blink.user_timing`/
`loading`, then bucket every event whose `ts` is in `[navigationStart, firstContentfulPaint]` by
name and sum `dur`. If `Layout`/`UpdateLayoutTree` dominate, first paint is layout-bound (a large DOM
laid out before the hero paints), not network-bound — measure it, don't assume. (Field result: one
project's Layout was ~245ms = ~70% of the pre-FCP window, disproving its own "network-bound" claim.)

**B. Arbitrate the single throttled pipe — demote, don't delete.** Slow-4G is one ~200KB/s pipe;
everything hinted High-priority in `<head>` races the HTML document that FCP waits on (document + its
inline CSS). Measure how many *compressed* bytes precede the LCP element (`indexOf` the LCP text,
brotli the prefix at the CDN's real quality — many serve ~q4, not q11), then:

- **Strip `fetchpriority="high"` from any preload whose target can't be the LCP element** (an image
  behind an entrance animation / opacity gate is disqualified as an LCP candidate — confirm via
  `lcp-breakdown-insight`). Keep the preload; just stop it preempting the render-blocking CSS.
- **Demote the framework entry `modulepreload` to `fetchpriority="low"` — do NOT remove it.**
  Removing it delays the module graph until the parser reaches the closing `<script>` (measured
  FCP +59ms, 4/4 pairs). `low` keeps the fetch early while the document bytes win the pipe.
- **`content-visibility: auto` on the heaviest below-fold sections** skips their pre-FCP layout.
  `contain-intrinsic-size` MUST be measured per breakpoint (heights can differ 3–4× between mobile
  and desktop) or JS anchor-nav mis-lands — verify nav + entrance animations after.

**Localhost caveat that will mislead you:** a local interleaved A/B can show a large delta from a
lever that moves nothing on production (or vice-versa), because the metric's binding constraint
differs by environment (localhost LCP layout-bound at ~3s vs production LCP network-bound at ~1.6s).
Trust local deltas only for resource-graph changes; confirm the rest on production with **cache-busted**
URLs (`?v=<n>` — on a CDN these still serve from cache, so no TTFB penalty, but PSI must analyse each
afresh, which also defeats its identical-`fetchTime` replay).

## Step 5 — Fixes that recur, by the metric they move

- **Theme/state flip at hydration** (~800ms TBT): a pre-paint inline script and the hydration-time
  store must agree on what EMPTY storage means — PSI always runs empty-storage + light-preference.
  A mismatch mutates `<html>` and re-styles the whole DOM every run. Fix the DEFAULTS to agree.
- **LCP element hygiene**: read `lcp-breakdown-insight` to identify it first (it is often TEXT, not
  the hero image). It must carry **no entrance animation, no JS opacity gate, no animated
  text-shadow** — any repaint re-records LCP. Animate the rest with CSS `both` fill, never JS gates.
  Know the candidate rules: **gradient text (`background-clip: text` + transparent color) is NOT an
  LCP candidate** — the next-largest plain text is the LCP element, so making a gradient heading
  bigger/earlier moves nothing (measured: SSR-ing a previously-empty gradient h1 changed LCP by
  0ms). A residual ~300ms text-LCP-after-FCP gap on Slow 4G is throttled-CPU layout time —
  structural, not removable by markup tweaks.
- **Single-render responsive DOM**: never render mobile+desktop variants twice (`hidden md:block`
  duplicates). One list: CSS scroll-snap carousel below the breakpoint, grid above. Field result:
  HTML 367→271KB, DOM 2452→1625, FCP −0.2s.
- **Third-party origins**: every extra origin = DNS+TLS on Slow 4G. Self-host, `immutable` cache
  headers, CSP `'self'` — also the only way to pass "efficient cache lifetimes".
- **LCP image**: preload with `imagesrcset`/`imagesizes` mirroring the `<img>` exactly,
  `fetchpriority=high`, explicit `width`/`height`, right-sized variants.
- **Inline critical CSS** (verify what the framework already does): all CSS in the prerendered HTML
  = zero render-blocking requests. Nuxt 3 inlines by default — PIN IT (`features.inlineStyles:
  true`; Nuxt 4's granular default un-inlines global CSS). Critters/beasties on an already-inlined
  page is a regression.
- **Mobile-DPR raster trap (Best Practices)**: any visible raster image needs natural size ≥
  displayed CSS px × ~2.6 DPR or `image-size-responsive` fails BP *on mobile only* (a 32px header
  logo needs ~84px natural — never reuse a favicon as a logo; desktop DPR 1 masks the bug).
- **Decorative layers**: `pointer-events-none` on every absolute glow/overlay — not a score item,
  but hit-testable decorations swallow taps and carousel swipes.
- **Head diet**: JSON-LD to end-of-body, minimal head — bytes before content delay first paint.
- **`color-contrast` / `target-size` / `link-name`**: compute contrast (white@50% on near-black is
  the 4.5:1 floor), 24×24 tap targets, `sr-only` text on icon-only links — check BOTH responsive
  variants of each component.

Project-specific recurring causes: [GROUND: the fixes that actually recur on this stack — the
image pipeline, the font strategy, the hydration-heavy components, and the CSP location.]

## Step 6 — Prototype discipline (never ship a "should help")

Every candidate lever gets: an **isolated git worktree**, the change, a functional proof, and an
**interleaved** Lighthouse A/B (alternate base/proto in ONE loop, 3–4 pairs — sequential rounds get
confounded by machine drift; it once manufactured a fake 7-point regression). Local runs:
`npx lighthouse <url> --form-factor=mobile --screenEmulation.mobile --screenEmulation.width=412
--screenEmulation.height=823 --screenEmulation.deviceScaleFactor=1.75 --throttling-method=simulate`.
Absolute localhost numbers differ from PSI; the base-vs-proto DELTA is the signal. **Pre-register
the deploy bar before measuring** (e.g. "LCP ≥75ms or no ship") and hold to it — don't ship a
lever that missed its bar because a secondary metric twitched.

**Lantern's limits:** localhost CAN measure resource-graph changes (add/remove a preload/request —
trustworthy). It CANNOT measure load-event-relative tricks (locally `load` fires *before* first
paint, inverting the premise) — those need a preview deploy + PSI.

**Levers measured NEGATIVE on an already-tuned page — do not re-try without new evidence:**

1. **Defer entry JS until `load`** — dead interactions until hydration (e2e caught a dead button);
   unmeasurable locally; rejected on the UX regression alone.
2. **`content-visibility: auto` on below-fold sections** — ~0 gain (first paint is network-bound,
   not layout-bound), +TBT bookkeeping, and fragile per-viewport `contain-intrinsic-size` constants
   that broke anchor navigation twice.
3. **Deeper component code-splitting** — +requests/+split overhead contends with hero assets (FCP
   +192ms/LCP +278ms in every pair). Framework entry JS is a floor; the "unused JavaScript" PSI
   flags usually lives there and is unreachable without changing frameworks.
4. **`fetchpriority="low"` on the entry script (+ dropping its modulepreload)** — priority change
   proven at the network layer (High→Low via CDP), hydration intact, and **LCP moved 0ms**
   (−6.5ms median over 4 interleaved pairs): entry-fetch bandwidth contention was NOT gating LCP.
   Side-effect: FCP −82ms in every pair — but that is ~+0.05 unrounded score points, below run
   noise, and it delays real hydration on slow networks. Failed its pre-registered bar; not shipped.

## Step 7 — Variance: measure like Google says to

- Google's own docs: a 100 "is extremely challenging **and not expected**"; treat performance as a
  **distribution**. Only ~zero-JS sites (Qwik/Astro/11ty) hold 100, and even they report 98–100
  bands. A hydrating-framework site *visits* 100 on clean rolls — that is the win condition.
- **Know the mobile FCP floor before promising more:** the Slow-4G simulation charges ~600ms of
  DNS+TCP+TLS handshakes before the first byte — identical for every site on Earth — plus your
  HTML transfer plus 4×-throttled rendering. FCP ≤1.0s (metric score 1.0) is reachable only by
  near-empty pages; ~1.35s on a tuned content page scores ~0.975 and that is the ceiling grade.
  Desktop pins 100 because its exam is ~4× easier (40ms RTT, 10Mbit/s, no CPU throttle) — the
  same site measures ×4 slower on mobile BY DESIGN; nothing "went wrong".
- When the tuned page's unrounded score sits at ~99.5, each run's printed 99-vs-100 is literal
  rounding of network wobble. The only roll-proof move left is shipping the page without JS
  (per-route `noScripts` in Nuxt) — a product decision (kills toggles/accordions), not a perf
  trick. Otherwise: capture the 100 with screenshots and declare the distribution final.
- PSI's shared VMs randomly spike TBT (~500ms on runs whose network numbers are pristine → score
  dips to high-80s). Officially acknowledged in PSI's release notes. Not your code. Judge by the
  **median of 3–5 fresh samples** (check `fetchTime` advanced), never a single run.
- PSI tests from 4 Google datacenters picked by the *requester's* IP — a global CDN mostly
  neutralizes it, but check TTFB on bad runs.
- Report honestly: before→after medians per category per form factor, named remaining audits,
  outliers labeled as outliers. Never round up.
- The lab digit is cosmetic for SEO: **search ranking uses field data (CrUX real-user Core Web
  Vitals), not the simulated Lighthouse score.**

## Step 8 — The automated 100-hunt (when the goal is a screenshot of 100)

Once clean rolls compute to ≥99.5, catching the printed 100 is a sampling problem. Automate it:

1. **One-shot sampler script** at the repo root (needs the repo's `node_modules` for
   `@playwright/test`): headed chromium → the Step-1 deep link → `waitForFunction` for the MOBILE
   LHR global (desktop optional — its lane fails sporadically) → extract categories + 5 metrics +
   fetchTime → **screenshot BOTH form-factor tabs** (the proof standard: never claim 100 without
   the report-page screenshot) → print one `RESULT {json}` line.
2. **Loop it** (a Bash loop around the sampler - you have no Workflow/Agent tool; for a
   multi-hour hunt, report back so the main session drives it): sequential samples ~4 min apart, fetchTime dedupe,
   **early-stop when one sample shows the full win condition** (Performance 100 AND a11y/BP/SEO
   100), 3-consecutive-failure circuit breaker, screenshots kept per sample. Deliver the winning
   pair immediately.
3. Between hunts, fix structure (Steps 4–6). A hunt against a deterministic 99 ceiling wastes
   hours — 24 samples proved it once; the structural fix then swept 100 on the **first** sample.

## Report format

```
| Category       | Mobile    | Desktop   |
| -------------- | --------- | --------- |
| Performance    | 91 → 100  | 98 → 100  |
| Accessibility  | 89 → 100  | 96 → 100  |
| Best Practices | 100 → 100 | 92 → 100  |
| SEO            | 100 → 100 | 100 → 100 |
```

Then: what changed, which metric each change moved (+ms), screenshot paths for any claimed 100, and
**what is still short and why**.
