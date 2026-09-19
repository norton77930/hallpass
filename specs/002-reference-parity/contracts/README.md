# Phase 1 Interface Contracts: Reference Parity — First Increment

**Feature**: `specs/002-reference-parity` · **Date**: 2026-09-04

This feature changes three interfaces the product already exposes. Each change is additive to the wire format
and closed in shape: a receiver that does not understand a new member refuses the frame rather than ignoring
the part it does not recognise.

The normative contract documents live in `specs/001-ai-browser-assistant/contracts/`. This file states what
must change in them, and the invariants any implementation must preserve. It intentionally names no module,
no file, and no message identifier from either reference extension.

---

## 1. Task channel — service to worker

### 1.1 Multiple capability requests in one frame

**Change**: a frame may carry an ordered sequence of capability requests instead of exactly one.

**Invariants**

- Every request in the sequence is admitted, revalidated, fenced, marked, dispatched, and verified
  individually. The sequence is a transport grouping, never a bulk effect.
- Requests execute in the order given, one at a time. Concurrency is not expressible.
- A sequence is admitted only when every request in it binds to a step of the same approved plan. A sequence
  containing a request that is not plan-bound is refused whole, before any step runs.
- The first request that cannot be admitted, or whose effect cannot be verified, ends the sequence. Later
  requests are never prepared. The service learns the sequence ended from that request's own result — the
  first result that is not `succeeded` — and MUST NOT expect a result for any later position; the user learns
  where the run got to, and why, from the worker's terminal (§2.3).
- A sequence refused whole is answered whole: every position receives the same refusal, so the service cannot
  mistake silence for a run in progress.
- While a sequence is executing, no other request is accepted. A single request or a second sequence that
  arrives from outside the run while a step is in flight is refused (`run-in-progress`) rather than admitted
  as the run's next step. Before this change the channel made concurrency impossible by construction — the
  service could not send a second request until the first was answered — and a sequence is exactly the
  relaxation of that, so the guarantee is now the worker's and is stated here rather than assumed.
- The same rule in the other direction, precisely: a sequence that arrives while a lone *action* is between
  the point just before its executor is called and the end of its dispatch tail is refused `run-in-progress`;
  so is a lone plan step that arrives in that window, after its own admission (a wrong step is still
  `plan.step-mismatch`, a second single-action still `capability.single-action-exhausted`). A page read in
  collection, and a lone action still in admission or awaiting consent, are not covered by that gate — the
  channel's one-frame-at-a-time delivery is what keeps those apart today.
- The service correlates results by `requestId`, never by arrival order: several positions are outstanding at
  once, and the positions a stopped sequence never reached simply remain outstanding until the session ends.
- The sequence carries a maximum length, supplied as bounded configuration. It may not exceed the plan bound.
- The frame is a distinct message type, `server.capability-request-sequence`, carrying `sequenceId` and
  `requests`. Nothing about `server.capability-request` changes, and a service that never sends a sequence is
  unaffected.

**Deployment constraint**: the frame is a new `strictObject` member and `protocolVersion` is unchanged, so an
extension older than this feature closes the channel on `invalid-frame` when it receives one. That is the
correct fail-closed answer, and it is acceptable only under the lock-step deployment `bounds.ts` already
assumes (both deployables ship together). A service that may face an older extension needs a capability
signal before it sends a sequence; none exists yet.

**Why this shape**: 001's action requirement forbids batch execution, and defines batch as parallel or bulk
effects *without per-step target and result validation*, explicitly excluding an approved plan executed and
verified sequentially. Preserving per-step validation is therefore not an implementation preference; it is
what keeps this change inside the approved requirement.

### 1.2 New capability requests

Four new capability values, each with its own closed argument shape and its own closed result shape:

| Capability | Arguments | Result evidence |
| --- | --- | --- |
| Press a key | The key, optional modifiers, the expected context | The key was delivered; the focused element's identity is unchanged |
| Hover | Target reference, expected context | The target is still connected and rendered after the hover (`targetVisible`); the change it caused is checked by the step that depends on it |
| Double activation | Target reference, expected context | The activation evidence, with the activation count |
| Drag | Start target, end target, expected context | The observed change between the two endpoints |

