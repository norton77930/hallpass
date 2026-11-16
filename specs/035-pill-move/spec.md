# Feature Specification: Move the Pill and Open the Side Panel from It

**Feature Branch**: `spec-035-pill-move` (from `spec-034-pill-stop` 11f538e, which is not merged yet)

**Feature Directory**: `specs/035-pill-move`

**Created**: 2026-11-16

**Status**: Approved by the owner on 2026-11-16 (design answers D-035-1 to D-035-4).

**Input**: Issue #65, "In-page pill: move top/bottom and open the side panel", deferred from 033
(D-033-2) and kept out of 034 (D-034-8). Observable behaviour of other products was read, not copied
(clean room, `docs/design-notes.md`); every phrase, number and state below is Hallpass's own.

**Facts checked 2026-11-16** (this repository at `spec-034-pill-stop` 11f538e, and one measurement):

- Every tab a session holds shows the in-page pill in its top document, fixed at the top-right corner
  of the page, above the page's own content. It has the words "An agent is working in this tab" and,
  since 034, a Stop or Resume control beside "back to the agent's tab" (004 FR-062, 034 FR-512).
- Every pill control acts only on a press the browser marks as the user's own; a click the page makes
  up is ignored. The worker learns which tab pressed from the browser's own sender record, never from
  the message body (004 FR-062, 034 FR-513).
- Captures hide the pill in place for the moment of the capture; it stays where it is and can still be
  pressed (033 FR-509).
- Nothing today moves the pill out of the agent's way. The agent's pointer, the point it clicks and the
  element it aims at can all fall under the pill. A press the agent sends through the browser is
  marked as a real press, so an agent click that lands on a pill control presses that control.
- The side panel opens today only from the toolbar icon and its shortcut (Alt+A).
- Measured on 2026-11-16 (Chrome 151, a throwaway test extension): after a real press on a page, the
  extension can open the side panel of that tab or of that window if it opens it at once on receiving
  the press. If it first waits for anything else, the browser refuses the open as not following a
  user gesture.
- A comparable browser-agent extension lets its user flip its in-page pill between top and bottom,
  keeps that choice only in memory, and flips it away on its own when its pointer's points fall where
  the pill is. Its pill has no control that opens its side panel.

**Decisions (D-035-n)** (owner, 2026-11-16):

- **D-035-1 - how the owner moves the pill** (Q1): one control on the pill toggles it between the top
  and the bottom of the page. The choice is remembered for the whole browser: every tab, every site,
  and after the browser restarts. No dragging.
- **D-035-2 - stepping aside** (Q2): when the agent's pointer, its click point or the element it aims
  at falls where the pill is, the pill moves to the other edge for that moment. If the other edge is
  covered too, it stays. The owner's chosen edge is not changed by this, and the pill goes back to it
  once the agent's points are clear of it.
- **D-035-3 - opening the side panel** (Q3): a new control beside "back to the agent's tab" opens the
  Hallpass side panel of this window, the same as the toolbar icon or Alt+A. If the panel is already
  open, nothing else happens.
- **D-035-4 - horizontal place** (Q4): the pill stays at the right edge (top-right or bottom-right).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The owner moves the pill out of the way (Priority: P1)

The pill covers a part of a page the owner wants to see, such as a site's own top-right menu. The owner
presses the move control and the pill goes to the bottom-right. Every other tab the agent holds shows
it at the bottom too, and so does every page after that, until the owner moves it back.

**Why this priority**: It is the first half of the issue, and the cheapest way for the owner to see
the page under the pill.

**Independent Test**: With a session holding two test tabs, press the move control on the first tab's
pill; confirm both pills sit at the bottom-right, a page navigated afterwards shows it at the bottom,
and after the browser is restarted and a new session starts, the pill is still at the bottom.

**Acceptance Scenarios**:

1. **Given** the pill sits at the top, **When** the owner presses its move control, **Then** within
   1 s it sits at the bottom-right of the page and its move control now offers the top.
2. **Given** the pill sits at the bottom, **When** the owner presses its move control, **Then** it
   returns to the top-right.
3. **Given** a session holds three tabs, **When** the owner moves the pill on one of them, **Then**
   the pills of every tab held by any session show the new edge within 1 s.
4. **Given** the owner chose the bottom, **When** a held tab navigates, a new tab joins a session, or
   the browser restarts and a new session starts, **Then** the pill is drawn at the bottom from the
   start.
5. **Given** the page itself dispatches a click on the move control, **When** that click arrives,
   **Then** nothing moves and the remembered edge is unchanged.

---

### User Story 2 - The pill steps aside from what the agent is doing (Priority: P1)

The agent is about to click a button that sits under the pill. Before the click lands, the pill moves to
the other edge, so the agent presses the page's button and not the pill, and the owner sees what the
agent is pointing at. After the step, the pill goes back where the owner put it.

**Why this priority**: An agent press is a real press. Without this, an agent aiming at something under
the pill can press Stop, Resume, "back to the agent's tab" or a new control by accident, and the owner
cannot see the target.

