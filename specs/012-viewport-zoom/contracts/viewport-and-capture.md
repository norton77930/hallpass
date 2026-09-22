# Contract: the `viewport` tool and the screenshot answer (feature 012)

Lives in `packages/contracts/src/agent-tools.ts`; this file is the readable statement the tests
pin. Link protocol number unchanged (additive only).

## `viewport`

```
args:   { tabId, action: "set", width: int 320..4096, height: int 320..4096 }
      | { tabId, action: "reset" }
ok:     { width, height, emulated: boolean }      # after reset: the real size, emulated false
stale:  tab-gone
failed: invalid-arguments | input-unavailable (devtools-open | restricted-page)
```

- Ownership as every tab tool (`held-by-session` / `not-yours`). Not an effect: never prompts.
- Batchable (`AGENT_BATCH_STEP_TOOL_NAMES`).
- Description (R-172): for viewing a page at a size without changing the window; prefer over
  `resize_window` for layout and breakpoint checks; reset before finishing unless the owner asked
  to keep it; cleared on release; independent of `resize_window`.

## `resize_window` (description only)

Adds: use `viewport` for viewing a page at a size; use this only when the real window must
change; does not change an emulated viewport.

## `screenshot`

```
args:   { tabId, region?: { x, y, width, height }, scale?: number 0.1..1 = 1 }
ok:     { mimeType: "image/png", data, cropped,
          width, height, scale, frame: { width, height }, coverage: "viewport" | "region", region? }
failed: region-outside-viewport (frame WxH)
        screenshot-too-large; retry with scale ≤ S
        (existing: tab-gone → stale, capture-refused → not-readable)
```

- `region` and `x`/`y` are CSS pixels of `frame`; the image is `region × DPR × scale` (region) or
  `frame × DPR × scale` (viewport). Under emulation DPR is 1.
- The host sends the image block and then the remaining fields as a text block (as it does for
  `cropped` today).

## Activity item

`kind: "viewport"`, `outcome: "set" | "cleared"`, `message?: "WxH"`.

## Attachment holder

`AttachmentHolder` gains `"viewport"`; enables no domain.

## Tool count

32 tools (README table, operations guide, `tool-offering` snapshot test).
