# Tasks: Stop the Agent from the Page

**Input**: `specs/034-pill-stop/` (spec, plan, research R-512..R-523, data-model,
contracts/pill-messages.md, contracts/agent-stop-reason.md, quickstart)

**Tests**: required (project rule: every behaviour change comes with the failing test that would have
caught its absence). Each test task is written first and must fail for the stated reason.

**Organisation**: by plan slice (K, W, P, S, L) so each slice is one dispatch; every task in a story phase
carries its user story. Paths are repository-relative. `EXT` = `apps/extension`, `CON` =
`packages/contracts/src`.

## Phase 1: Setup

None: no new package, dependency, build step or permission (plan, Technical Context).

## Phase 2: Contracts and words (slice K) - blocks W, P, S

- [x] T1002 Failing tests: in `tests/contract/agent-tools-014.contract.test.ts` (T350) the exact stop
  reason list is `["owner-stopped", "owner-interrupted", "owner-held"]` and
  `{ callId, outcome: "stopped", reason: "owner-held", hint: HELD_HINT }` parses as an agent native
  response; in `CON/agent-tools.test.ts` the panel command schema accepts
  `{ type: "ui.agent.session-resume", payload: { sessionId } }` and refuses an extra field, the session
  view accepts an ISO `heldAt` and refuses a non-ISO one, the activity entry accepts `hold`/`held` and
  `resume`/`resumed` and refuses `hold`/`interrupted`; `CON/settings.test.ts` (the list of session
  commands at ~111) includes `ui.agent.session-resume` where the list names panel session commands.
  R-516, R-521.
- [x] T1003 In `CON/agent-tools.ts`: add `"owner-held"` to `AGENT_STOP_REASONS`; add `HELD_HINT` beside
  `INTERRUPT_HINTS` with the FR-523 agent message; add `ui.agent.session-resume` to
  `agentPanelCommandSchema`; add optional `heldAt` (ISO date-time) to `agentSessionViewSchema`; add
  activity kinds `hold` (outcome `held`) and `resume` (outcome `resumed`) with the refinement pairing
  them; until T1002 passes. Build with `npx tsc -b`.
- [x] T1004 Add the FR-523 keys to `EXT/src/locales/en-US.ts` and `EXT/src/locales/zh-TW.ts` (R-523):
  `agent.indicator.stop`, `agent.indicator.resume`, `agent.indicator.held`,
  `agent.indicator.stopUndelivered`, `agent.indicator.resumeUndelivered`, `agent.session.heldFromPage`,
  `agent.session.resume`, the activity labels for `hold`/`held` and `resume`/`resumed` (named like the
  existing interrupt activity keys), and `agent.pointer.stopped` ("Stopped" / 「已停止」);
  `tests/contract/locales.contract.test.ts` passes.

**Checkpoint**: `npx tsc -b`, `npm run typecheck`, the two contract files and `CON` tests green.

## Phase 3: Worker hold (slice W) - US1, US2, US3, US4 worker side

- [x] T1005 [P] [US3] Failing tests in `EXT/tests/hold-store.test.ts` (node, a fake
  `chrome.storage.session`): `set`, `get`, `delete`, `load` returning every hold; two writes in a row are
  serialised (the second sees the first); a second store instance over the same fake storage (a worker
  restart) loads the holds the first wrote; `deleteMany` removes only the named sessions. R-513.
- [x] T1006 [US3] Implement `EXT/src/service-worker/hold-store.ts` (shape after `site-plan-store.ts`,
  own key, map `sessionId -> { at, tabId }`) until T1005 passes.
- [x] T1007 [P] [US1] Failing tests in `EXT/tests/agent-runtime-hold.test.ts` (runtime-level, as
  `agent-runtime-interrupt.test.ts` builds it): with a session held, `click`, `read_page`, `screenshot`,
  `tabs_context` and `find` each answer exactly `{ callId, outcome: "stopped", reason: "owner-held",
  hint: HELD_HINT }`, and no runner, pointer step or tab message runs; a second session's calls run;
  a new runtime over the same storage, the session greeting again, refuses its first call with
  `owner-held` (the load is awaited); End session, an agent-changed greeting and unpair each delete the
  hold (a later session with the same id is not held); `ui.agent.session-resume` lifts it and the next
  call runs; a call refused while held is not run after the resume. R-512..R-514, R-516.