Every result carries the two literal guarantees existing action results already carry: no value is echoed
back, and the document did not change. A result that cannot establish its evidence is reported as uncertain,
never as succeeded.

**Refusals and uncertainty, as implemented for the key press**: a refusal the runtime decides from policy — the
submission guard, a key outside the set, a target the read policy withholds — is transmitted as `denied` with an
error code naming the guard (`submission-guard`, `unsupported-key`, `denied`). It is not `failed`, which invites a
retry, and not `unsupported`, which says the capability is absent from the profile. An uncertain result names its
cause: `document-changed` when the document was replaced (the binding is dropped and the plan expires, as in 001)
and `focus-lost` when the document is intact but the focused element changed under the key (nothing bound to the
document is stale; the run ends with `effect-unverified`). This amends the post-effect verification rule in
001's `task-channel.md` (the sentence that makes `document-changed` the only attention-required code) and the
uncertain-code list under "Action contract" in 001's `extension-runtime.md`; the T085/T086 doc sync folds it in.
The refusal and uncertainty vocabulary is stated here once; data-model.md and the spec change log point to it.

**The pointer gestures, as implemented** (User Story 4): `browser.hover`, `browser.double-click` and `browser.drag`.
A hover and a double activation take one target; a drag takes two distinct endpoints (`targetHandle`,
`dropTargetHandle`), both classified as click targets on the live element, the stricter deciding. Delivery is the
events a page's own handlers listen for — pointer and mouse `over`/`enter`/`move` for a hover, two activations and
a `dblclick` for a double activation, the HTML drag-and-drop sequence (`dragstart`, `dragenter`, `dragover`,
`drop`, `dragend`) with one shared `DataTransfer` for a drag. Synthetic events do not make CSS `:hover` match: a
menu opened purely by a stylesheet stays closed, a script-driven one opens. Verified results carry
`documentChanged: false` exactly as a click result does (a gesture echoes no value, so there is no `valueEchoed`
field to set): a hover `{ effect: "hovered", targetVisible: true }` — the target is still connected and rendered;
a double activation `{ effect: "double-activated", clicks }` with `clicks` at least two; a drag
`{ effect: "dragged", moved: true }` — the dragged element's document order relative to the drop target, or its
position on screen relative to the drop target, changed (a scroll that carried both endpoints is not a move). The uncertain causes are named as for the key press: `target-not-visible` for a
hovered target that vanished and `not-moved` for a drag the page ignored, both leaving the document binding and
the plan standing; a document that changes mid-gesture ends the gesture before the drop and is `document-changed`.
Secondary activation is not a member under any name. On the wire that means the request frame fails the closed
capability enum: the client closes the channel on `invalid-frame` and the task halts as a lifecycle interruption,
before any handler runs. The worker's explicit `unsupported` result covers a request that reaches admission by any
other route. The refusal is therefore a frame refusal in production - fail-closed, with no effect, but not an
answered result. The wording tension this raised is resolved: FR-025 was amended on 2026-09-07 (option A) to say
exactly that, so the spec and the implementation now agree (the same was already true of every capability outside
the profile since 001). A drag's review card names both
endpoints: the drop target's label and role are projected by the worker exactly as the start's are
(`dropTargetLabel`, `dropTargetRole`, present only on a drag), so the user approves a drag from one named element
onto another. A drop is delivered only where the page cancelled `dragover` — the browser's own rule for accepting
a drag — and a drag the page did not accept reports `moved: false`. Reach: the collector mints handles only for
`<button type="button">` and ordinary text controls, so a gesture can target nothing a click could not.

**Deployment constraint**: the hello frame now lists ten capabilities (the wait in §1.3 is the tenth) and
`protocolVersion` is unchanged, so a
peer from before this feature refuses the hello in either direction — earlier than §1.1's sequence-frame tripwire,
and equally fail-closed. It is acceptable only under the same lock-step deployment.

### 1.3 Wait

A wait is a control instruction, not an action. It names a condition against a target the worker already
holds, and a bound. It produces one of: condition observed, bound reached, stopped, or document changed. It
never carries a risk label and is never separately consented, because it performs no effect.

