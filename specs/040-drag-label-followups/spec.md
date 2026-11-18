# Feature Specification: In-Element Drag Verdict, Label Names, and Test Fixes (040)

**Feature Branch**: `spec-040-followups`
**Created**: 2026-11-18
**Status**: Approved by the owner 2026-11-18 ("照建議，直接開始下一輪": 039 follow-ups 1, 2, 5, with 6 and 8)
**Input**: Follow-ups left by spec 039 (released in 0.26.1).

## What is wrong today

- **An in-element drag answers `not-moved` (039 follow-up 1).** A drag is verified only when the start
  element's box moved. Since 039 a drag between two points on one canvas, slider track or map is delivered,
  but the element does not move, so the answer is `not-moved` (attention required) and the binding is
  dropped. An agent reads that as a failure and may drag again.
- **A control named only by `<label>` has no name (039 follow-up 2).** The walk names a control by
  `aria-labelledby`, `aria-label`, its text, `name` or `placeholder`. A form that labels its inputs the
  ordinary way - `<label for="email">Email</label><input id="email">` or an input inside a `<label>` - lists
  them without names in `read_page`, `find` and the 039 receiving-field hint.
- **A test anchors the caption fade on the wrong moment (039 follow-up 5).** `agent-pointer-033` live-1 checks
  that the pointing caption fades 300-1800 ms after the `click` call *returned*; FR-501 (033) says about a
  second after the pointer *arrives*. The call keeps working after arrival (confirmation), 870-941 ms in
  passing runs and 1281-1923 ms in failing ones (measured 2026-11-18, 10 runs), so the check fails whenever
  the call is slow, on 0.26.0 as well.
- **Dead code (039 follow-up 6).** The plan-step drag check in `effects.ts` is never reached: `drag` is a
  pointer tool and returns before `planEffect`.
- **An unpinned branch (039 follow-up 8).** The focus check's real-browser path (`isContentEditable` as a
  boolean) has no unit test; jsdom always takes the attribute fallback.

## Decisions

- **D-040-1 - an in-element drag is verified the way a click is.** When both ends of a drag resolve to the
  same element, the verdict is decided by whether the press point resolves to that element (the 004/T128
  confirmation a click uses): `verified`, `target-missed` or `target-unconfirmed`. Whether the page did
  anything with the gesture is not claimed, as it is not for a click. A drag between two different elements
  keeps the moved-box rule.
- **D-040-2 - a control's `<label>` names it.** The text of the control's labels (`control.labels`: a
  `<label for>` and a wrapping `<label>`) names it after `aria-labelledby` and `aria-label` and before
  every other source, as the browser's accessible name does. The label's own form controls are left out of
  the text (a wrapping label's input, a select's options).
- **D-040-3 - tests measure the claim.** The live-1 fade check is anchored on the pointer's arrival.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A drag on one canvas reports success (Priority: P1)

1. **Given** the 039 canvas fixture, **When** the agent drags between two points inside the canvas, **Then**
   the answer is `verified` and the canvas records both ends at the named points.
2. **Given** two different elements where the dragged one does not move, **Then** the answer is `not-moved`
   as today.

### User Story 2 - Inputs labelled the ordinary way have names (Priority: P1)

1. **Given** `<label for="email">Email address</label><input id="email">`, **When** the agent calls
   `read_page` or `find`, **Then** the input is listed with the name "Email address".
2. **Given** `<label>Remember me <input type="checkbox"></label>`, **Then** the checkbox is named "Remember me".
3. **Given** a `<label>` wrapping a `<select>`, **Then** the select's name is the label's text without the
   option texts.

### Edge Cases

- `aria-labelledby` and `aria-label` still win over a `<label>`.
- Several labels join with one space, in document order; the name is bounded as every name is.
- A label hidden with `display:none` still names its control (as `aria-labelledby` does today).
- A drag from a ref to a point inside that ref's element is an in-element drag.

## Requirements *(mandatory)*

- **FR-572 - in-element drag verdict**: when a drag's two ends resolve to the same element, the verdict is the
  press point's confirmation against that element (hit → `verified`, missed → `target-missed`, not
  asked → `target-unconfirmed`); otherwise the moved-box rule stands. The `drag` tool text says which rule
  applies.
- **FR-573 - label names**: a control with `labels` takes its name from their text (form controls inside a
  label excluded) after `aria-labelledby` and `aria-label`, before `title`, `alt`, its own text, `name`
  and `placeholder`, bounded like every name. The 039 receiving-field hint (FR-569) uses the same name.
- **FR-574 - fade measured from arrival**: `agent-pointer-033` live-1 measures the caption fade from the
  pointer's arrival at the target (FR-501), with the bounds FR-501 gives.
- **FR-575 - no unreachable drag check**: the plan-step drag branch that cannot be reached is removed; the
  delivery check (039 FR-570) is the one rule.
- **FR-576 - real-browser branch pinned**: a unit test pins the focus check's `isContentEditable` boolean path.
- **FR-577 - kind words for every role** (owner 2026-11-19, option A): `find` counts a role's own name as a word
  for its kind for every role, and checkbox, radio, switch and link get their everyday English and zh-TW words
  beside the textbox, button and combobox ones (002 FR-026). A kind word still names only its own kind.

## Success Criteria *(mandatory)*

- **SC-258**: On the canvas fixture a drag between two points answers `verified`; on 0.26.1 it answers
  `not-moved`.
- **SC-259**: On the label fixture `find`/`read_page` name the `label for` input, the wrapped checkbox and the
  wrapped select as in User Story 2; on 0.26.1 they are nameless (or named by `name`).
- **SC-260**: `agent-pointer-033` passes when run after `agent-input` twice in a row.
- **SC-261**: The 039 + 038 packaged set still passes.
- **SC-262**: `find "the remember me checkbox"` resolves the labelled checkbox on `/label-040`.

## Assumptions

- The click confirmation (004/T128, `content.resolve-point` with a `targetHandle`) applies to a drag's press
  point unchanged.
