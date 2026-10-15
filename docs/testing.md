# Testing

[Documentation index](README.md) · [Architecture](architecture.md#verification)

How NeedMark is tested: the design rules every test follows, which layer a change belongs to, and how to run and maintain the suites. The [`testing` skill](../.claude/skills/testing/SKILL.md) turns these rules into a step-by-step procedure for agents.

## Principles

1. **Test behaviour through public interfaces.** Call the exported function, the HTTP API, the CLI or the UI the way its users do, and assert on the outcome they see (returned value, saved files, rendered text, accessible names), not on private functions, call order or CSS classes. A test that breaks when unrelated code is refactored without a user-visible change is a defect in the test.
2. **Use the smallest test that can catch the failure.** Push each check down to the lowest layer that reproduces it; a browser test is justified only by what needs a real engine. Do not re-verify in the browser what a unit test already proves.
3. **One behaviour per test.** Name the test after the behaviour and its expected outcome, as a sentence. If the name needs "and" to join unrelated outcomes, split the test, or extend an existing test only when the extra assertion belongs to the same behaviour.
4. **Complete, concise and straight-line.** Each test shows the inputs that matter (descriptive and meaningful over DRY). Prefer straight-line code; loops are only for data tables or parameterized tests whose rows differ by data alone. Use shared helpers for setup that is not the point of the test.
5. **Reproduce a bug before fixing it.** Write the failing test at the lowest layer that reproduces the bug, watch it fail, then fix the code.
6. **Deterministic and isolated.** Each test creates its own data and leaves nothing that another test reads. Wait for the state the product promises with web-first assertions (`toBeVisible`, `expect.poll`), never for a fixed delay that hides a race. Control timing-sensitive transports with `page.route` or stubs instead of waiting on real latency.
7. **Fewer, stronger tests.** Every test costs run time and maintenance. Weigh speed, maintainability, resource use, reliability and fidelity together: a slower, higher-fidelity test is worth it only for risk the faster layers cannot see.

## Layers and sizes

Size is what a test may touch; scope is how much code it validates. NeedMark uses three sizes.

| Size | Runner and location | May touch | Use for |
| --- | --- | --- | --- |
| Small | Vitest, `src/**/*.test.ts` next to the file under test | One process; no files, network or real time | Validation, prompt formatting, classification, geometry, parsing, configuration rules and other pure logic |
| Medium | Vitest, `src/**/*.test.ts` | The local filesystem (temporary directories) and localhost servers started by the test | Storage and file layout, review API and origin/token checks, proxy streaming and rewriting, CLI commands, MCP protocol and tools |
| Large | Playwright, `tests/*.spec.ts` | A real browser against the demo server and proxies started by the spec | What needs a real engine: selection and hit testing, rendering and capture pixels, focus, keyboard and pointer events, shadow DOM and iframes, browser APIs (clipboard, history, media) and complete review flows |

Repository rules live beside the small tests: `src/structure.test.ts` enforces the source-layer boundaries and `src/comments.test.ts` the bilingual code comments.

### Choosing the layer

- Start from the behaviour and ask what is the smallest environment in which it can go wrong. Logic that can be called with plain data belongs to a small test even when it was found in the browser.
- A browser test is right when the outcome depends on layout, rendering, event dispatch or browser APIs, or when the risk is the wiring between widget, server and files in a real review flow.
- Logic that only runs in the page (for example, collecting context from a DOM tree) may be tested in the browser through `page.evaluate`, but then belongs to one engine unless the engine changes the result.
- When a browser test fails because of logic, add the small test that pins that logic, and keep the browser test only for what remains engine-specific.

### Browser engines

Chromium runs every spec. Playwright WebKit repeats only tests tagged `@cross-engine`, set in the test options:

```ts
test('text caret selection falls back to the legacy browser API when the standard API is unavailable', { tag: '@cross-engine' }, async ({ page }) => { /* ... */ });
```

Tag a test only when its outcome depends on engine behaviour: rendering and DOM/tab capture, hit testing and overlap picking, carets and ranges, iframe and shadow geometry, JavaScript stack formats, native dialogs and top layer, style inheritance, pointer and keyboard event handling, media and animation APIs. Tests of the product's own logic, panels, lists, settings, copy and send stay Chromium-only; one ordinary review flow (`review-ux`, `review-flow`) is tagged as a WebKit smoke test. The native tab-picker tests use Chromium launch flags and are never tagged. Playwright WebKit is an engine check, not certification of the installed Safari application.

## What not to test

- Styling and decoration: colours, sizes, spacing, sticky positioning, animation curves. Check them in the demo (see [Manual check](#manual-check)).
- Static copy or DOM structure, except captions and roles that users and assistive technology rely on, which specs use as locators.
- Guarantees the type system or a schema already enforces.
- Third-party behaviour you do not control; stub it at the boundary.
- The same rule at two layers. Keep the lower one and delete the duplicate.

## Writing tests

### Small and medium (Vitest)

- Put the test next to the file it tests and name it after that file (`storage.ts` → `storage.test.ts`).
- Shared feedback inputs and code contexts come from [`tests/fixtures.ts`](../tests/fixtures.ts); build variations from them instead of copying literals.
- Create temporary directories per test and remove them afterwards; start servers on a free port (`listen()` or port 0).

### Large (Playwright)

- Import `test` and `expect` from [`tests/support/review.ts`](../tests/support/review.ts), not from `@playwright/test`. Its automatic fixture empties the shared feedback folder before every test.
- Use the helpers there instead of repeating setup: `configureReview` (settings through the panel), `enableWidgetOption` (submission or runtime source lookup on the served page), `saveAndList`, `searchList`, `toggleFilter`, and `output` / `tempRoot` for paths. Add a helper only when at least two specs need the same setup and it is not the behaviour under test.
- Locate elements by role, label and text first; fall back to `[data-needmark] .class` selectors only for internals with no accessible handle (pins, outlines, previews).
- Fixed-content fixtures that a spec needs beyond the demo live in `tests/fixtures/`.

## Running

```sh
pnpm build       # required first: typecheck, E2E and the demo load dist/
pnpm typecheck
pnpm test        # Vitest small and medium tests
pnpm test:e2e    # Playwright: every spec in headed Chromium, @cross-engine tests in WebKit
```

Install the browser engines once with `pnpm exec playwright install chromium webkit`.

While working, run what the change touches: `pnpm test src/server/storage.test.ts`, `pnpm test:e2e tests/review-ux.spec.ts`, a single test with `-g "<title>"`, or one engine with `--project=chromium`. Rebuild with `pnpm build` before E2E after changing `src/`. Before committing or opening a pull request, all four commands must pass. CI runs `build`, `typecheck` and `test` on Node 22 and 24; E2E runs locally because it needs headed Chromium with tab-capture flags.

E2E specs run sequentially against one demo server on port 4192 that writes to `needmark-e2e-feedback` in the temporary directory (`/private/tmp` on macOS). Specs that need a proxy start their own on other ports.

## Maintaining the suites

- Update tests in the same change as the behaviour. When a caption, role or flow changes intentionally, change the affected specs rather than adding new ones beside them.
- Before adding a browser test, search for one that already drives the same flow. Extend it only if the new assertion is part of the same behaviour; otherwise add a small test.
- Delete tests that duplicate a lower layer, check only styling or copy, or no longer correspond to documented behaviour. Deleting a redundant test is a valid change on its own.
- A flaky test is a bug: find the race and wait for the promised state. Do not add retries or longer timeouts to hide it.
- Watch the cost: a full `pnpm test:e2e` should stay around ten minutes. When it grows, look for tests to push down, merge or drop before adding more.

## Package managers

`pnpm test:package-managers` packs the package and, for each runner, copies [`examples/vite-react`](#examples) (without its `needmark.config.ts`) into a temporary project, points its `needmark` dependency at the tarball and installs it. The runners are npm (the one bundled with Node), pnpm 11, Yarn 4 with Plug'n'Play and Yarn 1. pnpm and Yarn are fetched through `npx` at those versions, so global installs and Corepack do not affect the result. In each project it checks:

- `needmark --help`, `remove` (which takes the plugin out of the copied `vite.config.ts`), `init --connect=yes` (config, Git ignore rule, the plugin added back and the runner's own command in the output) and `list` through the runner;
- an MCP `initialize` handshake over `needmark mcp`;
- that the example's `dev` script, started through the runner, serves the page with the review client injected, the Vite plugin reading the `needmark.config.ts` that `init` wrote;
- that the `needmark/proxy` review proxy injects and serves the client;
- that a production Vite build contains no NeedMark code.

Each runner uses one example only; the other frameworks are checked by hand with the [examples](#examples).

Run it before a release and after changes to packaging, the CLI, the build or dependencies. It needs network access to the npm registry.

| Option | Effect |
| --- | --- |
| `--only=npm,yarn` | Run selected runners (`npm`, `pnpm`, `yarn`, `yarn1`) |
| `--pnpm=10`, `--yarn=4.9` | Use another pnpm or Yarn version; pnpm 11 itself needs Node 22.13, so use `--pnpm=10` on Node 22.12 |
| `--spec=needmark@1.0.0` | Install a published version from the registry instead of the local tarball, to check a release after publishing. Yarn's quarantine of newly published versions is turned off for the check |
| `--keep` | Keep the temporary projects after a successful run (they are always kept after a failure) |

Pass options after `--`, for example `pnpm test:package-managers -- --only=yarn`. To check another Node version, run the script with it, for example `mise exec node@22.12 -- node scripts/verify-package-managers.mjs`.

## Examples

`examples/` holds small applications for checking NeedMark by hand in different frameworks. They are pnpm workspace packages that link `needmark` with `workspace:*`, so they load this repository's `dist/`; they are not part of the published package. Each page has the same review targets: a sticky header, buttons (including a disabled one), a form, an SVG image, a same-origin iframe (`/embed.html`), a cross-origin Google Maps iframe and ten articles that make the page long.

| Command | Example | NeedMark through | Open |
| --- | --- | --- | --- |
| `pnpm examples:react` | `examples/vite-react` (Vite 8, React) | Vite plugin | `http://127.0.0.1:4310` |
| `pnpm examples:vue` | `examples/vite-vue` (Vite 8, Vue) | Vite plugin | `http://127.0.0.1:4320` |
| `pnpm examples:astro` | `examples/astro` (Astro 5) | Vite plugin in `astro.config.mjs` | `http://127.0.0.1:4330` |
| `pnpm examples:next` | `examples/next` (Next.js 16 App Router, Turbopack) | `needmark dev -- next dev`, app on a free port | `http://localhost:4340` |
| `pnpm examples:html` | `examples/html` (static files served by `sirv`) | `needmark dev` proxy, app on 4351 | `http://127.0.0.1:4350` |

Each command runs `pnpm build` first and then the example's `dev` script, which starts the application with NeedMark: the Next.js example wraps `next dev` with `needmark dev --`, and the HTML example starts the static server and `needmark dev --target` together through `concurrently`; Ctrl+C stops both. Every example has its own `needmark.config.ts` (Japanese UI, DOM capture) and saves feedback to its own `.needmark/feedback`, which Git ignores. Rebuild after changing `src/` by restarting the command.

`examples/next/proxy.ts` is a pass-through Next.js proxy: without it, Turbopack takes the workspace root as the project root and loads this repository's `src/proxy.ts` as the app's proxy.

## Demo pages

The demo is a fictional product, Halden Analytics, used as a realistic review target. All demo content is in English. `pnpm demo` shows the review UI in English; E2E sets `NEEDMARK_DEMO_LANGUAGE=ja` so specs keep using the Japanese default captions.

| Page | Purpose |
| --- | --- |
| `demo/index.html` | Marketing landing page (static HTML, compile-time source positions) |
| `demo/react.html` + `demo/react.tsx` | Product dashboard (React, runtime component ownership) |
| `demo/embed.html` | Changelog widget embedded by the landing page in a same-origin iframe |

### What the demo lets you verify

| Element | Where | Checks |
| --- | --- | --- |
| Sticky header with navigation | Landing | Pins and selection on sticky/fixed elements while scrolling |
| Headline and body copy with inline emphasis | Landing | Text ranges, semantic owners, accessible names |
| Trial card (plan name, price, call to action, status message) | Landing | Element/multiple selection, exact HTML source positions |
| Product screenshot built from CSS and SVG | Landing | Area selection and DOM capture of gradients, shadows and radii |
| Scrolling logo strip and live indicator | Landing | Animation pause and resume |
| Feature cards | Landing | Marquee selection across repeated cards |
| Tabs with hidden panels | Landing, dashboard | Hidden targets, pins on panels that become hidden, route-preserving state changes |
| Billing toggle and pricing plans | Landing | Retained selection while the page changes text |
| Auto-advancing testimonial carousel with previous/next, dots and its own pause button | Landing | Pausing motion to comment on one slide, off-screen slides, timers scheduled after the widget starts |
| FAQ (`details`/`summary`) | Landing | Expanded and collapsed content |
| Sign-up form with password and a `data-needmark-redact` API key | Landing | Form values excluded from context, password and redacted regions masked in images |
| "Book a demo" native modal dialog | Landing | Review UI inside the dialog focus boundary and DOM capture of modals |
| Changelog in a same-origin iframe | Landing | Iframe selection, frame URLs and iframe capture |
| Status badge custom element with an open shadow root | Landing | Shadow DOM selection and root paths |
| App shell with sidebar, search and avatar | Dashboard | Selection and pins on a dense application layout |
| KPI cards and plan card from repeated React components | Dashboard | Runtime component chains, repeated instances, ambiguous test IDs |
| Line, bar and donut charts in SVG | Dashboard | Selecting chart parts and capturing SVG |
| Data grid with sorting, row selection, sticky header and horizontal scrolling | Dashboard | Overflow clipping, configured `data-feature`/`data-ticket` attributes, many similar rows |

### Fixture contract

E2E specs depend on these; change them only together with the specs.

- The landing page title contains `NeedMark` (Chromium's automatic tab-capture selection matches it).
- The landing page has `main`, a heading `h2#product-title`, a `button#purchase-button` whose click writes a message to `#purchase-status` (`role="status"`).
- The dashboard renders two `PurchaseButton` component instances, `#purchase-one` and `#purchase-two`, sharing `data-testid="purchase"`, with 20 px padding and a click counter in their text. The `<button id={id}` line in `demo/react.tsx` is indented four spaces, and the nearest heading belongs to the plan card.

## Manual check

Automated tests do not replace using the product. After a user-facing change:

1. `pnpm build`, then `NEEDMARK_DEMO_PORT=4290 NEEDMARK_OUTPUT_DIR=.needmark/manual pnpm demo` and open `http://127.0.0.1:4290`. A separate port and folder keep manual data away from E2E.
2. Perform the changed flow with a real pointer and keyboard, in Japanese and English when copy changed, in light and dark themes when visuals changed.
3. Inspect `demo/.needmark/manual/<id>/context.json`, `comment.md` and `screenshot.png`, and `node dist/cli.js export demo/.needmark/manual`.
4. For agent integrations, send JSON-RPC lines to `node dist/cli.js mcp demo/.needmark/manual` over stdio.

## References

The principles above follow these sources:

- [Test Sizes](https://testing.googleblog.com/2010/12/test-sizes.html), Google Testing Blog: size is defined by what a test may touch.
- [Software Engineering at Google, chapter 12: Unit Testing](https://abseil.io/resources/swe-book/html/ch12.html): test through public APIs, test state and behaviours, complete and concise tests, DAMP over DRY.
- [SMURF: Beyond the Test Pyramid](https://testing.googleblog.com/2024/10/smurf-beyond-test-pyramid.html), Google Testing Blog: weigh speed, maintainability, utilization, reliability and fidelity.
- [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) and [Test Pyramid](https://martinfowler.com/bliki/TestPyramid.html), martinfowler.com: push tests down and avoid duplicating them across layers.
- [Write tests. Not too many. Mostly integration.](https://kentcdodds.com/blog/write-tests), Kent C. Dodds: tests are a return on investment, not a coverage target.
- [Playwright best practices](https://playwright.dev/docs/best-practices): user-visible behaviour, isolation, user-facing locators and web-first assertions.
- [ピラミッド、アイスクリームコーン、SMURF: 自動テストの最適バランスを求めて](https://speakerdeck.com/twada/pyramid-ice-cream-cone-and-smurf), 和田卓人.
