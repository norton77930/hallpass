# Data Model: Consent per Site for Embedded Frames

Nothing new is stored. The one stored record that changes is which key a frame decision writes to: the
existing site-mode store, keyed by full origin (`site-mode-store.ts`).

## DecidingSite (in memory, one per action)

| Field | Type | Rule |
| --- | --- | --- |
| `kind` | `"page" \| "frame" \| "unknown"` | `page` when the target is in the top frame or in a frame whose sender origin equals the page's site |
| `site` | `SiteOrigin` | present for `page` and `frame` |
| `pageSite` | `SiteOrigin` | the tab's site, always present |
| `frameId` / `documentId` | browser ids | present for element-reference actions (R-440); compared again before dispatch (R-446) |
| `point` | top-viewport point | present for coordinate actions (R-442); looked up again before dispatch |

Transitions: it is decided before the gate (R-443), re-checked right before the gesture (R-446) and dropped
when the call answers. It never outlives one call.

## Gate input (changed)

`GateInput.site: SiteOrigin | null`. It is the deciding site, and `null` means unknown. With `null`, the
gate always prompts.

## Prompt (changed, contract)

`agentEffectPromptSchema.frame?: { site: SiteOrigin } | { unknown: true }`. Present only when the deciding
site is not the page's site. See [contracts/prompt-and-reads.md](contracts/prompt-and-reads.md).

## Read outputs (changed, contract)

- `agentReadPageFrameSchema.site: SiteOrigin | "unknown"`, on every listed frame.
- `read_page` node and `find` match: `site?: SiteOrigin | "unknown"`, only when it differs from the page's
  site.