**Independent Test**: On a test page with a button under the pill's top-right spot, let the agent
click the button; confirm the page's button received the click, no pill control was pressed, the pill
was at the bottom while the pointer was there, and it was back at the top once the agent's next step
pointed elsewhere.

**Acceptance Scenarios**:

1. **Given** the pill sits at the owner's edge, **When** the agent's pointer, its click point or the
   box of the element it aims at overlaps the pill's area, **Then** the pill moves to the other edge
   before the agent's press is sent.
2. **Given** the pill stepped aside, **When** the agent's next point and target are clear of the
   owner's edge, **Then** the pill returns to the owner's edge.
3. **Given** the agent's points overlap the pill's area at both edges (for example, a tall element on
   the right), **When** the pill would step aside, **Then** it stays at the owner's edge.
4. **Given** the pill stepped aside, **When** the owner looks at the move control, **Then** it still
   names the edge opposite the one the pill is at now, and pressing it makes that edge the owner's
   choice.
5. **Given** the agent's click lands where the pill was before it stepped aside, **When** the press
   arrives, **Then** it reaches the page's element and no pill control.

---

### User Story 3 - The owner opens the side panel from the page (Priority: P2)

The owner sees the agent working on a page and wants the side panel, for example to answer a consent
card, look at the session card or end the session. They press "Open side panel" on the pill and the
Hallpass side panel opens in this window.

**Why this priority**: The second half of the issue. The toolbar icon and Alt+A already work, so this
only saves a step, but it puts the way to the panel where the owner is already looking.

**Independent Test**: With the side panel closed and a session working in a test tab, press "Open side
panel" on the pill; confirm the side panel of that window opens within 1 s, shows the session, and
that no session, site mode or consent changed.

**Acceptance Scenarios**:

1. **Given** the side panel of this window is closed, **When** the owner presses "Open side panel" on
   the pill, **Then** the panel opens in this window within 1 s.
2. **Given** the side panel is already open, **When** the owner presses it, **Then** the panel stays
   open and nothing else happens.
3. **Given** the page itself dispatches a click on the control, **When** that click arrives, **Then**
   nothing opens.
4. **Given** the browser refuses to open the panel, **When** about 2 s have passed since the press,
   **Then** the pill says the side panel did not open and that the toolbar icon or Alt+A opens it.
5. **Given** any session state (working, held from the page, or a side-panel conversation), **When**
   the owner opens the side panel from the pill, **Then** that state is unchanged.

---

### Edge Cases

- **Held and conversation pills (034)**: the move and open controls are on every pill, in every state;
  Stop, Resume and the not-delivered messages behave the same at either edge.
- **The not-delivered messages (034 FR-522) and the new open message**: they are shown on the pill at
  the edge it is at, and a step aside moves them with it.
- **Captures**: the pill is hidden in place for a capture at whichever edge it is at (033 FR-509); a
  capture never shows it at the other edge for that reason alone.
- **The agent's pointer at rest**: the resting pointer sits at the bottom-left, so on its own it never
  makes the pill step aside.
- **A very short window**: when the page's visible height is too small for the pill to sit clear of
  the agent's points at either edge, the pill stays at the owner's edge (Story 2, scenario 3).
- **The agent aims at the pill**: an agent never has a reason to press a pill control; stepping aside
  happens even when the target is a pill control, so the press reaches the page underneath.
- **Moving while stepped aside**: a press on the move control always moves the pill to the edge it
  names and makes that the owner's edge, whichever edge it was at.
- **The owner's edge cannot be read**: if the remembered choice cannot be read, the pill uses the top,
  as it does today, and a later move is remembered as usual.
- **A page that copies the pill**: a look-alike control drawn by the page never reaches the worker as a
  move or an open; the remembered edge belongs to the browser profile, and no page can read or change
  it.
- **Frames**: the pill is drawn in the tab's top document only, so its presses come from the top
  document; points inside a frame are compared with the pill in the top document's coordinates.
- **Several windows**: "Open side panel" opens the panel of the window whose tab was pressed, not
  another window's.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-526 - two pill places**: the pill sits at the top-right or the bottom-right of the page, at the
  same distance from the edges in both places. It never sits on the left or in the middle.
