# Implementation Plan: Stop the Agent from the Page

**Branch**: `spec-034-pill-stop` (from private main a71f19e; spec 8d79ec3) | **Date**: 2026-11-15 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/034-pill-stop/spec.md`, approved by the owner on 2026-11-15
including D-034-1..9.

## Summary

The pill gets Stop (and, while held, Resume). A trusted press sends a new internal message with a reply
(R-517); the worker decides the session from the sender's tab lease (R-522). For an outside session it
sets a *hold* - a memory mirror backed by `chrome.storage.session`, loaded before the first call after a
worker start (R-513) - then ends the calls in flight the way Interrupt does (R-515). `handleToolCall`
refuses every call of a held session with the new stop reason `owner-held` before anything reaches a
page (R-512, R-516). Every pill of the session is redrawn held, from the same indicator composer that
answers a navigating page (R-518), and gets a "Stopped" pointer caption (R-519). The side-panel card
shows the hold and its own Resume through a new panel command (R-521). For a side-panel conversation the
press forwards the conversation's own Stop and holds nothing (R-520). Holds end with Resume or the
session (R-514).

## Technical Context

**Language/Version**: TypeScript; Chrome MV3 service worker, content runtime (Vite bundle), React side panel

**Primary Dependencies**: none added

**Storage**: `chrome.storage.session`, one new key (holds by session id); same lifetime as site plans

**Testing**: vitest `unit` (worker, jsdom page modules), `extension-ui` (side panel), `contract`;
packaged gate in the attached test Chromium (quickstart)

**Target Platform**: Chrome ≥ the manifest minimum, all platforms the extension supports; side-panel
conversations Windows-only as before

**Project Type**: browser extension + stdio MCP server (npm workspaces); the host's code does not change

**Performance Goals**: pill shows the held state within 1 s of the press (SC-225); a held call is
refused without any page round trip

**Constraints**: clean room; no new permission; only `owner-held` changes what agents see; page words
are the worker's; a hold never lifts by itself

**Scale/Scope**: one hold per session; pills in the top document of each held tab

## Constitution Check

| Principle | Status |
|---|---|
| I. Requirements are the source of truth | Pass. Every behaviour traces to D-034-n and FR-512..525 |
| II. Clean room | Pass. The reference was read for observable behaviour only (spec Facts); the hold, its messages and its words are Hallpass's own |
| III. Traceability | Pass. R-512..523 cite FRs; tasks will cite R and FR ids |
| IV. Explicit uncertainty | Pass. Activity lines not surviving a restart is stated as a known limit (R-521) |
| V. Least privilege | Pass. No permission, no host access change |
| VI. Consent and privacy | Pass. The hold stores a session id, a time and a tab id, in session storage only; nothing leaves the browser beyond the refusal the agent already receives |
| VII. Testable | Pass. Worker gate, store, trust and page states are unit-tested; each story has a packaged-gate scenario |
| VIII. MV3 | Pass |
| IX. Requirements before architecture | Pass. Spec approved 2026-11-15 |
| X. Dependencies | Pass. None added |
| XI. Failure behaviour | Pass. Undelivered press, worker restart, navigation, end of session, a tab no longer held, page-made clicks and a missing broker are specified |
| XII. Spec before implementation | Pass |

Re-check after design: unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/034-pill-stop/
├── spec.md
├── plan.md              # this file
├── research.md          # R-512..R-523
├── data-model.md
├── quickstart.md
├── contracts/pill-messages.md        # internal: indicator, press + reply, panel command
├── contracts/agent-stop-reason.md    # agent-facing: owner-held
└── checklists/requirements.md
```

### Source Code (touched areas)

```text
packages/contracts/src/agent-tools.ts                         # K: owner-held, HELD_HINT, session-resume, heldAt, activity kinds
tests/contract/agent-tools-014.contract.test.ts               # K: pinned reason list
apps/extension/src/locales/en-US.ts, zh-TW.ts                 # K: every new key (R-523)
apps/extension/src/service-worker/hold-store.ts               # W: new
apps/extension/src/service-worker/agent-runtime.ts            # W: gate, press handler, conversation route, clears, projection
apps/extension/src/service-worker/agent-tools/indicator.ts    # W: composer modes and words
apps/extension/src/service-worker/agent-panel-port.ts         # W: session-resume route
apps/extension/src/content-runtime/indicator.ts               # P: Stop/Resume controls, held drawing, retry, not-delivered
apps/extension/src/content-runtime/agent-entry.ts             # P: press with reply
apps/extension/src/side-panel/agent/SessionCard.tsx           # S: held state, Resume
apps/extension/src/side-panel/agent/AgentShell.tsx            # S: send session-resume
apps/extension/src/side-panel/agent-panel-keys.ts             # S: activity labels
tests/e2e/packaged/agent-pill-stop.spec.ts                    # L: quickstart scenarios 1-11
```

## Slices and order

| Slice | Stories / FR | Risk | Owns | Depends on |
|---|---|---|---|---|
| K - contracts and words | FR-521, 523, 525; D-034-9 | exposed interface (agent-facing reason) | `packages/contracts/src/agent-tools.ts` and its tests, `agent-tools-014.contract.test.ts`, both locale files | - |
| W - worker hold | US1-US4 worker side; FR-513..520, 522 (reply) | R1: trust decision, hold lifecycle across restart and session end | `hold-store.ts`, `agent-runtime.ts`, `agent-tools/indicator.ts`, `agent-panel-port.ts`, their tests | K merged |
| P - pill on the page | US1, US2, US5 page side; FR-512, 522, 524 | none (live-verifiable UI; trust is the existing `isTrusted` seam) | `content-runtime/indicator.ts`, `agent-entry.ts`, their tests | K merged; message shapes fixed in contracts/pill-messages.md |
| S - side-panel card | US2 panel side; FR-520 | none (live-verifiable UI) | `SessionCard.tsx`, `AgentShell.tsx`, `agent-panel-keys.ts`, their tests | K merged |
| L - live stories | quickstart 1-11 | none | `tests/e2e/packaged/agent-pill-stop.spec.ts`, fixture registration if a page is needed | W, P, S merged |

Wave 1: K alone (`implementer-sonnet`; the content is fully given by research and the contracts).
Wave 2: W, P and S together - three writers in this checkout, the burst case: they own disjoint files,
K settles every shared interface, and their checks are unit tests with no shared outputs.
W goes to `implementer` at effort `high` (trigger: security logic - it decides which session a page press
acts on - and lifecycle across worker restart and session end). P and S go to `implementer-sonnet`.
Wave 3: L (`implementer-sonnet`), then main runs it in the attached test Chromium and captures the
screenshots; US4 is checked by hand on Windows.

Reviews: `code-reviewer` on K + W once wave 2 is merged (R1: trust and hold lifecycle);
`architecture-reviewer` on K (the agent-facing stop reason). P, S and L close on live verification.

Closing evidence: unit tests per slice; the two reviews; one planned final verification (typecheck,
`npm test`, build, `test:contract`, `snapshot:check`); the packaged-gate stories by main; the owner's look
in branded Chrome after reload (SC-231).

## Complexity Tracking

| Addition | Why it is needed | Simpler alternative rejected because |
|---|---|---|
| A storage-backed hold with a load barrier | D-034-5: a worker restart must not lift a hold | memory only would silently resume after a restart |
| A reply channel for two content messages | D-034-7: the page must know whether Stop landed | fire-and-forget gives the page nothing to wait on |
| A new agent-facing stop reason | D-034-9: neither existing reason is true of a hold | reusing `owner-stopped` tells the agent the session ended, `owner-interrupted` that it may continue |
