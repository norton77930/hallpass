# Clarifications: Reference Parity — First Increment

**Feature**: `specs/002-reference-parity` · **Created**: 2026-09-04
**Status**: Q-021 through Q-023 answered 2026-09-04; the five implementation follow-ups resolved 2026-09-07; nothing open.

Identifiers continue the sequence used in `specs/001-ai-browser-assistant/clarifications.md` (Q-001–Q-020)
so a question is unambiguous across the project.

---

## Q-021 — Is secondary (context-menu) activation in scope?

**Related requirement**: FR-025 · **Impact**: scope · **Blocking level**: BLOCKS-PLANNING

**Context**

Both reference extensions expose a secondary-activation gesture. In Claude in Chrome it is one of the
`computer` actions; the teardown records it as present but does not establish what it is used for.

The difficulty is what the gesture produces. On most pages, secondary activation opens the browser's own
context menu — chrome that lives outside the page. The product cannot see it, cannot operate it, and has no
approved capability that would let it. The gesture only has an effect the product can act on when the page
itself intercepts it and renders its own menu, which is a minority of pages.

So the gesture is either (a) genuinely useful on the pages that handle it themselves, or (b) an action that
usually opens something the assistant then cannot use, leaving the browser in a state the user did not ask
for and must dismiss.

**What we need to know**: Should this increment include secondary activation?

| Option | Answer | Implications |
| ------ | ------ | ------------ |
| A | Exclude it from this increment | FR-025 covers double activation, hover and drag only. No behaviour is lost today, since the product cannot perform it now either. Revisit if a real task needs it. |
| B | Include it, restricted to pages that handle it themselves | Requires the product to establish, before acting, that the page intercepts the gesture — and to refuse otherwise. Adds a precondition no other action has, and it is not obvious it can be established reliably. |
| C | Include it unconditionally | Simplest to build, but the assistant can leave a browser menu open that it cannot close, and the user has to clear it. Contradicts the existing rule that an action must have a verifiable observable effect. |
| Custom | Provide your own answer | For example: include it only behind an explicit per-action consent regardless of plan approval. |

**Unapproved recommendation**: **A**. The gesture's value is unestablished and option C conflicts with the
effect-verification rule the product already enforces. Excluding it costs nothing that exists today.

**Resolved 2026-09-07 (option A)** — secondary activation stays out of scope; the implementation is A-compatible.

---

## Q-022 — When a user excludes a step, what happens to the steps after it?

**Related requirement**: FR-021 · **Impact**: scope, user experience · **Blocking level**: BLOCKS-PLANNING

**Context**

Step-level exclusion is the point of User Story 1. But plan steps are frequently dependent: step 5 types into
a field that step 4 opened. If the user excludes step 4 and the product runs step 5 anyway, step 5 acts on a
page that is not in the state the plan assumed. The product's per-step revalidation would usually catch this —
the target would not be found — but "usually" is not a specification.

The product cannot determine dependency from the plan itself; a plan states an order, not a dependency graph,
and inferring one would be the product guessing at the service's intent.

**What we need to know**: After an excluded step, how should the remaining steps be treated?

| Option | Answer | Implications |
| ------ | ------ | ------------ |
| A | Run the remaining steps; rely on per-step revalidation to stop anything that no longer applies | Simplest and most permissive. A dependent step fails its target check and stops the run, so the failure is safe — but the user sees a task that stopped part-way rather than a clear "you removed something this needed". |
| B | Stop the run at the excluded step; steps after it do not run | Safest and easiest to explain: "everything before your exclusion ran; nothing after it did." Costs the user the value of later independent steps, and makes exclusion close to truncation. |
| C | Ask the service for a replacement plan that omits the excluded step | Keeps the plan coherent, but turns one user gesture into a new review cycle — which is most of what User Story 1 was trying to avoid. |
| Custom | Provide your own answer | For example: run the remainder, but present the exclusion in the terminal summary so a part-way stop is attributable. |

**Unapproved recommendation**: **A, with the exclusion named in the outcome**. Per-step revalidation already
exists and is the mechanism that makes A safe; B discards value the user did not ask to discard; C reintroduces
the round trip the feature exists to remove. The addition of naming the exclusion in the terminal outcome is
what turns A's part-way stop from confusing into explicable.

---

## Q-023 — Does resolving a description disclose more than page-read already authorizes?

**Related requirement**: FR-026 · **Impact**: security/privacy · **Blocking level**: BLOCKS-PLANNING

**Context**

Resolving "the search box" to a target means examining candidate elements and reporting back enough for the
service to choose. The product already has an authorized data category for the bounded metadata of a target it
is about to act on. Resolution differs in two ways: it examines elements the product is *not* about to act on,
and it may report several candidates rather than one.

