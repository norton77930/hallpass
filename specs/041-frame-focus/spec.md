# Feature Specification: 041 focus check before keys: frame focus pinned, editable body proven, refuse when the check cannot run

**Feature Branch**: `spec-041-frame-focus`
**Created**: 2026-11-19
**Status**: Approved (owner 2026-11-19, "照建議，A+B 開始，C 先查清楚"; revised owner 2026-11-19, "照建議，拿掉檢查，C 選 B 併進 041")
**Input**: Follow-ups A, B and C of spec 039 (released in 0.26.1).

## What was wrong

- **A - a frame's stale focus could pass the check.** Before `type` with a target, the target's own frame is asked
  which element has focus (039 FR-568). The concern was that a document keeps its `activeElement` after focus
  leaves it for another frame. **Measured (coverage.md, measurement 1): not so in Chromium 151.** A frame's
  `activeElement` returns to `BODY` once focus moves to another frame, so the 039 check already refuses the
  overlay case on 0.26.2. A is pinned by a packaged test and needs no code.
- **B - an editable body in a cross-site frame was unproven.** Proven by a packaged run, window in front and
  behind (coverage.md, measurements 2 and 3).
- **C - the check fails open when it cannot run.** When the focus check cannot get an answer (the frame's
  document was replaced or removed, the page navigated, the round trip timed out), `type` sends the text and
  answers `verified`; `key` sends the key and answers `focus-lost`, which nothing observed. No spec chose
  this: 039 FR-568 says the check answers `focus-lost` "otherwise". A target whose element is no longer in
  the frame's registry answers a confirmed miss (`focus-lost`) although nothing was compared. The retry
  counts attempts, and each attempt can wait for the 10 s round-trip deadline.

## Decisions

- **D-041-1 (A, revised)**: no frame focus walk. A slice built one (top-down walk, 030 T908) and it changed no
  observable outcome on 0.26.2; it was removed before review (owner 2026-11-19). The overlay scenario stays as
  a regression pin.
- **D-041-2 (A)**: a target in the top document keeps the 039 rule.
- **D-041-3 (B)**: settled by the run in coverage.md: `verified` with the window in front and behind.
- **D-041-4 (C, owner chose option B)**: `type` and `key` with a named target (ref, description or point)
  refuse before any key when the focus check cannot answer within its time budget. The answer is the new verdict
  `focus-unconfirmed`, `verified: false`, `charactersChanged: 0` for `type`, and a hint that says the
  check could not run and that the agent should read the page again before retrying. It mirrors
  `target-unconfirmed` for clicks (004 B82): a check that did not run is never reported as a miss or a
  success. With no target nothing is checked and the keys go where focus is, as before.
- **D-041-5**: `key` with a named target gets the same check before the key that `type` has (039 FR-568).
  A confirmed miss answers `focus-lost` with no key sent, and an unknown answer gives `focus-unconfirmed` with
  no key sent. The check after the key (004 T128) stays for the verdict. An unknown answer there is
  `focus-unconfirmed`, never `focus-lost`.
- **D-041-6**: the check's retry is bounded by time, not by attempts. A confirmed answer still settles inside
  the existing 50 ms poll. An unknown answer is asked again until 2000 ms after the first ask. Each ask is cut
  off at what is left of that budget, and the call refuses after it. Today one ask can wait the 10 s round-trip
  deadline, up to six times. The budget applies only to the checks before a key. The check after a key keeps
  the 50 ms window for asking again. An answer still unknown after it is `focus-unconfirmed`. A single ask there
  is cut off at the 2000 ms budget, so a busy renderer still confirms. An unknown or cut-off answer never
  replaces a miss already confirmed in the same check. A key that navigates (Enter submitting a form) must not wait 2 s for a document that
  is already gone.
- **D-041-7**: a named target whose element its frame can no longer resolve answers "could not check"
  (`focus-unconfirmed`), not a confirmed miss. No focus was compared.
- The verdict is additive. The host and the extension ship as one pinned version
  (`tool-offering.ts`), so no older peer meets it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - typing does not follow a frame's stale focus (P1, pinned)

