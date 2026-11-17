# Data model: 036 session card (panel-side only)

All shapes are derived in the panel from `AgentPanelState["sessions"][number]` (unchanged contract).

## SiteRow (R-534)

| Field | Type | Rule |
|---|---|---|
| origin | string \| undefined | canonical origin when known; absent for a held host whose tab url did not parse |
| host | string | display form: `displayOrigin(origin)` without the scheme, or the bare host |
| tabHere | boolean | the session holds a tab on this origin/host |
| inPlan | boolean | the origin is in `sitePlan.origins` |
| grants | { kind: "page-actions" \| "diagnostics"; source: "client" \| "browser" }[] | session grants on this origin, in the order given |

Order: held, then granted, then plan-only; each origin once.

## ActivityRow (R-535)

| Field | Type | Rule |
|---|---|---|
| at | number | the newest item's `at` in the row |
| kind | "hold-resume" \| "site-plan" \| ActivityItem["kind"] | |
| count | number | pairs folded (hold-resume only), ≥ 1 |
| text | string | the sentence (locale-resolved by the card) |
| result | string \| undefined | outcome or answer word |
| tone | "ok" \| "warn" \| "danger" \| "muted" | |
| place | "client" \| "browser" \| undefined | where a consent was answered |

## Card state (R-536, R-537)

- `needsOwner(s)`: `s.state === "waiting" || s.state === "working" || s.heldAt !== undefined`
- `primaryAction(s)`: `"answer"` if waiting; else `"resume"` if held; else `"interrupt"` if working; else none
- `isOpen(s, choice, onlyOne)`: `choice ?? (needsOwner(s) || onlyOne)`
- transitions: needsOwner false→true clears the choice; true→false while open sets choice `true`
