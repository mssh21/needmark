# NeedMark

**English** | [日本語](README.ja.md)

Point at your UI, leave a comment, and hand it to your usual coding agent. NeedMark saves the comment, target/source context and optional screenshot as local files, so the agent can inspect the evidence and you can check the repair.

MIT licensed. It requires no account, MCP server or specific AI provider. The runtime UI does not require React; use the Vite development plugin or a separate review proxy for an existing HTTP development server, including Next.js. NeedMark is independent of hosted NeedBack.

## Try locally

```sh
pnpm install
pnpm build
pnpm demo
```

Open `http://127.0.0.1:4190`. Use the toolbar to select a target and write a comment. Settings let you choose English or Japanese and DOM, tab or image-free capture. Demo feedback stays in `demo/.needmark/feedback`.

## Install in your project

Requires Node.js 22.12 or newer. In your application project:

```sh
pnpm add -D needmark   # npm install -D needmark / yarn add -D needmark
pnpm exec needmark init
pnpm dev               # your usual development command
```

Open the app as usual; the NeedMark toolbar appears at the bottom of the page. Examples use pnpm. With npm run the CLI as `npx needmark`, with Yarn as `yarn needmark`.

`init` shows recommended settings and, with your consent, connects NeedMark to the development server. It never touches application source or production builds:

| Project | What `init` changes |
| --- | --- |
| Vite (React, Vue and others) | Adds `needmark()` to `plugins` in `vite.config.*` |
| Astro | Adds `vite: { plugins: [needmark()] }` to `astro.config.*` |
| Next.js | Starts the `dev` script through `needmark dev --`, which keeps your usual port and runs Next.js behind it |

It also writes `needmark.config.ts` and targeted Git ignore rules. `NEEDMARK=off pnpm dev` starts without NeedMark for you; `enabled: false` in `needmark.config.ts` turns it off for everyone; `pnpm exec needmark remove` undoes the connection. Other servers and configs `init` cannot read are set up by hand as described in [Getting started](docs/getting-started.md#connect-the-development-server); [all noninteractive flags](docs/getting-started.md#install-and-initialize) are documented there too.

## Review, hand off, verify

1. [Hover to preview the target’s tag, name and available component](docs/getting-started.md#select-and-save), then select an element, text, area or multiple elements. Shift+click/drag adds multiple targets; Alt/Option+drag selects part of the text; Ctrl/Cmd+click picks a covered target. Enter finishes selection.
2. Write a comment and save it with DOM capture, current-tab capture or no image. Choose **Fix**, **Discuss** or **Question** so the agent knows whether to change code or answer. Each item has `comment.md`, `context.json` and an optional `screenshot.png`.
3. Copy the filtered open comments as instructions for your coding agent. It needs access to the project files and, when used, the images.
4. Have the agent fix the code and reply with its verification. Check the result yourself before resolving the comment.

Agents that support MCP, such as Claude Code and Codex, can register `needmark mcp` to read feedback with its screenshot, reply, resolve and wait for new feedback. See [Connect an AI agent](docs/getting-started.md#connect-an-ai-agent).

```sh
pnpm exec needmark export --detail compact
pnpm exec needmark watch
pnpm exec needmark reply <id> 'Adjusted padding; checks passed.' --author Codex
# After the user checks the result:
pnpm exec needmark resolve <id>
```

Pins and the list support editing, replies and resolving or reopening comments.

DOM capture needs no sharing permission but has rendering limits. Tab capture asks to share the current tab. Passwords and marked regions are masked in saved images; [capture and privacy](docs/getting-started.md#capture-and-privacy) cover the limits and image-free recovery.

## Language and documentation

Set `language: 'en'` or `'ja'` in `needmark.config.ts`; the UI defaults to Japanese for compatibility. A saved browser preference takes precedence. Changing language keeps comments, replies, captured page text and custom component text as written. UI prompt copies use the selected language; CLI exports use an explicitly configured language and otherwise retain English prose.

- [Getting started](docs/getting-started.md): configuration, selection, handoff, sharing and migration.
- [はじめに](docs/getting-started.ja.md): the same guide in Japanese.
- [Architecture and operating limits](docs/architecture.md): detailed implementation reference in English.
- [Agentation comparison and product evaluation (Japanese)](docs/agentation-comparison.ja.md)
- [Documentation index](docs/README.md) · [MIT license](LICENSE)
