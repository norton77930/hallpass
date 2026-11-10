# Implementation Plan: Outside-Agent Consent and Capture Experience

**Branch**: `031-outside-agent-experience` (not created yet) | **Date**: 2026-11-08 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/031-outside-agent-experience/spec.md`. D-031-1..13 were
approved by the owner on 2026-11-08. R-457 and R-466 propose two amendments that await the owner's
confirmation (see "Open for the owner").

## Summary

Ask an outside agent's consent question in the agent's own client through MCP form elicitation, at the
same time as the side-panel card. The first answer wins, and the client may grant only once or for this
session. Diagnostics tools ask instead of refusing. Screenshots stop bringing tabs to the front where
measurement shows it is safe, a minimized window is reported, and the debugger is released when idle.
The worker stays the only judge: the host relays a question out and an answer back (R-450).

## Technical Context

**Language/Version**: TypeScript, Node ≥ 24 (host), Chrome MV3 service worker + React side panel

**Primary Dependencies**: `@modelcontextprotocol/sdk` 1.32.2 (already present; low-level request API for
`elicitation/create`, R-451). No new dependency.

**Storage**: `chrome.storage.session` for session grants (R-456); existing `site-mode-store` for
always/diagnostics.

**Testing**: vitest `unit` / `extension-ui` / `contract`; packaged Playwright gate (attach mode) with a
scripted elicitation-capable fake client.

**Target Platform**: Windows 11 first (owner); the host changes are platform-neutral (spec 028).

**Project Type**: browser extension + stdio MCP server (npm workspaces)

**Performance Goals**: a question appears in the client within 1 s of the raise; screenshots no slower
than today's path.

**Constraints**: closed `strictObject` schemas; relay carries no policy; spec 012 picture contract
unchanged; no new browser permission.

**Scale/Scope**: one question per session at a time (unchanged); N sessions on one relay (unchanged).

## Constitution Check

| Principle | Status |
|---|---|
| I. Requirements are the source of truth | Pass. Every behaviour traces to D-031-n or FR-467..483 |
| II. Clean room | Pass. Reference products only informed what to measure. No code, identifiers or protocol copied; the reference's private host protocol is a non-goal |
| III. Traceability | Pass. R-450..466 cite FRs; tasks will cite R and FR ids |
| IV. Explicit uncertainty | Pass. R-462/R-463 are measurements gating slice 3; client rendering is a live check |
| V. Least privilege | Pass. No new permission; the terminal can grant only session-bounded consent (D-031-2) |
| VI. Consent and privacy | Pass with attention. A new place an answer can come from; bounded by D-031-2/3/5 and code review (R2) |
| VII. Testable | Pass. Every story has an automated gate plus the listed live checks |
| VIII. MV3 | Pass |
| IX. Requirements before architecture | Pass. The spec is approved; architecture is chosen here |
| X. Dependencies | Pass. None added |
| XI. Failure behaviour | Pass. Decline/cancel/no-capability/timeout/stale-site/minimized are all specified |
| XII. Spec before implementation | Pass, once the two amendments below are confirmed |

Re-check after design: unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/031-outside-agent-experience/
├── spec.md
├── plan.md
├── research.md          # R-450..R-466
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── terminal-consent.md
│   └── capture.md
├── checklists/requirements.md
└── tasks.md             # next: /speckit-tasks
```

### Source Code (touched areas)

```text
packages/contracts/src/agent-tools.ts         # prompt-raised / prompt-answer / prompt-settled, effect-decide flags,
                                              # diagnostics card kind, window-minimized code, sentences
packages/agent-host/src/mcp-server.ts         # capability read, elicitation ask/abort per call, answer frame
packages/agent-host/src/relay-mux.ts          # keep call routable after prompt-raised
apps/extension/src/service-worker/
├── agent-tools/prompts.ts                    # one 120 s bound, ticks at every raise, decideByCall, settle events
├── agent-tools/gate.ts                       # covered-by-plan-or-grant input (unchanged rule)
├── agent-tools/effects.ts, dialogs.ts, batch.ts  # session grant read + write; in-flight hold per call
├── agent-tools/diagnostics.ts                # ask instead of refuse; re-check site; session/always
├── agent-tools/input.ts                      # holder accessor, in-flight count, idle drop, focus emulation hook
├── agent-tools/photograph.ts, chrome-adapters/capture.ts  # non-activating path per R-462, minimized check
├── session-grant-store.ts                    # new
├── agent-runtime.ts, agent-bridge.ts         # wiring, attention rule, features, frames
└── chrome-adapters/windows.ts                # window state read
apps/extension/src/side-panel/agent/PromptCard.tsx, SessionCard.tsx  # This session button, diagnostics card, grant source
```

**Structure Decision**: existing workspaces only. One new worker module (`session-grant-store.ts`).

## Slices and order

1. **Slice A - terminal consent (US1, US2)**: contracts -> worker bound/ticks/badge/decideByCall/session
   grants -> host elicitation -> panel buttons and grant source -> packaged gate with the fake client.
   R2: `code-reviewer` after the slice, then the owner's live checks 1-2.
2. **Slice B - diagnostics ask (US3)**: depends on A's question channel and grant store. R2:
   `code-reviewer`.
3. **Slice C - capture and debugger (US4, US5)**: independent of A/B in files except `effects.ts` (the
   in-flight hold). It starts with the R-462/R-463 measurement; implementation follows the measured
   outcome. Review: `code-reviewer` on the attach/detach lifecycle; live checks 3-5.

A and C can run in parallel after C's measurement, with `effects.ts` edits serialized (A owns the
grant read; C owns the in-flight hold, landed after A).

## Amendments (both confirmed by the owner, 2026-11-08; spec.md amended)

1. **R-457 - dialog OK under a session grant**: D-031-8 says "the same page actions spec 017 admits" and
   also "dialog OK is asked each time". Spec 017 admits dialog OK. Recommendation: follow 017 (dialog OK
   is covered).
2. **R-466 - diagnostics keeps the debugger**: D-031-13 names recording and viewport as the reasons to
   keep the attachment. Console and network history live on the attachment, so idle release would lose
   it. Recommendation: diagnostics in use also keeps it.

## Complexity Tracking

No constitution violations.
