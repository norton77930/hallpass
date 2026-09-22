# Feature Specification: Viewport Override and Zoom

**Feature Branch**: `012-viewport-zoom` (git: `feature-012-viewport-zoom` in the `feature-008-spec`
worktree, from `main` at f1ab64b)

**Feature Directory**: `specs/012-viewport-zoom`

**Created**: 2026-09-21

**Status**: Draft; owner decisions D-012-1 to D-012-4 taken 2026-09-21 (below); ready for
`/speckit-plan`, whose research must include the measurements R-166 to R-168 before implementation.

**Input**: Owner discussion of 2026-09-21 after feature 011 closed: the next feature is the
viewport / zoom work deferred by D-011-1, with `upload_image` split off into feature 013. The
reference reading behind this document is the private evidence file for 012 (summarised publicly
in `docs/design-notes.md` §7).

**Owner decisions (2026-09-21)**:

- **D-012-1** — Feature 012 = an emulated viewport + zoom. `upload_image` is feature 013 (its own
  screenshot-id and cache design). Version 0.4.0 ships 012.
- **D-012-2** — The emulated viewport is the primary way to test a page at a size; `resize_window`
  stays for the rare case where the real window must change. The tool descriptions steer the agent
  accordingly.
- **D-012-3** — The emulation is cleared automatically when the session lets the tab go, in
  addition to an explicit reset; the agent cannot leave the owner's tab emulated.
- **D-012-4** — Nothing about the window is added here: restoring a maximized or full-screen window
  after `resize_window` already exists (008 FR-118 to FR-120, D-008-6) and was mistakenly listed as
  open in the 2026-09-16 follow-up notes; those notes are corrected, not the product.

**Authoritative Source Order**: Constitution (IV explicit uncertainty, V least privilege, VII
observable, XI defined failure) → `docs/product-requirements-draft.md` PR-005 (tabs and windows) and
PR-006 (reading a page, screenshots) → the owner's decisions above → `docs/design-notes.md` §7
("planned, not skipped") → the private reference evidence for 012 → the repository's own code as
read on 2026-09-21 (facts cited inline).

## Why this feature exists

A coding agent that changes a page's layout wants to see it at a phone width, a tablet width and a
desktop width without asking the owner to drag their window around. Today the only size tool is
`resize_window`, which changes the owner's real window (un-maximizing it first, 003 FR-045) and is
clamped by the screen: a 375-pixel-wide phone layout or a 2 560-pixel-wide desktop cannot be
obtained on many machines, and every use disturbs the owner's furniture. An emulated viewport gives
the page the size the agent asks for, leaves the window alone, and is undone the moment the session
lets the tab go.

Separately, a screenshot of a whole viewport squeezes small text and dense controls into the
image budget the agent receives; the agent then guesses at a label it cannot read. A region capture
at the device's own pixel density, with a scale the agent chooses, gives it a legible picture of
the part it is looking at for fewer tokens, and the same scale lets it take a cheap overview of the
whole viewport when detail does not matter.

Of the two reference extensions, one implements the viewport override (as emulation, per session,
re-applied whenever the tab is re-attached, reset explicitly) and the other implements the region
capture with a scale in the same range; neither has both. The behaviour here is designed from
those observations and from this product's own release model, not copied.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Test a page at a chosen width without touching the window (Priority: P1)

A coding agent working on a responsive layout holds a tab, sets its viewport to 375 by 812, takes
a screenshot, reads the page, clicks the hamburger menu that appears at that width, then sets
1 280 by 800 and confirms the menu is gone. The owner's window never changes size or state. When
the agent releases the tab, the page returns to the window's real size on its own.

**Why this priority**: it is the capability the owner named first and the one with no workable
substitute today (`resize_window` cannot reach phone or wide-desktop sizes on a laptop screen and
disturbs the owner).

