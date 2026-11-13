# Tasks: The Pointer Says What the Agent Is Doing

**Input**: `specs/033-cursor-action-label/` (spec, plan, research R-491..R-499, data-model,
contracts/page-pointer-messages.md, quickstart)

**Tests**: required (project rule: every behaviour change comes with the failing test that would have
caught its absence). Each test task is written first and must fail for the stated reason.

**Organisation**: by plan slice (M, A, B, C) so each slice is one dispatch; every task carries its user
story. Paths are repository-relative. `EXT` = `apps/extension`.

## Phase 1: Measurement (slice M, main session, live)

- [x] T980 [US4] With a held test page (`https://localhost:19443`) in the attached test Chromium, click
  once so the pointer is up (pill and glow are up while held), call `screenshot` and `screenshot` with a
  `region` around the pointer, and inspect both images: record in `specs/033-cursor-action-label/coverage.md`
  whether the pointer, the pill and the glow appear. If none appears, mark FR-509 and Phase 5 "not
  needed" with this evidence.

## Phase 2: Worker words and step (slice A) - US1, US2

- [x] T981 [P] [US1] Failing tests in `EXT/tests/pointer-captions.test.ts` (node): for every FR-499 row,
  `pointerCaption(tool, args, locale)` returns the table's words in `en-US` and `zh-TW` and its mode;
  `computer` actions map to their stand-alone rows; scroll direction picks its row; navigate URL gives
  `Opening {host}` with the hostname, `back` / `forward` their rows; `{query}`, `{keys}` cut to 20
  characters + `…`; `wait` gives `{n}`; screenshot and tools without a page (tabs_context, list_browsers,
  select_browser, request_browser_choice, propose_sites, downloads_context, gif_recorder, dialog,
  tabs_create/close/claim/release) give `undefined` (no step). R-491, R-493.
- [x] T982 [US1] Add `agent.pointer.*` keys to `EXT/src/locales/en-US.ts` and `EXT/src/locales/zh-TW.ts`
  (FR-499 wording; zh base phrases ≤ 8 characters) and implement
  `EXT/src/service-worker/agent-tools/pointer-captions.ts` until T981 passes.
- [x] T983 [P] [US1] Failing test in `EXT/tests/agent-pointer-step.test.ts` (node, runtime-level as the
  existing dispatch tests do): a top-level `find` and each step of a two-step `browser_batch` send
  `{type:"pointer-step", words, mode}` to frame 0 of the held tab before the runner acts; a tool with
  `undefined` caption sends nothing; a rejected `sendMessage` does not fail or delay the call. R-491.
- [x] T984 [US1] In `EXT/src/service-worker/agent-runtime.ts` `dispatchTool`, after `heldByTransition`
  and before `runTool`, send the step (fire-and-forget, `chrome.tabs.sendMessage(tabId, step,
  {frameId:0})`, rejection swallowed) with the indicator's locale source, until T983 passes.
- [x] T985 [P] [US3] Failing tests in `EXT/tests/pointer-delivery.test.ts`: a click's cursor message
  carries `press: true`, hover/scroll/drag-end do not, the drag's press move does; the arrival cap is
  420 ms (a never-answering page delays the first event by 420 ms, not 250). R-492, R-496.
- [x] T986 [US3] In `EXT/src/service-worker/agent-tools/input.ts` set `CURSOR_ARRIVAL_CAP_MS = 420`,
  add `press?: true` to `CursorMessage` and send it for the click family and the drag press, until T985
  passes; update comments in `effects.ts` that cite 250 ms.

## Phase 3: Page drawing (slice B) - US1, US2, US3, US4

- [x] T987 [P] [US3] Failing tests in `EXT/tests/cursor-motion.test.ts` (node): `planTravel` durations
  grow with distance and stay within 140-380 ms; < 1 px and reduced motion give 0; the path's sideways
  bend ≤ min(10 %·d, 24 px); the overshoot ≤ 3 px and the last frame is exactly the target; tilt ≤ 8°
  and 0 at both ends. R-496.
- [x] T988 [US3] Implement `EXT/src/content-runtime/cursor-motion.ts` until T987 passes.
- [x] T989 [P] [US4] Failing tests in `EXT/tests/caption-placement.test.ts` (node): `placeCaption`
  default below-right; `left` near the right edge; `above` near the bottom; both near the bottom-right
  corner; the box always ≥ 8 px inside for the 16 placements of SC-220 at 1280×800 and 400×700;
  pointed corner faces the tip on every side. R-495.
