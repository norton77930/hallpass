---

description: "Task list for Reference Parity — First Increment"
---

# Tasks: Reference Parity — First Increment

**Input**: Design documents from `/specs/002-reference-parity/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/README.md), [quickstart.md](./quickstart.md)

**Tests**: **Required.** This repository's working rules mandate a focused failing test before every
behaviour change (`specs/001-ai-browser-assistant/fixes/00-index.md` §1.3), and constitution Article VII
requires observable acceptance criteria. Every behaviour task below is preceded by its red test.

**Organization**: Tasks are grouped by user story so each can be implemented, tested, and delivered on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel — different files, no dependency on an incomplete task
- **[Story]**: US1–US6, mapping to the user stories in spec.md
- Every task names the exact file it touches

## Path Conventions

This is an npm workspace with an extension and a service. Real paths:

- `packages/contracts/src/` — closed schemas at every trust boundary
- `packages/domain/src/` — pure decision logic, no I/O
- `apps/extension/src/service-worker/` — admission, dispatch, fence, markers
- `apps/extension/src/content-runtime/` — effect delivery and verification
- `apps/extension/src/side-panel/` — review UI
- `apps/server/src/` — deterministic service, test journeys only
- `tests/contract/`, `tests/e2e/packaged/`, `apps/extension/tests/`, `apps/server/tests/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish a known-green baseline and the bounded configuration values three stories need.

> **Read before starting.** This task list was written before the 001 fix plan's WP8–WP10 landed, and WP8
> moved the ground these tasks stand on. Every protocol limit now lives in one `ProtocolBounds` object in
> `packages/contracts/src/bounds.ts`, validated by `createBounds`; the per-action argument shapes live once
> in `packages/contracts/src/action-arguments.ts` and are built by **both** boundaries, so whatever the task
> channel refuses the content runtime refuses identically; and `task-channel.ts` / `extension-runtime.ts`
> are now `create…Schemas(bounds)` factories with module-level default instances. Adding a limit or an
> argument shape anywhere else would re-split exactly what WP8 unified. The tasks below name the real
> homes; if a task still reads as though a value belongs somewhere else, the task is wrong, not the code.

- [X] T001 Run the exit checklist from `specs/001-ai-browser-assistant/fixes/00-index.md` §6 and record the counts, so any later red test is attributable to this feature rather than to pre-existing state
- [X] T002 [P] Add a contract test pinning the three bounded configuration values this feature adds — maximum request-sequence length, maximum wait duration, maximum resolution candidates — and asserting `createBounds` still refuses each of them when it is not a positive integer, in `tests/contract/task-channel.contract.test.ts` beside the existing bounds coverage
- [X] T003 Add those three values to `ProtocolBounds` and `DEFAULT_BOUNDS` in `packages/contracts/src/bounds.ts`, each with a comment stating it is a protocol constant recorded as a product decision rather than a tuning knob (the wording WP8 settled on)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The refusal path and the risk-classification seam that every added capability depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 [P] Add a failing contract test asserting that a capability request naming a capability outside the profile is refused with an explicit unsupported-capability result and no effect, in `tests/contract/task-channel.contract.test.ts`
- [X] T005 Implement the shared unsupported-capability refusal in `apps/extension/src/service-worker/control-port.ts`, so every capability added later inherits one refusal path rather than adding its own. **Check first**: `dispatchAllowedAction` already refuses a capability outside the three actions with `status: "unsupported"`, and `ERROR_CODES` already carries `capability.unsupported`. If the path exists, this task is the test that pins it, not a second implementation
- [X] T006 [P] Add a failing unit test asserting that `classifyActionRisk` reports `unclassified` for any capability it does not recognise, in `apps/extension/tests/action-lifecycle.test.ts`
- [X] T007 Widen the `classifyActionRisk` input type in `packages/domain/src/action-policy.ts` to accept the added capabilities, defaulting every unrecognised one to `unclassified`
- [X] T008 Add the shared reason codes this feature introduces to both locale catalogues, `apps/extension/src/locales/en-US.ts` and `apps/extension/src/locales/zh-TW.ts`, and extend `tests/contract/locales.contract.test.ts` to pin them in both — **no-op for this phase**: the shared refusal reuses the existing `unsupported` code, so Phase 2 introduced no new copy. Each story adds its own codes (T023, T039, T051, T062, T073, T083), and `locales.contract.test.ts` already fails on any key present in one catalogue and not the other

**Checkpoint**: refusal path and risk seam exist — user stories can begin.

---

## Phase 3: User Story 1 — Remove one step from a proposed plan (Priority: P1) 🎯 MVP

**Requirements**: FR-020, FR-021 · **Success criteria**: SC-014, SC-019

**Goal**: A user can exclude individual steps from a proposed plan and approve the remainder, and an excluded
step can never execute.

**Independent Test**: Propose a five-step plan, exclude step three, approve. Steps one and two are observed;
step three is never dispatched and no marker is ever written for it; the terminal outcome names the exclusion.

### Tests for User Story 1

> Write these first and confirm each fails before implementing.

