# Implementation Plan: A Session Site Plan — The Agent Names Its Sites Up Front, the Owner Approves Once

**Branch**: `017-session-site-plan` (git: `worktree-relay-no-cross-browser-supersede`) | **Date**: 2026-10-02 | **Spec**: [spec.md](./spec.md)

**Input**: Approved spec (D-017-1 … 9); [research.md](./research.md) R-245 – R-253; private evidence 017;
worker, host, panel and contracts sources at 8ff9ee8 (0.9.0 + two-browser relay fix).

## Summary

One new agent tool, one new question card, one new per-session grant, one new gate input. The agent
calls `propose_sites` (R-248); the worker validates and raises a site-plan card through the existing
prompt controller (R-247); the owner unticks and approves; the approved origins go into a
per-session store in session storage (R-246). Every gated call computes "this session's plan covers
this tab's origin" and hands it to the one gate, which admits covered page actions without a card
(R-245, R-250); page JavaScript and uploads are never covered. Batches on covered `follow-a-plan`
sites skip the per-batch plan card (R-249, D-017-9). The session card shows the plan and withdraws it
(R-252). Older extensions answer `unavailable` (R-251). 0.10.0.

## Technical Context

**Language/Version**: TypeScript 5 on Node 24 (host, contracts), MV3 extension (worker, React panel);
Vitest (unit, extension-ui, contract); Playwright packaged gate.

**Primary Dependencies**: none new.

**Storage**: `chrome.storage.session` key `agentSessionSitePlans` (new, additive).

**Testing**: unit (gate matrix, store lifetime, prompt subset, validation), contract (tool schema,
panel schema, covered-set pin, versions), extension-ui (card, session card), packaged gate
`agent-site-plan.spec.ts` on Chromium 151 attach with real side panel; owner branded Chrome; probe S17.

**Target Platform**: Chrome / Chromium / Edge MV3 on Windows (as 0.9.0).

**Project Type**: browser extension + local MCP host (apps/extension, packages/agent-host,
packages/contracts).

**Performance Goals**: one session-storage read per gated call (already done for transitions); no
added latency elsewhere.

**Constraints**: authorization change (R2): the agent can never approve (FR-253); link protocol stays
2; strict schemas, additive only; no new permission; public docs carry no reference identifiers.

**Scale/Scope**: 1 tool, 1 card, 1 store, 1 gate input, session-card row, strings en/zh, docs.

## Constitution Check

| Principle | Status |
| --- | --- |
| I Requirements are the source of truth | FR-249 – FR-265 from D-017-1 … 9 |
| II Clean room | Reference read for behaviour only (evidence 017, private); own tool name, shape, card, lifetime and matching |
| III Traceability | Tasks cite FRs/SCs; coverage.md at close |
| IV Explicit uncertainty | FR-265 amended during planning (R-251) with the reason; FR-257 answered by the owner |
| V Least privilege | No new permission; the grant is narrower than any existing mode (one session, listed origins, page actions only) |
| VI Privacy / consent | Owner-only approval (FR-253), full list shown before approve (SC-124), steering warning, never persisted |
| VII Observable & testable | Every FR mapped to unit/contract/gate (R-253) |
| VIII MV3 baseline | unchanged |
| IX Requirements before architecture | Spec approved before this plan |
| X Dependency discipline | No new dependency |
| XI Defined failure behaviour | Invalid input, no answer, session end, old extension, busy panel all defined (spec edge cases, data-model) |
| XII Specification before implementation | Plan follows the approved spec |

Post-design re-check: unchanged — no violation.

## Project Structure

### Documentation (this feature)

```text
specs/017-session-site-plan/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md
├── contracts/propose-sites.md
├── checklists/requirements.md
└── tasks.md  coverage.md   (next steps)
```

### Source Code (repository root)

```text
packages/contracts/src/agent-tools.ts      tool schema + descriptor, covered-set constant,
                                           panel state/command additions, feature name
packages/agent-host/src/tool-offering.ts   list the tool
packages/agent-host/src/mcp-server.ts      feature check → unavailable (R-251)
apps/extension/src/service-worker/
  site-plan-store.ts (new)                 per-session grant, storage.session
  agent-tools/site-plan.ts (new)           tool runner: validate, ask, store
  agent-tools/gate.ts                      new input + covered set
  agent-tools/batch.ts                     skip plan card when covered
  agent-tools/prompts.ts                   askSitePlan / decideSitePlan
  agent-runtime.ts                         wiring, coverage lookup, release/unpair clear, projection
  agent-panel-port.ts                      two commands
apps/extension/src/side-panel/agent/       SitePlanCard, PromptCard arbitration, SessionCard row
apps/extension/src/locales/                en-US / zh-TW strings
tests/e2e/packaged/agent-site-plan.spec.ts gate
```

## Slice ordering

| Slice | Content | Depends on | Writer |
| --- | --- | --- | --- |
| S1 | contracts: tool schema/descriptor, covered set, panel state/commands, feature name; host lists tool + `unavailable` path | — | implementer |
| S2 | worker: store (R-246), gate input + covered set (R-245/R-250), batch (R-249), coverage lookup, release/unpair clear | S1 | implementer-high |
| S3 | worker prompt + runner (R-247/R-248), panel card + session-card row + strings (R-252) | S1; S2 store API | implementer |
| S4 | packaged gate, 0.10.0 pins, docs (README tool list, CHANGELOG, design-notes), coverage | S1–S3 | main + implementer |

S1 first (small, committed). S2 and S3 touch disjoint files except `agent-runtime.ts`: S2 owns it; S3
gets the store API and the prompt controller only and hands the runtime wiring of its runner to S2's
seam (or runs after S2). Reviews: **code-reviewer** on S2+S3 (authorization: gate, store lifetime,
subset check, owner-only approval) and **architecture-reviewer** on S1 (new tool contract and panel
protocol) — both required (R2).

## Completion Contract

- **Scope**: FR-249 – FR-265; non-goals as spec "Out of Scope".
- **Claims → evidence**: owner-only approval and subset (unit + contract over command set);
  coverage and exclusions (gate unit matrix + packaged gate SC-121/122); lifetime (store unit + gate
  SC-123); card content (extension-ui + gate SC-124); skew (host unit with a worker without the
  feature); versions/docs (contract pins, snapshot).
- **Assurance roles**: code-reviewer (S2+S3), architecture-reviewer (S1).
- **Final verification (one)**: `npm run typecheck && npm test && npm run build && npm run
  test:contract && npm run snapshot:check`, then `agent-site-plan.spec.ts` plus every `agent-*` gate on
  Chromium 151 attach. Owner branded-Chrome run and paid probe S17 at release.

## Complexity Tracking

None. The new store mirrors the 014 transition store; the new card mirrors the batch plan card.