**As implemented** (User Story 6): the capability is `page.wait`, the tenth member of the profile and not a
member of `BRIDGE_ACTIONS`. It is expressible only as a step of an approved plan - `executionBinding.mode` must be
`approved-plan-step`, so a lone wait and a wait asked for as a read are both refused by the channel - and it
names exactly the `page.target-metadata` category. Its arguments are the closed triple
`{ targetHandle, condition, maxWaitMs }` (`waitArgumentsSchema`): the handle must be one the worker already
holds, the condition is one of `present`, `absent`, `enabled`, `visible-text-changed` (`WAIT_CONDITIONS`), and
the bound is required, positive, and at most `maxWaitMs` (15 000 ms). A selector, an expression, a URL, or a
network condition has no field and is not expressible.

The worker admits it through the same plan-step gate an action uses - the next kept step, under the digest it
was reviewed with - and through the task's active general page-read grant (`denied` / `consent-required`
without one, `stale-context` against a document it never bound, `failed` / `unknown-target` for a handle it
never minted). Like an admitted action, the step is consumed at admission, before those checks: a wait the
worker admitted and then could not carry out ends the run rather than leaving the plan open to a retry.
It then polls the content runtime (`content.evaluate-condition`, carrying the grant id, the
handle and the condition) every `DEFAULT_WAIT_POLL_MS` (250 ms; an implementation constant, not a product
bound) until one of four things happens. Nothing is dispatched to the page: there is no consent card, no
operation marker, no risk classification, and the task is not recorded as one that ran a browser effect.

A poll goes to the **leased** tab, not to whatever tab is active - the same rule a cancel follows. A wait
spans seconds and performs no effect, so the user looking at another tab in the meantime does not end it;
the bound document is still there, and that is what is being watched. The dependent action step is
unaffected: it is still refused at dispatch unless the leased tab is the active one, because that rule
belongs to the effect rather than to watching it. A leased tab that is gone, or that no longer shows the
task origin, is `stale-context` - there is no document left to watch.

The bound runs on the worker's own timer, armed once for the whole wait rather than only checked between
polls. One poll is a page round trip and carries the same ten-second content-operation deadline as every
other round trip, which can outlast a short wait; without a timer of its own a wait sitting inside a silent
poll would end seconds past its bound, and as the round trip failing rather than the bound being reached.
When the timer fires the wait ends `failed` / `bound-reached` immediately, and the poll's late reply is
ignored. Both timers are cleared on every exit. `waitedMs` is floored at zero: a clock that stepped
backwards must not produce a result the channel refuses.

The runtime answers one boolean (`contentEvaluateConditionReplySchema`: `{ ok: true, holds }`). That split is
deliberate: everything the page can observe is in that arm, and every other ending is the worker's own, decided
from state the page cannot see. A condition observed is `succeeded` with
`{ contextHandle, outcome: "condition-met", condition, waitedMs }` (`waitResultSchema`, in the top-level result
union and deliberately not in the action union). A bound reached is `failed` / `bound-reached`, and the run
stops with the reason `wait-bound-reached`. A document change - which folds in an origin change, exactly as
`onDocumentOrOriginChange` does - is `stale-context` / `document-changed`, whether the worker noticed the
binding go or the runtime refused with `stale-target`/`stale-binding`/`stale-context`. A revoked grant is
`denied` / `grant-revoked`, the same answer a dispatch gives for it.

A Stop is the one ending a wait does not name for itself: it halts the task, and the path that already settles
every in-flight run step reports the step as `cancelled` under the stop's own reason. `WAIT_END_REASONS` is
therefore `bound-reached` and `document-changed` only - a `stopped` member would be a second name for that
event and one nothing produces (recorded in the T064a review carry-over).

`visible-text-changed` is measured against the element's own trimmed text as it was when the handle was
minted, kept beside the handle in the content runtime and never projected or matched against. On the review
card the step reads as "Wait", the condition as a sentence about the named element, and the bound in seconds;
it carries no risk row, because there is no effect to classify.

