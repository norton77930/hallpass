# Implementation Plan: Clicks Land on What a Person Points At (038)

**Branch**: `spec-038-point-click` (from main 2726b82) | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

## Summary

Three changes. The collector always collects a rooted collection's own root (FR-562). The agent's walk lists the
ARIA widget roles and names them from content (FR-565..567). The pointer delivery uses the named point for a
point target and stops scrolling for it (FR-563..564).

## Technical Context

TypeScript MV3 extension. Content runtime `collector.ts` (`snapshotDocument`, `WALK_SELECTORS`,
`snapshotTarget`); worker `agent-tools/effects.ts` (`locator`, `deliverPointer`, `deliverKeyboard`,
`confirmPoint` input) and `agent-tools/reads.ts` (`INTERACTIVE_ROLES`). vitest `unit`; Playwright packaged gate
with the HTTPS page fixtures (`tests/harness/page-fixtures.ts`). No contract, schema, permission or dependency
change.

## Constitution Check

| Principle | Status |
|---|---|
| I. Requirements are the source of truth | Pass: FR-562..567 from D-038-1..3 |
| II. Clean room | Pass: behaviour described from a pointer's own semantics; no other product's code |
| III. Traceability | Pass: R-544..546, T1077..1088 |
| Consent (030) | Pass: the frame claim, landing check and re-check still run on the element at the point (FR-564) |
| Test first | Pass: T1077, T1078, T1081 are RED before GREEN |

## Research

- **R-544 - why points failed** (FR-562). `content.resolve-point` registers the innermost hit element
  (`registerLiveElement`); `locateInFrame` asks `collectPage` rooted at that ref, and `snapshotDocument` walks
  `WALK_SELECTORS["all-controls"]` filtered by `withinRoot`, so a root outside the selector never appears.
  Decision: `snapshotDocument` adds the root to the walk when the selector did not return it (first, depth 0),
  and `collectPage` gives the root its existing handle regardless of `hidden` (the ref was already issued; the
  node still carries `hidden: true` for reads). Rejected: climbing from the hit to the nearest walked ancestor
  - it changes which element a point names and still fails for refs `find` already returned.
- **R-545 - point delivery** (FR-563, FR-564). Today `locator` locates with `scroll: true` and clicks
  `centreOf(rect)`; for an inner span the centre is close, for a large element it is not, and the scroll moves
  the page under a point the agent read from a screenshot. Decision: `deliverPointer`/`deliverKeyboard` keep the
  point from `args`; for a point target the locate runs with `scroll: false` (still needed for the frame,
  landing check, link flag and box), the pointer gets the named point, and `confirmPoint` gets the named point.
  Drag: both endpoints at their named points; the "moved" re-measure is unchanged. Rejected: dropping the
  locate for points - the frame claim and the link flag need the element.
- **R-546 - widget roles** (FR-565..567). The walk lacked the ARIA widget roles, so `div[role=option]` was
  invisible and `li[role=menuitemradio]` was only an `li`. Decision: extend the selector and add a
  name-from-content role set beside `TEXT_NAMED_TAGS`; `INTERACTIVE_ROLES` gains the three missing roles.
  Expected: some existing read fixtures gain nodes; tests that pin counts are updated with the reason.

## Slices

| Slice | Tasks | Owner | Files |
|---|---|---|---|
| AB | T1077-T1080, T1083 | implementer-sonnet | `content-runtime/collector.ts`, `agent-tools/reads.ts`, `tests/harness/page-fixtures.ts`, new unit tests, new `tests/e2e/packaged/agent-point-click-038.spec.ts` |
| C | T1081-T1082 | implementer (effort high: cross-module delivery, frame claim) | `agent-tools/effects.ts` and its unit tests |

The two slices touch disjoint files and run in separate worktrees; main merges C into the 038 branch after AB,
then runs T1084-T1086.