- [X] T009 [P] [US1] Contract test: the plan decision payload accepts an exclusion set, rejects an unknown step identifier, and rejects duplicates, in `tests/contract/task-channel.contract.test.ts`
- [X] T010 [P] [US1] Contract test: the terminal payload accepts an optional excluded-step reference, in `tests/contract/task-channel.contract.test.ts`
- [X] T011 [P] [US1] Contract test: the panel plan-review projection carries per-step exclusion state, in `tests/contract/extension-runtime.contract.test.ts`
- [X] T012 [P] [US1] Unit test: approving with every step excluded is recorded as a denial, in `apps/extension/tests/control-port-task.test.ts`
- [X] T013 [P] [US1] Unit test: a request naming an excluded step is refused and recorded as a user denial, not a failure, in `apps/extension/tests/control-port-task.test.ts`
- [X] T014 [P] [US1] Unit test: a step whose predecessor was excluded fails its own target revalidation and stops the run, and the terminal outcome names the exclusion, in `apps/extension/tests/control-port-task.test.ts`
- [X] T015 [P] [US1] Panel test: excluding a step and approving sends a decision carrying exactly that exclusion, in `apps/extension/tests/side-panel-task.test.tsx`
- [X] T015a [P] [US1] **SC-019 regression**: a plan review still names, for every step, the element that step will act on — `targetLabel`, `targetRole` and the local risk, which WP2 already projects. Excluding a step must not remove that from the remaining ones. Without it, the exclusion control is added to the one surface whose whole purpose is telling the user what each step will touch, and nothing checks it survives. In `apps/extension/tests/side-panel-task.test.tsx`

### Implementation for User Story 1

- [X] T016 [US1] Add the exclusion set to the plan decision payload and the optional excluded-step reference to the terminal payload in `packages/contracts/src/task-channel.ts`
- [X] T017 [US1] Add per-step exclusion state to the plan-review projection inside `createExtensionRuntimeSchemas` in `packages/contracts/src/extension-runtime.ts`. Leave `worker.context.state` alone: WP8 put the last read's `truncation` and `withheld` there, and both are replayed on panel takeover — extend that payload only if this story genuinely needs to, and never by replacing it
- [X] T018 [US1] Record per-step approval state on the plan in `packages/domain/src/task-plan.ts`, deriving it from the decision rather than from anything the service authors
- [X] T019 [US1] Treat an all-steps exclusion as a denial in `apps/extension/src/service-worker/task-mode-controller.ts`
- [X] T020 [US1] Refuse any admission naming an excluded step in `apps/extension/src/service-worker/task-mode-controller.ts`, returning a user denial distinct from a failure
- [X] T021 [US1] Carry the excluded-step reference into the terminal outcome in `apps/extension/src/service-worker/control-port.ts`
- [X] T022 [US1] Add per-step exclusion controls to plan review in `apps/extension/src/side-panel/PlanReview.tsx` and the decision it returns in `apps/extension/src/side-panel/workspace-controller.ts`
- [X] T023 [P] [US1] Add the exclusion labels to both locale catalogues in `apps/extension/src/locales/en-US.ts` and `apps/extension/src/locales/zh-TW.ts`
- [X] T024 [US1] Extend the deterministic plan journey to propose a plan whose third step is excluded, in `packages/test-kit/src/ai-adapter.ts`
- [X] T025 [US1] Packaged journey: exclude a step, approve, and assert the excluded step never runs, in `tests/e2e/packaged/task-mode.spec.ts`

**Checkpoint**: plan review is usable on its own — a user can correct a plan instead of discarding it.

---

## Phase 4: User Story 2 — Run an approved plan without stopping between every step (Priority: P1)

**Requirements**: FR-022, FR-023 · **Success criteria**: SC-013, SC-017

**Goal**: An approved plan executes in one exchange with the service, with every step still individually
admitted, fenced, marked, dispatched, and verified.

**Independent Test**: Approve a five-step plan; one request-carrying frame is exchanged, not five; the marker
sequence shows a prepared/dispatched/observed cycle per step; no two markers are dispatched simultaneously.

**Depends on**: User Story 1. This is a product decision from the spec, not a technical one — an approval that
covers a whole run must be correctable before it is allowed to cover a whole run.

### Tests for User Story 2

- [X] T026 [P] [US2] Contract test: a frame may carry an ordered request sequence, bounded by the maximum length, in `tests/contract/task-channel.contract.test.ts`
- [X] T027 [P] [US2] Contract test: a sequence containing a request that is not plan-bound is invalid, in `tests/contract/task-channel.contract.test.ts`
- [X] T028 [P] [US2] Unit test: every step of a sequence is admitted, fenced, marked, and verified individually; no two markers are dispatched at once, in `apps/extension/tests/control-port-task.test.ts`
- [X] T029 [P] [US2] Unit test: the first step whose effect cannot be verified stops the run and later steps are never prepared, in `apps/extension/tests/control-port-task.test.ts`
- [X] T030 [P] [US2] Unit test: Stop mid-run dispatches nothing further and reports an already-dispatched step as uncertain, in `apps/extension/tests/control-port-stop-delivery.test.ts`
- [X] T031 [P] [US2] Unit test: a bound-document change mid-run stops the run, in `apps/extension/tests/control-port-content-lifecycle.test.ts`
- [X] T032 [P] [US2] Unit test: a sequence that is not bound to an approved plan is refused whole, before any step runs, in `apps/extension/tests/control-port-task.test.ts`
- [X] T033 [P] [US2] Unit test: a worker restart mid-run recovers the markers and reports the interrupted step as uncertain, in `apps/extension/tests/marker-restart-recovery.test.ts`

### Implementation for User Story 2

