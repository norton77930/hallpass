# Research: Attachments in the Side-Panel Conversation

Evidence from reading the pinned adapters (`npm pack` of claude-agent-acp 0.81.2 and codex-acp 1.13.1, read
only) and the repository on 2026-10-21. Behaviour of other agent side panels was observed, never copied.

## R-336 — What the agents accept

- **Decision**: send images as ACP `image` blocks (base64 + mimeType) and the tab as one `resource` block with
  text contents; name files in a text block; read `agentCapabilities.promptCapabilities` at `initialize` and
  report `{ image, context }` per conversation and per agent (last seen).
- **Rationale**: claude-agent-acp advertises `image: true, embeddedContext: true` and maps base64 images to the
  model's image input and text resources to a `<context ref=…>` block; it ignores blob resources. codex-acp
  advertises the same at session start and maps images to a data URL and text resources to context.
- **Alternatives**: `resource_link` for the tab (only a link, the text would be lost); blob resource for PDFs
  (Claude Code ignores it) — a PDF goes as a file instead.

## R-337 — Getting bytes past the 1 MiB frame

- **Decision**: the panel sends `ui.conversation.attach` pieces of at most 512 KiB of raw bytes (≤ 699 052
  base64 chars), one at a time, each awaited through its `conversation-result` (matched by commandId, T547).
  Images and the tab text also travel as attach pieces, so `ui.conversation.send` stays small.
- **Rationale**: the native frame codec refuses > 1 MiB in both directions; per-piece results give natural
  flow control and a clear failure point; the existing command pipeline needs no new frame type.
- **Alternatives**: worker-side splitting of one large panel message (one 33 MB port message, worker memory
  spike, worker becomes stateful); raising the frame cap (weakens the decoder's bound everywhere).

## R-338 — When bytes travel

- **Decision**: nothing leaves the panel until Send, after the conversation exists (020 start-then-send). A
  chip removed before Send leaves no trace anywhere.
- **Rationale**: a new conversation has no folder until it starts; "removed before sending" becomes trivially
  true; the held first-use message only holds panel memory.

## R-339 — Where files land and how they are named

- **Decision**: `<conversation folder>\hallpass-attachments\` (mkdir on demand). The broker stages to
  `.<attachmentId>.part` in that folder and at send links it to the final name with an exclusive create (hard
  link, falling back to copy with exclusive flag), then removes the part. The final name is the base name the
  panel gave, reduced to its last path segment, characters `<>:"/\|?*` and control characters replaced with
  `_`, trailing dots/spaces trimmed, Windows device names (`CON`, `NUL`, `COM1`…) prefixed with `_`, at most
  120 characters; empty becomes `attachment`. A taken name gets ` (2)`, ` (3)`… before the extension, up to
  ` (999)`. The resolved path is checked to stay inside the subfolder after `realpath` of the folder.
- **Rationale**: exclusive create makes "never overwrite" race-free; the panel never supplies a path.
- **Alternatives**: writing in a temp folder outside the conversation folder (spec says only inside).

## R-340 — Limits and cleanup in the broker

- **Decision**: the broker enforces the same limits as the panel (5 images, 5 files, 25 MB per file, 25 MB
  of files per message, one tab, 700 000 base64 chars per image, 50 000 chars of tab text plus address and
  title), sequential piece indexes, declared size equals received size. Staged data is dropped (and part files
  deleted) on: `ui.conversation.attach-cancel`, a refused piece, a failed or refused send, stop/remove/exit of
  the conversation, and 120 s without a piece for an unfinished attachment. A finished, unsent attachment
  expires after 10 minutes.
- **Rationale**: the broker is the authority (constitution); the panel may vanish mid-transfer.

## R-341 — Panel image preparation

- **Decision**: `createImageBitmap` + `OffscreenCanvas` in the panel; long edge ≤ 2000 px; keep PNG when the
  original is PNG and the encoding fits 700 000 base64 chars, else JPEG at quality 0.85 stepping down by 0.1
  to 0.35, then halving the size; GIF and WebP become their first frame. Thumbnail: 160 px JPEG ≤ 12 000
  base64 chars, sent with the image's first piece for the owner event.
- **Rationale**: browser built-ins, no dependency; same family of approach as the screenshot re-encode
  (capture.ts) without sharing worker code.

## R-342 — The viewed tab

- **Decision**: a panel command `ui.tab.capture { tabId, what: "screenshot" | "page" }` answered by the worker
  with `tab-capture-result`. Screenshot: `captureVisibleTab` of the tab's window (tab must be the active one in
  its window; the panel only offers it for the active tab), re-encoded within the image bound. Page: the
  content runtime's visible-text collection (as `get_page_text`) through `chrome.scripting` without an MCP
  binding; a PDF (by response content type, else `.pdf` path) is fetched by the worker and returned as a file
  (≤ 25 MB) instead. Restricted pages: the same restricted-origin rule the page binding uses. No site consent
  card: the owner acted (spec Edge Cases).
- **Rationale**: reuse existing capture/text code; the worker already owns `chrome.*`.

## R-343 — Owner event and bubble

- **Decision**: the owner `text` event gains optional `attachments: [{ kind, name, size?, thumbnail? }]`
  (thumbnail only for images, ≤ 12 000 chars); text may be empty when attachments exist. Replayed
  `user_message_chunk` image blocks become an owner event attachment `{ kind: "image", name: "image" }`.
- **Rationale**: every panel document (and a resync) shows the same bubble; the log page bound (256 KiB)
  holds 5 thumbnails easily.

## R-344 — Capabilities in the panel before a conversation exists

- **Decision**: the projection's agent entries carry `accepts?: { image, context }` from the agent's last
  `initialize` (unknown = allowed); an open conversation carries its own. The broker refuses a send whose
  attachments the agent does not accept with `attachment-not-accepted`.
