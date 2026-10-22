# Data Model: Attachments

## Panel: DraftAttachment (per conversation draft, memory only)

| Field | Type | Notes |
|---|---|---|
| localId | string | panel-minted, becomes the attachmentId |
| kind | `image` \| `file` \| `tab` | |
| name | string ≤ 255 | display name; file base name |
| size | number | bytes (image: encoded size) |
| state | `preparing` \| `ready` \| `refused` \| `sending` | refused carries a reason code |
| mimeType | string | image: `image/png` or `image/jpeg` after preparation |
| bytes | Blob / base64 | image encoded data; file contents; tab text |
| thumbnail | base64 ≤ 12 000 | images only |
| tab | `{ url, title, cut }` | tab only |

Rules: ≤ 5 image, ≤ 5 file, ≤ 1 tab, Σ file size ≤ 25 MB, each file ≤ 25 MB. Send enabled when text or ≥ 1
ready and none preparing. HeldMessage gains `attachments`.

## Broker: StagedAttachment (per conversation, memory + part file)

| Field | Type | Notes |
|---|---|---|
| attachmentId | string 1..64, `[A-Za-z0-9_-]` | from the panel |
| kind | image \| file \| tab | fixed by piece 0 |
| name | string | sanitised (R-339) for files |
| declaredSize | number | bytes; checked at the final piece |
| received | number | bytes so far |
| nextIndex | number | pieces must arrive in order |
| data | base64 (image) / text (tab) | memory |
| partPath | path | files: `<folder>\hallpass-attachments\.<id>.part` |
| complete | boolean | |
| lastPieceAt | time | 120 s idle → dropped |

State: `receiving → complete → sent (prompt built; part linked to final name) | dropped`.

## Owner event (extended)

`{ type: "text", role: "owner", text, attachments?: [{ kind, name, size?, thumbnail?, path? }] }` — `path` is the
final file path for files (shown on hover/title), `cut: true` on a tab whose text was shortened.

## Projection (extended)

- agent entry: `accepts?: { image: boolean; context: boolean }`
- conversation entry: `accepts?: { image: boolean; context: boolean }`