- [X] T034 [US2] Add the ordered request sequence to the channel envelope inside `createTaskChannelSchemas` in `packages/contracts/src/task-channel.ts`, bounded by `bounds.maxRequestSequenceLength` — read from the injected bounds like every other limit, never a literal
- [X] T035 [US2] Add run position and stop-reason state in `packages/domain/src/task-state.ts`, with no execution semantics of its own
- [X] T036 [US2] Admit a sequence only when every request binds to a step of the same approved plan, refusing the whole sequence otherwise, in `apps/extension/src/service-worker/task-mode-controller.ts`
- [X] T037 [US2] Execute a sequence one step at a time through the existing single-step path in `apps/extension/src/service-worker/control-port.ts`, stopping at the first step that cannot be admitted or verified
- [X] T038 [US2] Report the stop position and reason in the terminal outcome in `apps/extension/src/service-worker/control-port.ts`
- [X] T039 [P] [US2] Add the run stop-reason labels to both locale catalogues in `apps/extension/src/locales/en-US.ts` and `apps/extension/src/locales/zh-TW.ts`
- [X] T040 [US2] Emit a request sequence from the deterministic service journey in `packages/test-kit/src/ai-adapter.ts`
- [X] T041 [US2] Packaged journey: an approved plan runs in one exchange and stops cleanly on an unverified step, in `tests/e2e/packaged/effect-verification.spec.ts`
- [X] T041a [US2] **SC-013 measurement**: a packaged journey that runs a ten-step approved plan against a form fixture and counts the points at which the panel waits for the user. It must be exactly two — the safety disclosure and the plan review — and no step may open a card of its own. This is the number the whole feature is justified by, and until something counts it, "at most twice" is an intention rather than a result. In `tests/e2e/packaged/task-mode.spec.ts`, with the ten-step plan added to `packages/test-kit/src/ai-adapter.ts`

> **T041a result (2026-09-05)**: measured **three** waits before a ten-step run, not two — the safety
> disclosure, the page-read consent (001/FR-004, a separate card with its own decision, which the task text
> above omits), and the plan review — and **zero** during it. SC-013's wording ("once to review the plan, and
> at most once more for an action the product cannot classify") counts neither the disclosure nor the
> consent, both of which are constitutional guarantees this feature may not remove. The test asserts the
> measured number and states why; whether SC-013's text is amended is the product owner's decision.

**Checkpoint**: the felt cost of a multi-step task drops without any guarantee being traded away.

---

## Phase 5: User Story 3 — Use the keyboard (Priority: P2)

**Requirements**: FR-024, FR-028, FR-029 · **Success criteria**: SC-015

**Goal**: The assistant can press the keys in a bounded named set, and is refused for any key whose effect on
the focused element would be a form submission or a navigation.

**Independent Test**: A task that enters two tags into a tag field, committing each with the confirmation key
and moving on with the tab key, completes; the same key in a search form is refused.

### Tests for User Story 3

- [X] T042 [P] [US3] Contract test: the key-press request and result shapes are closed, and a key outside the named set is invalid, in `tests/contract/task-channel.contract.test.ts`
- [X] T043 [P] [US3] Unit test: the submission guard refuses the confirmation key where its default effect would submit a form or navigate, and refuses when that cannot be established, in `packages/domain/src/action-policy.test.ts` (placed with the policy it tests; originally named `apps/extension/tests/action-entry.test.ts`)
- [X] T044 [P] [US3] Unit test: a key press directed at a sensitive field is refused, in `packages/domain/src/action-policy.test.ts` (same placement)
- [X] T045 [P] [US3] Unit test: `classifyActionRisk` reports `activation` for a key press, in `packages/domain/src/action-policy.test.ts` (same placement; originally named `apps/extension/tests/action-lifecycle.test.ts`)
- [X] T046 [P] [US3] Content-runtime test: a delivered key press is verified by the focused element retaining its identity, in `apps/extension/tests/content-runtime-effect-policy.test.ts`

### Implementation for User Story 3

- [X] T047 [US3] Add the key-press capability to `packages/contracts/src/capabilities.ts`, its closed argument shape and the named key set to `createActionArgumentSchemas` in `packages/contracts/src/action-arguments.ts` (so the runtime boundary inherits it through `executeActionPayloadSchema` without a second definition), and its closed result shape to the action result union in `packages/contracts/src/task-channel.ts`
- [X] T048 [US3] Implement the submission-and-navigation guard in `packages/domain/src/action-policy.ts`, failing closed where the effect cannot be established
- [X] T049 [US3] Add the key-press risk case in `packages/domain/src/action-policy.ts`
- [X] T050 [US3] Deliver and verify a key press in `apps/extension/src/content-runtime/actions.ts`
- [X] T051 [P] [US3] Add the key-press consent and refusal labels to both locale catalogues in `apps/extension/src/locales/en-US.ts` and `apps/extension/src/locales/zh-TW.ts`
- [X] T052 [US3] Add a tag-field and a search-form fixture in `tests/harness/page-fixtures.ts`
- [X] T053 [US3] Packaged journey: commit two tags with the keyboard, and confirm the same key is refused in the search form, in `tests/e2e/packaged/task-mode.spec.ts`

**Checkpoint**: the assistant can finish operating a control instead of stalling on it.

---

### Before User Story 4 (from the User Story 3 review)

