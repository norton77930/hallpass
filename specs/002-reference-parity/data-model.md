# Phase 1 Data Model: Reference Parity — First Increment

**Feature**: `specs/002-reference-parity` · **Date**: 2026-09-04

Entities are described by what they mean and what must hold true of them. Every shape here is closed: an
unknown field is a validation failure, not an ignored extra. Existing entities from 001 are listed only where
this feature changes them.

---

## Changed entities

### Plan Decision

The record of what the user decided about a proposed plan.

| Field | Meaning | Rules |
| --- | --- | --- |
| plan identity | Which plan, at which version, with which digest | Unchanged from 001; a decision that does not cite the current proposal is refused |
| decision | Approved or denied | Unchanged |
| decision identity | Stable identifier for this decision | Unchanged |
| **excluded steps** | The step identifiers the user removed | **New.** Each MUST name a step of the cited plan. Duplicates are a validation failure. Excluding every step MUST be recorded as a denial rather than an approval with an empty remainder. |

**State transitions**: a plan moves from proposed to approved-with-exclusions or denied, and never back. A
replacement proposal starts a fresh review; exclusions do not carry across proposals. An approved plan expires
when the authority every step was reviewed under goes away: the bound document changes, or the user revokes the
general page-read grant the task holds. A later step of an expired plan is refused as expired.

### Plan Step

One proposed action inside a plan.

| Field | Meaning | Rules |
| --- | --- | --- |
| step identity | Stable identifier within the plan | Unchanged |
| binding digest | Fixes the capability, purpose, data categories, expected context, and arguments | Unchanged; still the sole test of whether a request matches the step it claims |
| **approval state** | Approved, or excluded by the user | **New.** Derived from the plan decision, not authored by the service. An excluded step is never dispatched and never observed. |

### Task Terminal Outcome

| Field | Meaning | Rules |
| --- | --- | --- |
| outcome, reason code, summary | Unchanged from 001 | |
| **excluded step record** | Which steps the user removed from the plan this task ran, each with the position it was reviewed under | **New, optional.** Every exclusion, not the first, and carried whatever the outcome: it is a record of the user's decision, not a claimed cause. A part-way stop is then attributable to their own decision rather than reported as an unexplained failure, and a completed run still says that the plan approved and the plan shown were not the same. Empty once no approved plan governs the task. |

---

## New entities

### Run

The execution of the approved steps of one approved plan.

| Field | Meaning | Rules |
| --- | --- | --- |
| plan identity | The approved plan the run executes | A run without an approved plan is refused |
| ordered steps | The approved, non-excluded steps in plan order | Order is the plan's; the run may not reorder, substitute, or re-derive |
| position | Which step is next | Advances only after the previous step is observed. Reported to the user as the reviewed position on the plan card (`stoppedAt`), never as a count of kept steps, so it agrees with the excluded-step record on the same terminal |
| stop reason | Why the run ended | One of: all steps observed (`completed`), a step was refused after commit — its grant revoked, the runtime's own policy refused it at effect time, or its approved Plan was expired by a general-grant revocation (`step-not-admitted`), a step could not be carried out once it reached the page — no target, an executor that failed (`step-failed`), a step's effect could not be verified (`effect-unverified`), the user stopped (`user-stopped`), the bound document changed (`document-changed`), or a wait reached its bound (added with User Story 6). `step-failed` was added during implementation: FR-022 names "authorization, target, or effect" as the three things a step may fail to establish, and the original list had no name for the middle one. Only the first reason is kept, and only a step committed to dispatch — or an expired plan — records one. |

**Invariants**

- A run is a sequence of independently gated steps, not an atomic unit. Every step is admitted, fenced,
  marked, dispatched, and verified exactly as a single step is.
- A run never runs two steps concurrently.
- A run stops at the first step it cannot admit or verify; later steps are never prepared.
- Stopping a run leaves earlier steps observed and later steps untouched. There is no rollback.

### Key Press