A plan must contain at least one action step (`planProposedPayloadSchema`, path `steps`). A wait is a control
instruction between actions, never the point of a plan: a plan of nothing but waits would be approved as work
on the page, hold the run until its last bound, and perform none of it.

### 1.4 Element resolution

A request carrying a description, answered with one or more bounded candidates (at most
`maxResolutionCandidates`), no match, or too broad - the service chooses among several and the acting step's card
names both the chosen element and the description (FR-026, amended 2026-09-07). The answer
carries only the target metadata a review card already displays. It never carries form values, and never a
truncated candidate list.

**As implemented** (User Story 5): the capability is `page.resolve` - a read under the `page-read` binding, with
`expectedContext` naming the bound document and `arguments: { description }` bounded like a label. It is admitted
only while the task holds an active general page-read grant (Q-023) and opens no card; before that grant it is
`denied` / `consent-required`, and against a document the worker never bound it is `stale-context`. The worker asks
the content runtime (`content.resolve-target`, carrying the grant id, the description and the candidate bound), and
the runtime asks the pure `matchDescription` (`packages/domain`) about each minted handle's label, a button's
visible text and the control's role, over elements the document still shows; the runtime itself keeps only liveness
and the bound. Matching is token by token: space-delimited text whole word against a small role vocabulary ("box",
"field", "button", "dropdown"), and text written without word breaks segmented (`Intl.Segmenter`) and matched by
containment in the label or against the zh-TW half of that vocabulary ("按鈕", "欄位", "選單", "東西"), which such a
language writes as an affix of the phrase. Containment is bounded by the same segmenter, by one rule and no other, so a
description names a word of a label and not a fragment of one: a hit begins and ends where a segment does, and so
does the remainder of a phrase carrying a kind word. The accepted limitations all err to too-broad or no-match,
never to a wrong element - a modifier ICU segments on its own leaves the base word matchable ("安全動作" names
"不安全動作", "刪除按鈕" names "取消刪除"), so sibling controls ("密碼", "確認密碼", "新密碼" under "密碼欄位") are
answered too-broad past the bound rather than narrowed; a description ICU glues to a content word is not
noise-stripped; and where `Intl.Segmenter` is absent, plain containment answers with no boundary rule at all -
fewer descriptions resolve, none resolve to something else. Noise words are dropped first, unless they
were all the description had, and never from inside a word for a kind ("輸入框", including where the run of noise
reaches it across several segments as in "點擊輸入框") or a name a segmenter split into lone characters ("點餐").
The result is
`{ outcome: "resolved", candidates }` with one to `maxResolutionCandidates` candidates, `{ outcome: "no-match" }`, or
`{ outcome: "too-broad" }` - past the bound there is no list at all. The runtime's reply to the worker carries
handles and nothing else (`candidates: [{ targetHandle }]`, `contentResolutionReplySchema`): `role`, `label` and
`kind` never travel back from the page, because the worker re-projects every candidate from the target metadata it
minted at collection, and a role or label the page authored could only describe an element the review never showed.
A handle the page names that the worker never minted fails the whole resolution (`failed` / `resolution-failed`), so
a page cannot name an element the review never showed and cannot pass that attempt off as "nothing matched". Each
candidate the service then receives carries `targetHandle`, `role`, `label`, `kind` and nothing else. A resolution names exactly the `page.target-metadata` category. A resolution with two or more candidates leaves the choice to the service, and the card of the
action that uses the chosen handle names the description it was resolved from (`resolvedFrom`, present on action
consent and plan-step projections). The context strip carries the last resolution (`resolution` on
`worker.context.state`: description, outcome, and the one target when there is one).

---

## 2. Task channel — worker to service

### 2.1 Plan decision gains exclusions

**Change**: the plan decision payload gains the set of step identifiers the user excluded.

**Invariants**

- Every excluded identifier must name a step of the cited plan; an unknown identifier invalidates the frame.
- Duplicate identifiers invalidate the frame.
- Excluding every step must be sent as a denial, not as an approval with a full exclusion set.
- The service must treat an approval-with-exclusions as authorising only the remaining steps. A later request
  for an excluded step is refused by the worker regardless of what the service believes.