- [X] T053a Replace the literal action union (`"browser.scroll" | "browser.click" | "browser.enter-text" | "browser.key-press"`, about sixteen sites across `apps/extension/src/service-worker/control-port.ts`, `content-broker.ts`, `action-dispatcher.ts`, `task-mode-controller.ts`, `apps/extension/src/side-panel/workspace-controller.ts`, `apps/extension/src/content-runtime/actions.ts`, `packages/test-kit/src/ai-adapter.ts`) with `BridgeAction` from `packages/contracts/src/capabilities.ts`, one `isBridgeAction()` predicate in place of the four hand-written chains, and exhaustive switches in `executeOnActiveTab` (`content-broker.ts`), `verifiedResult` (`control-port.ts`) and `executeAction` (`content-runtime/actions.ts`) so a member added in one place cannot fall through another's text-entry default; `classifyActionRisk`'s deliberate `capability: string` parameter in `packages/domain/src/action-policy.ts` is exempt. No behaviour change; the existing suite is the verification. User Story 4 adds three members and must not widen the literal union again.
- [X] T053b Close the content runtime's reply-reason vocabulary: today `apps/extension/src/content-runtime/actions.ts` (`denied`, `submission-guard`, `unsupported-key`, `stale-target`, `missing-target`, `missing-sink`) and `RUNTIME_POLICY_REFUSALS` in `apps/extension/src/service-worker/control-port.ts` agree by text only, and the broker passes any bounded string through as the task-channel `errorCode`. Define the reason enum in `packages/contracts/src/extension-runtime.ts` beside `executeActionPayloadSchema`, import it in both bundles, and have `executeOnActiveTab` in `content-broker.ts` refuse an unknown reason as `content.invalid-result`; the `denied`/`failed` decision stays in the worker. User Story 4 adds reasons and must add them there.
- [X] T053c Pin what a `focus-lost` result leaves standing (002 US3 review, test debt): through the channel-handler seam in `apps/extension/tests/control-port-capability-delivery.test.ts`, approve a plan whose second step is a key press, answer it with `focusRetained: false` and an intact re-probe, then send the third step and assert it is refused `plan.run-ended` (not `plan.expired`) and that a page read is still admitted and succeeds; the mirror case with a changed re-probe must be `plan.expired`. (Done 2026-09-05: the binding itself is unobservable once the run has ended, because every later action step is refused before the binding is consulted, so the test pins the refusal code and the read.)

## Phase 6: User Story 4 — Use the remaining pointer gestures (Priority: P2)

**Requirements**: FR-025, FR-028, FR-029

**Goal**: Double activation, hover, and drag, each restricted to targets the existing classification accepts.
Secondary activation is refused.

**Independent Test**: A task reveals a hover menu and activates an item within it; a drag with one
unclassifiable endpoint is refused; a secondary-activation request is refused.

### Tests for User Story 4

- [X] T054 [P] [US4] Contract test: the three gesture request and result shapes are closed, and secondary activation is not expressible, in `tests/contract/task-channel.contract.test.ts`
- [X] T055 [P] [US4] Unit test: a drag classifies both endpoints and the stricter decides; an unclassifiable endpoint refuses the request, in `packages/domain/src/action-policy.test.ts` (`classifyDrag`; placed with the policy it tests — the task named `apps/extension/tests/action-executor.test.ts`) and, on the live element, in `apps/extension/tests/content-runtime-effect-policy.test.ts`
- [X] T056 [P] [US4] Unit test: hover reports `view-only`, double activation and drag report `activation`, in `packages/domain/src/action-policy.test.ts` (same placement; the task named `apps/extension/tests/action-lifecycle.test.ts`)
- [X] T057 [P] [US4] Unit test: a drag whose document changes mid-gesture reports uncertain, never succeeded, in `apps/extension/tests/content-runtime-effect-policy.test.ts` (the runtime ends the gesture before the drop and reports the change) and `apps/extension/tests/control-port-task.test.ts` (the worker never transmits success for it)
- [X] T058 [P] [US4] Unit test: a secondary-activation request is refused with an unsupported-capability result, in `apps/extension/tests/control-port-capability-delivery.test.ts` (through the channel-handler seam) and `tests/contract/task-channel.contract.test.ts` (not expressible under any name)

### Implementation for User Story 4

- [X] T059 [US4] (after T053a and T053b) Add the double-activation, hover, and drag capabilities to `packages/contracts/src/capabilities.ts`, their closed argument shapes to `createActionArgumentSchemas` in `packages/contracts/src/action-arguments.ts`, and their closed result shapes to the action result union in `packages/contracts/src/task-channel.ts`
- [X] T060 [US4] Add the three risk cases and the two-endpoint drag rule in `packages/domain/src/action-policy.ts`
- [X] T061 [US4] Deliver and verify the three gestures in `apps/extension/src/content-runtime/actions.ts`, reporting uncertain when the document changes mid-gesture
- [X] T062 [P] [US4] Add the gesture consent labels to both locale catalogues in `apps/extension/src/locales/en-US.ts` and `apps/extension/src/locales/zh-TW.ts`
- [X] T063 [US4] Add a hover-menu and a reorderable-list fixture in `tests/harness/page-fixtures.ts`
- [X] T064 [US4] Packaged journey: reveal a hover menu and activate an item within it, in `tests/e2e/packaged/task-mode.spec.ts` (with the other 002 journeys; the task named `tests/e2e/packaged/us3-controlled-actions.spec.ts`, which does not exist)

**Checkpoint**: interfaces that need a gesture beyond a click are reachable.

