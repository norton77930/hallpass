# Implementation Plan: Consent per Site for Embedded Frames

**Branch**: `030-frame-site-consent` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/030-frame-site-consent/spec.md`

## Summary

Today every effect is gated by the tab's top-level site. The frame that holds the target is found only
after the gate (`effects.ts:1693-1736`), and a frame's origin is what the frame says about itself. This
plan changes the order. Before the gate, the extension finds the target frame without scrolling. It sets
the **deciding site** from the browser:
- for element references, the sender origin of a message from the claimed frame (R-440);
- for coordinate actions, a debugger hit-test (R-442).

The gate then decides on that site's mode and plan (R-444). The prompt gains an optional `frame` field,
and Allow always stores the frame's site (R-445). Right before the gesture, the frame's site is checked
again (R-446). Reads label frames and references from other sites (R-448). Two browser measurements
(M1, M2) come first, because R-441 and R-442 depend on them.

## Technical Context

**Language/Version**: TypeScript, Node >= 24, Chrome MV3

**Primary Dependencies**: existing only: React side panel, zod contracts, the Chrome debugger and
messaging already in use. No new dependency or manifest permission.

**Storage**: the existing site-mode and site-plan stores. Only the key a frame decision writes changes.

**Testing**: vitest `unit` / `extension-ui` / `contract`. New packaged gate
`tests/e2e/packaged/agent-frame-consent.spec.ts` on the attach recipe.

**Target Platform**: Chrome, Edge and Brave on Windows 11, plus Linux and macOS for the bridge.

**Project Type**: browser extension plus a local MCP host

**Performance Goals**: an element-reference action adds one frame enumeration (`executeScript` across
all frames, no scrolling) before the gate on every page, since a reference carries no frame identity.
A target in the top frame gets no probe. A target in a child frame adds one sender probe before the gate,
or one hit-test walk for a coordinate action, and one again before dispatch. (Amended after T892. The
first goal of zero extra round trips on pages with only one document could not be met without that
enumeration.)

**Constraints**: nothing on the page moves before the owner answers. An unknown site never runs without a
prompt. Same-site prompts and answers stay byte-for-byte unchanged (SC-206).
The debugger is now acquired before the gate for point targets and `upload_image` drops, so Chrome's
"being debugged" bar can appear for an action the owner then refuses. A drop whose attachment cannot be had
asks as an unknown site.
In round trips: each element-ref action costs one all-frames enumeration plus one content round trip per
child frame, and this is repeated at delivery. Keys sent with no target (T908) cost one all-frames focus read
plus one sender probe when focus is in a child frame, and the same again right before the first key.

**Scale/Scope**: about 12 source files in `apps/extension/src/service-worker/agent-tools/`, `gate.ts`,
the prompt card, `packages/contracts/src/agent-tools.ts`, and fixtures and tests.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Note |
| --- | --- | --- |
| I. Product requirements | PASS | Every change traces to FR-450..466 |
| II. Clean room | PASS | Behaviour described in our own words; no reference code |
| III. Traceability | PASS | R-440..449 cite FRs; tasks will cite R/FR/SC |
| IV. Explicit uncertainty | PASS | M1/M2 are named as measurements, each with a fail-closed fallback |
| V. Least privilege | PASS | No new permission; debugger and messaging are already used |
| VI. Consent | PASS | The feature narrows consent to the acting site; an unknown site always asks |
| VII. Testable | PASS | Every story maps to a packaged-gate row in quickstart.md |
| VIII. MV3 | PASS | Service-worker only; no persistent background |
| IX. Requirements before architecture | PASS | Spec 030 approved before this plan |
| X. Dependencies | PASS | None added |
| XI. Failure behaviour | PASS | Each failure path resolves to "unknown, ask" or "cancelled, frame moved" |
| XII. Spec first | PASS | Spec committed 9c27acc |

**Post-design re-check**: still PASS. O-030-1 is resolved: the owner put `file_upload` and `upload_image`
into child frames under FR-454.

## Project Structure

### Documentation (this feature)

```text
specs/030-frame-site-consent/
├── plan.md
├── research.md          # R-440..449, M1/M2
├── data-model.md
├── quickstart.md
├── contracts/prompt-and-reads.md
└── tasks.md             # next: speckit-tasks
```

### Source Code (touched)

```text
packages/contracts/src/agent-tools.ts                    # prompt.frame, frame/ref/find site, tool text
apps/extension/src/service-worker/agent-tools/
├── gate.ts                                              # GateInput.site: SiteOrigin | null
├── frame-site.ts                                        # NEW: pure deciding site, hit-test and focus walks
├── frame-consent.ts                                     # NEW: deciding site -> gate, prompt, answer (both runners)
├── frame-focus.ts                                       # NEW: all-frames focus read (T908)
├── upload.ts                                            # drop point and ref by frame site
├── effects.ts                                           # pre-gate claim, deciding site, store key, re-check
├── site-recheck.ts                                      # frame answer family (R-447)
├── refs.ts / frames.ts / reads.ts                       # scroll-free discovery, read labels
└── computer.ts                                          # coordinate frame lookup before the gate
apps/extension/src/chrome-adapters/frame-sender.ts       # NEW: sender-origin probe (T891)
apps/extension/src/chrome-adapters/main-world-marks.ts   # NEW: read the point nonce across frames
apps/extension/src/content-runtime/index.ts              # answer the site probe message
apps/extension/src/side-panel/agent/PromptCard.tsx       # frame wording, no Allow always when unknown
tests/harness/page-fixtures.ts + pages                   # sandboxed, srcdoc, about:blank, nested, navigating
tests/e2e/packaged/agent-frame-consent.spec.ts           # NEW gate
```

**Structure Decision**: the existing layout. `frame-site.ts` keeps "which site decides" pure, next to
the pure gate; `frame-consent.ts` is the one place that joins it to the browser reads and to the
runners' gate input, prompt and answers (review round 1 removed a drifting copy in `upload.ts`).

## Slices (order)

1. **M1 + M2 measurement**: a throwaway gate spec on the fixtures, which records the answers in
   research.md. It decides R-441 and R-442.
2. **Gate and contracts**: `site: null`, `prompt.frame`, schema tests (unit + contract).
3. **Element-reference path**: scroll-free claim, sender-origin site, store key, re-check, answers.
4. **Coordinate path**: hit-test walk before the gate and before dispatch.
5. **Card**: frame wording, Allow always hidden for an unknown site (extension-ui test plus a gate
   screenshot).
6. **Reads, tool text and `propose_sites` text**.
7. **Packaged gate and the SC-206 regression gates**.

Slices 3 and 4 share `effects.ts`, so they are serialized. Slices 5 and 6 can run in parallel after slice 2.

**Risk**: security logic (consent decisions), R1 or more. At completion, `code-reviewer` reviews the work,
and `architecture-reviewer` reviews the gate input and prompt contract change.

## Complexity Tracking

No violations.
