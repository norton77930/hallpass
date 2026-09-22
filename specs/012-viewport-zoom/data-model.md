# Data Model: Viewport Override and Zoom

## ViewportRecord (worker, `chrome.storage.session` key `agentViewports`)

One per emulated tab; a later `set` replaces it.

| Field | Type | Notes |
| --- | --- | --- |
| `tabId` | number | map key |
| `sessionId` | string | the session that set it; only that session may reset it (ownership check as every tab tool) |
| `width`, `height` | integer 320..4 096 | CSS pixels (FR-156) |
| `setAt` | epoch ms | for the activity line and for tests |

**Lifecycle**: created/replaced by `viewport set` → applied over the attachment → re-applied on
every `acquire` for the tab (`onAttached`) → cleared and dropped by `viewport reset`, by any
release path (`onBeforeRelease`, before the detach), by the tab closing (dropped only; nothing to
clear). Survives worker eviction (R-167); dies with the browser.

**Decisions (pure function, `decideClear(record, attached)`)**: `attached` → send clear over the
attachment then drop; not attached → attach, clear, detach, drop (best effort: a failure still
drops the record, and reports `agent.viewport.clear-failed`).

## AttachmentHolder (existing `input.ts`)

`"input" | "diagnostics" | "recording" | "viewport"` — the new holder keeps the attachment alive
while the emulation lasts and enables no domain (invariant unchanged, pinned by
`input-attachment.test.ts`).

## Attachment hooks (existing module, new surface)

| Hook | When | Registered by |
| --- | --- | --- |
| `onAttached(tabId)` | after a successful `attach` and the per-attachment setup | viewport module: re-apply if a record exists |
| `onBeforeRelease(tabId)` | before `detach` in `release` / `releaseAll` | viewport module: clear if a record exists |

## CaptureRequest → CaptureAnswer (screenshot)

Request: `tabId`, `region? { x, y, width, height }` (CSS px of the frame), `scale` (0.1..1, default 1).

Answer (`agentScreenshotResultSchema`, all new fields optional for an older host):

| Field | Meaning |
| --- | --- |
| `mimeType`, `data` | as today |
| `cropped` | as today (true when a region was applied) |
| `width`, `height` | the image's pixel size |
| `scale` | the scale applied |
| `frame { width, height }` | the CSS size of the viewport the picture is of (emulated or real) |
| `coverage` | `"viewport"` or `"region"` |
| `region` | echoed when given |

Path choice (`photograph.ts`): record exists for the tab → protocol capture (`clip` = region or the
whole frame, `scale`); else `captureVisibleTab` + canvas crop at `region × DPR` (`DPR = image.width
/ frame.width`) + scale.

Refusals: `region-outside-viewport (frame WxH)`; `screenshot-too-large; retry with scale ≤ S`.

## ActivityItem (existing contract)

`kind` gains `"viewport"`; `outcome` gains `"set"` and `"cleared"`; `message` carries `"WxH"` for
`set` and is absent for `cleared`. Panel text: "Viewport set to {size}" / "Viewport cleared"
(en, zh-TW).

## Tool list

`AGENT_TOOL_NAMES` gains `"viewport"` (32 tools); `AGENT_BATCH_STEP_TOOL_NAMES` gains it too.
