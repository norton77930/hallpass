# Quickstart: Validating Reference Parity — First Increment

**Feature**: `specs/002-reference-parity` · **Date**: 2026-09-04

How to prove this feature works end to end. Every scenario below states what to run and what must be true
afterwards. Details of shapes and rules live in `data-model.md` and `contracts/README.md`; this file does not
repeat them.

## Prerequisites

The environment is the one 001 already defines — see `specs/001-ai-browser-assistant/quickstart.md` for the
test PKI, the deterministic service, and the page fixtures. This feature adds no prerequisite: it needs no new
permission, no new environment variable, and no new service.

## Commands

The existing verification path is unchanged. Run it in this order and check each exit code:

```powershell
npx tsc -b
npx tsc -p apps/extension --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npm test
npm run test:contract
npm run build:extension:test
$env:HALLPASS_PRODUCTION_EXTENSION_ID = "<a valid release extension id>"
$env:HALLPASS_PRODUCTION_HTTPS_ORIGIN = "https://api.product.example"
$env:HALLPASS_PRODUCTION_WSS_ORIGIN   = "wss://api.product.example"
npm run build
$env:HALLPASS_LOCALE = "en-US"; npm run test:e2e:extension-core
$env:HALLPASS_LOCALE = "zh-TW"; npm run test:e2e:extension-core
```

## Scenario 1 — Exclude one step and proceed (US-1)

**Setup**: a task that proposes a five-step plan against a fixture page.

**Do**: in the plan review, exclude step three, approve the remainder.

**Expect**:

- Steps one and two are observed as succeeded.
- Step three is never dispatched: no operation marker is ever written for it.
- If the service later requests step three, the request is refused and recorded as a **denial**, not a failure.
- The terminal outcome names the excluded step.

**Also check**: excluding every step is recorded as a denial, and no step executes.

**Recorded 2026-09-07** — packaged journey: `tests/e2e/packaged/task-mode.spec.ts` › "a plan step the
user removed never runs, and the steps after it still do" (excludes the middle step of a three-step
plan on the real fixture page).

- Steps around the exclusion observed as succeeded — that journey: the scroll moved and `notes` holds
  the entered text.
- The excluded step is never dispatched — that journey: `#clicked` still reads "not clicked yet" and
  no action card ever appears. That it never reaches admission, so no marker is written for it, is
  unit only: `apps/extension/tests/task-mode-controller.test.ts` › "refuses a sequence that includes a
  step the user removed".
- A later request for the excluded step is a **denial**, not a failure — unit only:
  `apps/extension/tests/control-port-task.test.ts` › "refuses a request for an excluded step as the
  user's denial, not a failure".
- The terminal names the excluded step — that journey (the terminal copy names two kept steps), plus
  `apps/extension/tests/side-panel-task.test.tsx` › "tells the user, on the terminal, which steps they
  left out" and "says nothing about exclusions on a terminal that had none".
- Excluding every step is a denial — unit only: `apps/extension/tests/control-port-task.test.ts` ›
  "records an approval that removes every step as a denial",
  `apps/extension/tests/side-panel-task.test.tsx` › "says that removing every step is the same as
  declining", and `tests/contract/task-channel.contract.test.ts` › "carries an exclusion set on a
  denial too, and admits no summary of it".
- The decision carries exactly what the panel showed — unit/contract:
  `apps/extension/tests/side-panel-task.test.tsx` › "carries exactly the steps the user removed into
  the decision the worker receives", `apps/extension/tests/control-port-task.test.ts` › "sends the
  service an approval naming exactly the steps the user removed" and "refuses the whole approval when
  an exclusion names a step the plan does not have", `tests/contract/task-channel.contract.test.ts` ›
  "accepts an approval that names excluded steps, and one that names none" / "refuses a decision that
  repeats a step or names one with no identity".

## Scenario 2 — A dependent step stops the run (US-1, edge case)

**Setup**: a five-step plan where step five acts on a control that step four would have revealed.

**Do**: exclude step four, approve, let the run proceed.

**Expect**: step five fails its own target revalidation, the run stops there, later steps do not execute, and
the terminal outcome names the exclusion as the reason. The stop is attributable to the user's decision, not
reported as an unexplained failure.

