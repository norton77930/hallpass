# Plan: 040

## Research

- **R-550 (FR-572)**: in `effects.ts` drag delivery, decide "same element" after both ends are located (the two
  located handles are the same, or one end is a point whose located element is the other end's). For that
  case ask the press point's confirmation the way the click path does (`confirmationPointOf`,
  `content.resolve-point` with `targetHandle`) and pass it to verification; `effect-verification.ts`'s
  `browser.drag` clause uses `pointConfirmation` when present (as `browser.hover` does) and `moved` otherwise.
  Tool text in `packages/contracts/src/agent-tools.ts` (`drag`) updated; contract tests pinning it updated.
- **R-551 (FR-573)**: `collector.ts` `labelRaw` gains `labelsText(element)` after `aria-label`: the controls'
  `labels` text with nested form controls' text removed, joined by a space. `content-runtime/index.ts`
  `describeField` (039) uses the same rule.
- **R-552 (FR-574)**: live-1 samples the pointer as live-3 does and anchors `watchFade` on the travel's end.

## Slices

- **Slice A** (implementer-sonnet, worktree `spec-040-followups`): FR-572, FR-575, FR-574; SC-258 by extending
  `agent-type-drag-039.spec.ts` SC-255 to require `verified`; SC-260. Owns port 9222.
- **Slice B** (implementer-sonnet, worktree `spec-040-b`): FR-573, FR-576; fixture `label-040`; packaged
  `agent-label-040.spec.ts` (SC-259) written, run by main.

## Verification

Machine suite on the merged branch; packaged 040 + 039 + 038 set (SC-261); RED on 0.26.1 for SC-258/259.