**Result note (2026-09-05)**: all eleven tasks complete. Capability names are `browser.hover`, `browser.double-click`,
`browser.drag`; drag arguments are `targetHandle` + `dropTargetHandle`. Synthetic events cannot make CSS `:hover`
match, so only script-driven hover menus open (recorded in data-model.md, R-026 and README §1.2); the packaged
journey's fixture (`/gestures`) opens its menu through its own `pointerenter`/`mouseenter` handlers. A drag is
delivered as the HTML drag-and-drop sequence only, and a drop only where the page cancelled `dragover`. The review
round added the drop target's label and role to both review projections. T058's "explicit unsupported-capability
result" holds at the worker's admission seam; over the real channel the frame is refused (`invalid-frame`) before
any handler - pinned in `apps/extension/tests/task-channel-lifecycle.test.ts`.

### Before Polish (from the User Story 5 review)

- [X] T074a Make description matching a language policy rather than an English habit: move `NOISE_WORDS`, `ROLE_WORDS`, `ANY_ROLE_WORDS` and the whole-word matcher out of `apps/extension/src/content-runtime/targets.ts` into `packages/domain` as a pure `matchDescription(description, { role, label, text })` (the runtime keeps liveness and the bound loop); add a segmenting tokenizer for descriptions written without spaces and a zh-TW role vocabulary; drop the noise-word edge where a control whose whole label is "type"/"press"/"click" is unreachable; add a zh-TW resolution journey to the packaged gate. Owner decision recorded in `clarifications.md` ("Deviations found during User Story 5").
  **Result note (2026-09-07)**: `matchDescription` lives in `packages/domain/src/description-matching.ts` (pure; the runtime keeps liveness, the loop and the bound). Latin text keeps the whole-word rule; text without word breaks is segmented with `Intl.Segmenter` and a phrase (bare, or the remainder after a zh-TW kind word) names a label only where it occurs with both ends on the label's segment boundaries — one rule, no heuristics; siblings that share a base word are answered too-broad at the bound; an ICU-glued description is not noise-stripped (no-match); a host without a segmenter falls back to containment. zh-TW noise/role vocabularies added; a control whose whole label is a noise word is reachable. New `localized` fixture and a zh-TW-only packaged journey (`task-mode.spec.ts`, skipped under en-US, so the en-US gate reports one skipped). Reviewed by code-reviewer: two fix rounds, final re-review clean. The 2026-09-05 US5 note's "a CJK description must contain the label verbatim" is superseded by this.

### Before User Story 6 (from the User Story 4 review)

- [X] T064a Make the uncertain-cause codes a contract value: `EffectVerdict` in `apps/extension/src/service-worker/control-port.ts` (`document-changed`, `focus-lost`, `target-not-visible`, `not-moved`) travels on the task channel as a free `errorCode` string. Define the closed set in `packages/contracts` beside the result statuses, type the worker's verdict from it, and pin it in the contract tests; User Story 6's wait outcomes (`bound reached`, `stopped`, `document changed`) are its cousins and must be defined alongside, not as a second vocabulary. In the same pass, type `PageExecutor.reason` in `control-port.ts` from the broker's `ContentExecutionRefusalReason | BrokerRefusalReason` union so the compiler checks `RUNTIME_POLICY_REFUSALS` against it and the unreachable `?? "execute-failed"` fallback can go. User Story 5 added the free codes `consent-required`, `invalid-arguments`, `resolver-missing`, `resolution-failed`, and answers a missing binding with `status: "stale-context"` where the action and page-read paths answer `failed` + `errorCode: "stale-context"` (`runStopReasonFor` keys on both) - unify in the same pass.
  **Result note (2026-09-07)**: closed set is `ATTENTION_REQUIRED_CAUSES` (document-changed, focus-lost, target-not-visible, not-moved, execute-uncertain, grant-revoked - the last because a verified effect whose covering grant was revoked before its result is told to the user as something that happened) with `WAIT_END_REASONS` (bound-reached, stopped, document-changed) beside it; the wire refines `attention-required` to that set only. The worker's page ports moved to `apps/extension/src/service-worker/page-ports.ts` (`PageExecutionOutcome` refusal arm carries `reachedPage`; `PageRefusalReason` replaces the broker-owned `BrokerRefusalReason`); `EffectVerdict` derives from a worker-side `POST_EFFECT_VERDICTS` inclusion list. Every "not the page in front of the user" answer on the action paths is `status: "stale-context"` (three pre-admission drift sites, the executor's `stale-context`/`stale-binding`, the dispatch-time missing binding). Both follow-ups its review raised (the page-read collect refused as stale, the throw-side vocabulary) were closed by T064b.
