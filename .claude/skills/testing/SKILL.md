---
name: testing
description: NeedMark's procedure for adding, changing, running and pruning tests. Use whenever a change in this repository adds or alters behaviour, fixes a bug, touches tests under src/**/*.test.ts or tests/*.spec.ts, or when reviewing or trimming the test suites, so each check lands in the smallest layer that can catch it and the browser suite stays small.
---

# Testing in NeedMark

The rules live in [`docs/testing.md`](../../../docs/testing.md); this skill is the order to apply them in. Read the Principles, Layers and sizes, and What not to test sections of that document before writing a test.

## 1. Decide what to prove

- Write the behaviour as one sentence a user or caller would recognise: "Leaving details hides the target outline", not "clearLocated hides outline".
- For a bug, that sentence is the expected behaviour the bug violates. You will reproduce it first.
- If the change only alters styling or copy, plan a demo check instead of a test.

## 2. Pick the smallest layer

Ask, in order, and stop at the first yes:

1. Can it be called with plain data and no I/O? → small Vitest test next to the source file.
2. Does it need files or a localhost server, but no browser? → medium Vitest test (temporary directory, free port).
3. Does the outcome depend on layout, rendering, events, browser APIs, or the full widget–server–files flow? → Playwright spec.

For a Playwright test, also decide whether WebKit could behave differently (rendering and capture, hit testing, carets and ranges, frames and shadow roots, stack formats, native dialogs, style inheritance, pointer and keyboard events, media). Only then add `{ tag: '@cross-engine' }`.

## 3. Look for an existing test first

- Search by behaviour: `grep -rn "<key word>" src --include='*.test.ts' tests/*.spec.ts`.
- If a test already drives the same flow and the new assertion belongs to the same behaviour, extend it. Otherwise add a new, focused test.
- If the same rule is already checked at a lower layer, do not add it in the browser.

## 4. Write it

- Arrange, act, assert, in straight lines; show the inputs that matter in the test body.
- Name the test after the behaviour and outcome.
- Playwright: import `test`, `expect` and helpers from `tests/support/review.ts`; locate by role, label and text; wait with web-first assertions or `expect.poll`, never with a fixed timeout; stub slow or flaky transports with `page.route`.
- Vitest: build data from `tests/fixtures.ts`; clean up temporary directories and servers in `afterEach`.
- For a bug, run the new test before the fix and confirm it fails for the reason you expect.

## 5. Run

- While iterating: `pnpm test <file>`, or `pnpm build` then `pnpm test:e2e <spec> -g "<title>" --project=chromium`.
- Before committing: `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` all pass. A full E2E run takes about ten minutes; run it in the background and report the summary line.
- Check user-facing changes in the demo as described in docs/testing.md#manual-check.

## 6. Leave the suite smaller or equal where you can

- When your change makes a test redundant (same rule at a lower layer, or a flow another test already covers), delete or merge it in the same change.
- Remove assertions on styling or decoration you come across in the tests you touch.
- If you notice a flaky test, fix the race; do not add retries or longer timeouts.

## Checklist

- [ ] The behaviour is stated as a sentence and the test name says it.
- [ ] The test is at the smallest layer that can catch the failure.
- [ ] A bug fix has a test that failed before the fix.
- [ ] No styling, static copy or type-level guarantees are asserted.
- [ ] `@cross-engine` only where WebKit could behave differently.
- [ ] Redundant tests touched by the change were removed or merged.
- [ ] `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` pass.
