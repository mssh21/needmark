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
pnpm exec needmark init --language=en
```

Examples use pnpm. With npm run the CLI as `npx needmark`, with Yarn as `yarn needmark`. Initialization output and agent prompts use the command that matches your project's lockfile.

Initialization creates `needmark.config.ts` and targeted Git ignore rules. In a terminal, accept the recommended settings or choose each one from an explained list. Use `--language=ja` for Japanese; [all noninteractive flags](docs/getting-started.md#install-and-initialize) are documented in the guide.

### Vite

Add the plugin explicitly to your existing Vite configuration:

```ts
import { defineConfig } from 'vite';
import { needmark } from 'needmark';

export default defineConfig({
  plugins: [needmark()],
});
```

The plugin runs during development only and is absent from production builds and `vite preview`. Called without arguments, it loads `needmark.config.ts` from the directory where Vite runs. It works on `localhost`, `127.0.0.1` and `[::1]` without configuration; set `origins` only to review through another hostname, such as a LAN address or a tunnel.

### Astro

Astro runs on Vite, so add the plugin to the `vite` option and start `astro dev` as usual:

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import { needmark } from 'needmark';

export default defineConfig({
  vite: { plugins: [needmark()] },
});
```

### Next.js and other development servers

Start your application normally, then run this in the same project:

```sh
pnpm exec needmark dev --target=http://localhost:3000
```

Open `http://localhost:4190`. The proxy adds the widget without changing application imports or builds. Target and review origin must be different loopback HTTP origins; [proxy setup and limits](docs/getting-started.md#nextjs-and-other-development-servers) explain the details.

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
