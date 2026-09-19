# Feature Specification: Reference Parity — First Increment

**Feature Branch**: `002-reference-parity` (logical feature identifier; this workspace has no Git metadata)

**Feature Directory**: `specs/002-reference-parity`

**Created**: 2026-09-04

**Status**: Draft — Q-021 through Q-023 resolved 2026-09-04; ready for planning

**Input**: Close the highest-value capability gaps found in the reference-extension analysis, limited to
what the currently approved permission surface already allows: plan-bound sequential execution without a
round trip per step, per-step plan rejection, the missing single-page interaction vocabulary, locating an
element by description, and waiting for an observable condition.

**Authoritative Source Order**: Constitution → `docs/product-requirements-draft.md` → the reference
analysis (kept in the private archive; its public summary is `docs/design-notes.md`).

**Relationship to 001**: This feature deepens capabilities already approved as MUST in
`specs/001-ai-browser-assistant` (PR-004/FR-004 page understanding, PR-005/FR-005 browser actions,
PR-008/FR-008 consent and safety). It introduces no new Product Requirement and no new browser permission.
FR-028 below records the one place where it amends an approved requirement.

**Explicitly out of scope for this increment**: anything requiring a permission the production manifest
does not already declare — screen capture, scheduling, notifications, downloads, local-agent pairing,
multi-tab or cross-origin work, navigation, page diagnostics, and trusted input events. Those remain
candidates for later increments and are unaffected by this specification.

Secondary (context-menu) activation is also out of scope, by the decision recorded in Q-021: on most pages
it opens browser chrome the product cannot see or operate, so it could not satisfy the effect-verification
rule that every other action must meet.

## User Scenarios & Testing

### User Story 1 - Remove one step from a proposed plan (Priority: P1)

A user asks the assistant to complete a multi-step task. The assistant proposes an ordered plan. One step is
wrong — it targets the wrong control, or does something the user did not intend. Today the user's only
options are to approve the whole plan or reject the whole plan and hope the next proposal is better. The user
wants to say "not that step, the rest is fine."

**Why this priority**: The approved plan is the authorization artifact for multi-step work. It is also the
precondition for User Story 2 — once an approval covers a whole run rather than one step at a time, the
inability to correct a single step becomes the difference between a usable plan and a discarded one.

**Independent Test**: Propose a five-step plan, exclude the third step, approve the remainder. Steps one and
two execute; step three is never dispatched; the task reaches a terminal outcome that states which step was
excluded. Fully deliverable on its own: it improves plan review even if nothing else in this feature ships.

**Acceptance Scenarios**:

1. **Given** a proposed plan of five steps, **When** the user excludes step three and approves, **Then** the
   assistant executes steps one and two, never dispatches step three, and reports a terminal outcome naming
   the exclusion.
2. **Given** an approved plan with an excluded step, **When** the service later requests the excluded step,
   **Then** the request is refused and the refusal is recorded as a denial, not a failure.
3. **Given** a proposed plan, **When** the user excludes every step, **Then** the plan is treated as rejected
   and no step executes.
4. **Given** an approved plan with an exclusion, **When** the service proposes a replacement plan citing the
   approved one, **Then** the replacement is reviewed afresh and the earlier exclusion does not carry over
   silently.
5. **Given** an approved plan whose step five depends on excluded step four, **When** the run reaches step
   five, **Then** step five fails its own target revalidation, the run stops there, and the terminal outcome
   names the excluded step as the reason the run did not complete.
6. **Given** an approved plan whose later steps do not depend on the excluded one, **When** the run proceeds,
   **Then** those later steps execute normally.

---

### User Story 2 - Run an approved plan without stopping between every step (Priority: P1)

A user approves a plan to fill in and submit a form. Today each step is a separate exchange with the service:
request, respond, request, respond. A ten-step task spends most of its time waiting on that traffic rather
than on the page. The user wants the approved plan to run.

**Why this priority**: This is the largest felt difference against both reference extensions, and it is the
one gap that costs the user time on every single task rather than occasionally.

**Independent Test**: Approve a five-step plan and observe that the run completes in one exchange rather than
five, that each step is still revalidated and verified individually, and that a step whose effect cannot be
verified stops the run with the remaining steps unexecuted.

**Acceptance Scenarios**:

1. **Given** an approved five-step plan, **When** the run begins, **Then** the steps execute in the approved
   order and each step is revalidated against the current tab, document, origin, target, and authorization
   immediately before it runs.
