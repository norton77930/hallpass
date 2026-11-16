# Data Model: Move the Pill and Open the Side Panel from It

## Owner's edge (worker, persisted)

| Field | Type | Rules |
|---|---|---|
| value | `"top" \| "bottom"` | `chrome.storage.local` key `agentPillEdge`; unreadable or other value = `"top"`; written only by an accepted move press (R-528, R-529) |

One value per browser profile. Memory mirror in the worker, loaded before the first indicator message
after a worker start.

## Pill place (page, in memory)

| Field | Type | Rules |
|---|---|---|
| ownerEdge | `"top" \| "bottom"` | from the latest `indicator.edge` |
| lastPoints | `{ point: {x,y}, box?: Box } \| undefined` | from the latest `cursor` message; cleared by `cursor {hide}` and by a `rest` pointer step |
| place | `"top" \| "bottom"` | derived: `placeFor(ownerEdge, pillSize, viewport, lastPoints)` (R-525) |

State changes:

```text
cursor{x,y,box?}   -> lastPoints := points; place := placeFor(...)   (before the glide starts)
cursor{hide} | rest -> lastPoints := undefined; place := ownerEdge
indicator{edge}    -> ownerEdge := edge; redraw; place := placeFor(...) with the kept lastPoints
viewport resize    -> place := placeFor(...) on the next cursor message (no listener of its own)
```

`placeFor` returns `ownerEdge` when `lastPoints` is undefined, when the points are clear of the owner's
area, or when they overlap both areas; otherwise the other edge. Areas are the pill's box at an edge,
grown by 8 px.

## Messages

See [contracts/pill-messages.md](contracts/pill-messages.md): `indicator` (+5 fields), `ui.agent.pill-move`
with reply, `ui.agent.pill-open-panel` with reply, `cursor` (+`box`).