**Recorded 2026-09-07** — no packaged journey; covered by unit tests only.
`apps/extension/tests/control-port-task.test.ts` › "attributes a stop to the exclusion when a later
step fails its own target check" is the whole scenario: the dependent step fails its own
revalidation, nothing after it runs, and the terminal carries the exclusion record beside the run
record rather than a claimed cause. Two adjacent facts the same file pins:
"attributes nothing once a revision has revoked the plan the exclusion belonged to" and "reviews a
replacement plan afresh, carrying no exclusion over to it". The panel half — the stop named in the
plan card's own numbering — is `apps/extension/tests/side-panel-task.test.tsx` › "uses the plan card's
numbering when steps were left out".

## Scenario 3 — A run without a round trip per step (US-2)

**Setup**: an approved five-step plan.

**Expect**:

- The service and worker exchange one request-carrying frame, not five.
- Each step is still individually admitted, fenced, marked, dispatched, and verified — verify by the marker
  sequence, which must show a prepared/dispatched/observed cycle per step, not one cycle for the run.
- Steps run one at a time. No two markers are ever in the dispatched state simultaneously.

**Negative**: a multi-step request that is not bound to an approved plan is refused whole, before any step
runs.

**Recorded 2026-09-07** — packaged journeys: `tests/e2e/packaged/effect-verification.spec.ts` › "an
approved plan runs in one exchange and stops cleanly on an unverified step", and
`tests/e2e/packaged/task-mode.spec.ts` › "a ten-step plan interrupts the user only before it runs,
never per step" (samples every card the panel shows across a ten-step run; the set is exactly the
three pre-run cards, never one per step).

- One request-carrying frame, not five — both journeys above; the per-step marker evidence is unit
  only: `apps/extension/tests/control-port-task.test.ts` › "runs every step of one frame in order,
  each marked and verified on its own" asserts one sequence frame for three steps and the marker
  trace `prepare/dispatch/observe` three times over.
- Steps run one at a time, never two dispatched at once — the same unit test's marker trace (each
  step's cycle closes before the next opens), plus
  `apps/extension/tests/control-port-content-lifecycle.test.ts` › "refuses a request that arrives from
  outside the run while a step is in flight" / "refuses a sequence that arrives while a lone step is
  in flight" / "refuses the next lone plan step while the previous one is in flight".
- A sequence that is not bound to an approved plan is refused whole — unit/contract:
  `apps/extension/tests/control-port-task.test.ts` › "refuses a run that is not bound to any approved
  plan, whole, before any step" and "refuses a sequence that is not the approved plan's next steps in
  order, before any step"; `apps/extension/tests/task-mode-controller.test.ts` › "refuses a sequence
  that skips a kept step, cites another plan, or is not plan-bound" and "refuses any sequence for a
  task with no approved plan"; `tests/contract/task-channel.contract.test.ts` › "accepts an ordered
  sequence of plan-bound requests up to the injected bound" / "refuses a sequence containing anything
  that is not a step of one plan" / "reads the bound from the injected configuration, never a
  literal".

## Scenario 4 — A run stops cleanly (US-2)

Run each of these against an approved plan and confirm the remaining steps never execute:

| Interruption | Expected outcome |
| --- | --- |
| A step's effect cannot be verified | Run stops at that step; outcome distinguishes "stopped part-way" from "completed" |
| The user presses Stop mid-run | No further step dispatched; any step already dispatched reports uncertain, never succeeded |
| The bound document changes mid-run | Run stops; remaining steps unexecuted |

**Recorded 2026-09-07** — packaged journey: `tests/e2e/packaged/effect-verification.spec.ts` › "an
approved plan runs in one exchange and stops cleanly on an unverified step" (the first row of the
table, on the real page).

- Effect cannot be verified — that journey, plus `apps/extension/tests/control-port-task.test.ts` ›
  "stops at the first step whose effect cannot be verified and never prepares the rest" and "records
  that a step could not be carried out when the page refuses it".
- The user presses Stop mid-run — unit only:
  `apps/extension/tests/control-port-stop-delivery.test.ts` › "dispatches nothing further and reports
  the dispatched step as uncertain" and "does not claim the user pressed Stop when the channel
  interrupted the run".
- The bound document changes mid-run — unit only:
  `apps/extension/tests/control-port-task.test.ts` › "ends the run as document-changed when a step's
  page is no longer the page in front of the user".