2. **Given** a run in progress, **When** a step's effect cannot be verified, **Then** the run stops at that
   step, the remaining steps do not execute, and the task reports an outcome that distinguishes "stopped
   part-way" from "completed".
3. **Given** a run in progress, **When** the user presses Stop, **Then** no further step is dispatched and any
   step already dispatched is reported as uncertain rather than successful.
4. **Given** a run in progress, **When** the bound document changes, **Then** the run stops and the remaining
   steps do not execute.
5. **Given** a task with no approved plan, **When** the service requests a multi-step run, **Then** the request
   is refused: a run is only ever the execution of an approved plan.

---

### User Story 3 - Use the keyboard (Priority: P2)

A user asks the assistant to fill in a form that uses a tag field and a date picker. Committing a tag needs a
keystroke; moving between fields needs another; dismissing the picker needs a third. The assistant cannot press
any key today, so tasks that are otherwise within reach stall on a control it cannot finish operating.

**Why this priority**: It is the most conspicuous missing primitive — a task can read the page, click, and
type, then stall because it cannot press one key. It requires no new permission.

**Note on scope**: keystrokes whose effect would be a form submission or a document navigation are refused, so
this story does not cover submitting a search. See FR-024 and research decision R-022.

**Independent Test**: A task that enters two tags into a tag field, committing each with the confirmation key
and moving on with the tab key, completes end to end.

**Acceptance Scenarios**:

1. **Given** focus in a control where the confirmation key commits a value without submitting a form or
   navigating, **When** the assistant presses it, **Then** the keystroke is delivered and the resulting change
   is verified like any other effect.
1b. **Given** focus in a field where the confirmation key would submit a form or navigate, **When** a press is
   requested, **Then** the request is refused with an explicit refusal result — a denial naming the submission
   guard — and no effect.
2. **Given** a request to press a key combination, **When** the combination is one of the supported set,
   **Then** it is delivered; **When** it is not, **Then** the request is refused rather than partially applied.
3. **Given** focus in a field the product classifies as sensitive, **When** a key press is requested, **Then**
   the request is refused.
4. **Given** a request to press a key whose target cannot be classified, **When** the request is evaluated,
   **Then** it is refused.

---

### User Story 4 - Use the remaining pointer gestures (Priority: P2)

Some interfaces only respond to a gesture the assistant does not have: a double-click to open, a hover to
reveal a menu, a drag to reorder or to set a slider.

**Why this priority**: Each unlocks a class of interface the assistant currently cannot operate at all, and
none needs a new permission. Lower than the keyboard because fewer everyday tasks depend on them.

**Independent Test**: A task that reveals a hover menu and activates an item within it completes.

**Acceptance Scenarios**:

1. **Given** a control the product classifies as low risk, **When** a double-click is requested, **Then** it is
   delivered and verified.
2. **Given** a hover request over a classifiable target, **When** it is delivered, **Then** the resulting change
   is observed before any dependent step proceeds.
3. **Given** a drag request, **When** either the start or the end target cannot be classified as low risk,
   **Then** the request is refused.
4. **Given** a drag in progress, **When** the document changes before the drag completes, **Then** the result is
   reported as uncertain rather than successful.

---

### User Story 5 - Point at something by describing it (Priority: P3)

The user says "click the search box". Today the assistant must be handed an exact target; a description is not
enough, so the service has to guess from a structural read of the page.

**Why this priority**: It removes a common failure mode — acting on the wrong element — and it makes plans
easier for a person to review, because a step can say what it means. It is a read, not a new effect.

**Independent Test**: A task phrased with a description resolves to a single target, and a description matching
nothing produces a clear "not found" rather than a wrong action.

**Acceptance Scenarios**:

1. **Given** a description that matches exactly one element, **When** the assistant resolves it, **Then** the
   resolved target is shown in the review before any action uses it.
2. **Given** a description that matches nothing, **When** the assistant resolves it, **Then** the result is an
   explicit no-match and no action is attempted.
3. **Given** a description that matches more than the disclosure limit allows, **When** the assistant resolves
   it, **Then** the result states that the description was too broad rather than silently choosing one.

---

### User Story 6 - Wait for something to happen, not for a fixed time (Priority: P3)

After a click, the next step depends on a result appearing. Waiting a fixed number of seconds is either too
short — the step fails — or too long, and every task pays the cost.

**Why this priority**: It improves reliability of everything above it, but nothing is impossible without it.

**Independent Test**: A step that waits for a result list proceeds as soon as the list appears, and reports a
clean timeout if it never does.

