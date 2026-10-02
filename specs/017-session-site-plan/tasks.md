---
description: "Task list for 017 session site plan"
---

# Tasks: A Session Site Plan — The Agent Names Its Sites Up Front, the Owner Approves Once

**Input**: `specs/017-session-site-plan/` — spec.md (FR-249 – FR-265, SC-121 – SC-126), plan.md (slices
S1 – S4), research.md (R-245 – R-253), data-model.md, contracts/propose-sites.md, quickstart.md.

**Tests**: TDD is required by the project (constitution VII, CLAUDE.md "test first"): each behaviour
task starts with a RED test in the named file.

**Rules for this run**: (1) implementers run unit + contract suites only; browser gates are run by
the main session, one at a time, Playwright Chromium launched with `--no-sandbox`; (2) a thing that
fails twice is measured differently, not tried a third time; (3) the owner's branded browser is never
launched by Claude; (4) authorization change (R2): code-reviewer and architecture-reviewer must pass
before any merge; no merge, no release without the owner.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T459 Record the 017 branch/worktree (`worktree-relay-no-cross-browser-supersede`, spec commit da3ef63) and baseline numbers (unit+ui 1607 / contract 255 / snapshot 671) at the top of specs/017-session-site-plan/coverage.md (new)

## Phase 2: Foundational — contracts and host (slice S1)

- [X] T460 RED contract tests in tests/contract/agent-tools-017.contract.test.ts (new): `propose_sites` args are a strict object (`origins` 1–10 unique strings, `purpose` 1–200, optional `steps` ≤ 10 × 1–120; extra keys rejected); the tool is in `AGENT_TOOL_NAMES` and NOT in `AGENT_BATCH_STEP_TOOL_NAMES`; `AGENT_SITE_PLAN_COVERED_TOOLS` equals the gated tools minus `evaluate`, `file_upload`, `upload_image` (R-250); panel state accepts optional `sitePlan` (proposalId, sessionId, origins, purpose, steps?, alreadyApproved?, raisedAt) and `sessions[].sitePlan { origins }`; panel commands accept `ui.agent.site-plan-decide { proposalId, approve, origins[] }` and `ui.agent.site-plan-withdraw { sessionId }` and reject extra keys; a 0.9.0-shaped panel state still parses
- [X] T461 Implement those additions in packages/contracts/src/agent-tools.ts and packages/contracts/src/index.ts (tool descriptor with the agent-facing description from contracts/propose-sites.md; exported feature name `site-plan`; link protocol unchanged at 2) until T460 is green
- [X] T462 RED host tests in packages/agent-host/tests/mcp-server.test.ts (describe "017 site plan"): `propose_sites` is listed by `tools/list`; with a paired worker that did not advertise `site-plan` the call answers `unavailable` / `extension-too-old` with a reload hint and sends nothing to the worker; with the feature it is forwarded unchanged; the tool-count pins in tests/contract/agent-tools-008.contract.test.ts and tests/contract/hallpass-identity.contract.test.ts are updated
- [X] T463 Implement in packages/agent-host/src/tool-offering.ts and packages/agent-host/src/mcp-server.ts (feature check modelled on `UPLOAD_CONSENT_FEATURE`) until T462 is green (R-248, R-251)

**Checkpoint**: unit + contract green; architecture-reviewer on T460 – T463 (new tool contract, panel protocol).

## Phase 3: User Story 1 — the owner approves a multi-site task once (P1) — slices S2 + S3

