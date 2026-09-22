# Data Model: Upload a Session Screenshot into a Page

## RetainedScreenshot (host, `packages/agent-host/src/screenshot-cache.ts`, memory only)

| Field | Type | Notes |
| --- | --- | --- |
| `imageId` | string `img_[a-z0-9]{10}` | map key; unique per process (issued-set check) |
| `mimeType` | `"image/png"` | as the screenshot answer |
| `bytesBase64` | string | the picture the agent received, unchanged |
| `size` | integer | `bytesBase64.length`, the unit the budget counts |
| `storedAt` | epoch ms | injectable clock |

**Constants**: `RETENTION_MS = 300_000`, `BUDGET_CHARS = 8_388_608`, `ISSUED_LIMIT = 10_000`.

**Lifecycle**: `put` on every screenshot-shaped reply (both `screenshot` and `computer`
screenshot) → `take` on `upload_image` (does not remove: an id may be uploaded twice within the
window) → removed by expiry (checked on `put` and `take`), by oldest-first eviction when a `put`
would exceed the budget, by `clear()` on session end, link loss, unpair. An entry larger than the
whole budget is never stored; its id is still issued with reason `oversize`.

**`take(id)` outcomes**: `ok { file: { name?, type, bytesBase64 } }` | `unknown` (id not in the
issued set) | `gone { why: "expired" | "evicted" | "oversize" }`. The issued set remembers the
reason for every id that was issued but is no longer held.

## Upload request (agent-facing shape, `packages/contracts`)

| Field | Type | Notes |
| --- | --- | --- |
| `tabId` | number | a held tab; the screenshot's tab or any other |
| `imageId` | string | from a screenshot answer of this session |
| `ref` | string? | element reference from `read_page`/`find` |
| `coordinate` | `{ x, y }`? | CSS px of the top-level viewport (emulated frame under 012) |
| `filename` | string? | default `screenshot.png`; same name rules as `file_upload` (no `/` `\`) |

Exactly one of `ref` / `coordinate` (schema refinement → `invalid-arguments`).

## Upload request (worker-facing schema, after host interception)

`{ tabId, target: { ref } | { coordinate: { x, y } }, file: { name, type, bytesBase64 } }` —
`file` bounded by `AGENT_UPLOAD_MAX_BASE64_CHARS` as `file_upload`'s files are.

## Content message `content.deliver-image` (broker → content runtime)

Payload: `{ target: { handle } | { point: { x, y } }, file, documentEpoch }` to the frame the
worker chose (the ref's frame, or frameId 0 for a point).

Reply: `{ ok: true, delivery: "input" | "drop", file: { name, size }, point?: { x, y } }` |
`{ ok: false, reason: "stale-target" | "not-a-drop-target" | "point-outside-viewport" |
"not-reachable" | "unsupported" }` with `frame: { width, height }` on the viewport refusal.

**Resolution**: handle → registry element; point → `elementFromPoint`; a frame element with a
readable `contentDocument` → resolve once more inside it with the point shifted by the frame's
rectangle (that document's realm for `File` / `DataTransfer` / `DragEvent`); a frame element again,
or an unreadable one → `not-reachable`. `<input type=file>` → input path; any other element →
drop path; no element (`null`) → `not-a-drop-target`.

## Upload answer (`agentUploadImageResultSchema`)

`{ delivery: "input" | "drop", file: { name, size }, point?: { x, y } }` — `name`/`size` read back
from the input (`input`) or echoed from the delivered `File` (`drop`, there is nothing to read
back). The host passes it through as the tool's text.

## Screenshot answer text block (host, additive)

`toolReply()` adds to the text-block object: `imageId`, and `upload` = the sentence telling the
agent to quote the id to `upload_image` — or, when not retained, that the picture was too large to
retain and a smaller one (scale or region) can be.

## Gate / activity / recording

- `decideGate({ tool: "upload_image" })` — effect, as `file_upload`.
- Prompt summary and activity line: `summariseToolCall("upload_image", args)` →
  "upload screenshot {imageId} to {ref}" / "drop screenshot {imageId} at ({x}, {y})".
- Recording effect list: + `upload_image`.
- Batchable: iff `file_upload` is (R-181).

## Tool list

`AGENT_TOOL_NAMES` gains `"upload_image"` (33 tools).