**Acceptance Scenarios**:

1. **Given** a wait for an observable page condition, **When** the condition becomes true, **Then** the run
   proceeds without further delay.
2. **Given** a wait whose condition never becomes true, **When** the bound reached, **Then** the run stops with
   an outcome that names the unmet condition.
3. **Given** a wait in progress, **When** the user presses Stop or the document changes, **Then** the wait ends
   immediately and no dependent step runs.

---

### Edge Cases

- A user excludes a step that a later step depends on. The later step runs, fails its own target
  revalidation, and stops the run; the terminal outcome names the exclusion so the stop is attributable.
- A run stops at step four of eight. The user must be able to tell what has already happened to the page.
- A key press is requested while focus sits in a field whose sensitivity cannot be established.
- A drag begins on a classifiable target and ends on one that appeared after the drag started.
- A description matches many elements, or matches an element that is not visible.
- A wait condition is satisfied by a change the user did not cause and did not expect.
- The user presses Stop between two steps of a run that is already in flight.
- An approved plan is executed on a document that has changed since approval.

## Requirements

### Functional Requirements

- **FR-020 (PR-008 — MUST)**: Plan review MUST let the user exclude individual steps and approve the
  remainder. The decision recorded MUST identify exactly which steps were approved. Excluding every step MUST
  be equivalent to rejecting the plan.
- **FR-021 (PR-008 — MUST)**: An excluded step MUST never be executed. A later request for an excluded step
  MUST be refused and recorded as a user denial, distinct from a failure. The product MUST NOT substitute,
  reorder, or re-derive a step to compensate for an exclusion. Steps after an excluded one MUST still be
  attempted in order, each subject to the same per-step revalidation as any other step, so a step that
  depended on the excluded one stops the run by failing its own target check rather than by inference. When a
  run stops after an exclusion, the terminal outcome MUST name the excluded step, so a part-way stop is
  attributable to the user's own decision.
- **FR-022 (PR-005 — MUST)**: The product MUST be able to execute an approved plan without a separate exchange
  with the service for each step, while preserving, for every step and before it runs, revalidation of the
  selected tab, top-level document, origin, target, and authorization, and, after it runs, verification of the
  observable effect. A step whose authorization, target, or effect cannot be established MUST stop the run with
  the remaining steps unexecuted.
- **FR-023 (PR-005 — MUST)**: Sequential multi-step execution MUST be available only for an approved plan. The
  product MUST refuse a multi-step run that is not bound to one, and MUST NOT execute steps in parallel or
  without per-step target and result validation.
- **FR-024 (PR-005 — MUST)**: The product MUST support delivering a bounded, named set of keyboard keys and
  modifier combinations to the focused element of the bound document. A key press MUST be refused when the
  focused element is classified as sensitive, when its classification cannot be established, or when the
  requested key is outside the named set. A key whose default effect on the focused element would be a form
  submission or a document navigation MUST be refused, because FR-028 preserves 001/FR-005's prohibition on
  both; where that effect cannot be locally established, the request MUST be refused. This qualification
  applies in practice to the confirmation key, which remains available where its effect is confined to the
  focused control — committing an inline edit, a token in a tag field, or a value in a combobox.
- **FR-025 (PR-005 — MUST)**: The product MUST support double activation, pointer hover, and drag between two
  targets, each restricted to targets the product classifies locally as low risk and non-navigating. A drag MUST
  classify both its start and end target; if either cannot be classified, the request MUST be refused. The
  product MUST NOT perform secondary (context-menu) activation, and MUST refuse such a request before any
  effect; on the wire, as a frame refusal that ends the channel (the request frame's `capability` is the closed
  `hallpass-v1` enum).
- **FR-026 (PR-004 — MUST)**: The product MUST be able to resolve a natural-language description of an element
  to a target within the bound document, returning either one or more bounded candidates (at most
  `maxResolutionCandidates`), no match, or too broad — the service chooses among several and the acting step's
  card names both the chosen element and the description. Resolution is authorized by the page-read consent already obtained for the current task and
  MUST NOT disclose a data category beyond those that consent covers; it MUST NOT read or report form values.
  The number of candidates disclosed MUST be bounded, and a description matching more than that bound MUST
  return the too-broad result rather than a selection. Before any action uses a resolved target, the review
  presented to the user MUST name the element that was resolved.
- **FR-027 (PR-005 — MUST)**: The product MUST support waiting for an observable condition of the bound
  document, with a bounded maximum wait. Reaching the bound, a Stop, or a document change MUST end the wait and
  prevent any dependent step from running.
