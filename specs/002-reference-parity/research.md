# Phase 0 Research: Reference Parity — First Increment

**Feature**: `specs/002-reference-parity` · **Date**: 2026-09-04

The technology stack is fixed by 001 and is not revisited here. Every unknown below is a design decision
about how to realise the specification inside the architecture that already exists.

---

## R-020 — How a plan-bound run avoids a round trip per step

**Decision**: The service may carry more than one capability request in a single channel frame. The worker
executes them sequentially, and each request is admitted, revalidated, dispatched, and verified by exactly the
same path a single request takes today. A run is therefore a transport optimisation, not a new execution mode.

**Rationale**: The existing admission path already validates each request against an approved plan step by its
binding digest, order, and bound context. Reusing it means the run inherits the dispatch fence, the write-ahead
operation marker, and the effect verification per step without redesigning any of them, which is what FR-022
requires. It is also the smallest change that satisfies "no separate exchange with the service for each step".

**Alternatives considered**:

- *Worker-driven run.* The worker executes the whole approved plan locally from the plan itself, with no
  per-step request from the service. Strictly stronger — the service could not vary a step's arguments after
  approval — but it moves execution authorship into the worker and changes who owns the step's arguments. That
  is a larger architectural change than this increment needs, and the binding digest already prevents argument
  substitution. Recorded as a candidate for a later increment.
- *Parallel execution.* Rejected outright: 001/FR-005 forbids parallel or bulk effects without per-step
  validation, and the whole safety argument for this feature rests on keeping validation per step.

**Consequence for the fence and markers**: a run is a sequence of independently fenced steps, not one atomic
unit. A marker is written before each step and resolved after it. A run that stops part-way leaves the earlier
steps observed and the later steps never prepared.

---

## R-021 — How a step exclusion is expressed and enforced

**Decision**: The plan decision carries the set of step identifiers the user excluded, alongside the existing
approval. An approval that excludes every step is treated as a rejection. Admission refuses any request naming
an excluded step, and the refusal is recorded as a user denial rather than a failure.

**Rationale**: The plan already carries stable step identifiers and a per-step binding digest, so an exclusion
is expressible without changing what a step is. Enforcing it in admission — the same place that already refuses
an out-of-order or altered step — keeps one gate rather than two.

**Alternatives considered**:

- *Send back a reduced plan.* Would require re-deriving digests and re-establishing order, and would let a
  reduced plan differ from the reviewed one in ways the user never saw.
- *Mark exclusions on the plan record only.* Rejected: the enforcement point must be admission, or a service
  that ignores the exclusion would still get the step executed.

---

## R-022 — Which keys may be pressed, and the form-submission problem

**Decision**: The named key set is `Enter`, `Tab`, `Shift+Tab`, `Escape`, the four arrow keys, `Home`, `End`,
`Backspace`, and `Delete`. `Enter` is admitted **only** when the focused element's default action can be
locally established as neither a form submission nor a navigation; otherwise the request is refused. Every
other key in the set is admitted on any target that already passes the text-entry classification. Keys outside
the set are refused.

**Rationale — and a contradiction this resolves**: FR-028 states that every constraint 001/FR-005 places on the
original action set applies unchanged to the additions. Two of those constraints are "non-navigation" and "not
a form submission". Pressing `Enter` in a single-input form submits it, and submitting a search form navigates.
Taken together, an unqualified `Enter` would violate both constraints that FR-028 promised to preserve, so the
spec as first written was internally inconsistent. The qualification above removes the inconsistency without
removing the capability: `Enter` remains available for the cases that motivated it — confirming an inline edit,
committing a token in a tag field, accepting a value in a combobox — and is refused exactly where it would
become a submission or a navigation.

This is locally decidable by the same kind of inspection `classifyClick` already performs: the focused
element's form ancestry, its type, and whether the form has a submit affordance. Where it cannot be
established, the existing fail-closed rule applies and the press is refused.