Whether that is the same disclosure or a wider one is a product decision, not something to infer. The existing
rule is strict — general page-read consent does not authorize form values, which needed its own disclosed
grant — so the precedent is that a wider disclosure gets its own consent.

**What we need to know**: How should description resolution be authorized?

| Option | Answer | Implications |
| ------ | ------ | ------------ |
| A | Treat it as covered by the page-read consent already obtained for the task | No new consent step; resolution is simply a read of the page the user already allowed reading. Relies on the disclosure limit in FR-026 to keep the candidate set small. |
| B | Cover it under page-read, but cap the disclosure at one candidate | The service never sees alternatives; either the description is unambiguous or it fails. Strictest reading, and it makes "too broad" the common failure for loose descriptions. |
| C | Give it its own disclosed grant, as form values have | Most consistent with the existing precedent for a wider category, but adds a consent step to a capability whose whole purpose is to reduce friction. |
| Custom | Provide your own answer | For example: A, but the review card names the resolved element so the user sees what was matched before any action uses it. |

**Unapproved recommendation**: **A, with the resolved element shown in the review** (which SC-019 already
requires). Resolution reads the same page under the same consent and reports structural metadata already in an
authorized category; the candidate cap plus showing the match in review addresses the "wider than one element"
concern without a second consent step. Option C is defensible and is the conservative choice if you would
rather set the precedent that any widened read gets its own grant.

---

## Answers recorded 2026-09-04

| Question | Answer | Where it landed in the spec |
| --- | --- | --- |
| Q-021 | **A** — exclude secondary activation from this increment | FR-025 (refused before any effect; amended 2026-09-07 to say how that reads on the wire — see the Q-021 follow-up below); out-of-scope statement |
| Q-022 | **A** — run the remaining steps; per-step revalidation stops a dependent one; name the exclusion in the terminal outcome | FR-021; User Story 1 scenarios 5 and 6; Edge Cases |
| Q-023 | **A** — covered by the page-read consent already obtained, bounded candidates, resolved element named in the review | FR-026; SC-019 |

All three were answered as recommended. No question remained open at planning time. Implementation later surfaced five follow-up decisions, recorded below. All five were resolved on 2026-09-07: Q-021 follow-up (FR-025 wording vs. the wire, option A), Q-023 follow-up 1 (zh-TW descriptions, option A, delivered by T074a), Q-023 follow-up 2 ("one target" wording, option A), T064-1 (a revoked general grant now expires the approved Plan, option A) and T064-2 (`reasonCode` bounded on the wire). Nothing is open.

---

## Wording tension found during User Story 4 implementation (2026-09-05) — owner decision

**Q-021 follow-up.** FR-025 says a secondary-activation request is "refused with an explicit unsupported-capability
result and no effect". As built, that is true only at the worker's admission seam. On the real task channel the
request frame's `capability` is the closed `hallpass-v1` enum (001 T004/T005), so a frame naming `browser.context-click`
(or any name outside the profile) fails the frame schema: the client closes the channel on `invalid-frame` and the
task halts as a lifecycle interruption, before any handler runs. Fail-closed, no effect, no disclosure — but not an
*answered* result. Pinned in `apps/extension/tests/task-channel-lifecycle.test.ts`; recorded in `contracts/README.md`
§1.2 and the spec change log.

Two ways to make the words and the wire agree:

- **A (recommended)** — amend FR-025 to "refused before any effect; on the wire, as a frame refusal that ends the
  channel". Keeps the closed capability enum, which is the property 001 relies on for every deferred capability.
  No code change.
- **B** — widen the request frame's `capability` to any string so the worker can answer `unsupported` per request.
  Trades away the closed enum at the frame boundary for one explicit result; every deferred capability (navigation,
  capture, downloads) would then reach the worker's admission path instead of being refused at the frame.

Nothing in User Story 4 depends on the choice; the implementation is A-compatible today.

**Resolved 2026-09-07 (option A)** — FR-025 amended; no code change.

---

## Deviations found during User Story 5 implementation (2026-09-05) — owner decisions

**Q-023 follow-up 1 — zh-TW descriptions.** FR-026 is a MUST for "a natural-language description". As built,
matching splits the description into words on letter/digit boundaries and compares whole words against the label,
a button's text and an English role vocabulary ("box", "field", "button", "dropdown"). A zh-TW description is one
word, so it matches only when it equals a whole label word - in practice, when the label is written the same way.
The packaged zh-TW gate is not evidence against this: its resolution journey submits English descriptions. The
Constitution asks a deviation to name the rule, a time-bounded remediation and explicit approval; this note names
the rule, and the remediation is `tasks.md` T074a (a segmenting tokenizer and a zh-TW role vocabulary, with the
matching rules moved to `packages/domain` where the sibling policies live). Options:

- **A (recommended)** — approve the deviation with T074a scheduled before Polish (Phase 9), so the zh-TW gate can
  gain a zh-TW resolution journey before T091/T092 run.
