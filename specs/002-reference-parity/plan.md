# Implementation Plan: Reference Parity — First Increment

**Branch**: `002-reference-parity` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-reference-parity/spec.md`

## Summary

Close the highest-value capability gaps found in the reference-extension analysis, limited to what the already
approved permission surface allows. Six user stories: per-step plan exclusion, plan-bound sequential execution
without a round trip per step, keyboard keys, the remaining pointer gestures, resolving an element from a
description, and waiting for an observable condition.

The technical approach is deliberately conservative. A run is a **transport grouping**, not a new execution
mode: several capability requests travel in one frame, and each is admitted, revalidated, fenced, marked,
dispatched, and verified by the same path a single request takes today. That choice is what keeps the change
inside 001/FR-005, which forbids batch execution but defines batch as parallel or bulk effects *without*
per-step validation and explicitly excludes an approved plan executed and verified sequentially.

No Product Requirement is added. No permission is added. One approved requirement is amended, recorded as
FR-028 and traced through the change log.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node 24, strict, with `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess` already enforced across the workspace.

**Primary Dependencies**: Zod for every closed schema at a trust boundary; React 19 with Vite 8 for the side
panel; Fastify 5 for the product service. No dependency is added by this feature — constitution Article X
requires every new dependency to trace to an approved requirement, and nothing here needs one.

**Storage**: Chrome extension session storage for transient task and marker state. Nothing durable is added:
runs, waits, and resolutions are all transient, consistent with 001's transient-data rule.

**Testing**: Vitest across three projects (unit, contract, jsdom UI), plus Playwright against the packaged
extension in real Chrome for the observable journeys.

**Target Platform**: Chrome Manifest V3 — service worker, side panel, dynamic injection into the ISOLATED
world only. Unchanged.

**Project Type**: Browser extension plus a product-controlled service, in an npm workspace.

**Performance Goals**: The measurable target is SC-013 — a ten-step task interrupts the user at most twice.
Round trips per approved plan drop from one per step to one per run. No latency budget is set on the service.

**Constraints**: Zero new browser permissions; the production manifest must be byte-identical in its declared
permission surface. Every added action must be locally classifiable, non-navigating, and not a form
submission. Every effect must remain independently verified.

**Scale/Scope**: One extension, one service, six user stories, four new capabilities, two changed channel
payloads, one changed panel projection.

No `NEEDS CLARIFICATION` remains: Q-021 through Q-023 were answered by the product owner, and R-020 through
R-026 in [research.md](./research.md) resolve the design unknowns.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 design. Result: PASS with one recorded amendment.*

| Article | Assessment |
| --- | --- |
| **I. Product Requirements are the source of truth** | PASS. Every story traces to PR-004, PR-005, or PR-008, all already approved MUST. No reference-extension behaviour becomes a requirement by itself: each is justified by the requirement it deepens, and the analysis is cited as evidence, never as rationale. |
| **II. Clean-room** | PASS. No reference source, asset, identifier, or private protocol is copied or adapted. The spec, plan, data model, and contracts name no module, message, or tool from either reference extension; those names stay in `docs/` as evidence. |
| **III. Traceability** | PASS. The spec carries a traceability table from each FR to its PR, its 001 requirement, and its reference feature. No reference feature changes destination. |
| **IV. Explicit uncertainty** | PASS. Three decisions were raised rather than assumed and are recorded with options and consequences; all three are now answered. R-022 raised a fourth issue found during research and resolved it by tightening the spec rather than by inference. |
| **V. Least-privilege** | PASS, and strengthened. FR-030 forbids any permission addition, SC-018 states it as a user-facing outcome, and the quickstart's regression gate fails the increment if the manifest contract test needs changing. |
| **VI. Privacy, consent, data minimisation** | PASS. No data category is added. Element resolution is bounded to review-card metadata and may never read or report form values. Consent lifetime stays bound to the current task and document — cross-task memory was deliberately excluded from this increment. |
| **VII. Observable and testable** | PASS. Every story has independent acceptance scenarios; success criteria are user-facing and measurable; the quickstart states the observable evidence for each. |
| **VIII. Manifest V3 baseline** | PASS. No deviation is proposed. |
| **IX. Requirements before architecture** | PASS. The spec states behaviour only. This plan is the first artifact that chooses structure, which is the phase where that is permitted. |
| **X. Dependency discipline** | PASS. No dependency added. |
| **XI. Defined failure behaviour** | PASS. Failure is specified for every added capability: refusal on unclassifiable targets, refusal for a submitting or navigating key, uncertain rather than succeeded for an interrupted drag, an explicit bound outcome for a wait, and an explicit too-broad outcome for a resolution. |
| **XII. Specification before implementation** | PASS. Specification and clarification gates completed before this plan; no source is written by this phase. |

**Amendment recorded, not a violation**: FR-028 amends 001/FR-005's statement that the executable action set is
"exactly" three actions. This is a change to an approved requirement, made deliberately and with the product
owner's agreement, and it preserves every constraint that requirement places on the original set. It is
recorded in the spec's Requirements section, its traceability table, and its change log. `permission-matrix.md`
is untouched, because the amendment adds no permission.

### Post-Design Constitution Check

Re-evaluated after Phase 1. Result unchanged: PASS. The design added no dependency, no permission, no data
category, and no durable storage. One finding during Phase 0 required a specification edit rather than a design
workaround — R-022 established that an unqualified confirmation key would violate the two 001/FR-005
constraints FR-028 promises to preserve. Tightening FR-024 and restating SC-015 kept Article I intact; carrying
the inconsistency into the design would not have.

## Project Structure

### Documentation (this feature)

```text
specs/002-reference-parity/
├── spec.md              # Feature specification (speckit-specify)
├── clarifications.md    # Q-021 – Q-023, asked and answered
├── checklists/
│   └── requirements.md  # Specification quality checklist — all items pass
├── plan.md              # This file
├── research.md          # Phase 0 — R-020 – R-026
├── data-model.md        # Phase 1 — entities, invariants, risk mapping
├── contracts/
│   └── README.md        # Phase 1 — the three interfaces that change
├── quickstart.md        # Phase 1 — how to prove it works
└── tasks.md             # Phase 2 — NOT created by this command
```

### Source Code (repository root)

The workspace already has its shape; this feature adds no top-level directory. The areas it touches:

```text
packages/contracts/src/          Closed schemas at every trust boundary:
                                 the new capability requests and results, the request
                                 sequence, the plan decision's exclusion set, the
                                 terminal outcome's exclusion reference, the named key
                                 set, and the wait condition vocabulary.