- **FR-527 - the move control**: every pill shows a move control that names the other edge ("Move to
  bottom" at the top, "Move to top" at the bottom). A press on it moves the pill to that edge and makes
  that edge the owner's edge.
- **FR-528 - the owner's edge is remembered for the browser**: the owner's edge is kept for the whole
  browser profile and survives a worker restart and a browser restart. It applies to every pill of
  every session, and a change is shown on every pill on the screen within 1 s. Until the owner first
  moves the pill, the edge is the top.
- **FR-529 - stepping aside**: before the agent's pointer moves to a point, before a press is sent, and
  while an element is the target of a step, the pill compares the agent's point and the element's box
  with the pill's area at the owner's edge. If they overlap, the pill is drawn at the other edge, unless
  they also overlap the pill's area there, in which case it stays. The pill is at its new place before
  the agent's press is sent.
- **FR-530 - going back**: once the agent's current point and target are clear of the owner's edge, the
  pill returns to the owner's edge. Stepping aside never changes the owner's edge.
- **FR-531 - the open control**: every pill shows an "Open side panel" control beside "back to the
  agent's tab". A press on it opens the Hallpass side panel of the window the pressed tab is in, the
  same panel the toolbar icon and Alt+A open. If the panel is already open, nothing else happens.
- **FR-532 - the open happens at once**: the worker opens the panel immediately on receiving the press,
  before it does anything else with it, because the browser refuses a later open. Opening the panel
  changes nothing an agent may do: no session, pairing, site mode, grant or consent card changes.
- **FR-533 - only the owner's press**: the move and open controls act only on a press the browser marks
  as the user's own. The worker decides the tab from the browser's sender record of the press, never
  from anything the page sends; the message names no edge, session, tab or window.
- **FR-534 - when the panel does not open**: the worker tells the page whether the open succeeded. If
  the browser refused it, or the page has no answer about 2 s after the press, the pill shows the
  not-opened message (FR-536) and keeps its state. A press is never sent a second time on its own.
- **FR-535 - captures and 034**: captures hide the pill in place at whichever edge it is at (033
  FR-509). Stop, Resume and their messages (034 FR-512 to FR-523) work the same at either edge and while
  the pill has stepped aside.
- **FR-536 - copy**: the words are the worker's, in the owner's locale, sent to the page as text:

  | Where | en-US | zh-TW |
  |---|---|---|
  | Move control, pill at the top | Move to bottom | 移到下方 |
  | Move control, pill at the bottom | Move to top | 移到上方 |
  | Open control | Open side panel | 打開側邊欄 |
  | Pill, side panel did not open | The side panel didn't open. Use the toolbar icon or Alt+A. | 側邊欄沒有打開。請按工具列圖示或 Alt+A。 |

- **FR-537 - internal messages only**: the page sends the worker a move or an open press as an internal
  message of a fixed, closed shape, and the worker sends the page the owner's edge with the pill's
  state. The page script puts the words on screen as text, never as markup. No tool, field or stop
  reason agents see changes, and the host and extension versions stay pinned to each other as today.

### Key Entities

- **Owner's edge**: top or bottom; one value for the browser profile, set only by the owner's press on
  the move control; top until first set.
- **Pill place**: where a pill is drawn right now: the owner's edge, or the other edge while the
  agent's point or target overlaps the owner's edge.
- **Agent's points**: the agent's pointer position, the point of its press, and the box of the element
  a step aims at, in the top document's coordinates.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-232**: After the owner presses the move control, every pill on screen sits at the new edge
  within 1 s in 10 of 10 presses.
- **SC-233**: The owner's edge is the same after a browser restart in 3 of 3 tries.
- **SC-234**: Across 20 agent clicks on elements placed under the pill's area, 20 reach the page's
  element and 0 press a pill control.
- **SC-235**: After a step-aside, the pill is back at the owner's edge by the end of the agent's next
  step that is clear of it, in 10 of 10 tries.
- **SC-236**: "Open side panel" opens the panel of the pressed tab's window within 1 s in 10 of 10
  presses, in both locales.
- **SC-237**: 0 of 20 page-made clicks on the move or open control move the pill, change the
  remembered edge or open the panel.
- **SC-238**: In the owner's live run, the owner moves the pill to the bottom on a real site, watches
  the agent click something that was under the pill's old place, and opens the side panel from the pill.

## Assumptions

- The pill's words follow the locale it already uses; locales other than `en-US` and `zh-TW` fall back
  to `en-US`.
- The new controls are text controls like the existing ones; the owner looks at the result in the live
  run and may ask for a change of look there.
- The pill's area for stepping aside is the pill's own box with a small margin around it, so a point at
  its very edge counts as under it.
- A step that aims at an element uses the element box the agent already resolves for that step; a
  `computer` step uses its point.
- The extension's local storage holds the owner's edge; it is the browser profile's, survives restarts,
  and pages cannot reach it.
- Live verification uses the attached-browser setup the packaged gate already uses; no new tooling.

## Non-goals

- Dragging the pill or placing it anywhere other than top-right or bottom-right.
- A per-site or per-tab pill place.
- Closing the side panel from the pill.
- A "stop every session" control.
- Changing what the toolbar icon or Alt+A do.

## Change log

- **2026-11-16**: first draft from the owner's answers to Q1-Q4; approved by the owner the same day.
- **2026-11-16 (plan)**: the move press names the edge its control showed (top or bottom), so a press
  while the pill has stepped aside sets the edge the control names (US2 scenario 4); FR-533's "names no
  edge" means no edge is taken from the page's own content - the worker accepts only the two values from
  the extension's content script after a trusted click, and still takes the tab from the sender record
  (research R-529). The pill's area is its box grown by 8 px (R-525).