**Independent Test**: on the packaged gate, hold a tab on a page whose layout has a breakpoint,
set the viewport below it, assert the page's own reported size equals the request and the
breakpoint layout is shown, set it above, assert the other layout, release, assert the page
reports the window's real size again and the window's bounds and state were never changed.

**Acceptance Scenarios**:

1. **Given** a held tab whose window is 1 366 by 768, **When** the agent sets the viewport to 375
   by 812, **Then** the page's own reported viewport is 375 by 812, a layout that switches at
   768 px shows its narrow form, and the window's bounds and state are unchanged.
2. **Given** the same tab, **When** the agent sets 2 560 by 1 440, **Then** the page reports
   2 560 by 1 440 and shows its wide form, though the window is smaller than that.
3. **Given** an emulated viewport, **When** the agent takes a screenshot, reads the page and clicks
   an element it found, **Then** the screenshot shows the emulated layout, the read's refs resolve,
   and the click lands on that element (see FR-158 and R-166; the precise picture geometry is a
   measured fact, recorded there before implementation).
4. **Given** an emulated viewport, **When** the agent calls the reset, **Then** the page reports the
   window's real viewport again.
5. **Given** an emulated viewport, **When** the agent releases the tab or the session ends,
   **Then** the page reports the window's real viewport again with no call from the agent.
6. **Given** an emulated viewport, **When** the worker is recycled and the agent's next call
   re-attaches to the tab, **Then** the page still reports the emulated size (the emulation is a
   session fact, not a worker fact).
7. **Given** a request outside the supported range, **When** the agent sets it, **Then** the call is
   refused with the range named and nothing changes.

---

### User Story 2 - Read a small part of the page clearly (Priority: P2)

An agent looking at a dense settings panel asks for a screenshot of the rectangle around it. It
receives that region at the device's own pixel density, so 11-pixel text is legible, and the
answer names the region so coordinates in the answer still map onto the viewport. For a first
overview it asks for the whole viewport at half scale and receives an image a quarter the size of a
full one.

**Why this priority**: it improves the agent's reading and its token spend but has a working
substitute today (`region` crop of the budget-limited full capture).

**Independent Test**: on the gate, place 11-px text at a known rectangle; capture that region;
assert the returned image's pixel size equals the region times the device pixel ratio (times the
scale when given), that the text is legible by OCR or pixel comparison against a reference, and
that the answer names the region and the coordinate frame.

**Acceptance Scenarios**:

1. **Given** a held tab on a display with device pixel ratio 2, **When** the agent captures the
   region 100,200 to 400,300, **Then** the image is 600 by 200 pixels and shows that rectangle at
   native density.
2. **Given** the same, **When** the agent passes scale 0.5, **Then** the image is 300 by 100 pixels
   and the answer states that coordinates are still in the full-resolution viewport frame.
3. **Given** a plain screenshot with scale 0.5, **When** taken, **Then** the image is half the
   width and height of the unscaled one and the answer says so.
4. **Given** a region partly outside the viewport, **When** captured, **Then** the call is refused
   naming the viewport's size; nothing is captured.
5. **Given** an emulated viewport (story 1), **When** a region is captured, **Then** the region is
   interpreted in the emulated viewport's coordinates and the refusal bound is the emulated size.
6. **Given** a scale outside 0.1 to 1, **When** given, **Then** the call is refused.

---

### User Story 3 - The agent picks the right tool for a size (Priority: P3)

An agent that wants "the page at 390 px" reads the tool list and reaches for the viewport tool; it
reaches for `resize_window` only when a task genuinely needs the real window changed (a window
screenshot by another program, a site that measures the window). The descriptions say this in as
many words, and the viewport tool's own text tells the agent to reset before finishing unless the
owner asked to keep the size.

**Why this priority**: it costs one sentence per tool and decides whether the owner's window keeps
being disturbed after this feature ships.

**Independent Test**: a contract check that the two descriptions contain the steering sentences;
the paid probe (SC-090) asks a real model for "the page at a phone width" and records which tool it
called.

**Acceptance Scenarios**:

1. **Given** the tool list, **When** read, **Then** the viewport tool's description says it is for
   testing a page at a size and does not change the window, and `resize_window`'s says to prefer
   the viewport tool unless the real window must change.
2. **Given** a `claude -p` probe asked to view a page at a phone width, **When** it acts, **Then**
   it calls the viewport tool and not `resize_window` (1/1, recorded with the model used).

---

### Edge Cases

- The tab navigates while emulated: the emulation is a property of the tab's session hold, so it
  persists across navigation within the hold (a responsive test usually spans several pages).
- Two of the agent's tabs share one window: each tab's emulation is its own; the window is untouched
  either way.
- Another session holds a tab in the same window: no interaction; emulation never touches shared
  state.
- The owner takes the tab back through the panel while emulated: that is a release; the emulation
  is cleared (FR-159).
- `resize_window` is called on an emulated tab: the window changes as today; the page keeps the
  emulated size until reset or release (the two are independent; the description says so).
- The debugger attachment is lost (the owner cancelled it, the tab crashed): the emulation is gone
  with it; the next call that re-attaches re-applies it (FR-160).
- The emulated viewport is larger than the window: the screenshot's geometry is the subject of
  R-166 (see FR-158); whichever way it measures, the coordinates the agent uses for clicks are the
  page's CSS pixels and must land where `read_page` says the element is.
- Recording (008) is running while the viewport is emulated: frames are captured as they are; the
  recording's frame size may change mid-recording, which the recorder already tolerates (it scales by
  recorded viewport width, not by device pixel ratio).
- The scale rounds the output to fewer than one pixel: the image is at least 1 by 1 and the answer
  states the actual size.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-156 (PR-005 — MUST)**: A paired agent MUST be able to set an emulated viewport of a held tab
  to a width and height in CSS pixels within a documented range (at least 320 to 4 096 on each
  side), so that the page lays out and reports itself at that size while the browser window's
  bounds and state are not changed. The answer states the size applied.
- **FR-157 (MUST)**: The agent MUST be able to reset the emulation explicitly; afterwards the page
  reports the window's real viewport.
- **FR-158 (MUST)**: While emulated, `screenshot`, `read_page`, `find` and every pointer tool MUST
  agree on one coordinate frame: the emulated viewport's CSS pixels. A screenshot MUST show the
  emulated layout. Whether the picture covers the whole emulated viewport or only the part the
  window can show is decided by measurement R-166 before implementation and recorded here; either
  way the answer MUST state what the picture covers.
- **FR-159 (MUST)**: The emulation MUST be cleared without any call from the agent when the session
  releases the tab (agent release, owner take-back through the panel, or session end), and the panel
  activity list MUST note it.
- **FR-160 (MUST)**: The emulation is a fact of the session's hold on the tab: it MUST survive
  worker eviction and MUST be re-applied when the tab's attachment is re-established for the next
  call (R-167 confirms the attach path this rides on).
- **FR-161 (MUST)**: Setting or resetting the viewport is not an effect on the page and MUST NOT
  prompt the owner; it is governed like `resize_window` today (a paired session with a held tab).
- **FR-162 (PR-006 — MUST)**: `screenshot` MUST accept a `scale` in 0.1 to 1 (default 1) that
  shrinks the returned image's width and height by that factor; the answer MUST state the image's
  actual pixel size and, when scaled, that coordinates remain in the unscaled viewport frame.
- **FR-163 (PR-006 — MUST)**: A `region` capture MUST return that rectangle at the device's own
  pixel density (region size times device pixel ratio, then times `scale`), not a crop of a
  budget-limited whole-viewport picture. The answer MUST name the region captured.
- **FR-164 (MUST)**: A region wholly or partly outside the current viewport (emulated or real) MUST
  be refused with the viewport's size in the reason; nothing is captured.