- **B** — treat User Story 5 as incomplete for zh-TW until T074a lands, and say so in the release notes.

**Resolved 2026-09-07 by T074a (option A)**: `matchDescription` in `packages/domain` now segments a description
written without word breaks, carries a zh-TW role vocabulary beside the English one, and the packaged zh-TW gate
has a zh-TW resolution journey of its own (`/localized`).

**Q-023 follow-up 2 — "one target" wording.** FR-026 and data-model.md say a resolution answers "one target, no
match, or too broad"; Q-023 option A (chosen) contemplated several bounded candidates and rejected the one-candidate
cap. As built, `resolved` carries one to `maxResolutionCandidates` candidates; the worker never chooses among them,
the service does, and the card of the action names both the chosen element (worker-held label) and the description.
Recommended: amend FR-026's wording to "one or more bounded candidates" (no code change). Alternative: tighten to
option B (exactly one candidate or too-broad), which is a one-line change in the contract and the runtime.

**Resolved 2026-09-07 (option A)** — wording amended; no code change.

## Deviations found during T064a/T064b (2026-09-07) — owner decisions

**T064-1 — a revoked general grant does not expire an approved Plan.** When the user revokes the general page-read
grant mid-task, the worker drops every page binding and target (`forgetPage("page-changed")`) but leaves the approved
Plan standing; a document change expires the Plan at the same point. Later steps fail closed (`stale-context`), so
nothing runs without authority, but the panel keeps showing a Plan that can no longer run. Options: **A
(recommended)** — expire the Plan on general-grant revocation exactly as on a document change (one line in the
revocation handler plus a test, FR-020/FR-008 unchanged); **B** — keep as is and let the next step's refusal end the
run. Not changed in T064b because it is a product decision, not a shape bug.

**Resolved 2026-09-07 (option A)** — the general-grant revocation handler now expires the approved Plan exactly as
the document-change handler does; a later plan step is refused `denied` / `plan.expired` instead of `stale-context`.
A Plan still awaiting review was left alone at this point (superseded by the follow-up resolved below), and a step already in flight keeps its own revocation answer
(`denied` / `grant-revoked`). FR-020/FR-008 unchanged. The run reason the panel shows names the revocation
(`step-not-admitted`), not a document change that never happened.

Open follow-up: a plan still *proposed* (not yet decided) when the general grant is revoked keeps its card but its
binding is forgotten; a reconnecting panel gets no card and the task stalls until Stop — refusing the proposal on
revocation (denied to the service, cancellation terminal) is the recommended fix, not done here.

**Resolved 2026-09-07** — revoking the general page-read grant while a Plan is still *proposed* now ends the task
locally through the same teardown the bound-document-change path uses: one terminal projected to the panel
(`cancellation` / `plan.grant-revoked`, or `attention-required` when an earlier effect was already transmitted as
uncertain) and a `lifecycle-interruption` Stop on the channel. No plan decision is sent to the service — the user
withdrew the page-read the Plan rode on, they did not deny the Plan, so naming it `denied` would misreport their
decision. Only the reason code and the summary (`status.planGrantRevoked`) differ from the document-change path; the
teardown itself is now one shared helper (`endTaskForLostProposal` in `control-port.ts`). Test: "withdraws a pending
Plan review when the general page-read grant is revoked (%s)" in `apps/extension/tests/control-port-task.test.ts`.

**T064-2 — `reasonCode` is an unbounded string on the wire.** `worker.task.terminal.reasonCode` and the task channel's
terminal `reasonCode` are `z.string().min(1)`; one worker path forwards the service's value, and T064b now exposes it in
the side panel DOM as `data-reason-code` for the packaged driver. It is never page-authored and the value was already
on the frame and in panel state, so no new boundary is crossed; the hardening is a contract change (`.max()` plus a
code pattern) that belongs to the owner. Recommended: bound it to 80 characters and `^[a-z][a-z0-9.-]*$` in a Polish
pass (T085/T086 doc sync would then name it).

**Resolved 2026-09-07** — `REASON_CODE_PATTERN` (`^[a-z][a-z0-9.-]*$`) and `REASON_CODE_MAX_CHARS` (80) are
protocol constants in `@hallpass/contracts`, applied to `server.terminal.reasonCode`, `worker.task.terminal.reasonCode`,
the unavailable `worker.service.state.reasonCode` and the optional `worker.context.state.reasonCode`. Every producer
in `apps/extension/src`, `apps/server/src`, `packages/test-kit/src` and the fixtures was already a conforming code,
so no producer needed normalising; the stop and cancel vocabularies were already closed enums. The auth projection's
same-family field is named `reason`, not `reasonCode`; it carries the same kind of value and is now bounded by the
same schema (its only producer is the literal `auth.account-mismatch`). Recorded in the 001 contract docs.