**Consequence for the spec**: FR-024 is tightened to state the qualification, and SC-015's example is amended
so it does not imply that submitting a search by keyboard is in scope. Both edits are recorded in the spec's
change log.

**Alternatives considered**:

- *Exclude `Enter` entirely.* Simplest and unambiguously safe, but removes the most-requested key and leaves
  the keyboard story half-delivered.
- *Allow `Enter` and treat submission as newly in scope.* Would require re-opening 001/FR-005's prohibition on
  form submission and, separately, the deferral of assistant-initiated navigation. Both are decisions of a
  different size than this increment, and neither was asked for.

---

## R-023 — Risk classification for the added actions

**Decision**:

| Action | Risk | Reasoning |
| --- | --- | --- |
| Hover | `view-only` | Cannot activate a control or enter text. Same rationale the existing classification uses for scrolling, which can also cause a page to load more content. |
| Double activation | `activation` | It is an activation of a control, and is admitted only for a target the existing click classification already accepts. |
| Drag | `activation` | Classified on **both** endpoints; the stricter of the two decides, and an unclassifiable endpoint refuses the request. |
| Key press | `activation` | It can commit a value. `Enter` additionally carries the qualification in R-022. |

No new value is added to the closed risk vocabulary. Any action whose target cannot be classified reports
`unclassified` and is refused, exactly as today.

**Rationale**: Reusing the existing four-value vocabulary keeps the consent projection, the review card, and the
locale catalogue unchanged, and avoids inventing a risk level whose meaning would have to be explained to the
user. Adding a value would also invalidate the existing closed-enumeration contract tests for no behavioural
gain.

---

## R-024 — What a wait may observe, and its bound

**Decision**: A wait may observe only conditions the content runtime can evaluate locally on the bound
document: an element matching a held target reference becomes present, becomes absent, becomes enabled, or its
visible text changes. Every wait carries a maximum duration supplied as a bounded configuration value. Reaching
the maximum, a Stop, a document change, or an origin change ends the wait and prevents the dependent step.

**Rationale**: A wait must not become a channel for reading the page beyond what the task's consent covers, so
its conditions are expressed against targets the worker already holds rather than against arbitrary selectors
or page content. Bounding the duration keeps a wait from holding the channel lease open, which the existing
lease would otherwise terminate less informatively.

**Alternatives considered**:

- *Arbitrary predicate supplied by the service.* Rejected: it would let the service specify an expression
  evaluated against the page, which is page-world execution by another name and is out of this increment's
  scope.
- *Unbounded wait.* Rejected: it interacts badly with the channel lease and gives a stalled task no distinct
  outcome.


**As implemented** (User Story 6): the four conditions are `present`, `absent`, `enabled` and
`visible-text-changed`, each decided by the content runtime on one handle the worker already holds and answered
with a single boolean; the worker polls every 250 ms until the condition holds or one of its own endings
arrives. The bound is the protocol's `maxWaitMs`. The origin change this decision lists as a fourth ending is
folded into `document-changed`, because `onDocumentOrOriginChange` is the one signal the worker observes for
both; and a Stop is not a wait-end reason of its own, because halting the task already settles the in-flight
step as a cancellation under the stop's own reason. `visible-text-changed` is measured against the element's
text as it was when the handle was minted.

Two endings this decision does *not* list, recorded after the User Story 6 review. A tab switch is not one: the
poll goes to the leased tab rather than the active one, because a wait performs no effect and the document it
watches is still there while the user looks elsewhere - the dependent action step is still refused unless the
leased tab is active, which is where that rule belongs. And a revoked page-read grant ends a wait `denied` /
`grant-revoked`, out of the vocabulary a dispatch already uses, rather than as a wait-end reason of its own.
The bound itself is kept on a worker-owned timer armed for the whole wait, not only checked between polls: one
poll carries the page port's ten-second deadline, which can outlast a short wait, and the bound is the worker's
promise to keep.
---