- **FR-165 (MUST)**: The viewport tool's description MUST say it is for viewing a page at a size,
  that it does not change the window, and to reset before finishing unless the owner asked to keep
  it; `resize_window`'s description MUST say to prefer the viewport tool unless the real window has
  to change. Both MUST say the two are independent.
- **FR-166 (MUST)**: No new browser permission is added; the emulation and the capture ride on the
  access a held tab already has.

### Key Entities

- **Viewport emulation**: session, tab, width, height; created by set, replaced by a later set,
  removed by reset or release; re-applied on re-attach.
- **Capture request**: tab, optional region (x, y, width, height in viewport CSS pixels), scale
  (0.1 to 1); answer carries the image, its pixel size, the region or "whole viewport", and the
  coordinate-frame note.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-085**: On the packaged gate, a page with a 768 px breakpoint shows its narrow form at 375
  by 812 and its wide form at 2 560 by 1 440 on a 1 366 by 768 window, and the window's bounds and
  state are identical before and after (2/2 sizes, 1/1 window check).
- **SC-086**: After reset, after `tabs_release`, after an owner take-back and after session end,
  the page reports the real viewport (4/4 paths).
- **SC-087**: After a forced worker restart mid-hold, the first call re-applies the emulation and
  the page reports the emulated size (1/1).
- **SC-088**: A click on an element found by `read_page` under emulation lands on it (3/3 targets,
  including one only visible in the emulated layout).
- **SC-089**: Region capture at device pixel ratio 2 returns exactly region × 2 pixels (and × scale
  when given) and the 11-px text reference matches (3/3 captures); an out-of-viewport region is
  refused (1/1).
- **SC-090**: The paid probe asked for "the page at a phone width" calls the viewport tool, not
  `resize_window` (1/1, model recorded).
- **SC-091**: R-166, R-167 and R-168 each have a recorded measurement (Chrome version, method,
  numbers) before implementation of FR-158, FR-160 and FR-163.
- **SC-092**: Unit, contract and snapshot checks stay green; the manifest's permissions are
  unchanged; the tool count and descriptions in the README and the operations guide are updated.

## Measurements the plan must make (Explicit Uncertainty, Constitution IV)

- **R-166 — Picture geometry under emulation**: with an emulated viewport larger than the window,
  what does the tab-level capture this product uses return (the window-sized part, or the whole
  emulated viewport), and what does a protocol-level capture return? Decides FR-158's wording and
  whether the capture path has to change for emulated tabs.
- **R-167 — Attachment lifetime**: confirm the one-attachment-per-held-tab design (004) and the
  point at which a re-attachment happens after worker eviction, so FR-160's re-apply hook is placed
  where every call passes through.
- **R-168 — Density capture on the branded browser**: confirm that a region capture at device pixel
  ratio 2 on the owner's Chrome returns native-density pixels through the path chosen for FR-163
  (the present capture path returns the window's picture at its own density; a clip at a scale may
  need the protocol path).

## Assumptions

- Device pixel ratio and "mobile" behaviour (touch events, user-agent) are not emulated; the
  override is size only. A later feature may add them if a task needs them.
- The supported range is a product choice with a wide default (320 to 4 096); the plan may narrow
  it if the browser refuses part of it.
- `resize_window`'s restore-on-release (008 FR-118 to FR-120) stays as is and is not re-specified.
- The gate runs on Chromium in attach mode as for 011; the owner's branded Chrome is used for R-168
  and the probe.

## Out of Scope

- `upload_image` (feature 013).
- Emulating device pixel ratio, touch, user-agent, orientation, colour scheme or network.
- A per-window or per-session "default viewport" the agent sets once for every tab.
- Any change to the window tools beyond their descriptions.

## Traceability

| Reference feature | Destination |
| --- | --- |
| Viewport override (one reference, as emulation) | FR-156 to FR-161, FR-165 |
| Region capture with scale (other reference) | FR-162 to FR-164 |
| Zoom as magnification beyond native density | Not in either reference; not built |
| Window restore after resize | Already shipped (008 FR-118 to FR-120); D-012-4 |
