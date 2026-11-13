# Implementation Plan: The Pointer Says What the Agent Is Doing

**Branch**: `worktree-spec-033-cursor-action-label` (from private main 14dcad0; spec 9000dd1) | **Date**:
2026-11-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/033-cursor-action-label/spec.md`, approved by the owner on
2026-11-13 including D-033-1..5.

## Summary

Every tool call on a held tab sends the page one *pointer step* (localised caption + `travel` / `stay` /
`rest`) from the single dispatch seam (R-491). Pointer gestures keep sending the existing cursor move,
now with an optional `press` for the ripple (R-492). The page draws the caption as generated content so
it is never page text (R-494), places it inside the viewport by a pure function (R-495), moves the
pointer along a planned, distance-aware, slightly curved path with a small settle and tilt (R-496), rests
it bottom-left for non-pointing tools (R-497) and rings on press (R-498). If measurement confirms the
marks appear in agent captures, the agent-facing captures hide them for the shot and always restore
them (R-499).

## Technical Context

**Language/Version**: TypeScript, Chrome MV3 service worker + content runtime (Vite bundle)

**Primary Dependencies**: none added (Web Animations API and generated content are platform features)

**Storage**: none

**Testing**: vitest `unit` (node, and jsdom via docblock for page modules), `contract`; live check in the
attached test Chromium and the owner's Chrome (quickstart)

**Target Platform**: Chrome ≥ the manifest's minimum, all platforms the extension supports

**Project Type**: browser extension + stdio MCP server (npm workspaces); only the extension changes

**Performance Goals**: no gesture waits more than 420 ms for the pointer (SC-221); a caption appears with
its call, without delaying it (the step is fire-and-forget)

**Constraints**: clean room (own words, numbers, shapes); MCP protocol unchanged; no new permission;
no text node carries caption words; marks hidden for agent captures only, GIF frames keep them

**Scale/Scope**: one pointer per held tab, top frame only (unchanged)

## Constitution Check

| Principle | Status |
|---|---|
| I. Requirements are the source of truth | Pass. Every behaviour traces to D-033-n and FR-499..511 |
| II. Clean room | Pass. Observable behaviour only; phrases, numbers, path shape and DOM approach are Hallpass's own |
| III. Traceability | Pass. R-491..499 cite FRs; tasks cite R and FR ids |
| IV. Explicit uncertainty | Pass. FR-509 is gated on measurement T980 |
| V. Least privilege | Pass. No permission, no host access change |
| VI. Consent and privacy | Pass. Captions carry only tool name parameters the owner's agent already sent (host, query, keys), cut to 20 characters, shown only on the owner's own page; nothing leaves the browser |
| VII. Testable | Pass. Pure functions for words, placement and motion; jsdom tests for the page; live checks per story |
| VIII. MV3 | Pass |
| IX. Requirements before architecture | Pass. Spec approved 2026-11-13 |
| X. Dependencies | Pass. None added |
| XI. Failure behaviour | Pass. Page without listener, refused call, hidden tab, navigation, failed capture and missing animation support are specified |
| XII. Spec before implementation | Pass |

Re-check after design: unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/033-cursor-action-label/
├── spec.md
├── plan.md              # this file
├── research.md          # R-491..R-499
├── data-model.md
├── quickstart.md
├── contracts/page-pointer-messages.md
└── checklists/requirements.md
```

### Source Code (touched areas)

```text
apps/extension/src/service-worker/agent-tools/pointer-captions.ts   # A: new, tool+args -> {words, mode}
apps/extension/src/service-worker/agent-runtime.ts                  # A: dispatchTool sends the step
apps/extension/src/service-worker/agent-tools/input.ts              # A: cap 420 ms, press flag
apps/extension/src/locales/en-US.ts, zh-TW.ts                       # A: agent.pointer.* keys
apps/extension/src/content-runtime/cursor-motion.ts                 # B: new, planTravel
apps/extension/src/content-runtime/cursor.ts                        # B: animation, caption, rest, ring, fade
apps/extension/src/content-runtime/caption-placement.ts             # B: new, placeCaption
apps/extension/src/content-runtime/agent-entry.ts                   # B: pointer-step route; C: marks route
apps/extension/src/content-runtime/indicator.ts                     # C: pill/glow honour hidden marks
apps/extension/src/service-worker/agent-tools/reads.ts, effects.ts  # C: hide around agent captures
```

## Slices and order

| Slice | Stories / FR | Risk | Owns | Depends on |
|---|---|---|---|---|
| M - measurement | FR-509 gate | none | no code; one live screenshot (T980) | - |
| A - worker words and step | US1, US2 (worker side); FR-499, 506, 508, 510 | none | pointer-captions.ts, agent-runtime.ts `dispatchTool`, input.ts, locales, their tests | - |
| B - page drawing | US1-US4 (page side); FR-500..507, 511 | none (live-verifiable UI) | cursor.ts, cursor-motion.ts, caption-placement.ts, agent-entry.ts, their tests | message shapes in the contract (settled here) |
| C - captures hide marks | US4; FR-509 | R1 (hide must always be undone) | reads.ts, effects.ts capture wrappers, agent-entry.ts marks route, indicator.ts, cursor.ts hidden rule, tests | M confirms; B merged (shares cursor.ts, agent-entry.ts) |

Wave 1: M (main, live) alongside A and B in parallel (disjoint files; the contract fixes the message
shapes both sides validate). Wave 2: C, only if M confirms; otherwise FR-509 is recorded as not needed
with the measurement as evidence.

Implementers: A and B go to `implementer-sonnet` (method and numbers settled in research). C goes to
`implementer-sonnet`, then `code-reviewer` (R1: hide/restore lifecycle).

Closing evidence: unit tests per slice; code-reviewer on C; one planned final verification (typecheck,
`npm test`, build, `test:contract`, `snapshot:check`); live checks 1-6 of the quickstart by main in the
attached test Chromium with GIFs; owner's look in branded Chrome after reload.

## Complexity Tracking

None. One new internal message (and one more if C is needed), three small pure modules, no store, no
dependency, no protocol change.
