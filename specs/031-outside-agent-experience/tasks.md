# Tasks: Outside-Agent Consent and Capture Experience (031)

**Input**: `specs/031-outside-agent-experience/` (spec.md, plan.md, research.md R-450..466, data-model.md,
contracts/, quickstart.md)

**Tests**: required. Project rule: every behaviour change comes with the one focused failing test that
would have caught its absence. Each test task is written first and must fail for the stated reason
before its implementation task starts.

**Slices**: A = US1 + US2 (terminal consent). B = US3 (diagnostics; depends on A). C = US4 + US5 (capture
and debugger; starts with the R-462/R-463 measurement). Risk: R2 for A and B, and R1 (lifecycle) for C.
Each slice ends in a `code-reviewer` gate.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T910 Create the acceptance file `.claude/acceptance/031-outside-agent-experience.json` with one gate per task marked **Gate** below (kinds: machine, live, review, human), sources pointing at spec.md stories and FRs.

---

## Phase 2: Foundational (blocks A and B)

- [x] T911 [P] Contract test: add `prompt-raised`, `prompt-answer`, `prompt-settled` frame cases (valid, an extra field refused, a `choice` outside the enum refused) to `tests/contract/prompt-waiting.contract.test.ts` per `contracts/terminal-consent.md`; run it and confirm it fails because the schemas do not exist.
- [x] T912 Add the three strictObject frame schemas, `terminal-consent` to the worker feature list type, `session: true` and `grantDiagnostics: true` flags on `ui.agent.effect-decide`, and the `diagnostics` card kind in `packages/contracts/src/agent-tools.ts`; rewrite the comment at the effect-decide schema (~4495) to state that only `grantDiagnostics`, and only on a diagnostics question, may set the diagnostics grant (R-461). T911 passes.
- [x] T913 [P] Unit test `apps/extension/tests/session-grant-store.test.ts`: add-only entries; `covers(sessionId, site, kind)` exact origin + kind; another session never covered; `clearSession` and `clearAgent` remove all; survives a fresh store instance over the same fake `chrome.storage.session`.
- [x] T914 Implement `apps/extension/src/service-worker/session-grant-store.ts` per data-model.md "Session grant" (R-456). T913 passes.

---

## Phase 3: User Story 1 - The owner answers in the terminal (P1) — Slice A

**Goal**: an outside agent's consent question is asked in its client and on the card at once; first answer wins; once / session / deny.

**Independent Test**: packaged gate with a scripted elicitation client (T928) plus live check T930.

### Tests first

- [x] T915 [P] [US1] Unit test in `apps/extension/tests/prompts.test.ts`: `decideByCall(callId, choice, "client")` settles the pending question; a later card `decide` for the same prompt logs `agent.prompt.late-answer` and changes nothing; the reverse order (card first, then client) likewise; `onSettled` fires once with `answeredFrom`.
- [x] T916 [P] [US1] Unit test in `apps/extension/tests/agent-effects.test.ts`: allow with `session` writes a `page-actions` grant with `source` for the gate site; the next covered effect on that site in the same session is admitted without a prompt; the same site in another session prompts; `evaluate`, `file_upload`, `upload_image`, forced `navigate` and `tabs_close` still prompt under a grant; `dialog` is admitted (R-457).
- [x] T917 [P] [US1] Unit test in `apps/extension/tests/agent-effects.test.ts`: the `prompt-raised` frame sent on raise carries `choices: ["once","session","deny"]` for covered tools and `["once","deny"]` for the others, and the site and action summary.
- [x] T918 [P] [US1] Host unit test `packages/agent-host/tests/terminal-consent.test.ts` with an SDK client advertising `elicitation: {form:{}}` and one advertising bare `elicitation: {}`: on `prompt-raised` the host sends `elicitation/create` with the `choice` enum; `accept` + valid choice sends `prompt-answer`; `decline`, `cancel`, an invalid choice and a thrown error send nothing; `prompt-settled` aborts the open request; a client without the capability is never asked.
- [x] T919 [P] [US1] Unit test in `packages/agent-host/tests/relay-mux.test.ts`: a worker `prompt-raised` and `prompt-settled` with a callId do not end the call's route (same exception as `prompt-waiting`); a host `prompt-answer` for a session other than the greeting's is refused.

