# Contract: the `upload_image` tool and the screenshot text block (feature 013)

Lives in `packages/contracts/src/agent-tools.ts` (shapes, descriptions) and
`packages/agent-host/src/mcp-server.ts` (the text block, the interception); this file is the
readable statement the tests pin. Link protocol number unchanged (additive only).

## Screenshot answers (`screenshot`, `computer` action `screenshot`)

The MCP reply keeps the `image` block and its `text` block; the text block's JSON gains:

```
imageId: "img_xxxxxxxxxx"
upload:  "Quote imageId to upload_image to put this picture into a page (kept 5 minutes)."
       | "Too large to retain for upload_image; a smaller screenshot (scale or region) can be."
```

## `upload_image` (agent-facing)

```
args:   { tabId, imageId, ref: string, filename?: string }
      | { tabId, imageId, coordinate: { x, y }, filename?: string }
ok:     { delivery: "input" | "drop", file: { name, size }, point?: { x, y } }
denied: unknown-image-id; take a new screenshot and quote its imageId
        image-no-longer-available (expired | evicted | oversize); take a new screenshot
        (host decides both before anything crosses the link)
        consent declined / revoked site  (as file_upload)
stale:  tab-gone | stale-target
not-actionable: not-a-drop-target | point-outside-viewport (frame WxH) | not-reachable | restricted page
failed: invalid-arguments (both or neither of ref / coordinate; bad filename) | not-yours
```

- Ownership as every tab tool. An **effect**: passes the per-site gate as `file_upload`
  (`ask` → the existing card, summary "upload screenshot {imageId} to {ref}" / "drop screenshot
  {imageId} at ({x}, {y})"; `skip-checks` → proceeds; revoked → refused).
- Batchable iff `file_upload` is.
- `filename` default `screenshot.png`; the same name rule as `file_upload` (no path separators).
- Description: uploads a screenshot **this session took**, quoting the `imageId` from the
  screenshot answer; targets a file input by `ref` (hidden inputs included) or a drop point by
  `coordinate` for pages that accept dragged files; the picture is kept 5 minutes; for files from
  the owner's disk use `file_upload`.

## `upload_image` (worker-facing, after host interception)

```
args:   { tabId, target: { ref } | { coordinate: { x, y } }, file: { name, type, bytesBase64 } }
```

`file.bytesBase64.length ≤ AGENT_UPLOAD_MAX_BASE64_CHARS` (700 000), the same bound as
`file_upload`'s total and the screenshot frame bound.

## `file_upload` (description only)

Adds: for a screenshot this session took, use `upload_image` with its `imageId`.

## `screenshot` and `computer` (description only)

Add: the answer carries an `imageId` that `upload_image` accepts for 5 minutes.

## Content message `content.deliver-image`

See data-model.md. Reply reasons: `stale-target`, `not-a-drop-target`, `point-outside-viewport`
(+ `frame`), `not-reachable`, `unsupported` (no `File`/`DataTransfer` in the realm).

## Delivery semantics

- `<input type=file>`: `files` set to the one file; `input` then `change` dispatched (bubbles);
  no `accept` refusal; answer reads the input back.
- Any other element: `dragenter`, `dragover`, `drop` in that order, same `DataTransfer` with the
  one `File`, `bubbles` + `cancelable`, `clientX/Y` at the point or the element's centre; no
  `dragleave`; answer echoes the file and the point.
- Same-origin child frame under the point: resolved one level down; deeper or cross-origin →
  `not-reachable`.

## Tool count

33 tools (README line 6 and table, zh-TW operations guide, QA guide tool list, the 008/012 count
assertions → 33, new `agent-tools-013.contract.test.ts`).