- [X] T064b Close the class of bug the US4 review found on the action card: `apps/extension/src/side-panel/TaskWorkspace.tsx` re-lists the consent projection's fields by hand when mounting `ConsentReview`, so a field added to `PendingConsent` (as `dropTargetLabel`/`dropTargetRole` were) can be silently dropped; the plan card is passed its projection whole and never had the bug. Either spread the consent projection whole (`ConsentReview` reads only its declared props; the extra keys are inert) or type the card's data props as `Pick<PendingConsent, …>` so a new projection field is a compile error at the card. Also type `dropTargetPairing`'s input in `packages/contracts/src/extension-runtime.ts` instead of the `unknown` cast, so a renamed `action`/`capability` key cannot turn the refinement into a no-op unnoticed (the contract tests would catch it today). User Story 5 added to the same class: `resolvedFrom` is hand-forwarded in `TaskWorkspace.tsx`; `contentFrame`'s `type` union in `content-broker.ts` is widened by hand instead of derived from the contract's message discriminant; the resolution reply type is declared three times (`targets.ts`, `content-broker.ts`, `control-port.ts`) and the notice type twice (`control-port.ts`, `workspace-controller.ts`) against shapes the contract owns; the runtime returns `role`/`label` per candidate that the broker validates and the worker discards - return handles only, or move matching into the worker over `pageTargets` and ask the runtime only for liveness. The packaged driver should read the terminal `reasonCode` when it sees `copy.failed`, so an interruption (`haltTask`) is distinguishable from a page failure - the one non-reproducible en-US failure of 2026-09-05 could not be classified without it. From the US5 re-review: `forgetPageTargets()` in `control-port.ts` strips the resolution notice from worker state but does not re-project it, so after a general-grant revocation or a document change (neither handler projects context) the strip keeps a stale notice until the next projection - re-project when a notice was actually stripped and the task is live; fold `pageBindings.clear()` into the same helper (the pair is still five hand-written copies); the integrity refusal of an unknown resolution handle (`resolution-failed`) should emit `reportDiagnostic` and its test should also fence that no `resolution` notice was projected and that a later action on that handle carries no `resolvedFrom`.
  **Result note (2026-09-07)**: `ConsentReview` props derive from `PendingConsent` through a mapped-record fence (a new projection field is a compile error until shown or explicitly omitted); `dropTargetPairing` is typed from the schemas it refines; `contentResolutionReplySchema`/`ContentResolutionReply`/`ResolutionNotice`/`WorkerPlanStep`/`WorkerContextState` are declared once in `@hallpass/contracts` and imported by runtime, broker, ports, worker and panel; the runtime returns handles only and the worker re-projects role/label/kind from the metadata it minted; `forgetPage(reason)` owns bindings, targets, resolved descriptions and the strip notice and re-projects exactly once while the task is live; the unknown-handle refusal reports `control.resolution-unknown-handle`; the terminal carries `data-reason-code` and the packaged driver reads it; a page-read collect refused as stale answers `stale-context`; the throw-side failure vocabulary (`PageFailureCode`, `pageFailure`, `pageOutcomeCode`) lives in `page-ports.ts`. Follow-ups (not blocking): `mintChannelNonce` is still imported by `control-port.ts` from the default backend; the broker still throws bare `Error("no-active-tab")`/`Error("unsupported-page")` that the port classifies by message; `PendingConsent` remains a hand-flattened union of `workerConsentPayloadSchema`. Owner items recorded in `clarifications.md` ("Deviations found during T064a/T064b").

---

## Phase 7: User Story 5 — Point at something by describing it (Priority: P3)

**Requirements**: FR-026 · **Success criteria**: SC-019

**Goal**: A description resolves to one target, an explicit no-match, or an explicit too-broad result, using
only the metadata a review card already displays.

**Independent Test**: A description matching one element resolves and the review names it; a description
matching nothing returns no-match; a description matching more than the bound returns too-broad.

### Tests for User Story 5

- [X] T065 [P] [US5] Contract test: the resolution result is one of exactly three outcomes and carries only review-card metadata, in `tests/contract/task-channel.contract.test.ts`
- [X] T066 [P] [US5] Privacy test: no form value appears in a resolution response under any input, in `tests/contract/privacy-boundary.contract.test.ts`
- [X] T067 [P] [US5] Unit test: more candidates than the bound produces too-broad rather than a truncated list or a silent choice, in `apps/extension/tests/targets.test.ts`
- [X] T068 [P] [US5] Panel test: a resolved target is named in the review before any action uses it, in `apps/extension/tests/side-panel-task.test.tsx` (the card) and `apps/extension/tests/side-panel-control.test.tsx` (the context strip, through `TaskWorkspace`)

### Implementation for User Story 5

- [X] T069 [US5] Add the resolution request and its three-outcome result shape inside `createTaskChannelSchemas` in `packages/contracts/src/task-channel.ts`, with the candidate bound read from the injected bounds. Resolution is a read, not an action, so it does not join `action-arguments.ts`
- [X] T070 [US5] Resolve a description against the bound document in `apps/extension/src/content-runtime/targets.ts`, capped at the bound and returning only review-card metadata
- [X] T071 [US5] Carry the resolved element into the review projection in `apps/extension/src/service-worker/control-port.ts`, alongside the existing `truncation` / `withheld` context projection rather than in place of it
- [X] T072 [US5] Display the resolved element in `apps/extension/src/side-panel/ConsentReview.tsx` and `apps/extension/src/side-panel/PlanReview.tsx`
- [X] T073 [P] [US5] Add the resolution outcome labels to both locale catalogues in `apps/extension/src/locales/en-US.ts` and `apps/extension/src/locales/zh-TW.ts`
- [X] T074 [US5] Packaged journey: resolve a description, see it named in the review, and act on it, in `tests/e2e/packaged/task-mode.spec.ts` (with the other 002 journeys; the named file does not exist)

**Checkpoint**: a plan step can say what it means, and the user can see what it resolved to.

**Result note (2026-09-05)**: all ten tasks complete. The capability is `page.resolve` (a read: page-read binding,
`expectedContext` required, `arguments: { description }` bounded like a label); the runtime message is
`content.resolve-target`; the result is `resolved` with one to `maxResolutionCandidates` candidates, `no-match`, or
`too-broad`. Candidates are re-projected by the worker from the target metadata it minted at collection (a handle
it never minted is dropped), each carrying only handle, role, label, kind. The card of the action that later uses
a resolved handle shows `resolvedFrom`; the context strip shows the last resolution. Matching is word-based on the
label, a button's text and a small role vocabulary; a CJK description must contain the label verbatim (recorded in
R-025). Resolution opens no card and needs the general page-read grant already held.