- "Stopped part-way" is distinguishable from "completed" — `apps/extension/tests/side-panel-task.test.tsx`
  › "names the step a run stopped at and why", "says a completed run completed, and adds no reason",
  "says where a run stopped even when the worker was not told why", and "says which steps ran when the
  completed run had steps left out"; the run really ends there is
  `apps/extension/tests/control-port-stop-delivery.test.ts` › "refuses a continuation after a
  committed step failed, so the run really ends where it says", with
  `apps/extension/tests/task-mode-controller.test.ts` › "refuses a correct continuation once a
  committed step ended the run".

## Scenario 5 — Keyboard (US-3)

**Setup**: a fixture with a tag field, a combobox, and a single-input search form.

**Expect**:

- Committing a tag with the confirmation key succeeds and is verified.
- Moving between fields with the tab key succeeds.
- Pressing the confirmation key **in the search form is refused** with an explicit unsupported-capability
  result and no effect — its default action would submit and navigate, which stays out of scope.
- A key outside the named set is refused.
- A key press directed at a sensitive field is refused.

**Recorded 2026-09-07** — packaged journey: `tests/e2e/packaged/task-mode.spec.ts` › "the keyboard
commits two tags, and the same key is refused in the search form" (a five-step plan on the `/tags`
fixture, then the same key in the search form as a lone action).

- Committing a tag with the confirmation key, verified — that journey (both tags land, the field is
  empty again, the URL is unchanged), plus `apps/extension/tests/control-port-task.test.ts` ›
  "transmits a verified key press in its closed shape and names the key on the card" and
  `apps/extension/tests/content-runtime-effect-policy.test.ts` › "delivers the confirmation key to a
  tag field outside any form and verifies focus stayed".
- Moving between fields with the tab key — that journey's plan carries the Tab step; the shape and
  the one supported modifier pairing are `tests/contract/task-channel.contract.test.ts` › "accepts
  every key in the named set, and Shift only with Tab" and
  `apps/extension/tests/content-runtime-effect-policy.test.ts` › "delivers Shift+Tab with the modifier
  set and no default focus move".
- The confirmation key refused in the search form — that journey (the panel says denied, the box
  keeps its value, no navigation), plus
  `apps/extension/tests/content-runtime-effect-policy.test.ts` › "refuses the confirmation key in a
  search box whose form would submit, before any event", "refuses the confirmation key in a
  single-field form, where implicit submission still fires", "refuses the confirmation key where a
  submit image outside the form is associated with it", and "allows the confirmation key in a form
  with no submit button and more than one text field". The refusal is delivered as `denied` naming
  the guard; scenario 1b was restated to "explicit refusal result" on 2026-09-05 (spec change log), so
  the words and the wire agree.
- A key outside the named set is refused — unit/contract only:
  `tests/contract/task-channel.contract.test.ts` › "refuses a key outside the set, a press with no
  target, and anything beyond the shape"; the request frame never validates, so no journey can carry
  one.
- A key press at a sensitive field is refused — unit only:
  `apps/extension/tests/content-runtime-effect-policy.test.ts` › "refuses any key into a control the
  read policy withholds, even with a planted handle".
- A key whose target lost focus is uncertain, not success — unit only:
  `apps/extension/tests/content-runtime-effect-policy.test.ts` › "reports a key whose handler moved
  focus as delivered but unverified" and
  `apps/extension/tests/control-port-capability-delivery.test.ts` › "a key whose target lost focus
  ends the run but leaves the Plan and the page binding standing".

## Scenario 6 — Pointer gestures (US-4)

**Setup**: a fixture with a hover-revealed menu, a double-activation control, and a reorderable list.

**Expect**:

