# Obsidipi

A chat-driven agent that lives inside your Obsidian vault — built mobile-first so the iOS app is the primary target. Streams responses, calls vault-aware tools (read, search, edit, organize), gates every write behind diff approval, and persists each conversation back into the vault as a readable markdown transcript.

Built on [`pi-mono`](https://github.com/badlogic/pi-mono) (`@mariozechner/pi-agent-core` for the loop, `@mariozechner/pi-ai/openai-completions` for transport). Defaults to DeepSeek via its OpenAI-compatible endpoint.

> Status: **functional preview**. All listed tools and UI work in desktop Obsidian. iOS smoke-testing is still in progress — see the roadmap section. Not yet submitted to the Obsidian community plugin catalog; install via the dev steps below.

## Highlights

**Vault-aware tools.** The model can read notes, search across the vault, navigate folders, and structurally inspect headings, tags, backlinks, and daily notes. Every mutating call (`edit_note`, `create_note`, `append_note`, `move_note`, `trash_note`, `set_frontmatter`, `add_tag`) renders an inline diff/preview card and waits for an explicit Approve tap.

**Harness UX, not just a chat box.** Plan mode, a todo drawer, and an `ask_user` clarification step give multi-step tasks the same feel as a coding harness. The agent proposes a plan, waits for "Go", then ticks off todos as it works.

**Native vault integration in the input.** Type `@` and a fuzzy-search popover surfaces your notes (basename + path + frontmatter aliases). Selecting one inserts an inline chip — the model still sees `[[note.md]]`, but the UI shows a pill. The sent user bubble renders the same chip.

**Thread persistence as plain markdown.** Every conversation auto-saves to `.harness/threads/<date>-<slug>.md`. The body is a human-readable transcript; a trailing `%%obsidipi-state` block holds the JSON message array used for resume. Open, edit, sync, or back up your chats like any other note. A built-in side panel groups threads by Today / Yesterday / Earlier this week / Earlier, with inline-confirmed delete.

**No backend, no native deps.** Everything runs inside the Obsidian plugin sandbox. Bundle: ~2.2 MB.

## Install (beta, via BRAT)

The plugin isn't on the community catalog yet, but you can install it on any vault (mobile or desktop) using [Obsidian42 - BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. In Obsidian: Settings → **Community plugins** → Browse → install **Obsidian42 - BRAT** → enable it.
2. Open BRAT's settings → **Add Beta plugin**.
3. Paste the repo path: `subhanmahmood/obsidipi`
4. Back in Community plugins, enable **Obsidipi**.

BRAT will automatically pull new releases as they're cut here. To stay on a specific version, use BRAT's "Add Beta plugin with frozen version" instead and paste the version (e.g. `0.1.0`).

Releases are tagged on [GitHub](https://github.com/subhanmahmood/obsidipi/releases). Each release attaches `manifest.json`, `main.js`, and `styles.css` so BRAT (and Obsidian itself) can fetch them directly.

## Install (development)

If you want to hack on the plugin instead of testing it:

```bash
git clone https://github.com/subhanmahmood/obsidipi.git
cd obsidipi
npm install --legacy-peer-deps
npm run build
```

Then sync the built artifacts into a vault's plugin directory:

```
<vault>/.obsidian/plugins/obsidipi/
  manifest.json    -> symlink to repo
  main.js          -> symlink to repo
  styles.css       -> symlink to repo
  data.json        (created by Obsidian on first run)
```

> Do **not** symlink the whole repo into `.obsidian/plugins/` — that drags `node_modules` into Obsidian Sync. File-level symlinks only. `npm run build` already copies into `~/Documents/notes/.obsidian/plugins/obsidipi/` on this machine; adjust `esbuild.config.mjs` for your own vault path.

Enable "Obsidipi" under Settings → Community plugins, then configure a provider key.

## Configure

Open Settings → Obsidipi:

- **Provider** — DeepSeek (default), Anthropic, Google, OpenAI, or OpenRouter. All five use the same OpenAI-compatible call shape; transport is `pi-ai/openai-completions`.
- **Model ID** — e.g. `deepseek-chat`, `deepseek-reasoner`, `gpt-4o`, etc. The reasoning flag is auto-set when the model ID contains `reasoner`.
- **API key** — stored via Obsidian's `secretStorage` API (Obsidian 1.11.4+), keyed per device, kept out of `data.json` so it doesn't sync via Obsidian Sync or iCloud.

A `Obsidipi: Test API key` command does a one-shot non-streaming call so you can verify credentials without opening the chat.

## Privacy & network

- **One outbound destination per chat.** Whatever provider you configured — DeepSeek (`api.deepseek.com`), Anthropic (`api.anthropic.com`), Google (`generativelanguage.googleapis.com`), OpenAI (`api.openai.com`), or OpenRouter (`openrouter.ai`). No third party in between. The base URL is fixed in `agent-factory.ts`.
- **What gets sent.** Your message history for the current thread, your API key (in the `Authorization` header), the system prompt, and the tool-call schemas. Tool *results* (note contents the model has read) become part of the transcript and are included on subsequent turns — same as any chat-with-tools setup.
- **Nothing else leaves the device.** No analytics, no telemetry, no auto-update pings, no remote configuration, no "phone home" anywhere in the bundle. Search the code for `fetch` / `requestUrl` / `XMLHttpRequest` — the only hits are the provider call path.
- **API key storage.** Stored via Obsidian's `secretStorage` (1.11.4+) — kept on this device, outside `data.json`, not picked up by Obsidian Sync or iCloud vault backups. Plain-text at rest (not Keychain), per-device (re-enter on each device).
- **Threads stay local.** Conversation persistence is plain markdown under `.harness/threads/` in the vault. They sync the same way the rest of your vault does (Obsidian Sync, iCloud, Git — your call); they never leave that path.

## Tools the agent can call

### Reads (no approval)

| Tool | Purpose |
| --- | --- |
| `read_note(path)` | Full contents of a note. |
| `search_vault(query, scope?, maxResults?)` | Case-insensitive substring across markdown files. |
| `get_active_note()` | The note the user currently has open. |
| `list_folder(path, recursive?)` | Files and subfolders. |
| `get_backlinks(path)` | Every note that links to the target. |
| `get_notes_by_tag(tag)` | Frontmatter + inline tags, nested-tag aware. |
| `get_daily_note(date?)` | Resolves via Daily Notes plugin config; falls back to `YYYY-MM-DD.md` at root. |
| `get_headings(path)` | Heading outline with levels and line numbers. |

### Writes (approval-gated, diff preview per tool)

| Tool | Notes |
| --- | --- |
| `edit_note(path, old, new)` | Unique-match replacement via `vault.process` (atomic against Sync). |
| `create_note(path, content)` | Auto-creates missing parent folders. |
| `append_note(path, text)` | Smart separator — won't double-newline. |
| `move_note(path, newPath)` | Routes through `fileManager.renameFile`, so incoming wiki/markdown links update automatically. |
| `trash_note(path)` | System trash (recoverable). |
| `set_frontmatter(path, key, value)` | Any JSON-shape value; pass `null` to remove the key. |
| `add_tag(path, tag)` | Idempotent, dedupes, normalizes scalar `tags:` to an array. |

### Meta (no vault I/O, drives the harness UI)

| Tool | Notes |
| --- | --- |
| `plan(steps[])` | Inline plan card with Go/Stop + optional note. |
| `todo_write(items[])` | Replaces the visible todo drawer. |
| `todo_check(id)` | Marks one item done. |
| `ask_user(question, options[])` | Pauses with optional quick-reply chips. |

## Storage layout

The plugin keeps everything under `.harness/` inside the vault:

```
.harness/
  threads/
    2026-05-15-summarise-shed-base-abcdef.md
    2026-05-14-...md
```

Each thread file:

````md
---
obsidipi: thread
id: ...
title: Summarise shed base
provider: deepseek
model: deepseek-chat
created: 2026-05-15T20:00:00Z
updated: 2026-05-15T20:14:33Z
---

## user
@shed-base summarise

## assistant
Shed specs — 2.84 × 2.14m ...

## tool · read_note
`house/shed base.md` (3172 chars)

%%obsidipi-state
```json
{"version":1,"messages":[...]}
```
%%
````

The body and the JSON state block are both regenerated from `Message[]` on every save, so they can't drift. Only the state block is read on resume.

The `.harness/` folder is a dot-prefix so it stays out of Obsidian's regular file explorer. The plugin transparently falls back to `vault.adapter.list/read/write` when the metadata cache can't see dot-folders.

## Architecture

```
ObsidipiChatView (ItemView)
  ├── header (hamburger / title / +)
  ├── todos drawer
  ├── messages list
  │     ├── user bubbles (markdown + chip rendering)
  │     ├── assistant bubbles (streamed markdown)
  │     └── tool bubbles (running / ok / error / approval / plan / ask)
  └── contenteditable input
        └── @-mention popover (fuzzy-ranked candidates)

  ↕ events / approval / meta callbacks

Agent (pi-agent-core)
  ├── streamFn ←→ pi-ai/openai-completions
  ├── beforeToolCall ←→ approval gate
  └── tools: src/vault-tools.ts + src/meta-tools.ts

thread-store.ts: save/load/list/delete via vault.process + adapter fallback
```

### Why this stack

| Piece | Why |
| --- | --- |
| `@mariozechner/pi-agent-core` | Pure-TS agent loop with streaming, parallel/sequential tool exec, abort, hooks, follow-ups — saves ~600 LOC of plumbing. |
| `@mariozechner/pi-ai/openai-completions` | Single subpath import so the heavy Anthropic/Google/Mistral/Bedrock SDKs in `pi-ai` don't end up in the iOS bundle. Bundle stays ~2.2 MB. |
| Plain DOM in an `ItemView` | No React on iOS — smaller bundle, fewer surprises in WKWebView. Obsidian's `MarkdownRenderer.render` handles wiki-links, callouts, math, tables. |
| `typebox` | Schemas for tool parameters (already a `pi-agent-core` dep). |

## Development

```bash
npm install --legacy-peer-deps   # vitest 3 peer-wants @types/node >= 18; plugin template pins ^16
npm run dev                       # esbuild watch
npm run build                     # tsc -noEmit && esbuild production + copy-to-vault
npm test                          # vitest run (148 tests)
npm run test:watch                # interactive
npm run lint
```

### Layout

```
src/
  main.ts               plugin entry, commands, modals
  chat-view.ts          ItemView — UI, streaming, approval cards, @-mentions, thread switcher
  agent-factory.ts      Builds the Agent, system prompt, approval gate, model config
  vault-tools.ts        All vault-touching tools
  meta-tools.ts         plan / todo_write / todo_check / ask_user
  note-picker.ts        @-mention fuzzy search + caret state machine (pure functions)
  thread-store.ts       Save/load/list/delete + Obsidian comment-block format
  settings.ts           Settings tab + provider config
  test-call.ts          Standalone API-key smoke test

tests/
  mock-obsidian.ts      In-memory App / Vault / MetadataCache / adapter
  vault-tools.test.ts   91 tests
  meta-tools.test.ts    13 tests
  note-picker.test.ts   19 tests
  thread-store.test.ts  25 tests
```

### iOS development loop

Plugin debugging on iOS has no native devtools. Working setup:

1. Build on a Mac (`npm run build` copies into a synced vault).
2. Open the vault on the iOS device — Obsidian Sync pulls the updated `main.js`/`styles.css` within seconds.
3. Toggle the plugin off/on (Settings → Community plugins) to force a reload.
4. Attach Safari Web Inspector via USB to see console logs and inspect DOM.

`Platform.isMobile` / `Platform.isIosApp` are available if you need to branch behavior; the plugin currently doesn't.

## Roadmap

The annotated, current source-of-truth is [`notes/obsidipi.md`](notes/obsidipi.md) — it documents what's landed, what's pending, and why every architectural call was made. Headline:

- Phases 0–5: vault tools (read, write, organize, graph reads) — landed.
- Phase 4: meta tools (plan / todos / ask_user) — landed.
- Phase 7: `@`-mention picker + chip rendering — landed.
- Phase 8: thread persistence + switcher UI + delete — landed.
- Phase 6: `web_search` via Tavily/Brave/Exa — pending.
- Pending v1: pending-edits tray, voice input, iOS Shortcut entry, `HARNESS.md` auto-injection.
- iOS verification of the full write + meta + chip path is still outstanding for several phases — call out anything that misbehaves on real hardware.

## License

[0BSD](./LICENSE) — do anything you like.