---

## Phase 8: User Story 6 — Wait for something to happen (Priority: P3)

**Requirements**: FR-027, FR-028 · **Success criteria**: SC-016

**Goal**: A run can wait for an observable condition on a target it already holds, bounded by a maximum.

**Independent Test**: A wait for an element to appear proceeds as soon as it appears; a wait whose condition
never holds ends at its bound with an outcome naming the unmet condition.

### Tests for User Story 6

- [X] T075 [P] [US6] Contract test: a wait names one of the four condition kinds against a held target, and an arbitrary selector or expression is not expressible, in `tests/contract/task-channel.contract.test.ts`
- [X] T076 [P] [US6] Unit test: a wait naming a target the worker does not hold is refused, in `apps/extension/tests/control-port-capability-delivery.test.ts`
- [X] T077 [P] [US6] Unit test: reaching the bound ends the wait with an outcome naming the unmet condition, in `apps/extension/tests/control-port-capability-delivery.test.ts`
- [X] T078 [P] [US6] Unit test: Stop or a document change ends a wait immediately and the dependent step does not run, in `apps/extension/tests/control-port-content-lifecycle.test.ts`
- [X] T079 [P] [US6] Unit test: a wait carries no risk label and produces no consent card, in `apps/extension/tests/control-port-task.test.ts` (plan projection) and `apps/extension/tests/side-panel-task.test.tsx` (card) — `action-lifecycle.test.ts` is the pure dispatch-fence seam a wait never reaches, so an assertion there would be vacuous

### Implementation for User Story 6

- [X] T080 [US6] Add the wait instruction with its four condition kinds inside `createTaskChannelSchemas` in `packages/contracts/src/task-channel.ts`, its duration bound read from the injected bounds. A wait is a control instruction, not an action, so it does not join `action-arguments.ts` and carries no result shape in the action union
- [X] T081 [US6] Evaluate wait conditions locally against a held target in `apps/extension/src/content-runtime/targets.ts`
- [X] T082 [US6] Drive the wait lifecycle and its four end conditions in `apps/extension/src/service-worker/control-port.ts`, without treating a wait as an action
- [X] T083 [P] [US6] Add the wait outcome labels to both locale catalogues in `apps/extension/src/locales/en-US.ts` and `apps/extension/src/locales/zh-TW.ts`
- [X] T084 [US6] Packaged journey: a run waits for a result to appear and proceeds, in `tests/e2e/packaged/effect-verification.spec.ts`

**Result note (2026-09-07)**: all ten tasks complete; reviewed by code-reviewer and architecture-reviewer, one fix round, re-review clean. `page.wait` is the tenth capability: a plan-step-only control instruction (`approved-plan-step` binding, `expectedContext`, `arguments: { targetHandle, condition, maxWaitMs }`, `dataCategories` exactly `["page.target-metadata"]`, admitted through the same plan-step gate as an action and under the active general page-read grant), no card, no risk, no marker. The worker polls the runtime's `content.evaluate-condition` (boolean reply; `DEFAULT_WAIT_POLL_MS` 250 ms, injectable) against the **leased** tab, not the active one, and owns a second timer at the bound so a hung poll cannot overrun `maxWaitMs`. Endings: `succeeded` `{ outcome: "condition-met", condition, waitedMs }`; `failed`/`bound-reached` → run reason `wait-bound-reached`; Stop through the existing cancellation path; revoked grant → `denied`/`grant-revoked`; document change or lost leased tab → `stale-context`/`document-changed`. `WAIT_END_REASONS` = bound-reached, document-changed. A plan must contain at least one action step. `visible-text-changed` compares against a registry-only baseline captured at collection (`visibleText`, bounded), never projected or matched. Follow-ups (not blocking): the evaluator's `ensureContentRuntime` may inject into a replaced document on a background tab only to discover the epoch mismatch — a probe-without-inject primitive would be tighter; the 001 extension-runtime contract still says every content round trip resolves the active tab (T086 syncs it).

**Checkpoint**: steps depending on a page change no longer rely on a guessed delay.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Requirements**: FR-028, FR-030 · **Success criteria**: SC-017, SC-018

- [X] T085 [P] Sync `specs/001-ai-browser-assistant/contracts/task-channel.md` with the request sequence, the exclusion set, the four added capabilities, the wait, and the resolution shapes
- [X] T086 [P] Sync `specs/001-ai-browser-assistant/contracts/extension-runtime.md` with the per-step exclusion projection and the resolved-element display
- [X] T087 [P] Record in `specs/001-ai-browser-assistant/spec.md` that 002/FR-028 amends FR-005's action set, with a pointer to this feature
- [X] T088 Confirm `tests/contract/locales.contract.test.ts` pins every reason code this feature added, in both locales
- [X] T089 **Regression gate**: confirm `tests/contract/manifest.contract.test.ts` passes unchanged and the production manifest declares the same five permissions and no host permission. If this test needed editing, the feature has exceeded its scope — stop and escalate
- [X] T090 **Regression gate**: confirm the dispatch fence still prevents a duplicate effect and a mid-run worker restart still reports the interrupted step as uncertain, per `quickstart.md`
- [X] T091 Run all eight scenarios in `quickstart.md` and record the result
  **Result notes (2026-09-07)**: T085/T086 synced both 001 contract documents with the ten capabilities, the exclusion set, request sequences, gestures and key press, `page.resolve`, `page.wait` (plan-step only, observed on the leased tab), the closed `attention-required` vocabulary and the run stop reasons; reviewed against the schemas by code-reviewer (one wording contradiction on the minimum Plan fixed: two or more steps with at least one effect, not two effects). T087 amendment note under FR-005. T088 `tests/contract/locales.contract.test.ts` walks `RUN_STOP_REASONS`, `WAIT_CONDITIONS`, `BRIDGE_ACTIONS` and the resolution/wait keys in both catalogues (red by removing one key, then green). T089 `manifest.contract.test.ts` 5/5 unchanged on 2026-09-07. T090 fence/restart/duplicate tests green (`failure-lifecycle-matrix`, `operation-marker-store`, `action-lifecycle`, the fence tests in `control-port-task.test.ts`). T091 each scenario bullet in `quickstart.md` names its covering packaged journey or unit/contract test; gate numbers are appended by T092.
