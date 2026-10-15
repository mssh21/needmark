# Testing

[Documentation index](README.md) · [Architecture](architecture.md#verification)

How NeedMark is tested and which layer to use for a change.

## Commands

```sh
pnpm build       # required first: typecheck, E2E and the demo load dist/
pnpm typecheck
pnpm test        # Vitest unit and API tests
pnpm test:e2e    # Playwright: headed Chromium and Playwright WebKit
```

Install the browser engines once with `pnpm exec playwright install chromium webkit`. A change is done only when all four pass.

## Package managers

`pnpm test:package-managers` packs the package and installs the tarball into a fresh temporary project for each runner: npm (the one bundled with Node), pnpm 11, Yarn 4 with Plug'n'Play and Yarn 1. pnpm and Yarn are fetched through `npx` at those versions, so global installs and Corepack do not affect the result. In each project it checks:

- `needmark --help`, `init` (config, Git ignore rule and the runner's own command in the output) and `list` through the runner;
- an MCP `initialize` handshake over `needmark mcp`;
- that the Vite plugin, loaded from `needmark.config.ts`, injects and serves the review client in development;
- that the `needmark/proxy` review proxy injects and serves the client;
- that a production Vite build contains no NeedMark code.

Run it before a release and after changes to packaging, the CLI, the build or dependencies. It needs network access to the npm registry.

| Option | Effect |
| --- | --- |
| `--only=npm,yarn` | Run selected runners (`npm`, `pnpm`, `yarn`, `yarn1`) |
| `--pnpm=10`, `--yarn=4.9` | Use another pnpm or Yarn version; pnpm 11 itself needs Node 22.13, so use `--pnpm=10` on Node 22.12 |
| `--spec=needmark@1.0.0` | Install a published version from the registry instead of the local tarball, to check a release after publishing. Yarn's quarantine of newly published versions is turned off for the check |
| `--keep` | Keep the temporary projects after a successful run (they are always kept after a failure) |

Pass options after `--`, for example `pnpm test:package-managers -- --only=yarn`. To check another Node version, run the script with it, for example `mise exec node@22.12 -- node scripts/verify-package-managers.mjs`.

## Layers

| Layer | Location | Use for |
| --- | --- | --- |
| Unit / API | `src/**/*.test.ts`, next to the file under test | Storage validation, prompt formatting, API boundaries, proxy, MCP protocol and tools, geometry and other pure logic |
| Repository rules | `src/structure.test.ts`, `src/comments.test.ts` | Source-layer boundaries and bilingual code comments |
| Browser (E2E) | `tests/*.spec.ts` | Selection, capture pixels, panels, keyboard, iframe/shadow DOM and anything that needs a real engine |

E2E specs run sequentially against one demo server on port 4192 that writes to `/private/tmp/needmark-e2e-feedback`. Tests that need a proxy start their own on other ports.

## What to test

- Add or update tests for stable behavior, branch conditions and edge cases with a concrete regression risk.
- Reproduce a bug with a failing test before fixing it.
- Do not add tests that only mirror static copy, decoration, DOM structure or styling, or guarantees the type system already enforces.
- Captions and roles used as selectors are part of many specs; when a change alters them intentionally, update those specs in the same change.
- Avoid timing races: wait for the state the product promises (for example, the review host moving into a dialog) rather than for a fixed delay.

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
| Trial card (plan name, price, call to action, status message) | Landing | Element/multiple selection, exact HTML source positions, page operation while selected |
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
