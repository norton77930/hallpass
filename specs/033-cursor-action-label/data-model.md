# Data Model: The Pointer Says What the Agent Is Doing

Nothing is stored. All state lives in the page document for as long as the tab is held, and in one
worker call while it runs.

## Pointer step (worker → page, per tool call) - R-491

| Field | Type | Rule |
|---|---|---|
| `type` | `"pointer-step"` | exact |
| `words` | string | already localised; ≤ 60 characters; `""` = keep whatever is shown |
| `mode` | `"travel"` \| `"stay"` \| `"rest"` | FR-499 table |

No other field is accepted. The page puts `words` into an attribute, never into markup.

## Cursor move (worker → page, per pointer gesture) - existing, widened (R-492)

| Field | Type | Rule |
|---|---|---|
| `type` | `"cursor"` | exact |
| `x`, `y` | number | top-viewport CSS pixels (unchanged) |
| `press` | `true` (optional) | ring on arrival |
| `hide` | `true` (optional) | unchanged |

Reply unchanged: `{ arrived: true }` when the pointer has landed.

## Marks visibility (worker → page, around an agent capture) - R-499, only if T980 confirms

| Field | Type | Rule |
|---|---|---|
| `type` | `"marks"` | exact |
| `hidden` | boolean | `true` hide, `false` show |

Reply: `{ painted: true }` after two animation frames, for hide and show alike; at once when the
document is hidden or has no animation frames (review fix c7a6288).

## Page-side pointer state (per document)

| State | Meaning | Leaves when |
|---|---|---|
| absent | no pointer yet | a `travel` move (drawn at its point) or a `stay`/`rest` step (drawn at rest) |
| pointing | at a gesture's point; caption fades 1 s after arrival | a `rest` step, a new move |
| resting | at the rest spot; caption stays | a move, a `stay` step does not move it |
| hidden-for-capture | any of the above with `data-hallpass-hidden` | `marks hidden:false`, or 3 s |
| gone | tab left the session (indicator `show:false`) or navigation | - |

Caption: `words` (attribute), `side` (`below-right` / `left` / `above`), `faded` (bool).
