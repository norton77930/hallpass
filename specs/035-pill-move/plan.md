# Implementation Plan: Move the Pill and Open the Side Panel from It

**Branch**: `spec-035-pill-move` (from `spec-034-pill-stop` 11f538e; spec 002bf3f) | **Date**: 2026-11-16 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/035-pill-move/spec.md`, approved by the owner on 2026-11-16
including D-035-1..4.

## Summary

The pill can sit top-right or bottom-right. The owner's edge is one `chrome.storage.local` value the
worker owns (R-528) and sends with every `indicator` message (R-530). A trusted press on the move control
sends the edge the control names (R-529); the worker stores it and redraws every held tab. The page
decides on each 033 `cursor` message, before the glide starts and so before the worker sends the press,
whether the agent's point or target box overlaps the pill's area and draws the pill at the other edge for
that moment (R-524, R-525); the element tools add the target box to that message (R-526). A trusted press
on "Open side panel" makes the worker call the toolbar's own open path at once, before any wait, and
answer whether it opened (R-527).

## Technical Context

**Language/Version**: TypeScript; Chrome MV3 service worker, content runtime (Vite bundle)

**Primary Dependencies**: none added

**Storage**: `chrome.storage.local`, one new key `agentPillEdge`

**Testing**: vitest `unit` (worker, jsdom page modules); packaged gate in the attached test Chromium
(quickstart)

**Target Platform**: Chrome ≥ the manifest minimum, every platform the extension supports

**Project Type**: browser extension + stdio MCP server (npm workspaces); host code does not change

**Performance Goals**: every pill at the new edge within 1 s of a move (SC-232); the step aside adds no
round trip to a pointer step; the panel opens within 1 s (SC-236)

**Constraints**: clean room; no new permission; nothing agents see changes; page words are the worker's;
the open must be issued before any `await`

**Scale/Scope**: one edge per browser profile; pills in the top document of each held tab

## Constitution Check

| Principle | Status |
|---|---|
| I. Requirements are the source of truth | Pass. Every behaviour traces to D-035-n and FR-526..537 |
| II. Clean room | Pass. The reference was read for observable behaviour only (spec Facts); the rule, messages and words are Hallpass's own |
| III. Traceability | Pass. R-524..532 cite FRs; tasks will cite R and FR ids |
| IV. Explicit uncertainty | Pass. The out-of-process frame limit (R-526) and the unsettled no-activation case (R-527) are stated |
| V. Least privilege | Pass. No permission; `sidePanel` and `storage` are already declared |
| VI. Consent and privacy | Pass. The stored value is "top" or "bottom"; opening the panel changes no session, site mode or grant |
| VII. Testable | Pass. The place rule, store, presses and open order are unit-tested; each story has a packaged-gate scenario |
| VIII. MV3 | Pass |
| IX. Requirements before architecture | Pass. Spec approved 2026-11-16 |
| X. Dependencies | Pass. None added |
| XI. Failure behaviour | Pass. Unreadable edge, refused open, no reply, page-made clicks, both edges covered and worker restart are specified |
| XII. Spec before implementation | Pass |

Re-check after design: unchanged. One refinement recorded in the spec change log: the move press names
the edge it moves to (R-529).

## Project Structure

### Documentation (this feature)

```text
specs/035-pill-move/
├── spec.md
├── plan.md              # this file
├── research.md          # R-524..R-532
├── data-model.md
├── quickstart.md
├── contracts/pill-messages.md   # internal: indicator fields, move/open presses, cursor box
└── checklists/requirements.md
```

### Source Code (touched areas)

```text
apps/extension/src/locales/en-US.ts, zh-TW.ts                 # W: four keys (R-532)
apps/extension/src/service-worker/pill-edge-store.ts          # W: new (R-528)
apps/extension/src/service-worker/agent-tools/indicator.ts    # W: edge + words in the composer
apps/extension/src/service-worker/agent-runtime.ts            # W: move and open press handlers, redraw all
apps/extension/src/service-worker/agent-tools/input.ts        # W: arrive() passes an optional box
apps/extension/src/service-worker/agent-tools/effects.ts      # W: element tools pass target.rect
apps/extension/src/content-runtime/indicator.ts               # P: edge, place rule, move/open controls, not-opened
apps/extension/src/content-runtime/agent-entry.ts             # P: cursor -> place before glide; presses with reply
apps/extension/src/content-runtime/cursor.ts                  # P: validator accepts box
tests/e2e/packaged/agent-pill-move.spec.ts                    # L: quickstart scenarios 1-13
tests/harness (fixture page)                                  # L: a page with a button under the pill's area
```

## Slices and order

| Slice | Stories / FR | Risk | Owns | Depends on |
|---|---|---|---|---|
| W - worker | US1-US3 worker side; FR-527, 528, 531-534, 536, 537 | none beyond tests: the move value is cosmetic and the open grants nothing; the open-before-await order is pinned by a unit test | locale files, `pill-edge-store.ts`, `agent-tools/indicator.ts`, `agent-runtime.ts`, `input.ts`, `effects.ts`, their tests | contracts/pill-messages.md (fixed) |
| P - page | US1-US3 page side; FR-526, 527, 529, 530, 534, 535 | none (live-verifiable UI; trust is the existing `isTrusted` seam) | `content-runtime/indicator.ts`, `agent-entry.ts`, `cursor.ts` (validator), their tests | contracts/pill-messages.md (fixed) |
| L - live stories | quickstart 1-13 | none | `tests/e2e/packaged/agent-pill-move.spec.ts`, fixture page registration | W, P merged |

Before wave 1: `npm ci` in this checkout (its `node_modules` were installed for `deps-76`, whose lockfile
is newer than this branch's).

Wave 1: W and P together - two writers in this checkout. They own disjoint files, the message shapes
are fixed in the contract, and their checks are focused unit tests with no shared outputs. Both go to
`implementer-sonnet` (settled method, exact contract, clear unit tests).
Wave 2: L (`implementer-sonnet`), then main runs it in the attached test Chromium in both locales and
captures a screenshot per pill state.

Reviews: none pre-selected. No row of the risk table fires: the trust seam is unchanged, no stored value
grants anything, nothing agents see changes, and every story closes on a live run.

Closing evidence: unit tests per slice; one planned final verification (`tsc -b`, typecheck, `npm test`,
build, `test:contract`, `snapshot:check`); the packaged-gate stories by main; the owner's look in branded
Chrome after reload (SC-238).

## Complexity Tracking

| Addition | Why it is needed | Simpler alternative rejected because |
|---|---|---|
| A box on the cursor message | FR-529 counts the target element, not only its centre | the centre alone misses a target whose edge is under the pill |
| A persisted owner's edge | D-035-1: remembered for the browser, across restarts | session storage is lost on a browser restart; page storage is per site and page-writable |
| The edge named in the move press | US2.4: while stepped aside the control must set the edge it names | a worker toggle picks the wrong edge in that case |
