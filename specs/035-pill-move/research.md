# Research: Move the Pill and Open the Side Panel from It

Facts below were read at `spec-034-pill-stop` 11f538e (file:line references are to that tree) and, for
R-527, measured on 2026-11-16 in the test Chromium (Chrome 151.0.7922.34) with a throwaway extension.

## R-524 - The page decides where the pill sits, on the cursor message

**Decision**: the step-aside decision is made in the content runtime when a 033 `cursor` message
arrives, synchronously and before the cursor's glide starts, so the pill is at its new place before the
page sends its arrival reply. The decision is a pure function of the owner's edge, the pill's size, the
viewport and the agent's points (point, plus a box when the step has one).

**Rationale**: the worker already sends every pointer move to frame 0 before any input event and waits
for the page's `{ arrived: true }` (`agent-tools/input.ts:976`, cap 420 ms, drag held-move 60 ms) before
the first `Input.dispatchMouseEvent` (`input.ts:994-998`). Deciding on receipt puts the move ahead of the
press with no new round trip. The page is also the only party that knows the pill's real size.

**Alternatives considered**: the worker hides or moves the pill with a separate message before the press
(one more round trip on every pointer step, and the worker does not know the pill's size); hiding the pill
like a capture does (033 FR-509 keeps the pill pressable while hidden, so it would still take the agent's
press).

## R-525 - Which points count, and the pill's area

**Decision**: every `cursor` message counts: clicks (left, right, double, triple), the focusing click of
`type`/`key` on a target, hover, wheel scroll, and both ends of a drag. A `cursor { hide: true }` and a
033 `pointer-step` in `rest` mode bring the pill back to the owner's edge. The pill's area is its own
bounding box at the owner's edge, grown by 8 px on every side. The place is:

- owner's edge, when neither the point nor the box overlaps the area at the owner's edge;
- the other edge, when they overlap the owner's edge and not the area at the other edge;
- owner's edge, when they overlap both.

The area at the other edge is the same box mirrored vertically (same x and size, 8 px from the other
edge), so it is known without drawing the pill there first.

**Rationale**: FR-529/530. The resting pointer sits at the bottom-left (`content-runtime/cursor.ts:270`),
so a `rest` never collides with a right-side pill. 8 px matches the pill's own distance from the edge.

**Alternatives considered**: a timer to come back (D-035-2 says "once clear", and a timer could bring the
pill back over a target the agent is still working on); only presses count (the owner would not see a
hover or scroll target under the pill).

## R-526 - The target box travels with the cursor message

**Decision**: the 033 `cursor` message gains one optional field, `box: { x, y, width, height }` in
top-document viewport pixels, sent by the element tools that press or hover a located target
(`effects.ts` ref click, hover, focusing click, drag start), from the same `target.rect` whose centre is
already the point (`effects.ts:2147, 2342`). `computer` steps send no box. The page's exact-key validator
(`cursor.ts:159-168`) accepts `box` only with four finite numbers, width and height ≥ 0; anything else
refuses the whole message as today.

**Rationale**: the spec counts "the element it aims at" (FR-529); the worker already has the box before the
press and only the point is sent today (`input.ts:969`).

**Known limit**: for a target in an out-of-process frame the point and box are frame-local, as the 033
pointer already is (`effects.ts:1169-1182`); stepping aside inherits that. The worker never dispatches
into the pill in that case either, because an out-of-process frame press goes to the frame's own
session.

## R-527 - Opening the side panel from a page press

**Decision**: a new content message `ui.agent.pill-open-panel`. In the worker's `runtime.onMessage`
listener its handler checks, synchronously, that `sender.id` is this extension and `sender.tab.id` is a
number, then calls the existing `activateWorkspace(sender.tab.id)` (`chrome-adapters/action-entry.ts:16-28`)
as its first asynchronous act, and answers `{ opened: boolean }` through `sendResponse` once the open
settles. No lease or session check comes first.

**Rationale**: measured 2026-11-16: `chrome.sidePanel.open({ tabId })` and `({ windowId })` called at once
in the `onMessage` handler after a trusted page click succeed (a `SIDE_PANEL` context appears); one `await`
before the call is refused with "`sidePanel.open()` may only be called in response to a user gesture."
`activateWorkspace` already issues the open before its first suspension and is what the toolbar icon and
Alt+A call, so the panel is the same one (FR-531). The press is from the active tab of its window (the
owner pressed it), so the tab's panel is this window's panel. Opening grants nothing (FR-532), so a press
from a tab no session holds can open the panel without harm.

**Alternatives considered**: `open({ windowId })` (needs `sender.tab.windowId`, which the worker's sender
type does not carry today, and differs from the toolbar's per-tab options); checking the lease first (the
browser refuses the open after any wait).

**Not settled**: whether a press with no user activation at all would also be accepted; the measurement
was confounded by the test driver's own activation. It does not matter here: the content script sends
the message only from a click whose `isTrusted` is true, and a page cannot send an extension message.

## R-528 - The owner's edge lives in `chrome.storage.local`

**Decision**: a new worker module `pill-edge-store.ts` after the pattern of `agent-appearance.ts:12-58`:
one key, `agentPillEdge`, value `"top" | "bottom"`, parsed with a fallback to `"top"`, writes serialised.
The worker keeps a memory mirror loaded at start; the indicator composer awaits the load before its
first message after a worker start, so a restarted worker never draws a pill at the wrong edge.

**Rationale**: FR-528, D-035-1: one value for the browser profile that survives restarts. Pages cannot
reach extension storage.

**Alternatives considered**: `storage.session` (lost on a browser restart); the page's own
`localStorage` (per site, readable and writable by the page).

## R-529 - The move press names the edge it moves to

**Decision**: `{ type: "ui.agent.pill-move", to: "top" | "bottom" }`. The page sends the edge its move
control names (the opposite of where the pill is drawn now). The worker refuses any other value or extra
field, stores `to` as the owner's edge (a no-op when equal), answers `{ accepted: boolean }`, then re-sends
the indicator message to every tab every session holds.

**Rationale**: US2 scenario 4 and FR-527: while the pill has stepped aside, its control names the edge the
pill is not at, and pressing it must make *that* the owner's edge. A bare toggle in the worker would pick
the wrong edge in that case. The field carries a choice between two harmless values from the extension's
own content script, only after a trusted click, so it gives a page nothing; the worker still takes the tab
only from `sender.tab.id`. This refines FR-533's "the message names no edge" (spec change log).

**Alternatives considered**: a worker toggle (wrong edge while stepped aside); the move control naming
the opposite of the owner's edge (a control saying "Move to bottom" on a pill that is at the bottom).

## R-530 - Page and worker messages, and the reply wait

**Decision**: the `indicator` message gains `edge`, `moveToTop`, `moveToBottom`, `openPanel` and
`panelUnopened` (contracts/pill-messages.md). The page draws the pill at `edge` (absent = top), and keeps
its last agent points across a redraw so a redraw does not undo a step aside. The open press waits 2 s for
its reply, then shows `panelUnopened` on `{ opened: false }`, a rejected send or no reply; it is never
resent (a resend carries no gesture). The move press reuses 034's press-with-reply path, including its
1 s resend and 2 s not-delivered timing, with no message of its own: an undelivered move leaves the pill
where it is, which the owner sees.

**Rationale**: FR-534, FR-536, FR-537; 034's pill already redraws from scratch on each `indicator`
(`indicator.ts:258`).

## R-531 - Layout

**Decision**: the controls sit in one row in this order: Stop or Resume (034), "back to the agent's tab",
"Open side panel", "Move to …". At the bottom the pill uses `bottom: 8px` in place of `top: 8px`, `right`
stays 8 px; the not-delivered messages (034) and the not-opened message sit inside the pill as today.

**Rationale**: FR-526, FR-531; D-035-4. The look is shown to the owner in the live run (spec Assumptions).

## R-532 - Locale keys

**Decision**: `agent.indicator.moveToTop`, `agent.indicator.moveToBottom`, `agent.indicator.openPanel`,
`agent.indicator.panelUnopened` in `locales/en-US.ts` and `locales/zh-TW.ts`, with the FR-536 words.