- [X] T464 [US1] RED store tests in apps/extension/tests/site-plan-store.test.ts (new): set/replace/get/clear per session in `chrome.storage.session` key `agentSessionSitePlans`; `covers(sessionId, origin)` exact-origin match only (`https://a.com` ≠ `https://www.a.com` ≠ `http://a.com` ≠ `https://a.com:8443`); clear of one session leaves others; a second store instance (worker restart) reads what the first wrote
- [X] T465 [US1] Implement apps/extension/src/service-worker/site-plan-store.ts (new) until T464 is green (R-246, data-model.md)
- [X] T466 [US1] RED gate tests in apps/extension/tests/site-mode-gate.test.ts (describe "017 session plan"): with `sitePlanCovers: true`, every tool in `AGENT_SITE_PLAN_COVERED_TOOLS` is admitted under `ask` and under `follow-a-plan` (no plan required); `evaluate`, `file_upload`, `upload_image` still prompt with `sitePlanCovers: true`; with `sitePlanCovers: false` every existing case is unchanged (re-run the existing matrix); `skip-checks` unchanged
- [X] T467 [US1] Implement the input in apps/extension/src/service-worker/agent-tools/gate.ts until T466 is green (R-245, R-250)
- [X] T468 [US1] RED batch tests in apps/extension/tests/agent-batch.test.ts (describe "017"): on a `follow-a-plan` site covered by the session plan no `askPlan` is raised and covered steps run; an upload or evaluate step inside that batch still prompts; an uncovered `follow-a-plan` site still raises the plan card exactly as before
- [X] T469 [US1] Implement in apps/extension/src/service-worker/agent-tools/batch.ts until T468 is green (R-249, D-017-9)
- [X] T470 [US1] RED runtime tests in apps/extension/tests/agent-runtime-site-plan.test.ts (new): every gated call computes coverage from the store and the tab's current top-level origin (a tab that navigated off the listed origin is not covered); coverage is per session (session B on a site in session A's plan is asked)
- [X] T471 [US1] Wire the store and coverage lookup into apps/extension/src/service-worker/agent-runtime.ts until T470 is green
- [X] T472 [US1] RED prompt tests in apps/extension/tests/prompts.test.ts (describe "017 site plan"): `askSitePlan` raises one question with the proposal and `alreadyApproved`; `decideSitePlan` with approve and a subset resolves `{ approved, leftOut }`; an origin not in the proposal or an empty list on approve is rejected (returns false, question stays); decline resolves `declined`; busy and call-end withdrawal behave like `askPlan`
- [X] T473 [US1] Implement `askSitePlan` / `decideSitePlan` in apps/extension/src/service-worker/agent-tools/prompts.ts until T472 is green (R-247)
- [X] T474 [US1] RED runner tests in apps/extension/tests/agent-tools-site-plan.test.ts (new): validation table for FR-250 (non-http scheme, path, query, fragment, wildcard, opaque `null`, duplicate, 11 sites, empty purpose) each answered `invalid-arguments` naming the first bad entry and raising no card; a valid proposal asks and, on approval, writes exactly the approved origins to the store (replacing any previous plan, FR-260) and answers `{ approved, leftOut }`; decline writes nothing and keeps a previous plan
- [X] T475 [US1] Implement apps/extension/src/service-worker/agent-tools/site-plan.ts (new), its dispatch in agent-runtime.ts and the `site-plan` feature advertisement on pair-result until T474 is green (R-248)
- [X] T476 [US1] RED panel tests in apps/extension/tests/site-plan-card.test.tsx (new): the card names the session (016 title), lists every origin with a checked box, shows purpose and steps, marks already-approved origins; Approve sends `ui.agent.site-plan-decide` with the ticked origins; the card takes the top question slot like the batch plan card (`questionOnTop`)
- [X] T477 [US1] Implement apps/extension/src/side-panel/agent/SitePlanCard.tsx (new), the arbitration in apps/extension/src/side-panel/agent/PromptCard.tsx, the command handling in apps/extension/src/service-worker/agent-panel-port.ts and the projection field in agent-runtime.ts until T476 is green

**Checkpoint**: unit + contract green — story 1 works end to end in unit tests.

## Phase 4: User Story 2 — the owner keeps control of what is in the list (P1)

- [X] T478 [US2] RED panel tests in apps/extension/tests/site-plan-card.test.tsx: unticking leaves an origin out of the sent list; Approve is disabled with nothing ticked; Decline sends `approve: false`; the steering warning is present in en-US and zh-TW; keyboard order and focus (006 rules); light and dark render
- [X] T479 [US2] Implement in SitePlanCard.tsx, apps/extension/src/locales/en-US.ts, apps/extension/src/locales/zh-TW.ts and apps/extension/src/side-panel/agent-panel-keys.ts until T478 is green
- [X] T480 [US2] RED panel-port test in apps/extension/tests/agent-panel-port.test.ts: a `site-plan-decide` naming an origin outside the proposal, or an unknown proposalId, grants nothing and is reported as a diagnostic (FR-253, SC-125)
- [X] T481 [US2] Implement the guard in agent-panel-port.ts / prompts.ts until T480 is green