- [x] T990 [US4] Implement `EXT/src/content-runtime/caption-placement.ts` until T989 passes.
- [x] T991 [P] [US1] Failing tests in `EXT/tests/cursor.test.ts` (jsdom) and through the content runtime:
  a `pointer-step` with mode `stay` and no pointer draws it at the rest spot with the words in
  `data-hallpass-words` and no text node anywhere under the pointer; `travel` stores words without
  drawing; the next cursor move draws at its point with the stored words; the caption gets `data-faded`
  1 000 ms after arrival (fake timers) and loses it on the next step; at rest it never fades; malformed
  steps (extra key, `words` > 60, unknown mode, foreign sender) are ignored. FR-499..502, FR-504, FR-510.
- [x] T992 [P] [US2] Failing tests in `EXT/tests/cursor.test.ts`: a `rest` step moves a pointing pointer
  to (16, innerHeight − 16 − arrow height); a following move travels from there; a viewport resize while
  resting re-places it. FR-502.
- [x] T993 [P] [US3] Failing tests in `EXT/tests/cursor.test.ts`: a move with `press:true` adds one ring
  element (indicator marker) on arrival and removes it within 700 ms; with `matchMedia('(prefers-reduced-motion: reduce)')`
  the ring does not scale; when `element.animate` is missing the pointer is placed directly and arrival
  resolves at once; a hidden document resolves at once. FR-505..507.
- [x] T994 [US1] Rework `EXT/src/content-runtime/cursor.ts` (animation via `planTravel`, inner tilt
  element, caption element + one marked `<style>` with the generated-content rule, rest spot, fade timer,
  ring) and route `pointer-step` in `EXT/src/content-runtime/agent-entry.ts` with an exact-shape
  `isPointerStep`, until T991-T993 pass; existing cursor tests keep passing.
- [x] T995 [P] [US4] Failing test in `EXT/tests/visible-text.test.ts` / collector tests: with a caption
  up, `visibleTextOf`, the `read_page` structure and `find` candidates contain none of the caption words.
  FR-504.

## Phase 4: Captures hide the marks (slice C) - US4 - only if T980 confirms

- [x] T996 [P] [US4] Failing tests in `EXT/tests/cursor.test.ts` / `indicator.test.ts` (jsdom): `marks
  hidden:true` sets `data-hallpass-hidden` on pointer, caption, ring, pill and glow, replies
  `{painted:true}` after two animation frames, changes no `display`/`visibility`/layout; `hidden:false`
  clears it; with no `hidden:false` it clears itself after 3 s; malformed marks messages are ignored.
  R-499.
- [x] T997 [P] [US4] Failing tests in `EXT/tests/agent-screenshot.test.ts` and `computer.test.ts`
  (node): an agent `screenshot` (whole and region) and the `computer` screenshot send `marks hidden:true`
  and await its reply (≤ 250 ms) before capturing, and send `hidden:false` after - also when the capture
  throws or times out; a page that never answers costs ≤ 250 ms; the GIF frame path
  (`recording/frame-capture.ts`, including its `photographTab` fallback) sends no marks message. R-499,
  D-033-5.
- [x] T998 [US4] Implement the page side (`agent-entry.ts` route, `cursor.ts` and `indicator.ts` honour
  `data-hallpass-hidden` through the marked stylesheet) and the worker wrapper in `reads.ts` and
  `effects.ts` (try/finally), until T996-T997 pass. Then dispatch code-reviewer (R1: hide/restore
  lifecycle).

## Phase 5: Close-out

- [x] T999 Planned final verification: `npx tsc -b`, `npm run typecheck`, `npm test`, `npm run build`,
  `npm run test:contract`, `npm run snapshot:check`.
- [x] T1000 [US1] [US2] [US3] [US4] Live checks 1-6 of `quickstart.md` in the attached test Chromium with
  one GIF each; record results in `specs/033-cursor-action-label/coverage.md`.
- [x] T1001 Owner's look in branded Chrome after `npm ci` + build in the main checkout and an extension
  reload (human gate).

## Dependencies

- T980 (M) runs alongside Phase 2 and Phase 3; Phase 4 starts only after T980 confirms and Phase 3 is
  merged (shares `cursor.ts`, `agent-entry.ts`).
- Phase 2 and Phase 3 are independent (disjoint files; message shapes fixed in the contract).
- Within a phase, each test task precedes its implementation task.
- T999 after all implementation; T1000 after T999; T1001 last.

## Parallel examples

- Wave 1: slice A (T981-T986) ‖ slice B (T987-T995) ‖ T980 (main, live).
- Inside slice B: T987, T989, T991-T993, T995 can be written in parallel; T988, T990 before T994.

## Implementation strategy

MVP = slices A + B (captions, rest, motion, ripple, placement, not-text): it delivers US1-US3 and most of
US4. Slice C completes US4 if the measurement asks for it.