- [X] T092 Run the exit checklist from `specs/001-ai-browser-assistant/fixes/00-index.md` §6 on one final build, both packaged gates sequentially
  **Result (2026-09-07, one final build)**: `npx tsc -b` 0 · `tsc -p apps/extension --noEmit` 0 · `tsc -p tsconfig.tests.json --noEmit` 0 · `npm test` 59 files / 656 · `npm run test:contract` 11 files / 141 · `npm run build:extension:test` 0 · `npm run build` 1 (environmental, unchanged since WP7: `productionIdentityDefine` requires the owner-held production Extension ID env; not a product regression) · packaged gate en-US 19 passed / 1 skipped (the zh-TW-only resolution journey) · packaged gate zh-TW 20 passed, run sequentially on the same `dist/test`. First pass of both gates failed one journey in each locale ("a ten-step plan interrupts the user only before it runs"): the 50 ms card sampler shares the panel's single CDP evaluation channel with the driver and missed the plan card the driver itself had waited for and answered; the test now records the three driver-answered cards directly and keeps the sampler for cards that must never appear (test-only change, `tests/e2e/packaged/task-mode.spec.ts`); both gates re-run green on the unchanged build.
  **Owner decisions applied (2026-09-07, later the same day)**: FR-025 wording (A), FR-026 wording (A), T064-1 (A: a general-grant revocation expires the approved Plan; the next step is refused `denied`/`plan.expired` and the run reason is `step-not-admitted`, first cause preserved), T064-2 (`reasonCode` bounded to 80 chars and `^[a-z][a-z0-9.-]*$` on every reason field incl. the auth `reason`). Reviewed by code-reviewer (one Medium fixed, re-review clean). Final build after these: typecheck 0/0/0, unit 59 files / 658, contract 11 / 144, test build ok, production build still env-blocked, gate en-US 19 passed / 1 skipped, gate zh-TW 20 passed.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — blocks every user story
- **US1 (Phase 3)**: depends on Foundational
- **US2 (Phase 4)**: depends on Foundational **and on US1** — a product decision from the spec, not a technical one
- **US3, US5, US6 (Phases 5, 7, 8)**: depend on Foundational only; independent of each other and of US1/US2
- **US4 (Phase 6)**: depends on Foundational **and on T053a and T053b** (the "Before User Story 4" items recorded after the US3 review); T059 must not widen the literal action union or add reply reasons outside the contract enum
- **Polish (Phase 9)**: depends on every story that is being delivered

### Within Each User Story

- Every test is written and failing before the implementation task it covers
- Contract schema before domain logic before worker before panel before journey
- A story is complete before the next priority begins

### Parallel Opportunities

- T002 and T003 differ only by file — T002 is the red test for T003
- All Foundational tasks marked [P] can run together
- Every test task within a story is marked [P]: they touch different files
- **US3, US4, US5, US6 can be worked in parallel** once Foundational is done — they touch different capability shapes and different content-runtime paths
- Locale tasks are marked [P] within their story but all touch the same two catalogue files; if run in parallel across stories they will conflict. Sequence them, or fold them into one task per catalogue at the end

---

## Parallel Example: User Story 4

```text
# All tests for User Story 4 together:
T054 Contract test for the three gesture shapes
T055 Unit test for two-endpoint drag classification
T056 Unit test for the risk mapping
T057 Unit test for mid-gesture document change
T058 Unit test for secondary-activation refusal
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 1 Setup
2. Phase 2 Foundational
3. Phase 3 User Story 1
4. **Stop and validate**: a user can correct a plan instead of discarding it. This is a complete, shippable
   improvement even if nothing else in the feature lands.

MVP is 26 tasks (T001-T025 plus T015a). The whole feature is 94.

### Recommended increment order

1. Setup + Foundational
2. **US1** — plan correction. Ship.
3. **US2** — plan-bound runs. Ship. Together with US1 this delivers SC-013, the headline outcome.
4. **US3** — keyboard. Ship. Closes the most conspicuous missing primitive.
5. **US4, US5, US6** — parallel if capacity allows; each ships on its own.

### Stop conditions

- If T089 fails, the feature has added a permission and must stop for a product decision.
- If T090 fails, a guarantee has been traded away and the increment must not ship.

---

## Notes

- `[P]` means a different file and no dependency on an incomplete task
- Every test is proven red before its implementation task, then green after — the repository's established
  practice is to demonstrate red by temporarily reverting the fix, not by assertion
- One writer at a time; run `npx tsc -b` before the extension tests; run the three typecheck stages separately
- The two packaged gates run only on the final build, sequentially, on fixed ports