- [x] T1008 [P] [US1] Failing tests in `EXT/tests/agent-pill-press.test.ts` (runtime-level) for
  `ui.agent.pill-stop` / `ui.agent.pill-resume` through the content-message listener:
  `accepted: false` for a wrong `sender.id`, no `sender.tab`, a tab no session leases, and a message with
  any extra field; for an outside session: `accepted: true`, the hold is set before the in-flight calls
  are interrupted (a call sent from inside the interrupt answers `owner-held`), the in-flight call
  answers `owner-interrupted`, a pending consent card is cancelled with `interrupted`, activity `hold` is
  noted, every leased tab of the session is sent an `indicator` with `mode: "held"`, and each gets one
  pointer step with the stopped words in `rest` mode; a second Stop changes nothing; Resume lifts the
  hold, re-raises `mode: "working"`, notes `resume`; Resume on a session not held answers
  `accepted: true` and changes nothing; for a panel session: the in-flight calls are interrupted,
  `{ type: "ui.conversation.stop", payload: { conversationId } }` reaches `conversations.command`, no hold
  is set, `accepted: true`; with no broker connected `accepted: false`. The listener returns `true` only
  for these two types. R-515, R-517, R-519, R-520, R-522.
- [x] T1009 [P] [US3] Failing tests in `EXT/tests/agent-indicator-sender.test.ts` (new describe): the
  composer fills `mode`, `stop`, `resume`, `heldLabel`, `stopUndelivered`, `resumeUndelivered` per
  data-model for `working`, `held` and `conversation` in `en-US` and `zh-TW`; `answerAnnouncement` for a
  held session's tab answers `mode: "held"`. R-518.
- [x] T1010 [US1] In `EXT/src/service-worker/agent-runtime.ts`: create the hold store and its mirror,
  load it in `start()` behind a promise that `handleToolCall` awaits; refuse a held session's call right
  after the session lookup (R-512); delete the hold in `releaseSession` and unpair (R-514); fill
  `heldAt` in the session projection; route `ui.agent.session-resume` in
  `EXT/src/service-worker/agent-panel-port.ts` beside `session-interrupt`; until T1007 passes.
- [x] T1011 [US1] In `EXT/src/service-worker/agent-runtime.ts`: the press handler and listener (sender
  checks as `focusMainTab`, lease lookup, `sendResponse`, `return true` for the two types), the
  outside-session Stop in R-515's order, Resume, the panel-session route (R-520), activity notes, the
  stopped pointer step (R-519); until T1008 passes.
- [x] T1012 [US3] In `EXT/src/service-worker/agent-tools/indicator.ts`: the extended message type and the
  composer modes and words (both type copies change together, contracts/pill-messages.md); raise every
  leased tab of a session on Stop and Resume; until T1009 passes.

**Checkpoint**: `npx vitest run --project unit` for the four test files above plus the existing
`agent-runtime-interrupt`, `agent-focus-main`, `agent-indicator-sender`, `agent-panel-port`,
`agent-runtime-sessions` and `stop` tests green.

## Phase 4: Pill on the page (slice P) - US1, US2, US5 page side

- [x] T1013 [P] [US5] Failing tests in `EXT/tests/indicator.test.ts` (jsdom, new describe): Stop is drawn
  only when the message carries `stop`, with that text; `mode: "held"` draws `heldLabel` and a Resume
  control with `resume`, and no Stop; `mode: "conversation"` draws Stop and never Resume; an unknown
  `mode` is drawn as `working`; the existing "back to the agent's tab" control stays; an untrusted click
  on Stop or Resume sends nothing; a trusted click sends `{ type: "ui.agent.pill-stop" }` (or
  `pill-resume`) through the host and awaits its reply; with no reply after 1 s the same press is sent
  once more; with no reply after 2 s `stopUndelivered` (or `resumeUndelivered`) is shown as text on the
  pill; a rejected send counts as no reply; an `accepted: true` reply within 1 s shows nothing extra;
  words with markup characters show literally. Fake timers. R-517, R-518, R-522.