- Hover reveals the menu, and the reveal is observed before any dependent step proceeds.
- Double activation succeeds on a control the existing classification accepts.
- A drag succeeds only when **both** endpoints classify; if either does not, the request is refused.
- A drag whose document changes mid-gesture reports uncertain, never succeeded.
- A secondary-activation request is refused before any effect; on the wire, as a frame refusal that
  ends the channel (the request frame's `capability` is the closed `hallpass-v1` enum).

**Recorded 2026-09-07** — packaged journey: `tests/e2e/packaged/task-mode.spec.ts` › "a hover reveals
the menu and the plan opens an item within it" (the `/gestures` fixture; the item is hidden until the
page's own handler opens the menu).

- Hover reveals the menu, and the reveal is observed before the dependent step proceeds — that
  journey, plus `apps/extension/tests/content-runtime-effect-policy.test.ts` › "hovers a target with
  the pointer and mouse events its handlers listen for, and verifies it is still shown" and
  `apps/extension/tests/control-port-task.test.ts` › "transmits a verified hover in its closed shape
  and labels it view-only".
- Double activation succeeds on an accepted control — unit only:
  `apps/extension/tests/content-runtime-effect-policy.test.ts` › "double activates a control: two
  activations its handlers count, then the dblclick they listen for" and
  `apps/extension/tests/control-port-task.test.ts` › "transmits a verified double activation with its
  count and labels it an activation".
- A drag succeeds only when both endpoints classify — unit only:
  `apps/extension/tests/content-runtime-effect-policy.test.ts` › "drags one target onto another with
  the drag-and-drop sequence and verifies the element moved", "refuses a drag when either endpoint
  fails the click classification, before any event", "delivers no drop where the page did not accept
  the drag, and reports nothing moved", "does not mistake a scroll that moved both endpoints for a
  move, but sees a relative move", and "reports a drag the page ignored as delivered but unverified";
  the review card's second endpoint is `apps/extension/tests/side-panel-task.test.tsx` › "shows the
  drop target by its label and role, and never the opaque handle".
- A drag whose document changes mid-gesture is uncertain — unit only:
  `apps/extension/tests/content-runtime-effect-policy.test.ts` › "ends a drag whose document changes
  mid-gesture and reports the change, never success (T057)".
- Secondary activation is refused — unit/contract only:
  `apps/extension/tests/control-port-capability-delivery.test.ts` › "refuses secondary activation as
  an unsupported capability with no effect (002 US4, T058)" and
  `tests/contract/task-channel.contract.test.ts` › "does not let secondary activation be expressed
  under any name". In production the frame fails the closed capability enum before any handler runs,
  so the answer is a fail-closed frame refusal rather than an answered result — exactly what FR-025
  says since its 2026-09-07 amendment (option A, `contracts/README.md` §1.2).
- The closed shapes behind all three — `tests/contract/task-channel.contract.test.ts` › "advertises
  the three gestures as hallpass-v1 capabilities and in the hello", "closes each gesture's arguments: one
  target for hover and double activation, two distinct targets for a drag", and "closes each
  gesture's verified result around its evidence".

## Scenario 7 — Resolve by description (US-5)

**Expect**:

- A description matching one element resolves, and the review names the resolved element before any action
  uses it.
- A description matching nothing returns an explicit no-match; no action is attempted.
- A description matching more than the bound returns too broad — never a truncated list, never a silent choice.
- The response carries only review-card metadata. **No form value appears in it under any input.**

**Recorded 2026-09-07** — packaged journeys: `tests/e2e/packaged/task-mode.spec.ts` › "a description
resolves to one element, is named in the review, and is acted on; no match acts on nothing" (en-US
gate) and › "a zh-TW description resolves to the element it names, and one that names nothing acts on
nothing" (zh-TW gate only; the test skips itself in the other locale).

- One element resolves and the review names it before any action uses it — both journeys, plus
  `apps/extension/tests/control-port-task.test.ts` › "resolves to one target, names the description on
  the action card, and lets the action proceed" and
  `apps/extension/tests/side-panel-task.test.tsx` › "shows the description the target was resolved
  from beside the target".
- No match returns an explicit no-match and no action is attempted — both journeys' second half, plus
  `apps/extension/tests/control-port-task.test.ts` › "answers no-match and too-broad as results, with
  no action card and no effect".