| Field | Meaning | Rules |
| --- | --- | --- |
| key | One of the named set | Outside the set is refused |
| modifiers | Optional combination | Outside the supported combinations is refused |
| target | The focused element of the bound document | Must pass the existing sensitivity classification |
| submission guard | Whether the key's default effect on this target would submit a form or navigate | Established locally. True, or not establishable, refuses the request |
| delivery | Keyboard events dispatched to the control | The browser's default action does not run: a synthetic key cannot submit a form, follow a link, or move focus by itself. What a key does is what the page's own handlers make of it; the tab key moves focus only where the page moves it |
| verification | The focused element kept its identity | Checked once the document is known to be intact. A press whose handler moved focus is reported uncertain with its own cause, which leaves the document binding and the plan where they were; codes and what each leaves standing: `contracts/README.md` §1.2 |
| refusal | A denial naming its cause | Transmitted as `denied` with a code naming the guard; never `failed` or `unsupported`. Vocabulary: `contracts/README.md` §1.2 |

**Named set**: confirmation, tab, shift+tab, escape, the four arrow keys, home, end, backspace, delete.
The set is closed; it is a contract value, not a configuration value.

**Reach**: the target must pass the classification text entry already applies (001/FR-004, FR-005), which
today admits only controls whose name is in the closed ordinary allow-list. A field named `tags` or `keywords`
is therefore not reachable for a key press, exactly as it is not for text entry; SC-015 is met on a tag field
the allow-list admits. Widening the list is a sensitivity-policy decision, not part of this feature.

### Pointer Gesture

| Field | Meaning | Rules |
| --- | --- | --- |
| kind | Double activation, hover, or drag | Secondary activation is not a member; a request naming it is refused |
| target | The element acted on | Must pass the existing click classification |
| second target | The drop target, for a drag only | Must independently pass the same classification; the stricter of the two decides |
| delivery | The events the page's own handlers listen for | Pointer and mouse events for a hover; two activations then `dblclick` for a double activation; the HTML drag-and-drop sequence for a drag. The browser's default actions do not run and CSS `:hover` does not match, so a stylesheet-only menu stays closed while a script-driven one opens |
| verification | Evidence the page cannot fake | Hover: the target is still connected and rendered (`targetVisible`). Double activation: the activation count rose by two. Drag: the dragged element's document order relative to the drop target, or its position on screen relative to the drop target, changed (`moved`); a drop is delivered only where the page accepted the drag by cancelling `dragover`. The review card names both endpoints (`dropTargetLabel`, `dropTargetRole`), present exactly for a drag. Missing evidence is uncertain with its own cause (`target-not-visible`, `not-moved`); a document changed mid-gesture ends the gesture before the drop and is `document-changed`. Vocabulary: `contracts/README.md` §1.2 |
| reach | Which elements a gesture can target | The same handles a click can target: the collector mints them only for `<button type="button">` and ordinary text controls. A gesture can reach nothing a click could not |

### Wait

| Field | Meaning | Rules |
| --- | --- | --- |
| condition | Present, absent, enabled, or visible-text-changed, stated against a target the worker already holds | A condition naming an unheld target is refused. Arbitrary selectors and expressions are not expressible. |
| bound | Maximum duration | Required, injected as a bounded configuration value; an unbounded wait is not expressible |
| ended by | Condition observed, bound reached, stop, or document change | A revoked page-read grant ends it too, as `denied` / `grant-revoked` out of the dispatch vocabulary. `WAIT_END_REASONS` names only what a wait names on its own: `bound-reached` and `document-changed` |
| which tab it watches | The leased tab, never whichever tab is active | A wait performs no effect, so a tab switch during it does not end it; the dependent action step is still refused unless the leased tab is active. A leased tab that is gone, or that no longer shows the task origin, is `stale-context` |
| how the bound is kept | A worker-owned timer, armed once for the whole wait | Not only checked between polls: one poll carries the page port's own ten-second deadline, which can outlast a short wait. When the timer fires the wait ends at its bound and the poll's late reply is ignored |
| where it may appear | A plan step, and a plan is never only waits | `planProposedPayloadSchema` requires at least one action step: a plan of nothing but waits performs nothing it was approved for |
| authority | What admits a wait | An approved plan step, and nothing else: `executionBinding.mode` must be `approved-plan-step`, so a lone wait is not expressible. It also needs the task's active general page-read grant, like a resolution. No card is opened |
| how it observes | What the worker asks, and how often | One question per poll to the content runtime about one held handle, answered with a boolean; the poll interval is an implementation constant (250 ms), not a product bound. Nothing else about the page travels back |
| text baseline | What `visible-text-changed` compares against | The element's own trimmed text as it was when the handle was minted, kept beside the handle in the page and never projected. It is not the label, and it is never matched against by a description |
| what it is not | Why it carries no risk and no marker | It dispatches nothing: no consent card, no operation marker, no risk classification, and the task is not recorded as having run a browser effect. Vocabulary: `contracts/README.md` §1.3 |

