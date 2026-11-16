# Tasks: Move the Pill and Open the Side Panel from It

**Input**: `specs/035-pill-move/` (spec, plan, research R-524..R-532, data-model, contracts/pill-messages.md,
quickstart). **Tests**: required - every behaviour change starts with its failing test (CLAUDE.md, "Test
first").

Slice owners (plan.md): **W** worker (`implementer-sonnet`), **P** page (`implementer-sonnet`), **L** live
stories (`implementer-sonnet`, after W and P). Each task names its slice in brackets after the story label.

## Phase 1: Setup

- [x] T1024 Reinstall this branch's dependencies with `npm ci` and confirm `npx tsc -b` passes (main)

## Phase 2: Foundational (blocks every story)

- [x] T1025 [P] [W] Add the four locale keys `agent.indicator.moveToTop`, `moveToBottom`, `openPanel`, `panelUnopened` with the FR-536 words in `apps/extension/src/locales/en-US.ts` and `apps/extension/src/locales/zh-TW.ts` (R-532); extend the locale parity test if one pins the key list
- [x] T1026 [P] [W] Write failing tests for the owner's-edge store in `apps/extension/tests/pill-edge-store.test.ts`: default `top` when unset, `top` for an unreadable or foreign value, a write is read back from `chrome.storage.local` key `agentPillEdge`, writes are serialised, a fresh store instance loads the stored value (R-528)
- [x] T1027 [W] Implement `apps/extension/src/service-worker/pill-edge-store.ts` after the `agent-appearance.ts` pattern so T1026 passes
- [x] T1028 [P] [P] Extend the page copy of the `IndicatorMessage` type and its guard in `apps/extension/src/content-runtime/indicator.ts` with `edge`, `moveToTop`, `moveToBottom`, `openPanel`, `panelUnopened` per contracts/pill-messages.md, with a failing guard test first in `apps/extension/tests/indicator.test.ts` (wrong types treated as absent; unknown fields still accepted)

## Phase 3: User Story 1 - The owner moves the pill (P1)

**Goal**: a move control toggles the pill between top-right and bottom-right, remembered for the browser.
**Independent test**: quickstart scenarios 1-4.

- [x] T1029 [P] [US1] [W] Write failing tests in `apps/extension/tests/agent-pill-move.test.ts` for the indicator composer in `service-worker/agent-tools/indicator.ts`: every `indicator` message (raise, announcement answer, 034 redraws) carries the stored `edge` and the four words in the owner's locale; the first message after a worker start waits for the store's load
- [x] T1030 [US1] [W] Make T1029 pass in `apps/extension/src/service-worker/agent-tools/indicator.ts` (worker copy of the type changes with the page copy)
- [x] T1031 [P] [US1] [W] Write failing tests in `apps/extension/tests/agent-pill-move.test.ts` for the move press in `agent-runtime.ts`: `{type:"ui.agent.pill-move", to}` from this extension with a sender tab stores `to` and answers `{accepted:true}`, then re-sends the indicator to every tab every session holds; `to` outside `top|bottom`, an extra field, a foreign `sender.id` or no `sender.tab.id` answer `{accepted:false}` and store nothing; no lease is required; the listener returns `true` for this type
- [x] T1032 [US1] [W] Make T1031 pass in `apps/extension/src/service-worker/agent-runtime.ts` (R-529)
- [x] T1033 [P] [US1] [P] Write failing tests in `apps/extension/tests/indicator.test.ts`: the pill is drawn at `top: 8px; right: 8px` for `edge` top or absent and `bottom: 8px; right: 8px` for bottom; the move control shows `moveToBottom` at the top and `moveToTop` at the bottom; a trusted click sends `{type:"ui.agent.pill-move", to}` naming the edge the control shows, with 034's 1 s resend and 2 s give-up and no extra message; an untrusted click sends nothing; controls in the R-531 order
- [x] T1034 [US1] [P] Make T1033 pass in `apps/extension/src/content-runtime/indicator.ts` and the press path in `apps/extension/src/content-runtime/agent-entry.ts`

## Phase 4: User Story 2 - The pill steps aside (P1)

**Goal**: the pill moves to the other edge before the agent's press when the agent's point or target box
overlaps it, and returns once clear. **Independent test**: quickstart scenarios 5-8.

- [x] T1035 [P] [US2] [P] Write failing tests for a pure `placeFor(ownerEdge, pillBox, viewport, points)` in `apps/extension/tests/indicator.test.ts`: no points -> owner edge; point inside the owner's area (box grown by 8 px) -> other edge; point 1 px outside the grown area -> owner edge; a box overlapping the area while its centre is outside -> other edge; overlap at both edges (short viewport, tall box) -> owner edge (R-525, data-model)
- [x] T1036 [US2] [P] Implement `placeFor` and the page state (`lastPoints`, place) in `apps/extension/src/content-runtime/indicator.ts` so T1035 passes; a redraw from a new `indicator` keeps `lastPoints`
- [x] T1037 [P] [US2] [P] Write failing tests in `apps/extension/tests/cursor.test.ts`: the `cursor` validator accepts `box` with exactly `x,y,width,height` finite and `width,height >= 0`, and refuses the whole message for any other `box` (extra key, NaN, negative size, string)
- [x] T1038 [US2] [P] Make T1037 pass in `apps/extension/src/content-runtime/cursor.ts`
- [x] T1039 [P] [US2] [P] Write failing tests in `apps/extension/tests/agent-entry.test.ts` (or the existing entry test file): on a `cursor` message the pill's place is decided and applied before the glide starts and before the `{arrived:true}` reply; `cursor {hide:true}` and a `rest` pointer step return the pill to the owner's edge
- [x] T1040 [US2] [P] Make T1039 pass in `apps/extension/src/content-runtime/agent-entry.ts`
- [x] T1041 [P] [US2] [W] Write failing tests in `apps/extension/tests/agent-pill-move.test.ts` (or the existing input/effects tests): element tools with a located target (ref click, hover, focusing click for `type`/`key`, drag start) send `box` = the target's `rect` with the cursor message; `computer` steps and a drag's end point send no `box`; the point is unchanged
- [x] T1042 [US2] [W] Make T1041 pass in `apps/extension/src/service-worker/agent-tools/input.ts` (`arrive` takes an optional box) and `apps/extension/src/service-worker/agent-tools/effects.ts` (R-526)

## Phase 5: User Story 3 - Open the side panel from the page (P2)

**Goal**: "Open side panel" opens this window's panel. **Independent test**: quickstart scenarios 9-11.

- [x] T1043 [P] [US3] [W] Write failing tests in `apps/extension/tests/agent-pill-move.test.ts` for the open press: `{type:"ui.agent.pill-open-panel"}` from this extension with a sender tab calls `chrome.sidePanel.open({tabId})` synchronously inside the listener call (assert the open was issued before the listener returns and before any microtask runs), answers `{opened:true}` on success and `{opened:false}` on rejection; an extra field, foreign `sender.id` or missing `sender.tab.id` answers `{opened:false}` with no open; no lease is required; the listener returns `true`
- [x] T1044 [US3] [W] Make T1043 pass in `apps/extension/src/service-worker/agent-runtime.ts` by calling `activateWorkspace(sender.tab.id)` from `chrome-adapters/action-entry.ts` first (R-527)
- [x] T1045 [P] [US3] [P] Write failing tests in `apps/extension/tests/indicator.test.ts`: the open control is drawn with `openPanel` beside "back to the agent's tab"; a trusted click sends `{type:"ui.agent.pill-open-panel"}` once; `{opened:false}`, a rejected send or no reply within 2 s shows `panelUnopened` and keeps the pill's state; it is never resent; an untrusted click sends nothing
- [x] T1046 [US3] [P] Make T1045 pass in `apps/extension/src/content-runtime/indicator.ts` and `apps/extension/src/content-runtime/agent-entry.ts`

## Phase 6: Live stories and polish

- [x] T1047 [L] Add a fixture page with a button under the pill's top-right area and a tall right-side element (register it with the HTTPS page fixtures in `tests/harness/`), and write `tests/e2e/packaged/agent-pill-move.spec.ts` covering quickstart scenarios 1-13 in en-US and zh-TW, saving one screenshot per pill state under the run's `test-results/<run-id>/`
- [x] T1048 Main runs `agent-pill-move.spec.ts` and the existing `agent-pill-stop.spec.ts` in the attached test Chromium (both locales) and reviews the screenshots
- [x] T1049 Update `specs/035-pill-move/` with a `coverage.md` mapping FR-526..537 and SC-232..238 to tests and live scenarios; tick tasks
- [x] T1050 Planned final verification: `npx tsc -b`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:contract`, `npm run snapshot:check`
- [x] T1051 Owner's look in branded Chrome after reload (SC-238): move the pill on a real site, watch an agent click under the old place, open the side panel from the pill
  Done 2026-11-16: the owner looked after reloading the main checkout build and approved the release (0.23.0).

## Dependencies

- T1024 first. T1025-T1028 before their stories; T1025 and T1027 before T1030, T1028 before T1034.
- W tasks (T1025-T1027, T1029-T1032, T1041-T1044) and P tasks (T1028, T1033-T1040, T1045-T1046) touch
  disjoint files and share only the fixed contract, so the two slices run in parallel.
- US1, US2 and US3 are independent of each other inside each slice; within a slice the tests before each
  implementation task.
- T1047 after W and P; T1048-T1051 in order.

## Parallel example

```text
Wave 1: implementer-sonnet W -> T1025, T1026, T1027, T1029-T1032, T1041-T1044
        implementer-sonnet P -> T1028, T1033-T1040, T1045, T1046
Wave 2: implementer-sonnet L -> T1047
Main:   T1048-T1050; owner T1051
```

## Implementation strategy

MVP is US1 + US2 (the pill can be moved and stops covering the agent's targets); US3 lands in the same
waves because its slices are small. The two wave-1 writers share one checkout, so they do not commit;
main commits each wave on `spec-035-pill-move` after its focused tests pass, and runs the final
verification once.
