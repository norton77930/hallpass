# Feature Specification: Clicks Land on What a Person Points At (038)

**Feature Branch**: `spec-038-point-click`
**Created**: 2026-11-18
**Status**: Approved by the owner 2026-11-18 ("A + C + B 一起作")
**Input**: A real session filling a GitHub fine-grained token form: `click` answered `target-not-located` on
the items of two popover menus (the Expiration menu's "Custom", the permission picker's "Issues"), whether the
target was a point or the ref `find` returned. The owner's screenshots of both menus, the session's call log,
and a measurement on a public GitHub menu (2026-11-18).

## What was measured

- A point target becomes a ref for whatever `elementFromPoint` returns there - the innermost element, which on
  a design-system menu is a `div` or `span` several levels inside the `li[role=menuitemradio]` item.
- The locate that turns a ref into a box collects the page rooted at that ref, and the collection only walks the
  agent's selector list (003/FR-040). An element outside that list is never in the collection, so its ref is
  never located and every such click answers `target-not-located`.
- `find "Custom"` then matched the inner span the point click had already named (its text is "Custom") and,
  collapsing nested matches to the innermost (004/T128 B65), handed back that same unlocatable ref.
- Every measured hit element was rendered and visible (`checkVisibility` with every option: true). Visibility
  rules played no part.
- The menu items themselves are `menuitemradio`/`option` roles, which the agent's walk does not list, so
  `read_page` and `find` could not name them by role either.

## Decisions

- **D-038-1 - a ref's own element is always in a collection rooted at it (A).** Whatever its tag or role, the
  element a ref names is part of the collection rooted at that ref and keeps the handle it already has. The
  selector list decides what else a walk shows; it never makes a ref the page already issued unlocatable.
- **D-038-2 - a point is clicked where it was named (C).** A point target is delivered at the point the agent
  named, not at the centre of the element found there, and naming it never scrolls the page. The element found
  there still decides which frame and site the action belongs to (030), what the post-delivery check compares
  against (004/T128) and whether it is a link (015). Amends 004/T128's "centre of the located box" for point
  targets only; a ref target keeps centre-of-box delivery and its scroll into view.
- **D-038-3 - the walk names ARIA widgets (B).** The agent's walk adds the widget roles a page builds its own
  controls from, and an element with one of the roles whose name comes from content is named by its text the
  way a `button` already is. `filter: "interactive"` keeps the menu-item and tree-item roles.
- **D-038-4 - clean room.** The behaviour matches what a person's pointer does; nothing is taken from another
  product's code.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Click a popover menu item by its coordinates (Priority: P1)

An agent sees a menu in a screenshot and clicks an item at its coordinates.

**Acceptance Scenarios**:

1. **Given** an open menu whose items are `li[role=menuitemradio]` with the label in a nested `span`, **When** the
   agent calls `click` at the label's coordinates, **Then** the call answers `verified` and the item is chosen.
2. **Given** a large element whose centre is covered by another control, **When** the agent clicks a point inside
   the large element away from that control, **Then** the large element receives the click and the control at
   the centre does not.
3. **Given** a point target, **When** the click is delivered, **Then** the page has not scrolled.

### User Story 2 - Find and read menu items by name (Priority: P1)

1. **Given** the same open menu, **When** the agent calls `find "Custom"`, **Then** a match comes back with role
   `menuitemradio` and label "Custom", and `click` on that ref answers `verified`.
2. **Given** a `div[role=option]` list, **When** the agent reads the page with `filter: "interactive"`, **Then**
   each option is listed with its role and its text as its name.
3. **Given** a ref a point click named earlier (an inner `span`), **When** the agent clicks that ref, **Then** it
   is located and the call answers `verified`.

### Edge Cases

- A point over a child frame names the frame's owning element in the top document; the click goes to the named
  point and the frame's site decides, as 030 already does for points.
- A point whose element is marked `aria-hidden` (an icon inside a button) is still located: the ref exists and
  the press lands where a person's pointer would.
- A point the page cannot hit (outside the viewport) is refused as before (#55).
- A ref target is unchanged: scrolled into view, clicked at its box centre.
- A drag with one ref end and one point end scrolls neither end: scrolling the ref end into view would move the
  page out from under the named point. A drag between two refs scrolls its first end as before.
- An element that has left the document still answers `stale-reference` (004/T136).

## Requirements *(mandatory)*

- **FR-562 - the root is collected**: a collection rooted at a ref includes that ref's own element with that
  ref, whatever its tag or role, unless the element has left the document (then `rootTargetGone` as today) or
  is inside Hallpass's own indicator. Its `hidden` marker is computed as for any other node.
- **FR-563 - point delivery**: for `click`, `double_click`, `triple_click`, `right_click`, `hover`, a `drag`
  endpoint and the placing click of `type`/`key` with a point target, the pointer events go to the named point
  (top-document viewport coordinates); the locate serving that target does not scroll.
- **FR-564 - point checks keep their meaning**: for a point target the frame landing check (030 R-443), the
  re-check before dispatch (030 R-446), the press-outcome link flag (015) and the hit confirmation (004/T128)
  use the element found at the point; the confirmation asks at the named point.
- **FR-565 - widget roles walked**: the agent's walk (`all-controls`) also visits `[role=menuitem]`,
  `[role=menuitemcheckbox]`, `[role=menuitemradio]`, `[role=option]`, `[role=tab]`, `[role=radio]`,
  `[role=combobox]`, `[role=textbox]`, `[role=searchbox]`, `[role=slider]`, `[role=spinbutton]`,
  `[role=treeitem]` and `[role=listbox]`. The reviewed walk does not change.
- **FR-566 - name from content**: an element whose explicit role is `button`, `link`, `checkbox`, `switch`,
  `radio`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `option`, `tab`, `treeitem`, `heading`,
  `cell`, `columnheader` or `rowheader` takes its text as its name when nothing more specific names it
  (same order and bound as a `button`).
- **FR-567 - interactive filter**: `filter: "interactive"` also keeps `menuitemcheckbox`, `menuitemradio` and
  `treeitem`.

## Success Criteria *(mandatory)*

- **SC-248**: On the packaged gate's popover fixture, `click` at an item label's coordinates answers `verified`
  and the page records that item chosen; the same test on main before this change answers
  `target-not-located`.
- **SC-249**: On that fixture `find` returns the item by role and label, `click` on its ref and on a ref minted
  by an earlier point click both answer `verified`, and an interactive read lists every option with its name.
- **SC-250**: On the cover fixture a point click inside a large element away from its centre reaches the large
  element, not the control at its centre, and `window.scrollY` is unchanged.
- **SC-251**: Every existing packaged pointer, frame-consent, refs, reads and press-outcome spec still passes.
- **SC-252**: In the attach-gate browser on a public GitHub repository page, `click` at a branch-menu item's
  coordinates answers `verified` and the menu selection changes.

## Assumptions

- Point coordinates reach the worker already in the top document's CSS pixels (012), as `elementFromPoint` and
  the pointer adapter take them today.
- `computer`'s position actions already deliver at the named point (`deliverPosition`) and do not change.