### Element Resolution

| Field | Meaning | Rules |
| --- | --- | --- |
| description | The natural-language phrase to resolve | |
| outcome | One or more bounded candidates (at most `maxResolutionCandidates`), no match, or too broad — the service chooses among several and the acting step's card names both the chosen element and the description | Never a truncated list, and never a silent choice among candidates |
| candidate metadata | For each candidate: role, length-capped label, control kind | Exactly the metadata a review card already displays. Form values are never read or reported. |
| bound | Maximum candidates before the outcome becomes too broad | Injected bounded configuration value (`maxResolutionCandidates`) |
| matching | How a description is compared with an element | Token by token against the label, a button's visible text and a small role vocabulary ("box", "field", "button", "dropdown", and its zh-TW half "按鈕", "欄位", "選單", "東西"); words with no meaning ("the", "click", "請") are dropped first, and every remaining token must match. Space-delimited text is matched whole word; text written without word breaks is segmented (`Intl.Segmenter`) and matched by containment in the label, or as the affix such a language writes a kind word as ("備註欄位" = "備註" plus "欄位"). Containment stops at the names' own segments, by one rule and no other: a hit must begin and end where a segment does, and so must the remainder of a phrase carrying a kind word. Accepted limitations, all erring to too-broad or no-match: a modifier ICU segments on its own leaves the base word matchable ("安全動作" names "不安全動作", "刪除按鈕" names "取消刪除"), so sibling controls ("密碼", "確認密碼", "新密碼" under "密碼欄位") are answered too-broad past the bound rather than narrowed; a description ICU glues to a content word is not noise-stripped; a host without `Intl.Segmenter` falls back to plain containment, where a fragment such as "全動" does name "安全動作". Noise is never removed from inside a word for a kind ("輸入框" opens with the noise word "輸入") or from a name a segmenter split into lone characters ("點餐"). Without a segmenter the run is matched by plain containment, with no boundary rule. A description that was nothing but noise words is matched literally instead, so a control labelled only "Click" is reachable. Only elements the document still shows count. The rule is the pure `matchDescription` in `packages/domain`; the content runtime keeps liveness and the bound |
| authority | What admits a resolution | The active general page-read grant of the task (Q-023) and a document the worker bound; no card is opened |
| provenance | Which description a target came from | Remembered per handle and shown as `resolvedFrom` on the card of the action that uses it; the last resolution is shown on the context strip |

---

## Risk classification

The closed risk vocabulary is unchanged. The added actions map onto it:

| Action | Risk |
| --- | --- |
| Hover | view-only |
| Double activation | activation |
| Drag | activation, decided by the stricter of its two endpoints |
| Key press | activation |
| Wait | not an action; carries no risk label and is never consented separately |
| Element resolution | not an action; a read under the task's existing page-read consent |

Any target whose classification cannot be established reports `unclassified` and the request is refused.

---

## What deliberately does not change

- Consent lifetime stays bound to the current task and current document.
- The data categories stay as they are; nothing here introduces a new one.
- The dispatch fence, the write-ahead operation marker, the effect verification rule, the runtime epoch, and
  the channel lease keep their existing per-step semantics.
- The declared permission surface is untouched.