### 2.2 Terminal outcome gains a record of what the user left out

**Change**: the terminal payload gains an optional list of the steps the user excluded from the plan the task
ran, each with the position it was reviewed under.

**Invariants**

- It is a record of the user's own decision, not a claimed cause. The worker cannot know which exclusion a
  later step's failed target check is owed to, so it states what it can attest to and lets the summary say
  what happened. That is what makes a part-way stop attributable instead of an unexplained failure.
- Every exclusion is carried, not the first: naming one of several would be arbitrary, and which one the
  service happens to request is the service's choice rather than the user's.
- Carried whatever the outcome. A run whose kept steps all succeeded still owes the user the note that the
  plan they approved and the plan they were shown are not the same.
- Cleared whenever no approved plan governs the task any more — including when a revision is taken out for
  review, which revokes the approval before the user answers.
- The position is the number the review card printed, so the terminal names a step the way the user decided
  about it without the panel holding a copy of a plan it has already answered.

---

### 2.3 Terminal outcome gains a run record

**Change**: the worker's terminal gains an optional record of how far the approved plan's execution got: how
many kept steps the plan had, how many this worker saw run and verified, the reviewed position of the first
kept step that did not run, and — when the worker knows — why it stopped, from a closed vocabulary (`completed`, `step-not-admitted`, `step-failed`, `effect-unverified`,
`user-stopped`, `document-changed`, `wait-bound-reached`).

**Invariants**

- Worker-authored, from the same state that decides whether a remote success is believed. It is what this
  worker verified, not what the service claims.
- "Completed" is derived from the counts, never asserted. The counts are in *kept* steps; the plan card is in
  *reviewed* positions (exclusions leave gaps). A run that stopped therefore also carries `stoppedAt`, the
  reviewed position of the first kept step that did not run, and the panel names the stop in the card's own
  numbering — the same numbering `excludedSteps[].position` (§2.2) uses — so one card never carries two
  different "step 1"s.
- Only a step that was actually committed to dispatch ends the run for good. A refusal before dispatch leaves
  the plan where it was — a corrected sequence could still complete it — so no reason is recorded for it, and
  the terminal says where the run got to without inventing a cause. An expired plan is the exception: it can
  never continue, whichever step noticed.
- "For good" is enforced, not only recorded: the same decision that records the reason also ends the plan for
  admission, so every later request or sequence for it — including a continuation from the next kept step —
  is refused `plan.run-ended`. Without that, the failed step's place in the dispatched list would make the
  next step admissible and a service could run past the stop the user was shown.
- Absent for a task that ran no plan.

## 3. Extension runtime — worker to panel

### 3.1 Plan review gains per-step exclusion

**Change**: the plan review projection lets the panel mark individual steps as excluded, and the decision the
panel returns carries that set.

**Invariants**

- While a plan is under review, the exclusions are the panel's own working state: they are not reported back
  to the worker step by step, so a panel that takes over mid-review starts the review again with nothing
  excluded. That is fail-safe rather than lossless — the worker approves nothing without a fresh explicit
  decision, and it validates every identifier in that decision against the plan it holds, refusing the whole
  approval if one names a step the plan does not have. A per-step round trip would make a takeover lossless;
  it is deliberately not built, because it would put pre-decision UI state on the wire for no guarantee.
- The projection's per-step `excluded` therefore reports the state of the plan being projected, which is only
  ever true for a plan already decided on.
- The projection continues to state, for every step, what element it will act on. This is what makes an
  exclusion a meaningful choice rather than a guess.

### 3.2 Element resolution appears in review

**Change**: where a step's target came from a description rather than a prior read, the review names the
element that was resolved.

**Invariant**: a resolved target is shown before any action uses it. This is the mechanism that keeps the
Q-023 answer true — nothing is disclosed by resolution that the user does not see.

---

## 4. Product API

**No change.** This feature adds no endpoint, no field, and no error code to the HTTPS surface.

---

## 5. Manifest

**No change.** No permission, no host permission, no content script, no web-accessible resource. The declared
permission surface after this feature is byte-identical to the one before it, and the existing manifest
contract test continues to pin it unchanged.
