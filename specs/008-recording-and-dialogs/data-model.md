# Data model — feature 008

All state is per session and dies with it; nothing touches `chrome.storage.local`. Where a value is
persisted, the key is named; otherwise it lives in the offscreen document's memory (frames) or the
worker's (current dialogs, which are re-derived from events after eviction: a dialog that opened while
the worker slept is heard again on the next attach because Chrome re-emits `javascriptDialogOpening` on
`Page.enable` for an already-open dialog — **to be confirmed by S4's measurement; if not, the first
blocked tool call re-queries by attempting a trivial command and inferring from its timeout**).

## Recording (worker summary — `chrome.storage.session["agentRecordings"]`, map by sessionId)

| Field | Type | Rule |
| --- | --- | --- |
| `state` | `"none" \| "recording" \| "stopped"` | `start` → recording; `stop` or cap → stopped; export/clear → none |
| `frames` | int ≥ 0 | count handed to the document; ≤ 200 |
| `skipped` | int ≥ 0 | captures that failed since start |
| `full` | boolean | true once `frames === 200`; every later answer carries `recording: "full"` |
| `startedAt` | epoch ms | |
| `nextIndex` | int | action index for labels (`#n`) |

Transitions: `none --start--> recording(initial frame) --action--> recording --200th frame--> stopped(full)`;
`recording|stopped --export(≥1 frame)--> none`; `--clear--> none`; session end with ≥ 1 frame → export → none.

## Frame (offscreen document memory, list per sessionId)

| Field | Type | Rule |
| --- | --- | --- |
| `index` | int | 0 = initial frame |
| `jpeg` | `ArrayBuffer` | ≤ ~1 MB; long side ≤ 1568 px after downscale |
| `width`, `height` | px | of the stored image |
| `viewportWidth`, `viewportHeight` | CSS px | at capture; `scale = width / viewportWidth` |
| `capturedAt` | epoch ms | not used for delays (fixed 800 ms) |
| `action` | Action \| null | null for the initial frame |

## Action (attached to a frame; built in the worker)

| Field | Type | Rule |
| --- | --- | --- |
| `index` | int | `#n` on the label, 1-based; `N` = frames − 1 at export |
| `tool` | AgentToolName | |
| `label` | string ≤ 40 chars | `"<tool> <target or text>"`, cut with `…`; masked to `••••` when `redacted` |
| `redacted` | boolean | 005 FR-073 predicate on the target at action time |
| `point` | `{x, y}` CSS px \| undefined | click family, hover, form_input, scroll (ring) |
| `from`, `to` | `{x, y}` \| undefined | drag (path) |

## Export request / result

Request `{sessionId, filename}` — filename grammar: `^[A-Za-z0-9 _.-]{1,80}$`, not starting with `.`,
`.gif` appended; default `agent-recording-<yyyyMMdd-HHmmss>`.
Result `{filename, frames, skipped, width, height, bytes, downloadId}`; refusals `invalid-filename`,
`empty-recording`, `download-failed {reason}`.

## CurrentDialog (worker memory, `Map<tabId, CurrentDialog>`; at most one per tab)

| Field | Type | Rule |
| --- | --- | --- |
| `id` | string | session counter `d1, d2…` |
| `type` | `"alert" \| "confirm" \| "prompt" \| "beforeunload"` | |
| `message` | string | on-screen text (D-008-5) |
| `defaultValue` | string \| undefined | prompt only |
| `openedAt` | epoch ms | |
| `tabId` | int | |
| `chainedTo` | `{tool, approvedAt}` \| undefined | set when `openedAt − lastApprovedEffect(tabId).approvedAt ≤ 1000` |

Removed on `javascriptDialogClosed`, on `dialog` answer, on tab loss. `beforeunload` never becomes a
current dialog: it is answered immediately by policy and recorded as a `BeforeunloadOutcome
{tabId, action: "stay" | "leave", url, at}` consumed by the pending `navigate`/`tabs_close`.

## LastApprovedEffect (worker memory, per tabId)

`{tool, approvedAt}` — written when an effect passes the gate as `admit` or after the owner's *allow*;
read only by the chaining rule.

## BeforeunloadPolicy (worker memory, per tabId)

`"stay" | "leave"`, default `stay`; set to `leave` by a gated `force:true` call for the duration of that
call, then reset.

## WindowRestoreRecord (`chrome.storage.session["agentWindowRestores"]`, list)

| Field | Type | Rule |
| --- | --- | --- |
| `windowId` | int | |
| `priorState` | `"maximized" \| "fullscreen"` | first seen wins (FR-120) |
| `sessionId` | string | |
| `setSize` | `{width, height}` | updated on each resize by the same session |

`decideRestore(record, window | undefined, otherRecordsForWindow): "restore" | "drop" | "leave-to-other"`:
window undefined → drop; `window.state === priorState` → drop; other records exist → leave-to-other;
`window.width/height !== setSize` → drop; else restore.

## ActivityItem (panel, per session card, last 20, newest first)

| Field | Type |
| --- | --- |
| `at` | epoch ms |
| `kind` | `"dialog" \| "export" \| "restore"` |
| `text` | string — `"{site} says: {message}"`, the file name, or `"window restored to {state}"` |
| `outcome` | `"accepted" \| "accepted-chained" \| "dismissed" \| "refused" \| "closed-by-owner" \| "stayed" \| "left" \| "exported" \| "restored"` |

## Panel messages (worker → panel), added

`recording-state {sessionId, state, frames, full}`, `activity {sessionId, item}`, `notice {sessionId,
text, sub}` (non-blocking card), and the existing consent prompt gains `kind: "dialog-accept" |
"beforeunload-force"` with `dialogText`.

## Offscreen protocol (worker ↔ document, `chrome.runtime` messages)

| Message | Direction | Payload | Reply |
| --- | --- | --- | --- |
| `recording/add-frame` | → doc | `{sessionId, frame}` (jpeg as ArrayBuffer via transferable-safe base64 or Blob URL) | `{frames}` |
| `recording/export` | → doc | `{sessionId, watermark}` | `{blobUrl, width, height, bytes, frames}` — **frames are kept** (a failed download must be retryable); encoding streams one frame at a time (decode → overlay → quantize → write → drop), never holding all frames as RGBA |
| `recording/clear` | → doc | `{sessionId}` | `{cleared}` — the only message that drops frames |
| `recording/revoke` | → doc | `{blobUrl}` | `{}` |
| `recording/count` | → doc | `{}` | `{sessions, pendingBlobUrls}` — the worker closes the document only when **both** are 0 |

The document never initiates a message, never fetches, never touches `chrome.*` beyond `runtime`, and
answers only messages from its own worker (`sender.id === chrome.runtime.id && !sender.tab`).

**Export sequence (worker side, R-137, decided 2026-09-19 after the S2 review)**: `export` → `downloads.download(blobUrl)`
→ on `complete`: `revoke` → `clear` → `count` → close at `{0, 0}`; on `interrupted`/failure: `revoke` only, keep the
recording, answer `download-failed`. The counter drawn on a frame is its **position in the list**, not the worker's
action index, so a skipped capture never yields `6 / 5`.
