# Implementation Plan: Consent Follow-ups After the Terminal Trial

**Branch**: `032-consent-followups` (not created yet; spec and plan written on `031-outside-agent-experience`,
private main 37037d9) | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/032-consent-followups/spec.md`, approved by the owner on
2026-11-09 including D-032-1..5.

## Summary

Raise the site-transition question and the site-plan question to the agent's client through the existing
spec 031 `prompt-raised` / `prompt-answer` path, with only session-bounded answers (R-484, R-485). Measure
every question's host keep-alive from when it was shown, not from when the call was admitted (R-486).
Make a site revoke remove that site from every session-scoped admission store (R-487). Note one activity
line per settled consent question (R-488). After a worker restart, arm the idle release for attachments
nothing claims (R-489), and pin that a screenshot past its bound already drops its hold (R-490). The worker
stays the only judge; the host only asks and relays (031 R-450).

## Technical Context

**Language/Version**: TypeScript, Node ≥ 24 (host), Chrome MV3 service worker + React side panel

**Primary Dependencies**: none added. `@modelcontextprotocol/sdk` 1.32.2 (already present, 031 R-451).

**Storage**: existing `chrome.storage.session` keys `agentSessionGrants`, `agentSessionSitePlans`,
`agentTransitionsAllowed` gain a per-site removal; `agentTransitionAllowances` (local, *always*) is untouched.

**Testing**: vitest `unit` / `extension-ui` / `contract`; packaged Playwright gate (attach mode) with the
031 scripted elicitation-capable fake client; one owner live check.

**Target Platform**: Windows 11 first (owner); host changes platform-neutral (spec 028).

**Project Type**: browser extension + stdio MCP server (npm workspaces)

**Performance Goals**: a transition or site-plan question appears in the client within 1 s of the raise
(as 031 SC); the idle release after a restart lands within 30 s of worker start (SC-218).

**Constraints**: closed `strictObject` schemas; the relay carries no policy; host and extension versions
stay pinned to each other (`tool-offering.ts`), so the frame change ships in one release; no new browser
permission; clean room.

**Scale/Scope**: one question per session at a time (unchanged); N sessions on one relay (unchanged).

## Constitution Check

| Principle | Status |
|---|---|
| I. Requirements are the source of truth | Pass. Every behaviour traces to D-032-n and FR-484..498 |
| II. Clean room | Pass. No reference material is used; this builds on Hallpass's own 031 design |
| III. Traceability | Pass. R-484..490 cite FRs; tasks will cite R and FR ids |
| IV. Explicit uncertainty | Pass. R-490 starts with a pinning test and only changes code if it fails; client rendering of the new wording is a live check |
| V. Least privilege | Pass. No permission; client answers stay session-bounded (D-032-1) |
| VI. Consent and privacy | Pass with attention. Two more questions can be answered from the client and a revoke now reaches session admissions; R2 code review on slices A and B |
| VII. Testable | Pass. Every story has an automated gate; US1 also a packaged gate and an owner live check |
| VIII. MV3 | Pass |
| IX. Requirements before architecture | Pass. Spec approved 2026-11-09 |
| X. Dependencies | Pass. None added |
| XI. Failure behaviour | Pass. Decline, dismiss, no capability, timeout, late answer, revoke while pending and restart are specified |
| XII. Spec before implementation | Pass |

Re-check after design: unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/032-consent-followups/
├── spec.md
├── plan.md              # this file
├── research.md          # R-484..R-490
├── data-model.md
├── quickstart.md        # owner live check + packaged gate run
├── contracts/
│   ├── terminal-consent-032.md   # prompt-raised kinds transition / site-plan
│   └── activity-consent.md       # activity item kind "consent"
└── checklists/requirements.md
```

### Source Code (touched areas)

```text
packages/contracts/src/agent-tools.ts               # A: promptRaisedFrameSchema; C: agentActivityItemSchema
packages/agent-host/src/terminal-consent.ts         # A: per-kind message and choice titles
packages/agent-host/src/router.ts                   # A: cap from the tick's own raise (R-486)
apps/extension/src/service-worker/agent-tools/prompts.ts   # A: raise transition + site plan; decideByCall for site plan; immediate tick. C: concluded callback
apps/extension/src/service-worker/session-grant-store.ts   # B: forgetSite
apps/extension/src/service-worker/site-plan-store.ts       # B: forgetSite
apps/extension/src/service-worker/transition-store.ts      # B: forgetSessionPairsTo
apps/extension/src/service-worker/agent-runtime.ts         # B: clearSiteMode wiring; C: noteActivity on concluded
apps/extension/src/side-panel/agent/SessionCard.tsx (+ agent-panel-keys.ts)  # C: consent sentence
apps/extension/src/service-worker/agent-tools/input.ts     # D: restart reconciliation
```

## Slices and order

| Slice | Stories | Risk | Owns | Depends on |
|---|---|---|---|---|
| A - more questions in the client, full wait | US1, US2, US3 | R2 (how consent is obtained) | contracts `prompt-raised`, terminal-consent.ts, router.ts, prompts.ts, their tests | - |
| B - revoke clears session admissions | US4 | R2 (how consent is revoked) | the three stores, agent-runtime.ts `clearSiteMode`, their tests | - |
| C - activity names the answer | US5 | none beyond review of A/B | contracts activity schema, prompts.ts concluded callback, agent-runtime.ts noteActivity, SessionCard, panel keys | A and B (shares prompts.ts, agent-runtime.ts, contracts) |
| D - debugger cleanup | US6 | none (test-only after R-489 was revised: the start-up reconciliation already releases left-over attachments) | agent-screenshot test | - |

Wave 1: A and B in parallel (disjoint files; A must not edit agent-runtime.ts, because the transition and
site-plan asks already hand prompts.ts what it needs). Wave 2: C and D in parallel (D owns input.ts only;
the reconciliation runs where input attachments are created, so it needs no runtime edit).

Implementers: A and B go to `implementer` at effort high (they change how consent is approved and revoked).
C goes to `implementer-sonnet` (settled method, contract given here). D goes to `implementer` at effort high
(lifecycle across restart).

Closing evidence: code-reviewer on A+B (R2) and on D (R1, lifecycle); a packaged gate for US1/US2 with the
031 fake elicitation client; one planned final verification (typecheck, `npm test`, build, `test:contract`,
`snapshot:check`); one owner live check (quickstart check 1, Chrome covered, real cross-site move).

## Complexity Tracking

None. No new store, frame type or dependency. The `prompt-raised` frame widens by two kinds and two
optional fields, and the activity item widens by one kind and three optional fields.
