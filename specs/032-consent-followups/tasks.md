# Tasks: Consent Follow-ups After the Terminal Trial

**Input**: `specs/032-consent-followups/` (spec, plan, research R-484..R-490, data-model, contracts, quickstart)

Every behaviour change has its focused failing test first (project rule). Task ids continue from 031 (T950).

## Phase 1: Setup

- [ ] T951 Confirm the baseline is green on private main 37037d9 before any edit: `npx tsc -b`, `npm run typecheck`, focused `npx vitest run --project unit packages/agent-host/src/router.test.ts apps/extension/tests/agent-prompts*.test.ts` (no file edits)

## Phase 2: Slice A - more questions in the client, full wait (US1, US2, US3; R2)

- [x] T952 [US1] Failing contract test: `prompt-raised` accepts `kind: "transition"` with `from` and choices `["session","deny"]`, `kind: "site-plan"` with `sites`; refuses `from`/`sites` on other kinds, refuses transition/site-plan with `once`, refuses effect without `once` - in packages/contracts/src/agent-tools.test.ts (or the existing terminal-consent contract test)
- [x] T953 [US1] Widen `promptRaisedFrameSchema` per contracts/terminal-consent-032.md in packages/contracts/src/agent-tools.ts (R-485)
- [x] T954 [US1] Failing tests: a transition question raises `onRaised` with `kind: "transition"`, `from`, `site` = destination, choices `["session","deny"]`; a client `session` settles it as allow without `rememberTransition`; `deny` as deny; upload-directory and plan questions still raise nothing; a late or other-id answer is refused - in apps/extension/tests (prompts tests; update the pin at prompts.test.ts:528-543 that says transition is not raised)
- [x] T955 [US1] Raise transition questions to the client and map their answers in apps/extension/src/service-worker/agent-tools/prompts.ts (R-484)
- [x] T956 [US2] Failing tests: a site-plan question raises `kind: "site-plan"` with `sites`; `decideByCall` `session` approves every proposed origin with `leftOut` empty, `deny` declines, a choice not offered is ignored and the card stays - in apps/extension/tests (prompts / site-plan tests)
- [x] T957 [US2] Raise site-plan questions and settle them through `decideByCall` in apps/extension/src/service-worker/agent-tools/prompts.ts (R-484)
- [x] T958 [US1] Failing host tests: the elicitation form for transition names both sites and offers only Continue-for-this-session / Deny; for site plan lists every site and offers only Allow-these-sites / Deny - in packages/agent-host/src/terminal-consent.test.ts
- [x] T959 [US1] Per-kind message and choice titles in packages/agent-host/src/terminal-consent.ts (R-485)
- [x] T960 [US3] Failing router test: a call admitted at t0 whose card-only question is first ticked at t0+100 s (waitedMs 0) is still alive at t0+225 s and expires by t0+230 s+slack; a stuck question whose ticks grow `waitedMs` cannot hold past its own raise + 130 s - in packages/agent-host/src/router.test.ts
- [x] T961 [US3] Cap from each tick's `now - waitedMs` in packages/agent-host/src/router.ts; send a `waitedMs: 0` tick when a question is armed in prompts.ts (R-486)
- [x] T962 [US3] Test pinning the toolbar mark for transition, plan, site-plan and upload-directory questions (deriveAttention input from `prompts.currentSession()`) in apps/extension/tests (no production change expected)
- [x] T963 [US1] Packaged gate: cross-site move answered `session` / `deny` in the scripted elicitation client, and `propose_sites` answered `session` - in tests/e2e/packaged (extend the 031 terminal-consent spec)

## Phase 3: Slice B - revoke clears session admissions (US4; R2)

- [x] T964 [P] [US4] Failing store tests: `sessionGrants.forgetSite(site)` removes page-action and diagnostics grants of that site in every session and keeps others; `sitePlans.forgetSite(site)` removes the origin from every plan and drops a plan left empty; `transitionStore.forgetSessionPairsTo(site)` removes session pairs to that site in every session and leaves `agentTransitionAllowances` untouched - in apps/extension/tests (store tests)
- [x] T965 [US4] Implement the three methods in apps/extension/src/service-worker/session-grant-store.ts, site-plan-store.ts, transition-store.ts (R-487)
- [x] T966 [US4] Failing runtime test: after `ui.agent.site-clear` for a site, the next page action, diagnostics call and move into that site in two live sessions each ask again; another site's grants still admit; a pending question about the site is not answered by the revoke - in apps/extension/tests
- [x] T967 [US4] Call the three removals from `clearSiteMode` in apps/extension/src/service-worker/agent-runtime.ts (R-487)

## Phase 4: Slice C - activity names the answer (US5)

- [x] T968 [US5] Failing contract test: activity item kind `consent` with `question`, `channel`, `answer`, `site` (and refusal of those fields on other kinds) - in tests/contract or packages/contracts tests
- [x] T969 [US5] Widen `agentActivityItemSchema` per contracts/activity-consent.md in packages/contracts/src/agent-tools.ts
- [x] T970 [US5] Failing tests: one `onConcluded` per settled question with kind, site, channel, answer (once / session / always / deny / timed-out); none for stop, interrupt, release - in apps/extension/tests (prompts tests); runtime notes it as activity within the 20-entry cap
- [x] T971 [US5] `onConcluded` in prompts.ts and `noteActivity` wiring in agent-runtime.ts (R-488)
- [x] T972 [US5] Failing UI test then sentence: SessionCard renders consent lines in zh-TW and en; an unknown kind no longer falls through to the dialog sentence - apps/extension/tests/session-card.test.tsx, SessionCard.tsx, agent-panel-keys.ts

## Phase 5: Slice D - debugger cleanup (US6; R1 lifecycle)

- [x] T973 [P] [US6] Restart release is already pinned: start-up reconciliation detaches every unrecorded attachment (apps/extension/tests/agent-diagnostics-gate.test.ts ~901-915); verified passing 2026-11-09 (R-489 as revised)
- [x] T974 [US6] Dropped: an input.ts countdown for left-over tabs was implemented, found redundant with the start-up detach, and reverted (R-489 as revised)
- [x] T975 [P] [US6] Pinning test: a surface capture that misses `SURFACE_CAPTURE_TIMEOUT_MS` ends the call's hold and the idle countdown arms - in apps/extension/tests/agent-screenshot.test.ts; passed with no production change (R-490)

## Phase 6: Close

- [x] T976 code-reviewer on slices A, B and C (one combined review; R2: how consent is obtained and revoked); slice D is test-only after R-489's revision and needs no review
- [x] T977 Planned final verification: `npx tsc -b`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:contract`, `npm run snapshot:check`
- [x] T978 Owner live check (quickstart.md checks 1-3, check 4 optional)
- [x] T979 coverage.md mapping FR-484..498 and SC-214..218 to tests and checks; README consent section and skills/hallpass/SKILL.md (+ `AGENT_SKILL_TEXT`, new hash in `SHIPPED_SKILL_HASHES`) say that a site change and a site plan are also asked in the client

## Dependencies

- A and B are independent (disjoint files); run together.
- C after A and B (shares contracts, prompts.ts, agent-runtime.ts).
- D independent of A/B/C files (input.ts and screenshot tests); runs with C.
- T976 after A, B, D; T977 after all; T978 after T977 with a build in the main checkout.

## MVP

Slice A alone fixes the failure the owner hit (US1).