### Implementation

- [x] T920 [US1] In `apps/extension/src/service-worker/agent-tools/prompts.ts`: add `decideByCall`, an `answeredFrom` on outcomes, an `onRaised` / `onSettled` notification, and the `session` remember flag on `decide`. T915 passes.
- [x] T921 [US1] In `apps/extension/src/service-worker/agent-runtime.ts` and `agent-tools/effects.ts`, `dialogs.ts`, `batch.ts`: compute the gate's covered flag as "site plan covers OR page-actions session grant covers" (R-456); on an allow with `session`, add the grant with its source; clear grants on `releaseSession`, unpair and session clear beside the site-plan clears (~899-906, 2159, 3255). T916 passes.
- [x] T922 [US1] In `apps/extension/src/service-worker/agent-bridge.ts` and `agent-runtime.ts`: advertise `terminal-consent` in `pair-result.features`; send `prompt-raised` (choices per R-457) and `prompt-settled`; route an incoming `prompt-answer` to `decideByCall` with `"client"`. T917 passes.
- [x] T923 [US1] In `packages/agent-host/src/relay-mux.ts`: keep a call routable across `prompt-raised` / `prompt-settled`. T919 passes.
- [x] T924 [US1] In `packages/agent-host/src/mcp-server.ts` (new helper module `packages/agent-host/src/terminal-consent.ts`): read the client's elicitation capability (form or bare), on `prompt-raised` send `elicitation/create` through the low-level request API with the result schema, timeout just under `boundMs` and an abort signal tied to `prompt-settled` and to the tool call's end; map the result per R-452 and send `prompt-answer`. T918 passes.
- [x] T925 [US1] In `apps/extension/src/side-panel/agent/PromptCard.tsx` and `SessionCard.tsx` plus locale files `en-US.ts` / `zh-TW.ts` and `side-panel/agent-panel-keys.ts`: add the *This session* button (consent card), and list the session's grants with "from terminal / from Chrome"; extension-ui test in `apps/extension/tests/prompt-card.test.tsx` written first (button sends `session: true`; grant line renders its source).

---

## Phase 4: User Story 2 - A question nobody can see does not expire silently (P1) — Slice A

**Goal**: one 120 s bound, ticks at every raise, badge whenever pending, actionable timeout text; dismissal is never an answer.

**Independent Test**: `prompt-waiting` unit tests + packaged gate branch "client declines".

- [x] T926 [P] [US2] Rewrite expectations first in `apps/extension/tests/prompt-waiting.test.ts`: bound 120 s with a visible panel; ticks start at raise with a visible panel; `deriveAttention` true whenever a prompt is pending regardless of presence (truth table ~225-239); the timed-out answer always carries the new hint text. Confirm the old assertions fail on current code for the stated reason.
- [x] T927 [US2] Implement in `agent-tools/prompts.ts` (merge `ASK_TIMEOUT_MS` into the 120 s bound, ticks always), `agent-runtime.ts` `deriveAttention`, and the sentences in `packages/contracts/src/agent-tools.ts` (`ATTENTION_SENTENCES.consent`, timeout hint, R-455); update `apps/extension/tests/agent-runtime-wiring.test.ts` and `packages/agent-host/tests/prompt-waiting.test.ts` only where they pin the old 25 s rule. T926 passes.
- [x] T928 [US1] [US2] Packaged gate `tests/e2e/packaged/agent-terminal-consent-031.spec.ts` with a scripted elicitation-capable MCP client in `tests/harness/`: branches answer-once, answer-session (next click unasked, second session asked), deny, decline (card still answerable), no capability (card only), card-first (client request aborted), no answer (timed-out after the bound, scaled by `HALLPASS_TEST_TIME_SCALE`). **Gate** (live).
- [x] T929 Slice A review: dispatch `code-reviewer` on the slice A diff with the claim "terminal consent can only grant once/session, first answer wins, dismissal never answers, session grants end with the session (FR-467..475)". **Gate** (review).
- [ ] T930 Owner live checks 1 and 2 from `quickstart.md` (Claude Code and Codex render the question). **Gate** (human). Record any client setting that hides the question in research.md's change log.