- **FR-028 (PR-005 — AMENDS 001/FR-005)**: 001/FR-005 fixes the executable action set as "exactly scrolling,
  activating a locally classifiable low-risk control, and entering text in a field not identified as sensitive."
  This feature extends that set with the keyboard, pointer, and wait primitives in FR-024, FR-025 and FR-027.
  Every constraint 001/FR-005 places on the original set — local classification, non-navigation, no form
  submission, no irreversible high-risk effect, refusal when sensitivity or risk cannot be established, and
  transient data — applies unchanged to the additions.
- **FR-029 (PR-005 — MUST)**: Every action added by this feature MUST carry a locally decided risk
  classification, and a request whose risk cannot be classified MUST be refused. No addition may rely on the
  service's judgement of its own risk.
- **FR-030 (PR-001 — MUST)**: This feature MUST NOT add a browser permission or host access. The shipped
  artefact's declared permission surface MUST be unchanged.

### Key Entities

- **Plan**: An ordered set of proposed steps presented for review before multi-step work begins. Carries the
  identity of the document and origin it was proposed against.
- **Plan Step**: One proposed action within a plan, with the target and arguments it will use. Now carries an
  approval state of its own rather than inheriting the plan's.
- **Run**: The execution of an approved plan's approved steps, in order, ending at completion, at the first
  step that cannot be established or verified, at a Stop, or at a document change.
- **Wait Condition**: An observable statement about the bound document that a run may pause on, with a bound
  on how long it may be awaited.
- **Element Description**: A natural-language phrase that resolves to zero, one, or too many targets in the
  bound document.

## Success Criteria

- **SC-013**: A ten-step form-filling task interrupts the user at most twice — once to review the plan, and at
  most once more for an action the product cannot classify — down from once per step today.
- **SC-014**: A user who disagrees with one step of a proposed plan can proceed with the remaining steps
  without the assistant re-proposing a plan.
- **SC-015**: A task whose completion depends on a keystroke that commits a value within a control — an inline
  edit, a tag field, a combobox — succeeds without the user operating the keyboard themselves. Today this task
  cannot be completed at all. Keystrokes that would submit a form or navigate remain out of scope, so this
  criterion is not met by, and must not be measured with, a search box.
- **SC-016**: A step that depends on a page change proceeds as soon as the change is observable, rather than
  after a fixed delay chosen in advance.
- **SC-017**: Every step that executes still produces a verified record of whether its effect occurred; the
  proportion of executed steps with an unverified outcome does not increase relative to today.
- **SC-018**: Installing this update grants the assistant no additional access to the user's browser or data
  beyond what it already has.
- **SC-019**: A user reviewing a plan can tell, for every step, which element it will act on, before approving.

## Assumptions

- **Plan-bound runs only.** Sequential multi-step execution is treated as the execution of an approved plan,
  which is what 001/FR-005 already excludes from its prohibition on batch execution. Ad-hoc multi-step
  execution is out of scope and is not requested.
- **A run stops at the first unestablished or unverified step.** The remaining steps are not attempted and are
  not silently re-planned. This mirrors the existing single-step behaviour rather than introducing a new
  recovery model.
- **Keyboard keys are a named, bounded set.** An unnamed key is refused. The set is chosen for navigation and
  submission within a form, not for arbitrary shortcut invocation.
- **Sensitivity rules carry over unchanged.** The existing classification that refuses text entry into
  sensitive fields also refuses key presses directed at them; nothing about sensitive-field handling is relaxed.
- **Drag is classified on both ends.** A drag is treated as two targets, and the stricter of the two decides.
- **Waiting is bounded.** Every wait has a maximum; an unbounded wait is not offered.
- **No change to consent lifetime.** Grants continue to be limited to the current task and current document.
  Whether a decision can be remembered across tasks is deliberately not part of this increment.
- **No change to the permission surface.** Every capability here is reachable with the permissions the product
  already declares.

## Resolved Product Decisions

Answered by the product owner on 2026-09-04. Full context, the options considered, and the reasoning are
recorded in `clarifications.md`.

- **Q-021 → A**: Secondary (context-menu) activation is out of scope. It usually opens browser chrome the
  product can neither see nor operate, so it could not meet the effect-verification rule every other action
  meets. Recorded in FR-025 and in the out-of-scope statement above.