packages/domain/src/             Pure decision logic, no I/O:
                                 the submission guard for a key press, endpoint
                                 classification for a drag, risk classification for the
                                 added actions, plan-step approval state, and run
                                 position and stop-reason state.

apps/extension/src/
  service-worker/                Admission of a request sequence against an approved
                                 plan, per-step fence and marker sequencing across a
                                 run, refusal of excluded steps, run stop handling, and
                                 the wait lifecycle.
  content-runtime/               Delivery and verification of the added gestures and
                                 key presses, local evaluation of wait conditions, and
                                 description resolution bounded to review metadata.
  side-panel/                    Per-step exclusion in plan review, and naming a
                                 resolved element before an action uses it.

apps/server/src/                 The deterministic service side of the sequence frame,
                                 for test and journey coverage only. No product API
                                 endpoint changes.

specs/001-ai-browser-assistant/contracts/
                                 task-channel.md and extension-runtime.md gain the
                                 sequence frame, the exclusion set, the added
                                 capabilities, and the wait and resolution shapes.

tests/                           Contract tests for every new closed shape; packaged
                                 journeys for the eight quickstart scenarios; the
                                 existing manifest contract test must pass unchanged.
```

**Structure Decision**: the existing workspace layout is kept exactly. The feature is a deepening of three
established seams — the closed contract schemas, the worker's admission and dispatch path, and the content
runtime's effect-and-verify path — not a new component. The one structural rule this plan sets is that a run
must not become an object with its own execution semantics: it is a position over an approved plan, and every
step continues to travel the single-step path.

## Complexity Tracking

No constitution violation requires justification. The table is intentionally empty.

## Phase Status

- [x] Phase 0 — research complete, all unknowns resolved ([research.md](./research.md))
- [x] Phase 1 — design complete ([data-model.md](./data-model.md), [contracts/](./contracts/README.md), [quickstart.md](./quickstart.md))
- [ ] Phase 2 — task breakdown (`speckit-tasks`, not created by this command)