## R-025 — Where description resolution runs and what it may return

**Decision**: Resolution runs in the content runtime against the bound document, returns at most a bounded
number of candidates, and each candidate carries only the target metadata already authorised for a review —
role, a length-capped label, and the control kind. It never reads or reports form values. More candidates than
the bound produces an explicit too-broad result rather than a truncated list.

**Rationale**: Q-023 settled that resolution is authorised by the page-read consent already obtained. Holding
the returned shape to the metadata a review already displays keeps that answer true by construction: nothing
is disclosed by resolution that the user would not see on a review card.

**Alternatives considered**:

- *Return a structural subtree for the service to search.* Rejected: it discloses far more than the review
  metadata and would reopen Q-023.
- *Resolve in the service from a page read.* Rejected: it requires shipping the page structure off-device for
  a decision the worker can make locally.

**As implemented** (User Story 5): resolution runs in the content runtime over the handles the last collection
minted, matching the description against the label, a button's visible text and a small vocabulary of
role words, so nothing is read beyond what a review card shows and form values are never touched. The worker holds
the bound and re-projects every candidate from its own target metadata, dropping any handle it never minted. Two
or more candidates within the bound are returned as a list and the service chooses; the card of the action that
uses the choice names the description (`resolvedFrom`), so the user judges the resolution as well as the element.

**As implemented** (T074a): matching is a language policy, not a runtime concern, so it is the pure
`matchDescription` in `packages/domain` and the content runtime keeps only liveness and the bound. A description is
tokenized per script: space-delimited text keeps the whole-word rule, and a run written without word breaks
(Han, Hiragana, Katakana, Hangul) is segmented with `Intl.Segmenter` and matched against the label or a button's
text by containment - a segmenter over-splits short CJK phrases, so containment of each phrase is the honest rule -
or against the zh-TW half of the role vocabulary ("按鈕", "欄位", "選單", "東西"), which such a language writes as an
affix of the phrase ("備註欄位" = the label "備註" plus the kind "欄位"). A mixed description is the union: every
token, whichever script, must match.

Containment is bounded by the same segmenter, and by exactly one rule: a description names a word of a label, never
a fragment of one - what "save" gets for free against "unsaved". The names (`label + " " + text`) are segmented
once, keeping every segment so the offsets stay exact, and a phrase counts only where it begins and ends on a
segment boundary. That is the whole rule; nothing further guesses at what a phrase meant. It applies the same way
to a phrase carrying a word for a kind, whose remainder ("備註" of "備註欄位") must clear the same boundaries. So
"全動" does not name "安全動作" (it opens inside "安全"), and "動作" names both "安全動作" and "危險動作" - which
is what makes a description that broad answer too-broad past the bound rather than pick one.

**Accepted limitations** (each errs to too-broad or no-match, never to a wrong element):

- A negation or modifier prefix that ICU splits into a segment of its own leaves the base word on boundaries, so
  the base word names the label: "安全動作" names "不安全動作", "刪除按鈕" names "取消刪除", "儲存" names
  "未儲存的變更" ("不安全動作" segments "不"|"安全"|"動作", "未儲存的變更" segments "未"|"儲存"|"的"|"變更").
  English behaves identically - "safe action button" names a button reading "Not safe action" - and where such a
  description covers sibling controls ("密碼欄位" over "密碼", "確認密碼", "新密碼"), the candidate bound is what
  answers: too-broad, never narrowed to whichever handle was walked first.
- A description ICU glues to a content word is not noise-stripped, so it finds nothing rather than a fragment.
- Hosts without `Intl.Segmenter` fall back to plain containment with no boundary rule at all, so a fragment such
  as "全動" can name "安全動作" there.