**Checkpoint**: Slice A usable on its own (MVP).

---

## Phase 5: User Story 3 - Diagnostics are asked about, not refused (P2) — Slice B (after A)

**Goal**: diagnostics ask through the same channel; once / session / always (card) / deny; re-check site before attaching.

**Independent Test**: `agent-diagnostics-gate.test.ts` + packaged gate T936.

- [x] T931 [P] [US3] Rewrite first in `apps/extension/tests/agent-diagnostics-gate.test.ts`: test ~182 becomes "asks the owner on a site the owner has not granted, and attaches nothing before an answer"; add cases for once (next call asks), session (diagnostics grant, checkbox stays off), always (`grantDiagnostics` sets `diagnosticsGranted`), deny (`diagnostics-not-granted`), a site change while waiting (no attach, refused as `site-changed` or the existing stale answer), and `evaluate` still gated after a diagnostics allow (test ~363 kept). Keep ~419 passing.
- [x] T932 [US3] Implement in `apps/extension/src/service-worker/agent-tools/diagnostics.ts` (replace refusal at ~422-428 with the question, re-check site for all three tools before `ensureAttached`), wiring the `diagnostics` grant kind from `session-grant-store.ts` and `grantDiagnostics` through `agent-panel-port.ts` (~319-333) and `prompts.ts`. T931 passes.
- [x] T933 [P] [US3] Contract test `tests/contract/agent-diagnostics.contract.test.ts`: `grantDiagnostics` accepted only with the diagnostics card kind; refusal vocabulary unchanged.
- [x] T934 [US3] Diagnostics card in `apps/extension/src/side-panel/agent/PromptCard.tsx` (Allow once / This session / Always on this site / Refuse) using the existing `agent.diagnosticsText` / `agent.diagnosticsLabel` keys; extension-ui test in `apps/extension/tests/prompt-card.test.tsx` first.
- [x] T935 [US3] `prompt-raised` for diagnostics carries `kind: "diagnostics"` and choices `once/session/deny`; add the case to T917's test file first, then implement in `agent-bridge.ts` / `diagnostics.ts`.
- [x] T936 [US3] Extend the packaged gate (new spec `tests/e2e/packaged/agent-diagnostics-ask-031.spec.ts`): `read_console` on an ungranted site asks in the scripted client and on the card; session answer lets a second call run unasked. **Gate** (live).
- [x] T937 Slice B review: `code-reviewer` on the slice B diff, claim "a diagnostics answer cannot outlive the session unless given as always in Chrome, nothing attaches before an answer or after a site change, evaluate stays gated (FR-476, FR-477)". **Gate** (review).

---

## Phase 6: User Story 4 - Screenshots work behind other windows (P2) — Slice C

**Goal**: non-activating capture where measured fresh; minimized reported; spec 012 contract unchanged.

**Independent Test**: capture unit tests + live check T946.

- [x] T938 [US4] Measurement (R-462, R-463): a scripted run `tests/harness/capture-freshness-031.ts` on branded Chrome attach mode, 10 runs each for (active tab in a covered window, background tab in a visible window, background tab in a covered window): change the page, capture with `Page.captureScreenshot {fromSurface:true}` without activating, compare. Also: a click and typing into a tab of a minimized window. Write the results into `research.md` (change log under R-462/R-463) and report them to the owner before T939. **Gate** (live).
- [x] T939 [P] [US4] Unit tests first in `apps/extension/tests/capture.test.ts` and `apps/extension/tests/agent-screenshot.test.ts`: for the tab states T938 measured fresh, `decideCapturePath` picks the protocol path and nothing is activated (owner tab unchanged); stale states keep activate-and-restore; protocol attach refused falls back to the current path (R-464); emulated tabs keep no fallback; whole-viewport frame size, density and JPEG ladder assertions (existing ~319-575) unchanged.
- [x] T940 [US4] Implement in `apps/extension/src/chrome-adapters/capture.ts` and `agent-tools/photograph.ts` (path choice by measured state, acquire the attachment for the capture, fallback). T939 passes.
- [x] T941 [P] [US4] Unit test first in `apps/extension/tests/agent-screenshot.test.ts` and `apps/extension/tests/chrome-adapters-windows.test.ts`: a tab in a minimized window answers `window-minimized` with the hint, nothing activated or restored; plus, only if T938 showed effects fail when minimized, an effect answers the same code (`apps/extension/tests/agent-effects.test.ts`).
- [x] T942 [US4] Implement the window-state read in `apps/extension/src/chrome-adapters/windows.ts`, the `window-minimized` code in `packages/contracts/src/agent-tools.ts` (contract case added first in `tests/contract/`), and the check in `photograph.ts` (and in `effects.ts` if T941 requires). T941 passes.
- [x] T943 [P] [US4] Unit test first in `apps/extension/tests/input-attachment.test.ts`: every attach and re-attach sends `Emulation.setFocusEmulationEnabled {enabled:true}`; a failure is logged and does not fail the attach. Implement in the per-attach hook wiring in `apps/extension/src/service-worker/agent-runtime.ts` / `agent-tools/input.ts` (R-465).