- **Q-022 → A**: After an excluded step, the remaining steps are still attempted; per-step revalidation is what
  stops a step that depended on the excluded one, and the terminal outcome names the exclusion so a part-way
  stop is attributable. Recorded in FR-021 and User Story 1 scenarios 5 and 6.
- **Q-023 → A**: Resolving a description is authorized by the page-read consent already obtained for the task,
  with a bounded candidate count and the resolved element named in the review before any action uses it.
  Recorded in FR-026 and SC-019.

## Traceability

| This feature | Existing requirement | Reference feature | Notes |
| --- | --- | --- | --- |
| FR-020, FR-021 | PR-008 / 001 FR-008 | F-008 | Plan review gains step-level granularity |
| FR-022, FR-023 | PR-005 / 001 FR-005 | F-004 | Permitted by 001/FR-005's own definition of batch |
| FR-024, FR-025 | PR-005 / 001 FR-005 | F-004 | Amends the action set — see FR-028 |
| FR-026 | PR-004 / 001 FR-004 | F-005 | Element resolution is a read |
| FR-027 | PR-005 / 001 FR-005 | F-004 | Wait is a control primitive, not an effect |
| FR-029, FR-030 | PR-005, PR-001 | — | Preserves the existing local-classification and least-privilege guarantees |

No Product Requirement is added by this feature. No reference feature changes destination: F-004, F-005 and
F-008 remain mapped as they are in 001.

## Change Log

