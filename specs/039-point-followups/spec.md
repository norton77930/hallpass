# Feature Specification: Typing, Dragging and Links After a Point Click (039)

**Feature Branch**: `spec-039-followups`
**Created**: 2026-11-18
**Status**: Approved by the owner 2026-11-18 ("照建議": #5 option B, #4 option A, #1 option A without the address, one spec, 0.26.1)
**Input**: Follow-ups 5, 4 and 1 of spec 038's review (038 shipped in 0.26.0). Reference behaviour read
2026-11-18 is recorded in the maintainer's private reference notes (section 039); public tool documentation
on label retargeting and positional drags was consulted.

## What is wrong today

- **Typing at a point inside an editor (F5).** `type` with a point target first clicks to place the caret, then
  checks that the element holding focus is the element named (004/T159). On a point inside a contenteditable
  the element named is an inner `span`; focus is on its editing host, so the check refuses and nothing is typed.
- **Dragging within one element (F4).** A drag whose two ends resolve to the same element is refused as
  `same-endpoints`. The rule dates from when both ends were pressed at the element's centre; since 038 a point
  end is pressed where it was named, so two points on one canvas, slider track or map are a real drag.
- **A press inside a link (F1).** The 015 hint "a link was pressed and nothing happened yet" is given only when
  the located element is itself a link. A point on the text of `<a><span>…</span></a>` locates the span.

## Decisions

- **D-039-1 - focus counts when it is on the path the click took, or on the label's control (B).** After the
  placing click, the check passes when the element holding focus is the element named, one of its ancestors
  (across shadow roots), or - when the element named is inside a `<label>` - that label's control. Anything else
  is still refused before a key is sent. When the field that took focus is not the element named, the answer
  says which field received the text. Typing to "whatever has focus" stays the job of `type` with no target.
- **D-039-2 - a drag is refused only when it would not move (A).** The refusal compares the two points that
  would be delivered, not the elements. A plan step (`browser_batch`) whose two ends are points compares the
  points; two refs compare the refs as today.
- **D-039-3 - a link is the element or its nearest link ancestor (A).** A press counts as on a link when the
  element located, or its nearest ancestor (across shadow roots, within its own document), is `a[href]` or has
  role `link`. The hint's wording does not change and carries no address.
- **D-039-4 - clean room.** Behaviour is described in our own words; no code is taken from another product.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Type into a rich-text editor at a point (Priority: P1)

1. **Given** a contenteditable editor whose text is in nested `span`s, **When** the agent calls `type` with a
   point on one of those spans, **Then** the text is entered in the editor and the call answers verified.
2. **Given** a `<label>` wrapping text and a separate `<input>` it labels (`for=`), **When** the agent types at
   a point on the label text, **Then** the text goes into the input and the answer names the input.
3. **Given** a point whose click moves focus to an unrelated field, **When** the agent types there, **Then** the
   call is refused (`focus-lost`) and no character is sent.

### User Story 2 - Drag within one element (Priority: P1)

1. **Given** a canvas that records pointer down and up positions, **When** the agent drags between two points
   inside it, **Then** the drag is delivered and the canvas records both ends at the named points.
2. **Given** a drag whose two points are the same, **Then** it is refused as `same-endpoints` with no input.
3. **Given** a drag between two refs to the same element, **Then** it is refused as today.

### User Story 3 - A press on link text (Priority: P2)

1. **Given** `<a href>` around a `span` and a page that cancels the navigation, **When** the agent clicks a point
   on the span (or the span's ref), **Then** the answer carries the link hint, as a press on the `a` itself does.

### Edge Cases

- Focus on an ancestor that is not editable (a `div tabindex=0` wrapper) counts as on the path; whether keys do
  anything there is the page's affair, as it is for a person.
- The label rule follows `label.control` only; a label inside a shadow root follows its own root.
- A drag between a ref and a point inside that ref's element is delivered when the point is not the ref's
  centre (D-039-2).
- A link ancestor in another document (the frame's owner) does not count; the frame decides for itself.

## Requirements *(mandatory)*

- **FR-568 - focus on the path counts**: the focus check between the placing click and the first key (004/T159)
  passes when the focused element is the element named, an ancestor of it (composed tree), or the
  `label.control` of the nearest `<label>` ancestor of it, in the frame that claimed the target. Otherwise it
  answers `focus-lost` before any key, as today. `key` with a target uses the same path rule in its own check, which still runs after the key press as it always has.
- **FR-569 - the receiving field is named**: when FR-568 passes on a field other than the element named, the
  answer's hint names that field by role and label (bounded as a `find` label is).
- **FR-570 - drag refused only without movement**: `drag` answers `same-endpoints` only when the two delivery
  points are less than 1 CSS pixel apart; for a plan step, when two point ends are less than 1 CSS pixel apart
  or two ref ends are the same ref.
- **FR-571 - a link ancestor counts**: the press-outcome link flag (015) is set when the located element or its
  nearest ancestor in the same document (composed tree) is `a[href]` or has role `link`.

## Success Criteria *(mandatory)*

- **SC-253**: On the editor fixture, `type` at a point on an inner span enters the text and answers verified;
  on main 0.26.0 it answers `focus-lost` with nothing typed.
- **SC-254**: On the label fixture the text lands in the labelled input and the hint names it; a point whose
  click focuses an unrelated field is refused with the field unchanged.
- **SC-255**: On the canvas fixture a drag between two points inside the canvas is delivered and the recorded
  down/up points match the named points (±1 px); on 0.26.0 it answers `same-endpoints`.
- **SC-256**: On the link fixture a click at a point on the span inside the link answers with the link hint;
  on 0.26.0 there is no hint.
- **SC-257**: The packaged regression set of 038 (SC-251) and agent-point-click-038 still pass.

## Assumptions

- Point coordinates and frames behave as in 038; nothing here changes where a press is delivered.

## Change Log

| Date | Change | Origin |
| --- | --- | --- |
| 2026-11-19 | Follow-ups from the 039 review, settled by spec 041. A (a frame's stale focus passing FR-568) does not reproduce in Chromium 151, so it is pinned by a packaged test and needs no code. B (an editable body in a cross-site frame) is proven with the window in front and behind. C (the FR-568 check failing open when it cannot run) is fixed: the check refuses with `focus-unconfirmed` before any key. | spec 041, owner 2026-11-19 |