## Phase 5: User Story 3 — the approval ends with the session and can be withdrawn (P2)

- [X] T482 [US3] RED runtime tests in apps/extension/tests/agent-runtime-site-plan.test.ts: every `releaseSession` path (named stop, unnamed stop, relay session end, stale sweep, owner stop) clears the plan; `unpair(agentId)` clears the plans of all that agent's sessions; interrupt keeps it; a pending proposal is withdrawn when its session ends (FR-261); each of approve / replace / withdraw / end writes one activity line (FR-263)
- [X] T483 [US3] Implement in agent-runtime.ts until T482 is green (R-246)
- [X] T484 [US3] RED panel tests in apps/extension/tests/session-card.test.tsx: a session with `sitePlan` shows "Site plan: N sites" (expandable list) and "Withdraw site plan", which sends `ui.agent.site-plan-withdraw`; no row without a plan; both locales
- [X] T485 [US3] Implement in apps/extension/src/side-panel/agent/SessionCard.tsx, the command in agent-panel-port.ts, the strings, until T484 is green (R-252)

## Phase 6: User Story 4 — everything outside the plan behaves as before (P2)

- [X] T486 [US4] RED runtime tests in apps/extension/tests/agent-runtime-site-plan.test.ts: with a plan for A, `evaluate` on A prompts, `file_upload` / `upload_image` on A go through their own consent, a press on unlisted B prompts, session 2 on A prompts, and a navigation from A to B raises the 014 transition card unchanged (FR-255, FR-256, FR-262)
- [X] T487 [US4] Fix any red from T486 in the files above (expected: none if T466 – T471 are right; if one is red, the fix belongs at the gate input, not in a runner)

**Checkpoint**: code-reviewer on S2 + S3 (T464 – T487): gate input, store lifetime, subset and owner-only approval, unpair clearing, coverage by current origin.

## Phase 7: Polish & cross-cutting (slice S4)

- [X] T488 Packaged gate tests/e2e/packaged/agent-site-plan.spec.ts (new, attach mode, real side panel via `openSidePanel`): the six quickstart scenarios on three fixture origins (SC-121 – SC-124), run by the main session on Chromium 151 with `--no-sandbox`
- [X] T489 Version 0.10.0: apps/extension/src/build-config.ts `AGENT_EXTENSION_VERSION`, packages/agent-host/src/tool-offering.ts `SERVER_VERSION`, the pins in tests/contract (identity, tool list count, qa-package literal), package manifests as in 0.9.0
- [X] T490 [P] Docs: README.md and README.zh-TW.md tool list (34 tools) and consent section; CHANGELOG.md 0.10.0 section (merge the Unreleased relay fix into it); docs/design-notes.md one paragraph on the session site plan in our own words (no reference identifiers)
- [X] T491 Run every `agent-*` gate on Chromium 151 attach (regression), then the final verification of plan.md; fill specs/017-session-site-plan/coverage.md (FR/SC → test → result)
- [X] T492 Owner items (not run by Claude): branded Chrome run of agent-site-plan.spec.ts; paid probe S17 (SC-126); merge and release decision

## Dependencies

- Phase 2 (S1) before everything. Phase 3 T464 – T471 (S2, implementer-high) and T472 – T477 (S3, implementer) share only agent-runtime.ts: S2 owns it; S3's runtime wiring (T475 dispatch, T477 projection) runs after T471 lands.
- US2 (T478 – T481) after T477. US3 (T482 – T485) after T471 and T477. US4 (T486 – T487) after T471.
- Phase 7 after all; T488 needs a built extension and host.

## Parallel opportunities

- T460/T462 tests can be written together (different files); T464 and T472 (store vs prompts) in parallel; T476/T478/T484 panel tests in parallel with worker work once contracts are in.

## Implementation strategy

MVP = Phases 2 – 4 (stories 1 and 2: propose, approve with untick, covered actions run). Then lifetime
(US3) and the non-regression proofs (US4), reviews, gate, version and docs. Nothing ships before the
reviews and the owner's run.