- [x] T1014 [US5] In `EXT/src/content-runtime/indicator.ts` (controls, modes, retry, not-delivered; the
  host gains a press call that resolves with the reply) and `EXT/src/content-runtime/agent-entry.ts`
  (press through `runtime.sendMessage`, reply returned, rejection surfaced as no reply); until T1013
  passes. The content guard accepts the new fields with their types only.

**Checkpoint**: `indicator`, `indicator-before-body` tests green; `npm run build:extension` (the content
runtime bundle validates after build).

## Phase 5: Side-panel card (slice S) - US2 panel side

- [x] T1015 [P] [US2] Failing tests in `EXT/tests/session-card-hold.test.tsx` (extension-ui): a session
  with `heldAt` shows "Stopped from the page" and Resume, keeps End session, hides Interrupt; a Resume
  click sends `{ type: "ui.agent.session-resume", payload: { sessionId } }`; activity `hold`/`held` and
  `resume`/`resumed` lines render their labels; the same in `zh-TW`. R-521.
- [x] T1016 [US2] Implement in `EXT/src/side-panel/agent/SessionCard.tsx`,
  `EXT/src/side-panel/agent/AgentShell.tsx` (send the command) and `EXT/src/side-panel/agent-panel-keys.ts`
  (activity labels) until T1015 passes.

**Checkpoint**: `npx vitest run --project extension-ui` green.

## Phase 6: Live stories (slice L) - all stories

- [x] T1017 [US1] [US2] [US3] [US5] `tests/e2e/packaged/agent-pill-stop.spec.ts` (attach mode, as
  `agent-claim.spec.ts` drives a trusted click through CDP): quickstart scenarios 1-11, each a test; a
  screenshot of the pill and of the side-panel card for scenarios 1, 6 and 11 into the run's
  `test-results/<run-id>/`; scenario 7 stops the worker through its CDP target and waits for the
  session's greeting; scenario 10 reloads the extension and presses the pill left on the page. Register a
  fixture page in `tests/harness/page-fixtures.ts` only if no existing one has a clickable counter.
- [x] T1018 Main runs T1017 in the attached test Chromium (`en-US` and `zh-TW`) and records the results
  and screenshot paths in `specs/034-pill-stop/coverage.md`.
- [x] T1019 [US4] Main (or the owner) checks US4 by hand on Windows: a side-panel conversation working in
  a tab, Stop on the pill ends the turn with the usual stopped line, no Resume, the next message can use
  the browser; recorded in `coverage.md`.

## Phase 7: Review, coverage and close

- [x] T1020 `specs/034-pill-stop/coverage.md`: FR-512..525 and SC-225..231 each mapped to tasks and
  tests (Constitution III).
- [x] T1021 `code-reviewer` on slices K + W (R1: trust decision, hold lifecycle); `architecture-reviewer`
  on slice K (agent-facing stop reason). Important findings fixed with their own failing test first.
- [x] T1022 Planned final verification: `npx tsc -b`, `npm run typecheck`, `npm test`, `npm run build`,
  `npm run test:contract`, `npm run snapshot:check`.
- [x] T1023 Owner's look in branded Chrome after reload (SC-231); release is the owner's decision.
  Done 2026-11-16: the owner looked after reloading the main checkout build and approved the release (0.23.0).

## Dependencies

- K (T1002-T1004) before W, P, S.
- W (T1005-T1012), P (T1013-T1014) and S (T1015-T1016) are independent of each other: disjoint files,
  interfaces fixed by K and contracts/pill-messages.md.
- L (T1017-T1019) after W, P and S. Reviews (T1021) after W is complete; final verification (T1022) after
  every fix.

## Parallel execution

- Wave 1: T1002 → T1003 → T1004 (one dispatch).
- Wave 2: W, P, S as three dispatches at once (T1005/T1007/T1008/T1009 tests can be written in any order
  inside W).
- Wave 3: T1017 (one dispatch), then T1018/T1019 by main.

## Implementation strategy

MVP is US1 + US2 + US3 for outside agents (K, W, P, S): the owner can stop from the page, resume, and the
hold survives a restart. US4 (conversation) rides on the same press path in W. US5 (not delivered) is in P.
