# Contracts: Attachments (additive; host and extension stay version-paired)

## Panel → worker → broker (forwarded unchanged inside `conversation-command`)

### `ui.conversation.attach`

```text
payload: {
  conversationId,
  attachmentId: /^[A-Za-z0-9_-]{1,64}$/,
  index: int >= 0,                 // pieces in order, from 0
  final: boolean,                  // last piece
  // piece 0 only:
  kind?: "image" | "file" | "tab",
  name?: string 1..255,
  size?: int >= 0,                 // total bytes (tab: UTF-8 bytes of text)
  mimeType?: string 1..100,        // image: image/png | image/jpeg | image/gif | image/webp
  thumbnail?: base64 <= 12000,     // image only
  tab?: { url: string <= 2048, title: string <= 512, cut: boolean },
  // every piece:
  data: base64 <= 699052 chars     // image / file bytes; tab: UTF-8 text bytes
}
result: ok | error codes below
```

### `ui.conversation.attach-cancel`

`payload: { conversationId, attachmentId }` — drops staged data and its part file; ok when unknown.

### `ui.conversation.send` (extended)

```text
payload: { conversationId, text: string 0..32768, activeTabId?, attachments?: attachmentId[] (1..11) }
refine: text.length >= 1 || attachments.length >= 1
```

Prompt built (R-336/R-333): `text` block (when any) · each image `{type:"image", data, mimeType}` · the tab
`{type:"resource", resource:{uri:url, mimeType:"text/plain", text:"<title>\n\n<text>"}}` · one text block
listing each file `- <name>: <absolute path>`.

### Error codes (new, in `conversation-result.error.code`)

`attachment-too-large`, `attachment-too-many`, `attachment-type`, `attachment-order`, `attachment-unknown`,
`attachment-incomplete`, `attachment-not-accepted`, `attachment-folder-gone`, `attachment-write-failed`.
`invalid-command` (T618 follow-up): a non-attach command with a readable `commandId` that did not validate (was `busy`).

## Panel ↔ worker only

### `ui.tab.capture`

`{ type: "ui.tab.capture", requestId: string 1..128, payload: { tabId: int, what: "screenshot" | "page" } }`

### `tab-capture-result` (worker → panel)

```text
{ type: "tab-capture-result", requestId, result:
    { ok: true, kind: "image", mimeType, data, width, height }
  | { ok: true, kind: "page", url, title, text, cut }
  | { ok: true, kind: "file", name, mimeType: "application/pdf", data, size }
  | { ok: false, code: "restricted" | "not-active" | "too-large" | "failed", message } }
```

## Projection / events

- agent entry and conversation entry: `accepts?: { image: boolean, context: boolean }`.
- owner text event: `text` may be empty when `attachments` (1..11) present; attachment
  `{ kind, name, size?, thumbnail?, path?, cut? }`.
