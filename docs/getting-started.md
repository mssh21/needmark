# Getting started with NeedMark

**English** | [日本語](getting-started.ja.md) · [README](../README.md) · [Documentation index](README.md)

NeedMark connects visual feedback to your own repair workflow: select UI, save a comment with context and an optional image, ask an agent to inspect the local files, then check the result yourself. It is MIT licensed and needs no account, mandatory MCP server or specific agent SDK. The runtime UI does not require React and does not connect to hosted NeedBack.

## Install and initialize

Use Node.js 22.12 or newer with npm, Yarn or pnpm. Install NeedMark in your application project:

```sh
pnpm add -D needmark   # npm install -D needmark / yarn add -D needmark
pnpm exec needmark init
pnpm dev               # your usual development command
```

This guide writes CLI commands for pnpm. With npm use `npx needmark`, with Yarn (classic or Plug'n'Play) `yarn needmark`, for example `npx needmark init`. Initialization output and agent prompts use the command that matches your project's lockfile ([package managers](architecture.md#package-managers)).

In a terminal, setup is in English. It first shows recommended settings (the review screen in your terminal's language, feedback kept on this computer, screenshots redrawn from the page and, when it recognizes your project, [connecting the development server](#connect-the-development-server)) and asks whether to use them. Answer `n` to choose each item from a numbered list that explains it. Choices given as flags are not asked again. Supply all choices as flags for a noninteractive invocation; without a terminal `init` changes no file of yours unless `--connect=yes` is given:

```sh
pnpm exec needmark init --share=local --capture=dom --language=en --connect=yes
```

Initialization writes `needmark.config.ts` and targeted Git ignore rules, preserving existing rules. It never overwrites an existing config: run again in a project that has one, `init` keeps it and only offers to connect the development server; see [migration](#migration) for compatibility with older projects. Installing does not start the application or an agent.

## Project configuration

The default export is trusted local TypeScript configuration, shared by the CLI and adapters:

```ts
import type { NeedMarkOptions } from 'needmark';

export default {
  language: 'en',
  capture: 'dom',
  outputDir: '.needmark/feedback',
} satisfies NeedMarkOptions;
```

| Option | Behavior |
| --- | --- |
| `enabled` | `false` turns NeedMark off for everyone who uses this config; see [turn NeedMark off](#turn-needmark-off). |
| `origins` | Optional Vite allowlist of exact origins, including scheme and port; no wildcards or paths. When omitted, the plugin allows `localhost`, `127.0.0.1` and `[::1]` on any port, so it keeps working when Vite moves to another port. Set it only to review through another hostname, such as a LAN address with `--host`, a tunnel or a custom local domain; the list then replaces the loopback default. It does not choose the proxy listener. |
| `language` | `'en'` or `'ja'`; initial UI language defaults to `'ja'`. An explicit value also selects CLI prompt prose. |
| `capture` | `'dom'`, `'tab'` or `'none'`; initial capture defaults to `'dom'`. |
| `outputDir` | Dedicated feedback folder, outside `public`; defaults to `.needmark/feedback` for a new project. Vite resolves it from its root, the proxy from its project root. |
| `editor` | Optional `'vscode'` or `'cursor'` links to validated local source positions; requires the installed app and protocol handler. |
| `contextAttributes` | Up to six additional safe lowercase HTML attribute names, such as `['data-feature', 'data-ticket']`, for context and proxy source verification. |
| `onFeedbackChange` | Optional Node callback after saved API changes. Failures are logged without failing saving; CLI/Git/direct file edits do not invoke it. |
| `onSubmit` | Optional awaited Node callback receiving `{ feedback, prompt, directory, detail, language? }`; enables the widget's Send action. |

The CLI and `needmark()` without arguments read config only from the current project directory. Invalid config stops startup. Changes take effect on the next CLI invocation or proxy restart; restart the Vite development server after changing `needmark.config.ts` or its plugin configuration. Feedback files are never imported as config.

### Language

A valid browser language preference overrides `language`. Change it in review settings; browser preferences are per origin. NeedMark control captions and UI copy/Send prompt prose use that choice. CLI `export` uses explicit config language, otherwise English; existing direct formatter calls also retain English by default.

Comments, replies, captured page text, and existing feedback remain as written. Technical metadata, JSON keys, identifiers and commands retain their English names. Third-party/browser errors can remain in their original language; the language setting does not guarantee translation of every message.

## Connect the development server

With your consent, `init` connects NeedMark so that your usual development command shows the toolbar. It changes only development configuration, never application source or production builds, and lists each line it changed:

| Project | What `init` changes |
| --- | --- |
| `vite.config.*` (React, Vue, Svelte and other Vite projects) | Adds `import { needmark } from 'needmark'` and `needmark()` first in `plugins` |
| `astro.config.*` | Adds the import and `needmark()` to `vite.plugins`, creating `vite: { plugins: [...] }` when needed |
| A `dev` script running `next dev` | Prefixes it with `needmark dev --`; see [Next.js and other development servers](#nextjs-and-other-development-servers) |

The change is committed with your project, so everyone who runs the development server gets the toolbar. `init` reads a config written as `defineConfig({...})`, a plain object, a named constant or a function returning the object; it leaves any other shape untouched and prints the manual steps below. `pnpm exec needmark init --connect=yes` connects later, and `pnpm exec needmark remove` removes exactly what connecting added, keeping `needmark.config.ts` and saved feedback.

### Turn NeedMark off

Start the development server with `NEEDMARK=off` (also `0`, `false` or `no`) to run it without NeedMark for yourself; `NEEDMARK=on` turns it back on for you even when the config says otherwise. `enabled: false` in `needmark.config.ts` turns it off for everyone. While off, the Vite plugin adds nothing and `needmark dev -- <command>` only runs the command on its usual port.

### Vite

To connect by hand, add the plugin to your existing Vite config, before any plugin whose pre-ordered transform compiles JSX:

```ts
import { defineConfig } from 'vite';
import { needmark } from 'needmark';

export default defineConfig({
  plugins: [needmark()],
});
```

Without arguments, the plugin loads `needmark.config.ts` from the current working directory when the development server starts, the same file the CLI reads. Passing settings, as in `needmark(settings)` or `needmark({ outputDir: 'reviews' })`, uses only those settings and skips the file.

Run your usual Vite development command and open it on `localhost`, `127.0.0.1` or `[::1]`, or on a configured origin. The plugin uses Vite's HTML transformation, appends the widget to HTML that a framework renders without it, and runs only in development serve, excluding `vite preview` and production builds. It annotates local `.jsx`/`.tsx` native tags and entry HTML; other template/SSR/generated-source mapping is not universal. The widget mounts only in the top document. Accessible same-origin children can be selected from their parent; opening a child directly creates its own toolbar.

### Astro

Astro runs on Vite, so add the same plugin to the `vite` option and run `astro dev` as usual:

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import { needmark } from 'needmark';

export default defineConfig({
  vite: { plugins: [needmark()] },
});
```

Astro renders pages without Vite's HTML transformation, so the plugin appends the widget script to the end of each HTML response instead. Source positions are not added to `.astro` templates; feedback keeps the DOM context and file hints.

### Next.js and other development servers

Put `needmark dev --` in front of the development command in `package.json`, as `init` does for Next.js:

```json
"scripts": { "dev": "needmark dev -- next dev" }
```

`pnpm dev` then serves the app with the toolbar on the port you always open: the port given to the command with `-p`/`--port` (removed from the command), otherwise `PORT`, otherwise 3000, or `--port` before `--`. NeedMark listens on `http://localhost:<port>` and starts the command with `PORT` set to a free port, so the server must read `PORT`, as Next.js and most Node servers do. Ctrl+C stops both, and the command's exit code is kept.

For a server that does not read `PORT`, start it as usual and run the proxy next to it:

```sh
pnpm exec needmark dev --target=http://localhost:3000 --origin=http://localhost:4190
```

Open the review origin, `http://localhost:4190`. Target is required; review origin defaults to that URL. Both must be different exact loopback HTTP origins using `localhost`, `127.0.0.1` or `[::1]`; review needs a port. Existing CSP, absolute application URLs and framework origin checks still apply and may require their normal development configuration. The proxy does not alter application imports or production builds; Ctrl+C stops it.

The command loads shared config, including language, capture, output directory, editor, context attributes and callbacks. `--capture=dom|tab|none` and `--directory` override config; browser capture preferences still take precedence. For programmatic use, `needmark/proxy` exports `startReviewProxy`: its required `target`/`origin`, optional `root` (current directory by default), and shared options return a review server with `close()`. Proxy source lookup needs compatible React development metadata, local source maps and current local JSX identifiers; otherwise DOM context and file-search hints remain usable.

## Select and save

### Toolbar

The toolbar sits at the bottom centre of the page; drag it from anywhere, including its buttons, to move it. The button at its right end collapses it to that single button; press it again to bring the tools back. Shortcuts keep working while it is collapsed. Hover or focus a button to see its name, what it does and its shortcut. Panels can be moved by dragging their header, which stays at the top while the panel scrolls; a moved panel stays there until you close it.

| Button | Purpose |
| --- | --- |
| Comment (plus icon) | Pick a spot on the page and leave a comment. This is NeedMark's main tool. |
| Toggle pins | Show or hide the pins of saved feedback. |
| Pause | Stop animations, video and timers so you can comment on one moment of a carousel or other moving UI. While paused it shows a play icon. |
| Comments | Review feedback, reply, resolve it and hand it to your agent. The list and settings open centred above their buttons. |
| Settings | Language, capture method, author (shown only when set) and how much context goes to the agent. Hover the i icon next to capture method or agent context for its explanation. |

### Comment

**Comment** is a single tool; the gesture decides what you select. While you select, the toolbar's buttons give way to a one-line hint, a **?** link to this section and a **×** button that ends selection (also Esc); the buttons return when you finish. The gestures below are documented here rather than on the toolbar so it stays readable on narrow screens.

| Gesture | Selects |
| --- | --- |
| Click | An element |
| Drag | A free area (scroll with the wheel, or hold the pointer near an edge of the window, to extend it beyond what is visible) |
| Shift+click or Shift+drag | Several elements (then click to add or remove, Enter to finish, Backspace to undo the last one) |
| Ctrl/Cmd+click | The element underneath an overlay |
| Alt/Option+drag | Part of the text, for typos and wording |

Multiple selection starts with Shift+click or Shift+drag; after that, plain clicks add or remove targets and the hint shows the count with **Finish selection**.

Hover before clicking to preview the target’s outline, tag and best-effort name, plus a component when local metadata provides one. Pressing or releasing Ctrl/Cmd updates the covered-target preview even with the pointer still. Names use bounded label, text and ID hints rather than a complete accessibility-name calculation. The preview reads no form values and makes no source lookup requests. Observed page/root changes, scrolling, resizing and a new gesture clear it; the review host keeps it out of saved images. See [preview behavior and limits](architecture.md#review-interaction).

- Ctrl/Cmd+click searches below the frontmost independent branch, passing additional empty containers or invisible covers to prefer content or controls. If only empty visual targets remain, it chooses the smallest visible one. A lower hit inside the frontmost open shadow root or accessible same-origin frame takes precedence over an outer branch. It keeps the frontmost target if no lower branch exists and never hides application overlays. Releasing the modifier does not finish selection; use Enter or the completion button.
- In a multiple selection every selected original keeps its context and numbered outline. Escape cancels an active drag first while retaining earlier selections, then ends selection. A bounded marquee search reports incomplete discovery; clicks and later drags can add targets.

### Write the comment

The comment panel shows the capture, then a **Category** choice above the comment field: **Fix** (the default), **Discuss** or **Question**. Fix asks the agent to change the code. Discuss and Question ask for an answer instead: the AI instructions tell the agent to reply to the comment and leave the code unchanged. The category appears in `comment.md`, the AI instructions and, for Discuss and Question, as a tag in the list.

**Save** (Ctrl/Cmd+Enter in the comment field) saves without opening the list and immediately starts selecting the next target; press Esc or the end button to stop, and open the list from the toolbar. While you type, a dashed outline marks the selected target; scrolling the page removes it. The capture appears between the heading and the comment field (click it to enlarge), and the source location for the agent sits below the form as a collapsed line.

**Comment** starts selecting right away, using `needmark.config.ts` and any values saved in **Settings**. Set an author name in **Settings** when several people review the same files.

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Shift+C, Ctrl/Cmd+Shift+F | Start or end selection |
| Shift+P | Pause or resume animation |
| Shift+H | Hide or show the toolbar and pins |
| Ctrl/Cmd+Enter | Save a comment, edit or reply |
| Enter / Backspace | Finish multiple selection / undo the last target |
| Esc | Cancel the current gesture or close the panel |

Page-wide shortcuts are ignored in text fields and during IME composition, and can be turned off with **Keyboard shortcuts** in settings. Pins show open feedback only.

Target references (items saved without a comment by earlier versions) still load. They have their own label, stay searchable, pinned and locatable, and can be resolved and replied to; the widget no longer creates them.

## Capture and privacy

| Method | Choice and limits |
| --- | --- |
| `dom` | No sharing permission. Renders the current DOM, including accessible same-origin frames; unsupported CSS, video and cross-origin content can differ from visible pixels. |
| `tab` | Requires sharing the current tab. Window/monitor sources are rejected; an active stream is reused until stopped or page exit. Choose the current tab when the browser cannot verify it. |
| `none` | Saves comment and target context without an image. When capture fails, the comment switches to this mode and keeps the typed text, so you can save it as usual. |

Saved pixels mask password fields and `data-needmark-redact` regions; `data-needback-redact` remains recognized. Mark a cross-origin iframe or closed shadow host itself to mask its interior. Masks do not alter the browser's live sharing stream. Changed targets, routes, viewport/frame geometry or sensitive regions can reject an in-flight capture. An accepted image retains its acquisition geometry; no audio/video recording is included. Inspect images in the zoom/pan viewer. [Capture details](architecture.md#capture) explain the full stability and rendering limits.

## Hand off and check the repair

Each feedback UUID folder contains `comment.md`, `context.json` and an optional `screenshot.png`. New projects use `.needmark/feedback`; demo files use `demo/.needmark/feedback`. JSON is the status source of truth. Target references use `intent: "reference"` and an empty comment. Upgrade all readers of a shared directory before adding references: older NeedMark versions reject their empty comments and may fail a mixed listing. The idle UI refreshes after CLI/Git changes without discarding active edits.

The list header holds **Copy prompt** (an AI sparkle icon), search, filter and ⋮ icons. Search turns the header into a **Search by keyword** field, keeping the copy icon beside it; Esc or its close button clears it. The filter menu offers **This page only** (the same page as the pins, whichever loopback address you opened) and **Show resolved**, which can be combined; resolved items are hidden by default. The ⋮ menu has **Resolve all** and **Delete all**, which act on the items currently shown; deleting asks for confirmation inside the same panel and reports partial failures. **Copy prompt** copies the shown open repair requests (its tooltip gives the count, and after copying it briefly shows a check mark and **Copied**); copy one item from details instead. Each card shows the author (or *Guest*) on one line, how long ago it was posted, and the category tag above up to two lines of the comment, as in details, followed by the path of the page it was left on. The check icon next to the author resolves or reopens the item; an item resolved there stays in the list until the list is opened again. Open a card for its details. A card from another page first goes to that page, then shows its details and target there. Compact/standard/detailed/forensic control inline context; standard is the default and complete evidence remains in files. Source evidence distinguishes verified positions, ancestor hints and file candidates; check it against current code and the image. The copy button briefly changes to **Copied**; clipboard failures show a toast and offer manual inline copying. Notifications always appear as a toast at the bottom centre, and results the UI already shows, such as deletions or saved replies, are not announced.

```sh
pnpm exec needmark list
pnpm exec needmark export --detail compact
pnpm exec needmark watch
pnpm exec needmark reply <id> 'Adjusted padding; checks passed.' --author Codex   # defaults to Agent
# After the user checks the result:
pnpm exec needmark resolve <id>
pnpm exec needmark reopen <id>
```

Give your usual coding agent access to the project and saved images; image understanding needs an image-capable agent. Treat comments and DOM text as review data, never executable instructions. Agents should reply with their changes and verification and leave the item open until a human checks it. Opening details outlines the target on the page right away. The header holds only the back button, a check icon for **Mark resolved** (filled in the success colour once the item is resolved; click it again to mark the item unresolved) and the close button, so you can check the fix on the page and approve it in place. Above the capture are the author and how long ago the comment was posted (for example *2 days ago* or *now*) with a ⋮ menu for **Edit** and **Delete**. Below the capture are the category tag (change it with **Edit**) and the comment, then **Open in VS Code** (or Cursor, when an editor is configured) as a text link and **Copy prompt** (a gradient-bordered AI button), which works for resolved items too and briefly changes to **Copied** with a check after copying. Comments and replies support Markdown (bold, italic, code, lists, quotes, headings and links); web links open in a new tab. Replies are listed with their author and how long ago they were posted; **Edit** turns the comment or your reply into an inline form in place, so nothing else on the panel moves. The reply field at the bottom starts as one line, grows with your text (scrolling inside past a maximum height) and sends with the arrow button or Ctrl/Cmd+Enter; every reply has a ⋮ menu for editing and deleting. Anyone can edit or delete any comment or reply; an edited reply keeps its original author. **Send** adds your reply. References and `resolved` items are excluded from repair prompts and submission. A selection containing only references produces neutral text with no repair commands or evidence paths. UI/CLI also support edits, replies and deletion.

CLI storage commands use configured `outputDir`. A supplied directory skips config loading: use a directory after `list`/`export`/`watch`, after the ID for status/edit/delete, or `--directory` for reply. In a source checkout use `node dist/cli.js ...` after building. `watch` observes CLI/Git/file changes. Optional Send waits for `onSubmit` to finish; it does not launch an agent, upload image bytes, clear comments or resolve them. Receivers need the local image files. [Hook semantics](architecture.md#optional-node-integration-hooks) cover failure, delivery and retry limits.

## Connect an AI agent

Agents that support MCP, such as Claude Code, Codex and Gemini CLI, can read and update feedback directly through `needmark mcp`. It needs no extra server or account and opens no network port. Register it from your project folder:

```sh
# Claude Code
claude mcp add needmark -- pnpm exec needmark mcp
# Codex
codex mcp add needmark -- pnpm exec needmark mcp
```

The agent gets these tools:

| Tool | Purpose |
| --- | --- |
| `needmark_list_feedback` | List feedback, open items by default |
| `needmark_get_feedback` | Full record plus the screenshot image |
| `needmark_reply` | Reply with an answer or progress report |
| `needmark_resolve` | Resolve with a summary reply, after you check the result |
| `needmark_watch` | Wait for new feedback and receive it as a batch |
| `needmark_export_prompt` | Build the repair prompt |

Screenshots arrive as images rather than file paths, so an image-capable agent sees exactly what you pointed at.

**Hands-free mode**: tell your agent something like:

```text
Call needmark_watch in a loop. For each feedback item, read it and its image with needmark_get_feedback,
fix it and report verification with needmark_reply.
Answer questions with a reply, and only resolve items after I confirm. Continue until I say stop.
```

See [MCP server](architecture.md#mcp-server) for exact behavior.

## Local or Git sharing

Choose `--share=local` to ignore feedback, or `--share=git` to expose only the feedback folder through targeted ignore rules. Review files can contain page content and images; decide what to include in your normal commits. The CLI does not commit/push, execute feedback or deliver live remote submissions into another checkout.

## Migration

The CLI and `needmark()` without arguments read `needback.config.ts` only when `needmark.config.ts` is absent; an invalid new config stops without falling back. Without explicit `outputDir`, existing `.needback/feedback` is used only when `.needmark/feedback` is absent. New storage wins when both exist; selection never merges, moves or deletes feedback.

`init` stops if either config name exists. When only old feedback exists, it retains that output directory and targets it in ignore rules. Browser preferences and toolbar position prefer `needmark-*` keys and read `needback-kit-*` only when the new key is unset; saves use new keys without deleting old ones. Command/package aliases are not provided.

See the [English architecture reference](architecture.md) for API/storage boundaries, source verification, iframe identity, animation pause and verification coverage.
