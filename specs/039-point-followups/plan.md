# Plan: 039 point follow-ups

## Research

- **R-547 (F5, focus path)**: `content.resolve-active-element` gains an optional `targetHandle`, mirroring
  `content.resolve-point`'s confirmation form (004/T129): the content runtime answers `resolved` with that ref
  when `document.activeElement` (deepest through open shadow roots) is the target's element, an ancestor of it in
  the composed tree, or the `control` of the target's nearest `label` ancestor; otherwise the active element's own
  candidate (a real miss, with its role and label). `createFocusConfirmer` passes the clicked ref and returns the
  receiving field's role/label when it differs, for the FR-569 hint.
- **R-548 (F4, drag)**: `same-endpoints` moves from ref equality to the distance between the two delivery points,
  computed after both ends are located (`effects.ts` drag delivery). The plan-step check (`effects.ts` ~1817)
  compares named points when both ends are points, refs when both are refs, and lets a mixed pair through.
- **R-549 (F1, link)**: the root of a rooted collection carries an optional link flag computed in the content
  runtime (`closest`-style walk over the composed tree, same document: `a[href]` or role `link`); the worker's
  locate sets `link` from it as well as from the node's own role (`effects.ts` ~981).
- Reference readings: section 039 of the maintainer's private reference notes.

## Slices

- **Slice FD** (implementer-sonnet, worktree `spec-039-followups`): FR-568, FR-569, FR-570; fixtures
  `editor-039`, `drag-039`; packaged `tests/e2e/packaged/agent-type-drag-039.spec.ts` (SC-253, SC-254, SC-255).
  Owns the attach browser (port 9222) and the fixture ports.
- **Slice L** (implementer-sonnet, worktree `spec-039-l`): FR-571; fixture `link-039`; packaged
  `tests/e2e/packaged/agent-link-039.spec.ts` (SC-256), written but run by main after the merge.
- Shared: `tests/harness/page-fixtures.ts` routes for all three fixtures are registered in the spec commit;
  `packages/contracts/src/extension-runtime.ts` is edited by both in different schemas; `effects.ts` in
  different functions. Main merges L into FD.

## Verification

Machine suite on the merged branch; packaged gate agent-type-drag-039 + agent-link-039 + the 038 set (SC-257);
RED for SC-253/255/256 with 0.26.0 production files; code-reviewer (R1: focus check before typing, drag refusal).
