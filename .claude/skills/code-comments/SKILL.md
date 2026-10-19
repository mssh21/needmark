---
name: code-comments
description: NeedMark's rules for code comments. Use whenever you add, change, review or remove TypeScript code under src/ (features, fixes, refactors, reviews), so every comment explains why that implementation was chosen, in English and Japanese, and never restates the specification.
---

# Code comments in NeedMark

NeedMark is an open-source project. Comments exist so a contributor can safely change the code: they explain **why this implementation was chosen over the alternatives**. What the product does belongs in `docs/` (see the reference-documentation rule in AGENTS.md).

## Rules

1. **No specification in comments.** Do not describe behavior, limits, defaults or user-visible rules ("Corners keep the opposite corner", "Default: ja", "Up to six attributes"). Put them in `docs/architecture.md` or the guides. If a comment would only restate code or docs, delete it.
2. **State the reason for the chosen implementation.** Name the constraint or the rejected alternative: browser/engine behavior, a security boundary, a race, performance, compatibility, a vendor quirk. Good: "html2canvas copies CSSOM edits and text alike, so match content instead of the STYLE ordinal its own stylesheet can shift."
3. **No reason, no code.** If you cannot write a concrete reason for a non-obvious construct (an extra microtask, a try/catch, a magic number, a special case), simplify or remove it instead of commenting it. Run the tests to prove it was unnecessary.
4. **English and Japanese.** Every comment carries the same reason in both languages, English first.
5. **Comment only the non-obvious.** Straightforward code needs no comment. One reason per decision, placed directly above it (or inline in an empty `catch`).

## Format

Write the English sentence first and the Japanese sentence second, with no labels such as "Why:" or "理由:".

```ts
// Chromium keeps a native modal's top layer out of DOM clones, so restore it on the clone.
// Chromiumは複製したDOMにネイティブモーダルのtop layerを引き継がないため、複製側で戻す。
clone.showModal();
```

- Line comments: one or more `//` lines in English, followed by the same reason in Japanese.
- Empty `catch` blocks and other inline spots: `/* English. / 日本語。 */`.
- JSDoc on exported API (`/** … */`): one sentence stating why the API exists in this shape, or a pointer to the document that specifies it (`See docs/getting-started.md#project-configuration`), in both languages. Do not restate option behavior.
- Do not add `TODO` without an issue link; record open work in an issue.

## When you change code

- Update or delete the comments next to code you change; a stale reason is worse than none.
- When a reason refers to a test that proves it, name the test file.
- `src/comments.test.ts` fails when a comment in `src/` (excluding `*.test.ts`) lacks either language. It cannot judge content, so review your comments against rules 1–3 before finishing.

## Review checklist

- [ ] No comment describes behavior that docs should describe.
- [ ] Each comment names a constraint or rejected alternative.
- [ ] Constructs without a reason were removed or simplified, with tests passing.
- [ ] Every comment has English and Japanese.
- [ ] `pnpm test` passes (includes `src/comments.test.ts`).