zh-TW noise words are removed only where the segmenter says a word ends and only when a whole stretch of segments
is nothing but noise, so the "的" inside "目的地" is not mistaken for the particle and "按鈕" is not cut down to
"鈕". Two more spans are kept for the same reason: one that covers a segment where a word for a kind of control
begins ("輸入框" begins where the noise word "輸入" does, so "備註輸入框" must not become "備註" plus "框", and
"點擊輸入框" - segmented "點"|"擊"|"輸入"|"框" - must not become "框"; the claim is tested at every segment the
span covers, not only at the first), and one glued to a lone character beside it, which is half of a name the
segmenter did not know ("點餐" is segmented "點"|"餐", and the noise word "點" is not what the person meant). Where
`Intl.Segmenter` is absent the run stays one token and is matched by plain containment, with no boundary rule to
apply: fewer descriptions resolve, none resolve to something else. A description that was nothing but noise is
matched literally rather than answered "no match", so a control whose whole label is "Click" or "點擊" is
reachable.

---

## R-026 — Result shapes and effect verification for the added actions

**Decision**: Each added action gets its own closed result shape in the existing discriminated union of action
results, carrying the observable evidence that the effect occurred and the two literal guarantees every action
result already carries — that no value was echoed back and that the document did not change. Verification for
each is the smallest observation that distinguishes "it happened" from "it did not":

| Action | Verified by |
| --- | --- |
| Hover | The target is still connected and rendered after the hover; the change it caused is what the dependent step checks |
| Double activation | The same evidence a single activation reports, with the activation count |
| Drag | The target's position or ordering changed between the two endpoints |
| Key press | The key was delivered to the focused element, with the focused element unchanged in identity |
| Wait | The awaited condition was observed, or the bound was reached |

**Rationale**: The existing model refuses to report success for an effect it did not observe. Extending it
per action, rather than adding a generic "action performed" result, keeps that property. A drag whose document
changed mid-gesture reports uncertain rather than succeeded, matching the existing treatment of an interrupted
effect.

**Key press, as implemented**: delivery is keyboard events dispatched to the control; the browser's default
action does not run (trusted input events are out of scope), so the page's own handlers decide what a key does
and the tab key moves focus only where the page moves it. Verification is checked after the document is known
to be intact, and a press whose handler moved focus is reported uncertain with its own cause, `focus-lost`,
rather than `document-changed`: the binding and the plan stay valid, and only the run ends. Each uncertainty
therefore names its cause; whether User Story 4's interrupted gesture is a document change or a cause of its own
is for that story to decide.

**Pointer gestures, as implemented** (User Story 4): the same boundary as the keyboard — events delivered to the
page's own handlers, never the browser's default actions, so CSS `:hover` does not match and a stylesheet-only
menu stays closed. The evidence in the table above was made concrete: a hover verifies by the target still being
connected and rendered, a double activation by the count rising by two, a drag by the dragged element's document
order relative to the drop target (a reorder) or its on-screen position relative to the drop target changing (so a
scroll that carried both endpoints is not a move). An interrupted drag is a document change — the gesture is ended
before the drop and reported `document-changed` — and the two new uncertain causes are `target-not-visible` and
`not-moved`. A drop is delivered only where the page cancelled `dragover`, which is the browser's own rule for a
page accepting a drag; a drag the page did not accept reports `not-moved`. A double activation delivers both
activations and the `dblclick` back to back, as a real double-click does, and observes the document afterwards:
a first activation that navigated makes the whole gesture `document-changed`, never success. A drag is delivered
as the HTML drag-and-drop event sequence only; pointer-driven reorder libraries that ignore drag events are out of
reach, and so are native sliders (no handle is minted for a range input), which is recorded rather than papered
over with a second delivery path.

---

## Resolved

No `NEEDS CLARIFICATION` remains. R-022 identified and resolved an internal inconsistency in the specification
as first written; the corresponding spec edits are recorded in the spec's change log and summarised in
`plan.md` under Post-Design Constitution Check.