| Date | Change | Origin |
| --- | --- | --- |
| 2026-09-04 | Initial specification | `/speckit-specify` |
| 2026-09-04 | Q-021, Q-022, Q-023 answered and written into FR-021, FR-025, FR-026, User Story 1, Edge Cases, and the out-of-scope statement | Product owner |
| 2026-09-04 | FR-024 tightened and SC-015 restated: the confirmation key is refused where its effect would be a form submission or a navigation | Phase 0 research R-022, which found that an unqualified confirmation key would violate the two 001/FR-005 constraints FR-028 promises to preserve |
| 2026-09-05 | User Story 3 scenario 1b restated: the refusal is an explicit refusal result (a denial naming the submission guard), not an "unsupported-capability" result. In this contract `unsupported` means the capability is absent from the profile, which would misdescribe a key the build supports on a target where it must not be delivered; `failed` would invite a retry of a decision that cannot change | User Story 3 implementation review (code and architecture reviewers) |
| 2026-09-05 | Recorded in data-model.md "Key Press" and research R-026, without changing FR-024: a key press is the delivery of keyboard events to the focused control, not the browser's default action, so the tab key moves focus only where the page's own handler moves it; a press whose handler moved focus is reported uncertain with a cause of its own (`focus-lost`) that leaves the document binding intact. SC-015's tag field is reachable only where its name is in the closed ordinary allow-list 001/FR-004 established; widening that list is a sensitivity-policy decision left to the owner | User Story 3 implementation review |
| 2026-09-05 | Recorded in data-model.md "Pointer Gesture", research R-026 and contracts/README.md §1.2, without changing FR-025: the gestures are delivered as events to the page's own handlers (no browser default action, so a CSS-only hover menu does not open), a drag uses the HTML drag-and-drop sequence only, and each gesture's verification evidence is named (`targetVisible`, `clicks`, `moved`) with its own uncertain cause. Gestures reach only the handles a click can reach. Secondary activation is not expressible: on the wire the frame fails the closed capability enum and the channel closes (`invalid-frame`); the worker's `unsupported` answer covers any other route. FR-025's "explicit unsupported-capability result" is realised as that frame refusal — recorded as a wording tension for the owner, pre-existing since 001. A drag's review card names both endpoints (`dropTargetLabel`/`dropTargetRole`) | User Story 4 implementation and review |
| 2026-09-05 | Recorded in data-model.md "Element Resolution", research R-025 and contracts/README.md §1.4, without changing FR-026: resolution is the read capability `page.resolve`, admitted under the page-read consent already held and bound to a document; a `resolved` answer carries one to `maxResolutionCandidates` candidates (the "one target" case being one), `no-match` and `too-broad` carry none; candidates carry only handle, role, label, kind and are re-projected from worker-held metadata; the card of the action that uses a resolved target names the description (`resolvedFrom`). Matching is whole-word, so a zh-TW description matches only a label written the same way - an open owner decision (clarifications.md, "Deviations found during User Story 5", follow-up 1; remediation T074a), as is the "one target" wording (follow-up 2) | User Story 5 implementation and review |
| 2026-09-07 | Recorded in data-model.md "Wait", research R-024 and contracts/README.md §1.3, without changing FR-027: the wait is the capability `page.wait`, the tenth of the profile and never an action; it is expressible only as a step of an approved plan, admitted under the page-read consent already held, and its arguments are the closed triple handle/condition/bound. The content runtime answers one boolean per poll and nothing else; the bound, the Stop and the document change are the worker's own endings. R-024's origin change is folded into `document-changed`, and a Stop is not a wait-end reason of its own - halting the task already settles the step as a cancellation - so `WAIT_END_REASONS` is `bound-reached` and `document-changed`. A run that outlasts a bound stops with the new reason `wait-bound-reached`. A wait carries no risk label, no consent card and no operation marker | User Story 6 implementation |
| 2026-09-07 | Recorded in the same three places after the User Story 6 review, without changing FR-027: a wait observes the *leased* tab rather than the active one (a tab switch does not end a wait, which performs no effect; the dependent action step is still refused unless the leased tab is active), its bound is kept on a worker-owned timer so a poll that never answers still ends at the bound rather than at the page port's ten-second deadline, and a page-read grant revoked mid-wait ends it `denied` / `grant-revoked` out of the dispatch vocabulary rather than as a wait-end reason of its own. A plan must now contain at least one action step: a plan of nothing but waits performs none of the work it was approved for | User Story 6 implementation review (code and architecture reviewers) |
| 2026-09-07 | Recorded in data-model.md "Element Resolution", research R-025 and contracts/README.md §1.4, without changing FR-026: description matching is a language policy and moved to the pure `matchDescription` in `packages/domain`, leaving the content runtime liveness and the bound. A description is tokenized per script - space-delimited text keeps the whole-word rule; a run written without word breaks is segmented (`Intl.Segmenter`) and matched where it occurs in the label with both ends on the segmenter's word boundaries (siblings that share the base word are answered too-broad at the bound; an ICU-glued description is not noise-stripped and answers no-match; a host without a segmenter falls back to containment) or against the zh-TW half of the role vocabulary, which such a language writes as an affix of the phrase - and a mixed description must match on every token. A description that was nothing but noise words is now matched literally instead of answered "no match", so a control labelled only "click"/"點擊" is reachable. The packaged zh-TW gate gains a zh-TW resolution journey against a zh-TW-labelled fixture page (`/localized`). Closes the first owner decision of clarifications.md "Deviations found during User Story 5" (option A); the "one target" wording (follow-up 2) is still open | T074a |
| 2026-09-07 | FR-025 amended (option A of clarifications.md "Wording tension found during User Story 4"): a secondary-activation request is refused before any effect; on the wire, as a frame refusal that ends the channel, because the request frame's `capability` is the closed `hallpass-v1` enum. No code change - the implementation was already A-compatible | Product owner |
| 2026-09-07 | FR-026 and data-model.md "Element Resolution" amended (option A of clarifications.md "Deviations found during User Story 5", follow-up 2): a resolution answers one or more bounded candidates (at most `maxResolutionCandidates`), no match, or too broad - the service chooses among several and the acting step's card names both the chosen element and the description. No code change | Product owner |
| 2026-09-07 | T064-1 resolved as option A, without changing FR-020 or FR-008: revoking the general page-read grant now expires the approved Plan exactly as a document change does. Every step was reviewed under the authority the user has just taken back, so a later plan-step request is refused `denied` / `plan.expired` instead of failing closed on the binding that went with the grant, and the panel is no longer left showing a Plan that can no longer run. A step already in flight keeps its own revocation answer (`denied` / `grant-revoked`), and a Plan still awaiting review is left alone. Recorded in data-model.md "Plan Decision" | Product owner |
| 2026-09-07 | T064-2 resolved, without changing any requirement: `reasonCode` is bounded on the wire. `REASON_CODE_PATTERN` (`^[a-z][a-z0-9.-]*$`) and `REASON_CODE_MAX_CHARS` (80) are protocol constants in `@hallpass/contracts`, applied to `server.terminal.reasonCode`, `worker.task.terminal.reasonCode`, the unavailable `worker.service.state.reasonCode` and the optional `worker.context.state.reasonCode`. It is a code, never free text: the panel keys reviewed copy off it and T064b exposes it in the DOM, so a sentence, an HTTP status line or a forwarded `Error.message` is refused at the frame rather than rendered. Every existing producer already conformed, so none needed normalising. Recorded in the 001 contract docs `task-channel.md` and `extension-runtime.md` | Product owner |