- Too broad, never a truncated list and never a silent choice — unit/contract only:
  the same unit test, `apps/extension/tests/control-port-task.test.ts` › "returns several candidates
  within the bound, names the description on the chosen one's card, and names no single target on the
  strip", and `tests/contract/task-channel.contract.test.ts` › "answers with exactly one of three
  outcomes and never a truncated list". The matching rules themselves are
  `packages/domain/src/description-matching.test.ts` (16 cases across both scripts, including "names
  every sibling a broad description covers, which is what a bound is there to answer").
- Only review-card metadata, no form value under any input — contract only:
  `tests/contract/privacy-boundary.contract.test.ts` › "rejects any form-value representation,
  selector, or attribute on a candidate" and `tests/contract/task-channel.contract.test.ts` › "lets a
  candidate carry only what a review card shows"; the page's own reply carries handles and nothing
  else, pinned by `apps/extension/tests/control-port-task.test.ts` › "refuses a resolution naming a
  handle the worker never minted, rather than passing it off as no match".
- The consent that authorises it, and the notice's lifetime — unit only:
  `apps/extension/tests/control-port-capability-delivery.test.ts` › "refuses a resolution before the
  page-read consent exists, and one against a document it never bound (002 US5)", plus
  `apps/extension/tests/control-port-task.test.ts` › "takes the resolution notice off the strip when
  the grant it rode on is revoked" / "…when the document it named is replaced" / "reports a resolver
  that fails or finds the document gone without inventing an outcome".

## Scenario 8 — Wait for a condition (US-6)

**Expect**:

- A wait for an element to appear proceeds as soon as it appears.
- A wait whose condition never holds ends at its bound, with an outcome naming the unmet condition.
- Stop or a document change ends the wait immediately, and the dependent step does not run.
- A wait naming a target the worker does not hold is refused.

**Recorded 2026-09-07** — packaged journeys: `tests/e2e/packaged/effect-verification.spec.ts` › "an
approved plan waits for a result to appear and proceeds as soon as it does" and › "a wait whose
condition never holds ends at its bound and names why the run stopped".

- A wait for an element to appear proceeds as soon as it appears — the first journey, plus
  `apps/extension/tests/control-port-capability-delivery.test.ts` › "proceeds as soon as the condition
  holds, and reports how long it waited (002 US6)" and
  `apps/extension/tests/control-port-task.test.ts` › "proceeds as soon as the condition holds, and the
  run completes".
- A condition that never holds ends at its bound, naming the unmet condition — the second journey,
  plus `apps/extension/tests/control-port-capability-delivery.test.ts` › "ends a wait at its bound and
  leaves the step that depended on it unrun (002 US6)" and "ends at its bound even when the page never
  answers the poll it is inside (002 US6)"; the panel wording is
  `apps/extension/tests/side-panel-task.test.tsx` › "says what it will wait for, on which element, and
  for how long at most" with the run reason copy pinned by
  `tests/contract/locales.contract.test.ts` › "002 pins every run reason, wait condition, action, and
  resolution string in both locales".
- Stop or a document change ends the wait immediately and the dependent step does not run — unit
  only: `apps/extension/tests/control-port-content-lifecycle.test.ts` › "stops watching when the user
  presses Stop, and the dependent step does not run" and "ends as a stale context when the bound
  document changes, and the dependent step does not run"; the leased-tab rule is the same file's
  "keeps watching the leased tab while the user looks at another one".
- A wait naming a target the worker does not hold is refused — unit only:
  `apps/extension/tests/control-port-capability-delivery.test.ts` › "refuses a wait naming a target the
  worker does not hold, without asking the page (002 US6)", beside "ends a wait whose question could
  not be asked at all, and stops asking", "ends a wait as a stale context when the page no longer
  knows the handle", and "ends a wait whose grant the user took back while it watched".
- The shape and the plan-step-only rule — `tests/contract/task-channel.contract.test.ts` ›
  "advertises the wait as a capability that is never an action", "names one of the four conditions
  against a held target, inside an approved plan", "is bounded, and is a plan step rather than a lone
  instruction", "carries the wait as a plan step, checked like every other step's arguments",
  "answers a wait it observed, and never reports a bound as a success", and "names the two ways a wait
  ends unmet, and the run stop reason a bound produces".

## Regression gate — nothing was traded away

These must still hold after this feature, and are the check that the increment bought capability without
spending guarantees:

- Every executed step still produces a verified record of whether its effect occurred.
- The dispatch fence still prevents a duplicate effect.
- A worker restart mid-run still recovers the write-ahead markers and reports the interrupted step as
  uncertain.
- The production manifest declares the same five permissions and no host permission. The manifest contract
  test passes unchanged — if it needed changing, this feature has exceeded its scope.

## Gate result 2026-09-07 (T092)

Both packaged gates on one final `dist/test` build, sequentially: en-US 19 passed / 1 skipped (the zh-TW-only
resolution journey), zh-TW 20 passed. Unit 59 files / 656, contract 11 files / 141, three typechecks clean.
The production build is blocked by the owner-held production Extension ID environment variable (WP7 D6), as
before.

Re-run after the four owner decisions of the same day (FR-025/FR-026 wording, T064-1, T064-2): unit 59 / 658,
contract 11 / 144, gate en-US 19 passed / 1 skipped, gate zh-TW 20 passed, on the rebuilt `dist/test`.