---

## Phase 7: User Story 5 - The "being debugged" state does not linger (P3) — Slice C

**Goal**: release after 20 s idle unless recording, viewport or diagnostics holds it.

**Independent Test**: fake-timer unit tests + live check.

- [x] T944 [P] [US5] Unit test first in `apps/extension/tests/input-attachment.test.ts` with fake timers: an effect call holds `inFlight`; 20 s after the count reaches zero with only `input` held, the input holder is dropped (not `release`d: the viewport clear is not run) and the tab detaches; `recording`, `viewport` or `diagnostics` held → no detach; a call during the countdown cancels it; the next call re-attaches and re-runs focus emulation.
- [x] T945 [US5] Implement in `apps/extension/src/service-worker/agent-tools/input.ts` (holder accessor, per-tab in-flight count, idle timer that drops `input`) and the per-call hold in `agent-tools/effects.ts` (~2006, 2224, 2432, 2702), `upload.ts` (~225) and the capture path. Land after slice A's `effects.ts` changes. T944 passes.
- [ ] T946 [US4] [US5] Owner live checks 3, 4 and 5 from `quickstart.md`. **Gate** (human).
- [x] T947 Slice C review: `code-reviewer` on the slice C diff, claim "attach/detach lifecycle: idle drop never clears an emulation, never races an in-flight call, lifetime holders keep the attachment; capture keeps the spec 012 contract (FR-478..482)". **Gate** (review).

---

## Phase 8: Polish & Cross-Cutting

- [x] T948 [P] Update tool descriptions in `packages/contracts/src/agent-tools.ts` (screenshot: no fronting where measured, `window-minimized`; consent: may be asked in the client; diagnostics: asks instead of refusing), the `hallpass` skill text if it describes the 25 s bound or the diagnostics checkbox, and `README.md`'s consent section.
- [x] T949 [P] Add `specs/031-outside-agent-experience/coverage.md` mapping FR-467..483 and SC-208..213 to tasks and tests.
- [x] T950 Final verification: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:contract`, `npm run snapshot:check`. **Gate** (machine).

---

## Dependencies

- T910 → everything. T911-T914 (foundation) → Slice A and B.
- Slice A: T915-T919 (tests, parallel) → T920 → T921, T922 → T923, T924 → T925; T926 → T927; T928 after T920-T927; T929, T930 after T928.
- Slice B: after T929 (reviewed A). T931 → T932 → T934, T935; T933 parallel; T936 → T937.
- Slice C: T938 first (measurement) → T939-T943; T944 → T945 (after A's `effects.ts` edits are merged); T946, T947 last.
- Slice C's T938-T943 may run in parallel with Slice A (different files), within the two-writer budget.

## Parallel examples

- Foundation: T911 and T913 together.
- Slice A tests: T915, T916/T917 (same file - one writer), T918, T919 together.
- Cross-slice: Slice A implementation (owner of `prompts.ts`, `effects.ts`, host) alongside Slice C T938-T943 (owner of `capture.ts`, `photograph.ts`, `windows.ts`, `input.ts`).

## Implementation strategy

MVP = Phase 1-4 (Slice A): it fixes the owner's biggest complaint on its own. Then Slice C (independent
value, runs partly in parallel), then Slice B. Each slice ends at its review gate. Release, version bump
and public push are separate `human` gates the owner authorises after T950.