1. **Given** a field inside a cross-site frame that last had focus, **When** `type` names it and the focusing
   click lands on a top-document overlay that focuses a top-document input, **Then** the call is refused
   `focus-lost` and neither input receives a character.
2. **Given** the same page without the overlay, **When** `type` names the frame field, **Then** the text lands
   and the answer is `verified`.
3. The same two scenarios hold for a same-site frame.

### User Story 2 - an editable body in a cross-site frame (P2)

1. **Given** a cross-site frame whose `body` is editable, **When** `type` names a point on its text, **Then**
   the text lands in the frame and the answer is `verified`.

### User Story 3 - no keys when focus cannot be checked (P1)

The agent types into a field inside a frame. The focusing click makes the page remove that frame, or replace
its document, and moves focus to a top-document input.

1. **Given** that page, **When** `type` names the frame field, **Then** the call is refused
   `focus-unconfirmed`, no character reaches any input, and the hint says to read the page again.
2. **Given** that page, **When** `key` names the frame field with a printable key, **Then** the call is refused
   `focus-unconfirmed` and no key is delivered.
3. **Given** an ordinary field, **When** `key` names it and its own handler moves focus away after the key,
   **Then** the answer is `focus-lost` as today (the key was sent). **When** the check after the key cannot run,
   **Then** the answer is `focus-unconfirmed`, not `focus-lost`.

## Requirements *(mandatory)*

- ~~**FR-578 - frame focus walk**~~: withdrawn (D-041-1).
- **FR-579 - top document unchanged**: a top-document target is checked exactly as in 039.
- ~~**FR-580 - key too (walk)**~~: withdrawn with FR-578. `key` is covered by FR-583.
- **FR-581 - editable body in a cross-site frame proven**: a packaged run types into an editable `body` in an
  out-of-process frame. The window-behind case is recorded in coverage.md.
- **FR-582 - type refuses an unknown check**: `type` with a named target refuses before any key with
  `focus-unconfirmed` (D-041-4) when the check cannot answer within its budget.
- **FR-583 - key checks before the key**: `key` with a named target runs the check before the key. A miss
  answers `focus-lost` and an unknown answer gives `focus-unconfirmed`. In both cases no key is delivered
  (D-041-5).
- **FR-584 - key verdict after the key**: an unknown check after the key answers `focus-unconfirmed`. `key`
  with no target is never `focus-lost`: it answers `verified`, as `type` with no target does.
- **FR-585 - time-bounded retry**: D-041-6. The whole check, retries included, ends within 2000 ms plus one
  poll interval. A test pins that a hanging ask does not hold the call past that.
- **FR-586 - unresolvable target is unknown**: D-041-7.
- **FR-587 - the verdict exists everywhere verdicts are listed**: the closed answer schema, the tool
  descriptions that explain verdicts, and the docs that list them.

## Success Criteria *(mandatory)*

- **SC-263 (revised)**: the overlay scenario of US1 is refused with no character in either input, in an
  out-of-process frame and in a same-site frame. It also passes on 0.26.2 (coverage.md, measurement 1). It is a
  regression pin, not a RED.
- **SC-264**: US1 scenario 2 and the existing frame typing specs (`agent-input` B76, `agent-frame-consent`)
  still pass.
- **SC-265**: US2 passes with the window in front.
- **SC-266**: the 040 + 039 + 038 packaged set still passes.
- **SC-267**: US3 scenarios 1 and 2 pass in a packaged run. On 0.26.2 the same run delivers the text or key
  into the top-document input (RED). If no page construction gives a deterministic RED in Chromium 151, that is
  measured and recorded, and the unit tests carry the claim.
- **SC-268**: unit tests pin FR-582 to FR-586, including the retry bound under a hanging ask.

## Assumptions

- Focus emulation stays on for attached tabs (031).
- A control that moves focus by design while it types (OTP boxes) is unaffected. The check runs once, before
  the first key (T159).

## Change Log

| Date | Change | Origin |
| --- | --- | --- |
| 2026-11-19 | Initial specification | owner 2026-11-19 |
| 2026-11-19 | A measured not reproducible in Chromium 151: walk withdrawn (FR-578, FR-580), SC-263 a pin; C option B added (D-041-4..7, FR-582..587, US3, SC-267, SC-268) | owner 2026-11-19 |
