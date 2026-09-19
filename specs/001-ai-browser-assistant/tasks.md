---
description: "Dependency-ordered implementation tasks for the Chrome AI Browser Assistant POC"
---

# Tasks: Chrome AI Browser Assistant POC

**Input**: Design documents from `specs/001-ai-browser-assistant/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, and `quickstart.md`

**Tests**: Required. The specification defines observable MUST acceptance criteria, contract checks,
deterministic E2E journeys, lifecycle/failure cases, and owner-run accessibility/browser/locale evidence.
Within every behavior slice, create the focused failing check first, observe the expected failure, make
the smallest coherent implementation, and rerun that check before broader regression coverage.

**Organization**: Implementation work is grouped into the three approved P1 user stories. Shared setup
and trust-boundary work precedes the stories; release/privacy/accessibility evidence follows them.

## Format: `[ID] [P?] [Story] Description with exact path`

- **[P]** marks tasks that are dependency-independent and touch different files. Repository governance
  still permits only one active writer; use parallel capacity for read-only review/testing unless that
  governance is explicitly changed.
- **[US1]**, **[US2]**, and **[US3]** map to `US-001`, `US-002`, and `US-003` in `spec.md`.
- Setup, Foundational, and Polish tasks intentionally have no story label.

## Approved POC Scope Guardrails

- Executable scope is exactly `PR-001`–`PR-005`, `PR-007`, and `PR-008`, implemented through US1–US3.
- Protocol `1` / `hallpass-v1` advertises `page.read` plus exactly `browser.scroll`, `browser.click`, and
  `browser.enter-text`; click is eligible only when locally classifiable as low-risk and non-navigation.
- `page.form-values` is a separately disclosed DataCategory under `page.read`, not a fifth
  capability and not a new Chrome permission. General page-read returns zero current form values and
  selected-option state; only a distinct current-task/current-document grant permits bounded
  task-relevant ordinary values and select selected-option state conclusively classified non-sensitive.
  Sensitive or ambiguous fields expose no value, length, hash, or partial content.
- A `plan.proposal` must contain at least two exact same-document effects. One effect uses
  `capability.request` with `single-action` binding; a one-step Plan is invalid.
- Assistant-initiated full-document, link, form, script-driven, or other navigation is unsupported with
  zero effect. Do not create a navigation literal, destination category, dispatcher, DNR rule, alarm,
  post-navigation Plan branch, permission, dependency, UI, or hidden future-profile scaffold.
- User/page navigation, reload, and SPA/document changes are compatibility events only: invalidate stale
  context, targets, action grants, and the complete Plan; later protected work requires fresh applicable
  safety, consent, probe, and a new same-document Plan ID.
- AI and identity vendors, production distribution, numeric limits/SLAs, and actual release Chrome major
  numbers remain unselected inputs. Production server code depends only on provider ports;
  `packages/test-kit` adapters are imported only by the explicit test composition. Record the actual
  two stable Chrome majors only during release qualification. A live-provider/deployment gate is
  post-POC and cannot block deterministic POC exit.
- Shared Stop plus ordinary/form page-grant review/revocation required by FR-007/FR-008 belongs to US2;
  US3 extends it with action/Plan grants and uncertain-effect behavior. This does not adopt the broader
  US-007 / PR-019 settings candidate.
- Cross-cutting POC acceptance covers CT-001–CT-013 and SC-001–SC-011; tests and evidence retain the
  applicable F identifiers so requirement-to-story-to-task traceability remains auditable.

| Deferred destination | Stories / requirements | This task set |
| --- | --- | --- |
| Navigation Lab | Deferred part of PR-005 / FR-005 / F-004 | No implementation task; requires a new product decision and profile |
| SHOULD stage | US-004–US-007 / PR-009, PR-010, PR-018, PR-019 | No schema, UI, permission, dependency, or task |
| COULD stage | US-009, US-011, US-015 / PR-011, PR-013, PR-017 | No schema, UI, permission, dependency, or task |
| Unresolved stage | US-008, US-010, US-012–US-014 / PR-006, PR-012, PR-014–PR-016 | Preserve unresolved; do not infer behavior |
| Reference-only | F-016, F-017 | Remain `REFERENCE-ONLY`; no implementation destination |

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the greenfield npm workspace and the exact build/test command surface approved by
the plan, without adding any deferred-feature package or vendor SDK.

- [x] T001 Initialize the Node 24 npm workspace, strict ESM TypeScript baseline, generated-output/test-PKI exclusions, and root package metadata in `package.json`, `tsconfig.base.json`, and `.gitignore`
- [x] T002 [P] Configure the React 19.2 / Vite 8.1 multi-entry Extension workspace in `apps/extension/package.json`, `apps/extension/tsconfig.json`, and `apps/extension/vite.config.ts`
- [x] T003 [P] Configure the Fastify 5 / WebSocket 11 server workspace in `apps/server/package.json` and `apps/server/tsconfig.json`
- [x] T004 [P] Configure the strict shared workspaces and public entry points in `packages/contracts/package.json`, `packages/domain/package.json`, `packages/test-kit/package.json`, and their `tsconfig.json` files
- [x] T005 [P] Configure Vitest 5 and Playwright 1.62 projects with parameterized Chrome binary/major and locale profiles, a fixed test Extension ID, installed-test-PKI preflight, deterministic timeouts, and shared setup in `vitest.config.ts`, `playwright.config.ts`, and `tests/setup.ts`
- [x] T006 Pin only the approved runtime/test dependencies and generate the clean-install lockfile in `package.json` and `package-lock.json`
- [x] T007 Wire `typecheck`, `test`, `test:contract`, `build`, `dev:test-server`, `dev:test-proxy`, `build:extension:test`, `test:config:verify`, `test:e2e`, `test:e2e:release-matrix`, `test:release-smoke`, `test:certs:install`, and `test:certs:remove` without vendor/deferred commands in `package.json`

**Checkpoint**: The empty workspace installs from `package-lock.json`, resolves all planned packages,
and exposes the quickstart command names without yet implementing product behavior.

---

## Phase 2: Foundational Trust Boundaries (Blocks All Stories)

**Purpose**: Implement the closed contracts, least-privilege runtime shells, transient-state foundation,
localization base, and deterministic harness used by all three stories.

**Critical rule**: T008–T015 are written first and observed failing for the expected missing behavior.
They must pass by T027 before story work begins.

### Focused failing checks

- [x] T008 [P] Add failing protocol `1` / exact `hallpass-v1` capability, `page.form-values` DataCategory, with/without-grant result shape, status, one-step `plan.proposal` rejection, legal `single-action` capability request, Plan-branch, and navigation-literal rejection checks in `tests/contract/task-channel.contract.test.ts`
- [x] T009 [P] Add failing closed internal-message, trusted-sender, runtime-epoch, distinct general/form-value disclosure-review-grant-revoke/withheld projections, and exact three-action-enum checks in `tests/contract/extension-runtime.contract.test.ts`
- [x] T010 [P] Add failing OpenAPI reference, closed request/response, authentication, no-store, origin-assessment minimization, executable server-entrypoint/route/WSS composition, provider injection, and missing-production-adapter fail-closed checks in `tests/contract/product-api.contract.test.ts` and `apps/server/tests/app-startup.test.ts`
- [x] T011 [P] Add failing Manifest checks for exactly five production API permissions, zero production host permissions, the sole test-only `https://localhost/*` host exception, CSP, packaged code, and fully separate stable production/test Extension IDs/endpoints/configuration in `tests/contract/manifest.contract.test.ts`
- [x] T012 [P] Add failing source/schema/import-boundary checks for the storage allowlist, transient retention, sensitive/ambiguous form-value exclusion, privacy-safe log fields, production prohibition on `packages/test-kit` imports, and deferred-source isolation in `tests/contract/privacy-boundary.contract.test.ts` and `tests/contract/poc-scope.contract.test.ts` (both files were retired with the archived remote path in 009; what still applies to the agent artefact is checked by `tests/contract/shipping-artifact.contract.test.ts`)
- [x] T013 [P] Add failing bilingual key/placeholder parity, locale selection, reviewed-English fallback, inert remote text, and fail-closed safety-copy checks in `tests/contract/locales.contract.test.ts`
- [x] T014 [P] Add failing runtime-epoch, exact-one-terminal, sequence/idempotency, stale-message, and interruption-without-replay checks in `packages/domain/src/runtime-foundation.test.ts`
- [x] T015 [P] Add failing exact-thumbprint test-PKI lifecycle, TLS SAN, deterministic proxy topology, fixed test build identity/config, localhost-service/127.0.0.1-page separation, and startup refusal unless the exact CurrentUser CA is installed before the service/proxy/browser harness in `tests/contract/test-environment.contract.test.ts`

### Foundational implementation

- [x] T016 Implement stable IDs, bounds, envelope metadata, all closed DataCategory values including `page.form-values`, `hallpass-v1`, result/terminal statuses, and non-localized error codes in `packages/contracts/src/common.ts` and `packages/contracts/src/capabilities.ts`
- [x] T017 [P] Implement Zod HTTP schemas matching every OpenAPI operation and closed component shape in `packages/contracts/src/product-api.ts`
- [x] T018 [P] Implement closed WSS discriminated schemas, distinct form-values request/result/withholding/document-grant bindings, one-step Plan rejection, legal single-action binding, exact same-document multi-step Plans, capability arguments/results, and profile negotiation in `packages/contracts/src/task-channel.ts`
- [x] T019 [P] Implement closed side-panel/content-runtime envelopes, sender projections, distinct ordinary/form-value consent-review-revoke messages, and three-action payload schemas in `packages/contracts/src/extension-runtime.ts`
- [x] T020 Export only the reviewed public contract surface and schema-version metadata in `packages/contracts/src/index.ts`
- [x] T021 Implement fully separate reviewed production/test build configuration, stable Extension-ID validation, build-pinned endpoint/CORS/WSS/CSP validation, exactly five production API permissions, zero production host permissions, and the sole test-only `https://localhost/*` LNA host exception in `apps/extension/src/build-config.ts`, `apps/extension/src/manifest.ts`, `apps/extension/scripts/write-manifest.ts`, and `apps/extension/public/manifest.json`
- [x] T022 Implement typed `en-US`/`zh-TW` catalogs, Chrome locale generation, exact selection, reviewed-English fallback, and inert-text rendering helpers in `apps/extension/src/locales/catalog.ts`, `apps/extension/src/locales/en-US.ts`, `apps/extension/src/locales/zh-TW.ts`, and `apps/extension/scripts/write-locales.ts`
- [x] T023 Implement the executable Fastify entrypoint and explicit production/test composition root; production-owned AI, identity, and origin-safety ports; route/WSS registration; exact HTTPS CORS/WSS Origin policy; bounded parsing; no-store responses; privacy-safe logging; and content-free health route in `apps/server/src/index.ts`, `apps/server/src/app.ts`, `apps/server/src/composition.ts`, `apps/server/src/ports/ai-provider.ts`, `apps/server/src/ports/identity-provider.ts`, `apps/server/src/ports/origin-safety-provider.ts`, `apps/server/src/config.ts`, `apps/server/src/logging.ts`, and `apps/server/src/routes/health.ts`; production code must not import test-kit and must fail startup for missing required live deployment ports
- [x] T024 [P] Implement test-only deterministic adapters for the production auth/AI/safety ports plus clocks, IDs, fake Chrome events, injected bounds, and safe exports without vendor SDKs in `packages/test-kit/src/auth-adapter.ts`, `packages/test-kit/src/ai-adapter.ts`, `packages/test-kit/src/origin-safety-adapter.ts`, `packages/test-kit/src/clock.ts`, `packages/test-kit/src/ids.ts`, `packages/test-kit/src/fake-chrome.ts`, and `packages/test-kit/src/index.ts`
- [x] T025 Implement exact-thumbprint CurrentUser test-CA install/removal, deterministic redacting proxy and stable test build configuration, trusted localhost HTTPS/WSS service fixtures, unprivileged 127.0.0.1 ordinary/form/empty/iframe-only/Shadow-DOM-only/canvas-WebGL-only/reload/SPA/document-change/origin-change fixtures, and persistent-profile Extension launch helpers in `scripts/test-pki.ps1`, `packages/test-kit/src/test-proxy.ts`, `packages/test-kit/src/build-config.ts`, `packages/test-kit/src/service-fixture.ts`, `packages/test-kit/src/page-fixture.ts`, and `tests/e2e/fixtures/extension.ts`
- [x] T026 Implement runtime-epoch, sender/sequence/idempotency, exactly-one-terminal, transient-store interfaces, and no-resume lifecycle primitives in `packages/domain/src/runtime-foundation.ts`, `packages/domain/src/transient-store.ts`, and `packages/domain/src/index.ts`
- [x] T027 Run all completed Phase 2 focused checks after T016–T026, make no implementation changes in this checkpoint, return failures to the owning task, and record exact commands/results in `tests/acceptance/foundation-checkpoint.md`

**Checkpoint**: Closed contracts, runtime shells, deterministic fixtures, and trust boundaries pass;
no user story, deferred capability, vendor choice, or durable Core history has been implemented.

---
## Phase 3: US1 — Start an Authorized Assistant Session (Priority: P1) 🎯 MVP Slice

**Goal**: Open/focus/close the current-context side-panel workspace and establish, restore, renew,
reauthenticate, or end one account-bound product session without sharing page data or causing a page effect.

**Independent Test**: On a supported page, exercise valid, expired, account-mismatched, policy-blocked,
cancelled, and failed deterministic sessions. Verify current-context association, accurate auth state,
local-first logout cleanup, reauthentication boundaries, and zero page actions. Traceability:
PR-001/PR-002 → FR-001/FR-002 → US-001; CT-003/006/007/009–012; F-001/F-002.

### Focused failing checks for US1

- [x] T028 [P] [US1] Add failing PKCE S256, OAuth state expiry/replay, five-state session transition, renewal-account mismatch, and logout tests in `packages/domain/src/authorized-session.test.ts`
- [x] T029 [P] [US1] Add failing authorization/exchange/refresh/session/revoke closed-contract, account isolation, no-store, and deterministic identity tests in `apps/server/tests/auth.routes.test.ts`
- [x] T030 [P] [US1] Add failing activation, trusted storage allowlist, restore, refresh-409, policy-block, and local-first logout controller tests in `apps/extension/tests/auth-controller.test.ts`
- [x] T031 [P] [US1] Add failing semantic workspace/auth-state, focus/close, keyboard, inert text, and zero-page-effect component tests in `apps/extension/tests/side-panel-session.test.tsx`
- [x] T032 [P] [US1] Add the observable valid/expired/cancelled/failed/renew/logout story before implementation in `tests/e2e/us1-authorized-session.spec.ts`

### Implementation for US1

- [x] T033 [US1] Implement PKCE S256, single-use state, exact account/organization binding, session transitions, and stable auth reason codes in `packages/domain/src/authorized-session.ts`
- [x] T034 [P] [US1] Implement the provider-neutral production identity-port consumer and transient authorization/session store in `apps/server/src/adapters/identity.ts` and `apps/server/src/domain/session-store.ts`; keep deterministic identity behavior in `packages/test-kit/src/auth-adapter.ts` and import it only from the test server composition
- [x] T035 [US1] Implement authorization start/exchange/refresh/state/revoke routes, including refresh-409 account mismatch and idempotent revoke, in `apps/server/src/routes/auth.ts`
- [x] T036 [P] [US1] Implement narrow Side Panel, Identity, and trusted `chrome.storage.session` allowlist adapters in `apps/extension/src/chrome-adapters/side-panel.ts`, `apps/extension/src/chrome-adapters/identity.ts`, and `apps/extension/src/chrome-adapters/session-storage.ts`
- [x] T037 [US1] Implement worker activation, accepted control Port, auth restore/renew/reauth/logout, account-bound cleanup, and sanitized projections in `apps/extension/src/service-worker/control-port.ts`, `apps/extension/src/service-worker/auth-controller.ts`, and `apps/extension/src/service-worker/index.ts`
- [x] T038 [P] [US1] Implement the accessible workspace and signed-out/authorizing/signed-in/reauthentication/policy-block views in `apps/extension/src/side-panel/App.tsx`, `apps/extension/src/side-panel/AuthPanel.tsx`, `apps/extension/src/side-panel/main.tsx`, and `apps/extension/src/side-panel/index.html`
- [x] T039 [P] [US1] Bind the packaged action, `_execute_action` keyboard route, context association, focus, and close behavior without page access in `apps/extension/src/chrome-adapters/action-entry.ts`
- [x] T040 [P] [US1] Add reviewed `en-US`/`zh-TW` US1 workspace/auth strings and English fallback coverage in `apps/extension/src/locales/en-US.ts` and `apps/extension/src/locales/zh-TW.ts`
- [x] T041 [US1] Run the completed US1 focused/E2E suites, make no behavior changes in this checkpoint, return failures to T033–T040, and record exact commands/results plus the independent-story outcome in `tests/acceptance/us1-checkpoint.md`

**Checkpoint**: US1 is independently demonstrable with no page read/action implementation. This is the
smallest MVP checkpoint, but it is not the complete browser-assistant POC.

---

## Phase 4: US2 — Ask About the Current Page (Priority: P1)

**Goal**: Run one transient answer/page-understanding task with progressive inert output, exact terminal
state, origin-minimized safety classification, current-task page-read consent, bounded ordinary-DOM
context, controlled separately granted ordinary form values/select selected-option state, complete
sensitive/ambiguous withholding, and shared local-first Stop.

**Independent Test**: Using an authorized-session fixture, exercise direct answer plus ordinary,
with/without-`page.form-values`-grant, sensitive/ambiguous, empty, and explicitly enumerated
unsupported pages under local allow/deny/unknown and remote allow/deny/unknown/unavailable. Verify
disclosure-before-classification, an origin-only request, separate general/form consent, withheld
context until applicable grants, final forwarding fences, redaction/truncation disclosure, shared Stop,
and exactly one terminal state. Traceability: PR-003/PR-004/PR-007/PR-008 →
FR-003/FR-004/FR-007/FR-008 → US-002; CT-002–012; SC-001–SC-005/SC-007/SC-008/SC-010/SC-011;
F-003/F-005/F-007/F-008 and F-009 page-context evidence.

### Focused failing checks for US2

- [x] T042 [P] [US2] Add failing undecided/answer-only/page-read-only task modes, answer-only zero-capability frames, strict sequence, lease loss, observable-result, and exactly-one-terminal tests in `packages/domain/src/task-state.test.ts`
- [x] T043 [P] [US2] Add failing canonical-origin, local allow/deny/unknown, disclosure evidence, exact origin-only remote body, expiry, and fail-closed safety tests in `packages/domain/src/origin-safety.test.ts`
- [x] T044 [P] [US2] Add failing executable server-entrypoint/app composition, AI-port injection, direct-answer/page-read orchestration, task bootstrap/cancel, ticket-bound WSS profile negotiation, heartbeat/lease/channel loss, origin-assessment minimization, and terminal tests in `apps/server/tests/tasks-and-channel.test.ts` and `apps/server/tests/app-startup.test.ts`
- [x] T045 [P] [US2] Add failing bounded ordinary-DOM tests proving zero form values/select state without a form grant; bounded task-relevant ordinary input/textarea values and select selected-option state with it; zero value/length/hash/partial for password, hidden/file, OTP, payment, sensitive-autocomplete, product-credential, and ambiguous fields; reload/SPA/document/origin invalidation; title/selection gating; truncation; unsupported surfaces; and document-bound handles in `apps/extension/tests/page-collector.test.ts`
- [x] T046 [P] [US2] Add failing first-page-read without server-guessed context, disclosure-before-request, distinct ordinary/form grants, local-first shared Stop, and post-collection/pre-WSS active task/channel/Stop/both-grants/tab/document/origin recheck races that drop invalid payloads in `apps/extension/tests/page-read-controller.test.ts`
- [x] T047 [P] [US2] Add failing request/progressive/terminal, safety review, distinct `page.form-values` disclosure/consent/revoke/withheld/expired projections, shared Stop, inert hostile text, and fallback-copy component tests in `apps/extension/tests/side-panel-task.test.tsx`
- [x] T048 [P] [US2] Add direct-answer, safety matrix, with/without-form-grant, allowed/sensitive/ambiguous form, empty, channel-loss, and each excluded fixture journey—iframe-only, Shadow-DOM-only, PDF, Chrome internal, extension-origin, Web Store, file/data/blob, incognito, and canvas/WebGL-only—in `tests/e2e/us2-page-understanding.spec.ts`; any non-automatable Chrome fixture requires an explicit manual blocked-evidence cell rather than a generic inaccessible substitute

### Implementation for US2

- [x] T049 [US2] Implement transient task modes, direction sequences, bounded progressive output, capability-result incorporation, lease handling, and exactly-one-terminal transitions in `packages/domain/src/task-state.ts`
- [x] T050 [P] [US2] Implement canonical origin serialization, local safety policy/state, disclosure evidence, a closed fail-closed form-value classifier, separate general/form current-task grants, exact document binding, and Stop/reload/SPA/document/origin/revoke/terminal invalidation in `packages/domain/src/canonical-origin.ts`, `packages/domain/src/origin-safety.ts`, `packages/domain/src/form-value-policy.ts`, and `packages/domain/src/authorization-grant.ts`
- [x] T051 [P] [US2] Extend only the test-kit deterministic AI and origin-safety implementations of the production ports with injected direct-answer/page-read/safety outcomes and bounds, no durable history, and no production import path in `packages/test-kit/src/ai-adapter.ts`, `packages/test-kit/src/origin-safety-adapter.ts`, and `packages/test-kit/src/test-composition.ts`
- [x] T052 [US2] Implement memory-only task/lease storage plus authenticated transient task bootstrap and idempotent cancel routes in `apps/server/src/domain/task-store.ts` and `apps/server/src/routes/tasks.ts`
- [x] T053 [US2] Implement the unauthenticated exact-canonical-origin assessment route as a consumer of the production origin-safety port in `apps/server/src/routes/origin-assessments.ts` and `apps/server/src/services/origin-safety.ts`; consume the T051 deterministic adapter only through the existing test composition
- [x] T054 [US2] Implement the provider-neutral server AI-port consumer, fail-closed deployment-adapter boundary, direct-answer/page-read orchestration, single-use-ticket WSS handler, `hallpass-v1` echo, strict schemas/sequences, heartbeat lease, progress, result, and terminal behavior; register all routes/WSS handlers in the executable app in `apps/server/src/task-channel/orchestrator.ts`, `apps/server/src/task-channel/handler.ts`, `apps/server/src/composition.ts`, and `apps/server/src/app.ts`
- [x] T055 [P] [US2] Implement current-selected-tab/top-frame eligibility and explicit pre-injection rejection for iframe-only, Shadow-DOM-only, PDF, Chrome internal, extension-origin, Web Store, file/data/blob, incognito, canvas/WebGL-only, and inaccessible contexts; use on-demand isolated frame-0 injection and treat `activeTab` as technical access only—never consent—in `apps/extension/src/chrome-adapters/tabs.ts`, `apps/extension/src/chrome-adapters/scripting.ts`, and `apps/extension/src/service-worker/content-broker.ts`
- [x] T056 [P] [US2] Implement content probing, bounded/redacted ordinary-DOM collection, the Option-C form collector with separate grant, allowed ordinary input/textarea values and select selected-option state, non-value sensitive/ambiguous withholding metadata with zero value/length/hash/partial, explicit empty/unsupported/inaccessible/truncated states, and opaque document-bound target registry in `apps/extension/src/content-runtime/collector.ts`, `apps/extension/src/content-runtime/targets.ts`, and `apps/extension/src/content-runtime/index.ts`
- [x] T057 [US2] Implement authenticated task bootstrap/cancel, fixed-origin WSS client, exact profile/sequence validation, channel interruption, and a worker-owned outbound guard that rechecks task/channel/Stop/every applicable grant/tab/document/origin after the final awaited prerequisite before forwarding any page/result payload in `apps/extension/src/service-worker/task-channel-client.ts` and `apps/extension/src/service-worker/result-transmission-guard.ts`
- [x] T058 [US2] Implement local-first safety evaluation, disclosure acknowledgment, first-page-read without server-guessed context, remote origin-only assessment, distinct general/form grants, final collection rechecks, and shared local-first Stop that cancels task/read/form grants, handles panel disconnect, invalidates on reload/SPA/document/origin change, and attempts remote cancel best effort; compose it in the worker entrypoint/control Port in `apps/extension/src/service-worker/origin-safety-controller.ts`, `apps/extension/src/service-worker/task-controller.ts`, `apps/extension/src/service-worker/stop-controller.ts`, `apps/extension/src/service-worker/control-port.ts`, and `apps/extension/src/service-worker/index.ts`
- [x] T059 [P] [US2] Implement request submission, progressive inert output, safety/general-page/form-value review, withheld/revoked/expired/truncation/access disclosures, Stop affordance, terminal UI, and actual App composition in `apps/extension/src/side-panel/TaskPanel.tsx`, `apps/extension/src/side-panel/SafetyReview.tsx`, `apps/extension/src/side-panel/ConsentReview.tsx`, and `apps/extension/src/side-panel/App.tsx`
- [x] T060 [P] [US2] Add reviewed `en-US`/`zh-TW` task/safety/general-page/form-value disclosure, withheld/revoked/expired, progress/terminal/unsupported strings and fallback coverage in `apps/extension/src/locales/en-US.ts` and `apps/extension/src/locales/zh-TW.ts`
- [x] T061 [US2] Run all completed US2 focused/E2E suites, make no behavior changes in this checkpoint, return failures to T049–T060, rerun US1 public-boundary regressions, and record exact commands/results plus the independent-story outcome in `tests/acceptance/us2-checkpoint.md`

**Checkpoint**: US2 is independently demonstrable with an authorized fixture and no browser-action
implementation. Integrated production use may consume US1 session behavior without making US2's tests
depend on US1 internals.

---
## Phase 5: US3 — Delegate a Controlled Browser Task (Priority: P1)

**Goal**: Review, deny, or execute exactly one approved action or one exact same-document sequential Plan
using only scroll, non-navigation low-risk click, or non-sensitive text entry; expose active control,
current-task grants/revocation, observable results, local-first Stop, and interruption/no-replay
behavior.

**Independent Test**: Exercise all three actions and one exact same-document Plan; deny one otherwise-
allowed single action and verify zero dispatch plus a continue-or-stop explanation; deny assistant
navigation, anchors/forms/file controls, sensitive text, high-risk effects, batch/multi-tab, persistent
grants, and bypass. While an action is pending, trigger a user/page origin change under local
allow/deny/unknown and, for unknown, remote allow/deny/unknown/invalid/unavailable; also trigger document
change, Stop, panel close, worker restart, and channel loss. Verify zero dispatch for every non-allow,
fresh safety/consent/review after allow, stale-state invalidation, visible control, no replay, and zero
excluded effects. Traceability: PR-003/PR-005/PR-007/PR-008 → FR-003/FR-005/FR-007/FR-008 → US-003;
CT-003–012; SC-001–011; F-003/F-004/F-007/F-008/F-018 and F-009 file-input exclusion evidence.

### Focused failing checks for US3

- [x] T062 [P] [US3] Add failing one-step `plan.proposal` rejection, legal one-effect `single-action` capability request, two-or-more-step exact Plan, canonical digest, pre-dispatch revision, post-dispatch immutability, next-step sequencing, mode, and document-invalidation tests in `packages/domain/src/task-plan.test.ts`
- [x] T063 [P] [US3] Add failing one-dispatch grant, risk/sensitivity, stale-target, three-action whitelist, anchor/form/file/script denial, and absent-navigation-profile tests in `packages/domain/src/action-policy.test.ts`
- [x] T064 [P] [US3] Add failing persisted-before-effect marker, dispatch-fence race, action-result final-transmission race, restart recovery, extension of the shared US2 Stop, panel-disconnect Stop, and no-replay tests in `apps/extension/tests/action-lifecycle.test.ts`
- [x] T065 [P] [US3] Add failing scroll/click/text observable-effect, document/target freshness, sensitive-field, submit/file/high-risk, and ambiguous-effect tests in `apps/extension/tests/action-executor.test.ts`
- [x] T066 [P] [US3] Add failing exact Plan/single-action review, otherwise-allowed single-action user denial with continue-or-stop explanation, purpose/category/risk/lifetime, grant revoke, active-control, Stop, uncertain-effect, keyboard, and semantic component tests in `apps/extension/tests/side-panel-control.test.tsx`
- [x] T067 [P] [US3] Add one effect through `single-action` capability request plus a two-or-more-step exact same-document three-action Plan journey before implementation in `tests/e2e/us3-controlled-actions.spec.ts`
- [x] T068 [P] [US3] Add an otherwise-allowed single-action user-denial journey proving zero marker/dispatch/effect plus continue-or-stop explanation, and assistant-navigation/high-risk/sensitive-field/batch/multi-tab/persistent-grant/bypass denial journeys before implementation in `tests/e2e/us3-denial-boundaries.spec.ts`
- [x] T069 [P] [US3] Add Stop/panel-close/worker-epoch/channel-loss/tab-switch/reload/SPA/document/origin-change/no-replay journeys; while an action is pending, enumerate local allow/deny/unknown and, for unknown, remote allow/deny/unknown/invalid/unavailable, proving zero dispatch for every non-allow plus fresh action consent/review after allow and correct invalidation of page/form snapshots/grants, targets, actions, and Plans before implementation in `tests/e2e/us3-lifecycle.spec.ts`

### Implementation for US3

- [x] T070 [US3] Implement canonical review/binding digests, exact same-document Plans, pre-dispatch revisions, immutable execution, current-task grants, expiry, and revocation in `packages/domain/src/canonical-digest.ts`, `packages/domain/src/task-plan.ts`, and `packages/domain/src/action-grant.ts`
- [x] T071 [P] [US3] Implement the three-action local risk/sensitivity policy, strict `hallpass-v1` decisions, and pre-effect navigation/form/file/high-risk denial in `packages/domain/src/action-policy.ts`
- [x] T072 [P] [US3] Extend the US2 target registry created by T056 with exact document-bound resolution plus scroll, non-navigation low-risk click, and non-sensitive text entry with bounded observable verification in `apps/extension/src/content-runtime/targets.ts` and `apps/extension/src/content-runtime/actions.ts`
- [x] T073 [P] [US3] Extend the US2 AI/orchestration boundary from T054 to emit `capability.request` for one effect, emit `plan.proposal` only for two-or-more exact same-document steps, bind exact purpose/context/argument/categories, and incorporate denied plus observed capability results into continuation or terminal behavior without browser authority in `apps/server/src/task-channel/orchestrator.ts` and `apps/server/src/task-channel/handler.ts`
- [x] T074 [US3] Implement local capability evaluation, zero-marker/zero-dispatch handling and denial-result forwarding for a user-denied otherwise-allowed request, sequential dispatch, final dispatch and action-result transmission fences, confirmed minimal operation markers, observable results, uncertain-effect recovery, and worker-entrypoint composition in `apps/extension/src/service-worker/action-dispatcher.ts`, `apps/extension/src/service-worker/operation-markers.ts`, `apps/extension/src/service-worker/result-transmission-guard.ts`, and `apps/extension/src/service-worker/index.ts`
- [x] T075 [US3] Extend the shared US2 `stop-controller.ts` with action/Plan grants, operation markers, uncertain in-flight effects, panel disconnect, tab ownership, and user/page reload/SPA/document/origin invalidation; for a pending action, apply local allow/deny/unknown and remote allow/deny/unknown/invalid/unavailable re-evaluation with zero dispatch for every non-allow plus fresh-review requirements after allow in `apps/extension/src/service-worker/stop-controller.ts` and `apps/extension/src/service-worker/context-monitor.ts`
- [x] T076 [P] [US3] Implement exact Plan review, single-action consent including an otherwise-allowed user-denial path and continue-or-stop explanation, current-task grant review/revoke, active-context identification, Stop, uncertain terminal UI, and actual App composition in `apps/extension/src/side-panel/PlanReview.tsx`, `apps/extension/src/side-panel/GrantsPanel.tsx`, `apps/extension/src/side-panel/ActiveControl.tsx`, and `apps/extension/src/side-panel/App.tsx`
- [x] T077 [P] [US3] Add reviewed `en-US`/`zh-TW` action/Plan/grant/control/Stop/uncertain/unsupported strings and fallback coverage in `apps/extension/src/locales/en-US.ts` and `apps/extension/src/locales/zh-TW.ts`
- [x] T078 [US3] Run all completed US3 focused/E2E suites, make no behavior changes in this checkpoint, return failures to T070–T077, rerun US1/US2 regressions, and record exact commands/results plus the independent-story outcome in `tests/acceptance/us3-checkpoint.md`

**Checkpoint**: All three P1 stories work independently with deterministic fixtures and compose into the
approved POC. No deferred story, assistant-navigation capability, or broad permission is present.

---

## Phase 6: Polish, Release Gates, and Cross-Cutting Evidence

**Purpose**: Prove the complete POC across privacy, lifecycle, localization, accessibility, build,
transport, browser-version, and owner-acceptance boundaries without expanding product scope.

**Critical rule**: T079–T083 are written first and their focused failures are observed before the
smallest cross-cutting fixes in T084–T086.

### Cross-cutting failing checks

- [x] T079 [P] Add failing hostile-remote-text, complete bilingual/fallback, missing-safety-copy fail-closed, keyboard, axe, live-region, focus, and no-trap coverage in `tests/e2e/accessibility-localization.spec.ts`
- [x] T080 [P] Add failing storage-session allowlist, terminal/logout cleanup, and server/proxy/network sentinels proving an explicitly granted ordinary form value may traverse only the active task channel but never durable storage/logs/telemetry, while every sensitive/ambiguous sentinel and its length/partial form appears nowhere; also prove zero durable Core history and exact origin-only classification in `tests/e2e/privacy-retention.spec.ts`
- [x] T081 [P] Add failing production/test build separation, exact permission/host/CSP set, fixed endpoint/ID, no remote code, and loopback/test-material rejection coverage in `tests/contract/release-build.contract.test.ts`
- [x] T082 [P] Add failing permission/auth/backend/network denial, every operation-marker restart state, stale context, exactly-one-terminal behavior, form-grant invalidation on reload/SPA/document/origin/Stop/revoke/terminal, and individually named iframe-only, Shadow-DOM-only, PDF, Chrome internal, extension-origin, Web Store, file/data/blob, incognito, and canvas/WebGL-only outcomes in `tests/e2e/failure-lifecycle-matrix.spec.ts`
- [x] T083 [P] Add failing unpacked-load, HTTPS CORS preflight, valid/missing/wrong WSS Origin, fixed Extension-ID binding, and two-recorded-Chrome-channel coverage in `tests/release/chrome-transport-smoke.spec.ts`

### Cross-cutting implementation and evidence

- [x] T084 Apply only the accessibility/localization remediations required by T079 across `apps/extension/src/side-panel/App.tsx`, `apps/extension/src/side-panel/styles.css`, and `apps/extension/src/locales/catalog.ts`
- [x] T085 Apply only the storage/privacy/logging/lifecycle remediations required by T080/T082 in `apps/extension/src/service-worker/index.ts`, `apps/server/src/logging.ts`, and `packages/domain/src/runtime-foundation.ts`
- [x] T086 Implement production/test build rejection, the complete two-recorded-Chrome × two-locale deterministic P1 matrix runner, and separate exact two-channel transport/load smoke orchestration required by T081/T083 in `apps/extension/scripts/validate-build.ts`, `tests/release/run-p1-matrix.ts`, and `tests/release/run-release-smoke.ts`
- [x] T087 Run a clean-build post-build/dependency audit across the production dependency closure/lockfile, server/Extension compiled output, manifest, CSP, assets, and source maps; fail on test-kit, unapproved vendor SDKs, telemetry, reference identifiers/assets/private protocols, deferred modules, navigation/DNR/alarm, broad permissions, loopback/test ID, or missing runtime-dependency provenance, and record it in `tests/acceptance/clean-room-provenance.md` and `tests/contract/shipping-artifact.contract.test.ts`
- [x] T088 Create the two-Chrome × two-locale keyboard/NVDA eight-pass templates, exact-version fields, privacy-safe evidence index, and a manual Load-unpacked fallback that runs the complete deterministic P1 cases—not only transport smoke—when an exact Chrome major cannot be automated, in `tests/acceptance/manual-pass-template.md`, `tests/acceptance/browser-matrix.md`, and `tests/acceptance/evidence-index.md`
- [x] T089 Encode the five owner-comprehension prompts and 100%-correct per-cell result fields without claiming multi-user evidence in `tests/acceptance/comprehension-template.md`
- [x] T090 Run `npm ci`, `npm run typecheck`, `npm test`, `npm run test:contract`, and `npm run build` from a clean state and record exact current commands/results in `tests/acceptance/evidence-index.md`
- [ ] T091 Resolve and record the then-current and immediately preceding stable Chrome majors, install/verify the exact test PKI and stable test configuration, then run `npm run test:e2e:release-matrix` so the complete deterministic P1 suite executes on both recorded majors × both locales; record exact results, per-major automation/manual status, and privacy captures in `tests/acceptance/browser-matrix.md` and `tests/acceptance/evidence-index.md`
- [x] T092 Using the two exact Chrome majors recorded by T091, run the separate `npm run test:release-smoke` transport/load gate on both or record the documented manual automation block, and store evidence in `tests/acceptance/browser-matrix.md`
- [ ] T093 Have the sole product owner complete and sign all eight keyboard/NVDA/browser/locale passes plus comprehension results in `tests/acceptance/evidence-index.md`
- [ ] T094 Run exact-thumbprint `npm run test:certs:remove`, verify test trust/private-key cleanup, complete PR/FR/US/CT/SC/F task-to-evidence traceability, and record the final deterministic POC exit decision in `tests/acceptance/evidence-index.md`

**Post-POC external-pilot gate — not a POC task or exit dependency**: After a separate vendor/deployment
selection, create `tests/acceptance/provider-deployment-gate.md` and record approved live identity/AI
adapters, no-training/zero-retention evidence, stable Extension-ID redirect/CORS/WSS binding, and pilot
smoke results. Do not create or require this artifact during deterministic POC implementation.

**Checkpoint**: The deterministic POC exits only when all automated commands, exact
manifest/transport/privacy checks, the complete P1 suite on both recorded Chrome majors, and all eight
owner passes are current and successful. It is not represented as a live-provider pilot.

---
## Dependencies and Execution Order

### Phase dependencies

1. **Phase 1 — Setup (T001–T007)** has no product-code dependency. T001 precedes T002–T005; those
   configuration tasks precede T006; T006 precedes T007.
2. **Phase 2 — Foundational (T008–T027)** depends on T007 and blocks all user stories. Write and observe
   T008–T015 failing before their paired implementation. T016 precedes T017–T020; T011 precedes T021;
   T013 precedes T022; T010/T016/T017 precede T023; T023 precedes T024; T015/T024 precede T025;
   T014/T016 precede T026. T027 requires all Phase 2 checks and implementations and performs
   verification only.
3. **US1 (T028–T041)** and **US2 (T042–T061)** begin after T027. US3 tests T062–T069 may also be written
   after T027 against controlled public fixtures, but US3 runtime implementation T070–T077 depends on
   the completed US2 context/target/task boundary at T056/T061.
4. **Phase 6 (T079–T094)** begins after T041, T061, and T078. T079–T083 fail first; T084 owns T079
   remediation, T085 owns T080/T082 remediation, and T086 owns T081/T083 remediation. T087 audits a
   clean shipping build. T090–T094 execute final evidence in order. The post-POC external-pilot gate is
   not part of this dependency graph.

### User-story dependencies

- **US1**: No story dependency. T028–T032 precede implementation. T033/T034/T036/T038/T039 can proceed
  on different files after their stated foundation; T035 depends on T033/T034; T037 depends on T033,
  T035, and T036; T040 depends on the locale base and adopted US1 surfaces; T041 is the story checkpoint.
- **US2**: Independently testable after Foundation with an authorized-session fixture. T042–T048 precede
  implementation. T049/T050/T051/T055 can start on different files; T052 depends on T023/T049; T053
  depends on T023/T050/T051; T054 depends on T023/T049/T051/T052; T056 depends on T050/T055; T057
  depends on T049/T054; T058 depends on T050/T055/T057; T059/T060 consume reviewed projections; T061
  depends on all US2 implementation and is verification-only. It also exercises US1's public session
  boundary but never US1 private internals.
- **US3**: Independently testable as a user outcome with controlled session/task/page fixtures.
  T062–T069 may precede US2 completion, but runtime implementation begins after T056/T061. T070/T071
  can proceed on new files; T072 depends on T056/T071; T073 depends on T054; T074 depends on
  T057/T058/T070–T073; T075 depends on T058/T070/T074; T076/T077 consume reviewed projections; T078
  depends on T061 and all US3 implementation and is verification-only. All three story suites must stay
  passing.

### Contract-to-story mapping

| Contract / model | First consumer | Required later consumers |
| --- | --- | --- |
| Product auth API and Authorized Service Session | US1 | US2, US3 through public session state only |
| Task bootstrap/WSS envelope, task modes, terminal state | US2 | US3 capability/Plan orchestration |
| Origin safety, separate general/form page-read Grants, Browsing Context, Snapshot, Target Handle | US2 | US3 exact context/target/action binding |
| Exact Plan, action Grant, Operation Marker, three-action result union | US3 | Phase 6 lifecycle/privacy/release gates |
| Manifest/runtime/localization/privacy contracts | Foundation | Every story and Phase 6 |

### Task-to-requirement and evidence mapping

Each task ID appears exactly once below. A range/group is used only when every member has the same
requirement/evidence destination.

| Task IDs | Requirement / success destinations | Evidence role |
| --- | --- | --- |
| T001–T007 | CT-001, CT-009, CT-010, CT-012; SC-007, SC-008, SC-011 | Reproducible approved workspace, command, browser, locale, and build surface |
| T008–T027 | FR-001–FR-005, FR-007, FR-008; CT-001–CT-013; SC-001–SC-008, SC-011 | Closed shared contracts, ports, runtime shells, deterministic harness, and pre-story trust boundaries |
| T028–T041 | FR-001, FR-002; SC-001, SC-002, SC-004, SC-007, SC-009–SC-011; F-001, F-002 | US1 focused checks, implementation, and independent checkpoint |
| T042–T061 | FR-003, FR-004, FR-007, FR-008; SC-001–SC-005, SC-007, SC-008, SC-010, SC-011; F-003, F-005, F-007, F-008, F-009 page evidence | US2 direct-answer/page-read, Option-C form values, shared Stop, composition, and independent checkpoint |
| T062–T078 | FR-003, FR-005, FR-007, FR-008; SC-001–SC-008, SC-010, SC-011; F-003, F-004, F-007, F-008, F-009, F-018 | US3 exact single-action/Plan/effect/lifecycle extension and independent checkpoint |
| T079, T084 | CT-012; SC-009–SC-011 | Automated accessibility/localization failure then owning remediation |
| T080 | FR-003, FR-004, FR-007, FR-008; SC-002, SC-003, SC-005, SC-006, SC-008 | Authorized ordinary form-value flow versus zero sensitive/ambiguous/storage/log leakage |
| T081, T086, T087 | CT-001, CT-003–CT-008, CT-010, CT-013; SC-001, SC-007, SC-008, SC-011 | Exact shipping build, full P1 runner, clean-room dependency/artifact closure |
| T082, T085 | FR-001–FR-005, FR-007, FR-008; SC-001–SC-008 | Full failure/lifecycle matrix and owning runtime/privacy remediation |
| T083 | FR-002, FR-003, FR-008; SC-001, SC-002, SC-004, SC-008 | Two-Chrome transport/load smoke definition |
| T088, T089 | CT-012; SC-009–SC-011 | Manual browser/locale/keyboard/NVDA and owner-comprehension templates |
| T090 | FR-001–FR-005, FR-007, FR-008; SC-001–SC-008, SC-011 | Clean-install type/unit/contract/build evidence |
| T091 | FR-001–FR-005, FR-007, FR-008; SC-001–SC-008, SC-011 | Complete deterministic P1 E2E on both recorded Chrome majors × both locales |
| T092 | FR-001–FR-003, FR-008; SC-001, SC-002, SC-004, SC-008 | Separate two-Chrome load/CORS/WSS smoke evidence |
| T093 | CT-012; SC-009–SC-011 | Signed eight-cell owner accessibility/comprehension evidence |
| T094 | PR-001–PR-008 approved destinations; CT-001–CT-013; SC-001–SC-011; F-001–F-021 destinations | PKI cleanup, complete traceability, and deterministic POC exit decision |
| T095–T104 | FR-001–FR-003; CT-009, CT-012; SC-001, SC-002, SC-004, SC-011, SC-012 | Finite service state, explicit LNA recovery, bilingual single-task side-panel convergence |
| T105–T120 | FR-003–FR-005, FR-007, FR-008; CT-009, CT-012; SC-001–SC-008, SC-011 | Prompt, unsupported-page, workspace, review, control-port, and reload recovery convergence |
| T121–T127 | FR-003–FR-005, FR-007, FR-008; CT-001, CT-004, CT-009, CT-010, CT-012, CT-013; SC-001–SC-008, SC-011 | Built classic runtime, packaged MV3 US2/US3 core, safe diagnostics, and requalification evidence |

## Parallel Opportunities

`[P]` identifies different-file/dependency-independent work packages. Under the current repository rule,
keep one active writer and use other agents only for read-only review or test-result analysis. If that
governance is explicitly changed later, the following groups are the safe logical parallel units.

### Parallel example: US1

```text
After T027, write the independent failing checks:
T028 packages/domain/src/authorized-session.test.ts
T029 apps/server/tests/auth.routes.test.ts
T030 apps/extension/tests/auth-controller.test.ts
T031 apps/extension/tests/side-panel-session.test.tsx
T032 tests/e2e/us1-authorized-session.spec.ts

After the shared session contract is stable, different-file implementation candidates are:
T034 server identity/session store
T036 Extension Chrome adapters
T038 side-panel workspace/auth UI
T039 browser action/keyboard entry
T040 US1 locale entries
```

### Parallel example: US2

```text
After T027, write T042–T048 in their separate domain/server/Extension/E2E files.

After their expected failures are recorded, these distinct-file foundations may start:
T049 task state machine
T050 origin safety and separate general/form-value grant domain
T051 deterministic test-only AI/safety adapters
T055 tab/scripting/content broker

After T050/T055 stabilize the policy and context interfaces:
T056 page collector and target registry

After the reviewed projections are stable, T059 task/safety/form-consent UI and T060 locale entries
may proceed on their distinct files.
```

### Parallel example: US3

```text
After T027, write T062–T069 in their separate domain/Extension/E2E files.

After their expected failures are recorded, these new-file domain candidates may start:
T070 exact Plan/digest/grant domain
T071 three-action policy

After US2 T056/T061 is complete, T072 extends its target registry and action boundary.
After US2 T054 is complete, T073 extends its provider-neutral orchestration.
After the reviewed projections are stable, T076 Plan/grant/control UI and T077 locale entries may
proceed on their distinct files.
```

## Implementation Strategy

### MVP first: US1 session/workspace slice

1. Complete T001–T007.
2. Complete the blocking T008–T027 foundation.
3. Complete T028–T041.
4. Stop and run the US1 independent test. A successful local US1 demo proves authorized workspace/session
   entry only; it is not presented as the full POC or a live-provider pilot.

### Incremental POC delivery

1. **US1** adds authorized workspace/session behavior.
2. **US2** adds transient direct answer, consented/redacted page understanding, the controlled Option-C
   ordinary/form-value subset, and the shared Stop lifecycle; rerun US1.
3. **US3** extends the US2 runtime with exact low-risk controlled actions, Plans, action grants, visible
   control, and the same shared Stop lifecycle; rerun US1/US2.
4. **Phase 6** qualifies the composed POC across both locales, both release Chrome majors, privacy,
   lifecycle, accessibility, transport, and owner comprehension.
5. Stop at the POC exit gate. Do not start Navigation Lab or any SHOULD/COULD/unresolved story from this
   task set; each needs a new approved specification/planning/task workflow.

### Per-task execution discipline

- Preserve unrelated workspace changes and never create commits, branches, worktrees, remotes, releases,
  deployments, or live vendor accounts without explicit user authorization.
- For every behavior task, run its focused failing check first and preserve the failure evidence; implement
  the smallest coherent change; rerun the focused check and the relevant prior-story regression set.
- Treat page/model/service strings as untrusted inert text. Never weaken consent, Stop, exact profile,
  sender/context, storage, permission, privacy, or terminal-state checks to make a test pass.
- Use injected test bounds/outcomes rather than inventing production numeric requirements.
- Keep PR/FR/US/CT/SC/F identifiers in tests/evidence so the final chain remains auditable.

## Task Summary

| Group | Task IDs | Count | Exit condition |
| --- | --- | ---: | --- |
| Setup | T001–T007 | 7 | Workspace and command surface ready |
| Foundational | T008–T027 | 20 | Closed contracts/trust boundaries and deterministic harness pass |
| US1 / US-001 | T028–T041 | 14 | Authorized workspace/session independently passes |
| US2 / US-002 | T042–T061 | 20 | Direct answer/page understanding independently passes |
| US3 / US-003 | T062–T078 | 17 | Controlled actions/Plans/Stop independently pass |
| Polish/release | T079–T094 | 16 | Automated plus eight owner acceptance cells pass |
| Convergence / requalification | T095–T127 | 33 | Manual-testability convergence plus packaged MV3 core requalification pass |
| **Total** | **T001–T127** | **127** | Complete approved POC evidence; zero deferred implementation |

## Notes

- Every checklist item includes an exact repository path and uses the required `- [ ] Tnnn [P?] [US?]`
  format; story labels appear only in story phases.
- Tests precede behavior implementation because the specification explicitly requires observable and
  deterministic acceptance coverage.
- No task selects an AI/identity vendor, production distribution, permanent Chrome version, numeric SLA,
  reference-private asset/protocol, or deferred capability.
- No numbered task authorizes deployment or a live-provider pilot. The unnumbered post-POC gate applies
  only after a separate vendor/deployment selection and is not a POC exit dependency.

## Phase 7: Convergence — Manually Testable Side Panel

**Purpose**: Close the 2026-08-28 manual-acceptance gap without expanding POC capability scope.
Existing T001–T094 remain immutable; T093/T094 still follow real owner/browser acceptance.

- [x] T095 Add focused failing protocol-v2 contract coverage for `ui.service.retry`,
  `worker.service.state`, malformed/unknown service payloads, and stale runtime epochs in
  `tests/contract/extension-runtime.contract.test.ts`
- [x] T096 Upgrade the closed runtime schemas to protocol v2 and the typed service messages in
  `packages/contracts/src/common.ts` and `packages/contracts/src/extension-runtime.ts`
- [x] T097 Add focused failing worker coverage for immediate Port-connect health probing, 204-gated
  restore/sign-in, non-204/rejection/five-second-timeout unavailable projection, one probe per manual
  retry, and stale probe/restore suppression in `apps/extension/tests/control-port.test.ts`
- [x] T098 Implement the service-worker-owned `GET /health` path, five-second bounded health/auth HTTP,
  service-state projection, retry handling, and generation guards in
  `apps/extension/src/service-worker/control-port.ts`,
  `apps/extension/src/service-worker/runtime.ts`, and their composition root
- [x] T099 Add focused failing side-panel coverage for checking, unavailable, signed-out, authorizing,
  signed-in empty, safety/consent/Plan review, progress, and all five terminal states; prove localized
  startup/retry copy, accessible names/focus, duplicate-submit prevention, and absence of inactive Stop,
  empty grants, raw identifiers, and raw JSON in `apps/extension/tests/side-panel-*.test.tsx`
- [x] T100 Recompose the React side panel and CSS into a full-height Chrome-native-feeling single-task
  workspace with scrollable state content, fixed composer, contextual review/grant/control surfaces,
  human-readable `en-US`/`zh-TW` labels, and narrow-panel/keyboard/NVDA-compatible semantics in
  `apps/extension/src/side-panel/` and `apps/extension/src/locales/`
- [x] T101 Run `npm test`, `npm run test:contract`, `npm run typecheck`, and
  `npm run build:extension:test`; record automated convergence evidence while leaving T093/T094 open
  for the sole product owner's real Chrome/NVDA/locale acceptance and final certificate/exit decision

### Automated convergence evidence — 2026-08-28

- `npm test`: 36 files, 192 tests passed.
- `npm run test:contract`: 10 files, 44 tests passed.
- `npm run typecheck`: passed.
- `npm run build:extension:test`: passed; the test extension bundle and manifest were generated.
- T093 and T094 remain open: no automated result substitutes for the sole product owner's real
  Chrome/NVDA/locale acceptance, certificate cleanup, and final POC exit decision.

## Phase 8: Convergence — Chrome Local Network Access Bootstrap

**Purpose**: Close the Chrome 151 manual-acceptance failure where an authoritative worker probe cannot
present the browser-owned loopback permission prompt. T093/T094 remain owner-only gates.

- [x] T102 Add focused failing public-seam side-panel coverage proving one explicit unavailable-state
  recovery gesture starts at most one bounded response-agnostic `GET /health`, disables duplicate
  gestures, never projects available from the bootstrap response, and emits exactly one
  `ui.service.retry` after settle/rejection/timeout per SC-012 (missing)
- [x] T103 Implement the explicit-gesture Local Network Access bootstrap with local target-address
  intent in `apps/extension/src/side-panel/App.tsx`; discard response/error, retain worker-authoritative
  availability, and preserve zero polling and zero panel auth/session/task/WSS access per FR-002 and
  plan: service availability data flow (missing)
- [x] T104 Add reviewed `en-US`/`zh-TW` recovery and pending labels plus accessible duplicate-action
  prevention in `apps/extension/src/side-panel/ServicePanel.tsx` and `apps/extension/src/locales/`;
  run focused tests, `npm test`, `npm run test:contract`, `npm run typecheck`, and
  `npm run build:extension:test`, recording evidence while leaving T093/T094 open per CT-009/CT-012
  (partial)

### Automated Local Network Access convergence evidence — 2026-08-29

- Focused red: `side-panel-lna-bootstrap.test.tsx` failed because the recovery gesture made zero
  visible-document requests; this reproduced the missing permission-bootstrap behavior.
- Focused green: 2 files, 9 tests passed for success, duplicate gesture, denied/dismissed permission,
  five-second timeout, worker-authoritative availability, and bilingual pending/recovery UI.
- `npm test`: 37 files, 196 tests passed on the final worktree.
- `npm run test:contract`: 10 files, 44 tests passed.
- `npm run typecheck`: passed after preserving Chrome's `targetAddressSpace` through an extended
  structurally compatible request-init type.
- `npm run build:extension:test`: passed; regenerated `apps/extension/dist/test`.
- `npm run test:e2e`: 100 passed and 36 unpacked-browser journeys skipped by the existing harness;
  this is not recorded as real Chrome/NVDA acceptance.
- T093/T094 remain open for the owner's real Chrome permission-prompt recovery check, eight-cell
  keyboard/NVDA/locale evidence, certificate cleanup, and final POC exit decision.

## Phase 9: Convergence — Deterministic Prompt and Unsupported-Page Recovery

**Purpose**: Close the 2026-08-29 real-Chrome finding where an ordinary prompt was routed to page read
on chrome://newtab and a rejected read displayed the contradictory summary Page read finished.

- [x] T105 Add focused failing provider coverage proving an ordinary natural-language request completes
  without page access and an unsupported page produces a locale-matched recovery message rather than a
  completion-sounding summary in packages/test-kit/src/ai-adapter.test.ts
- [x] T106 Make deterministic prompt fallback direct-answer, preserve unsupported-page as a stable
  terminal reason with en-US/zh-TW recovery copy, update the manual quickstart, and rerun focused,
  task-channel, full regression, typecheck, and test-extension build evidence while leaving T093/T094 open

### Automated prompt and unsupported-page convergence evidence — 2026-08-29

- Focused red 1: hi produced capability-request(page.read) instead of a success terminal.
- Focused red 2: unsupported-page produced capability.failed plus Page read finished instead of a
  localized recovery explanation.
- Focused green: packages/test-kit/src/ai-adapter.test.ts passed 2/2 tests.
- Task-channel regressions: apps/extension/tests/control-port-task.test.ts passed 33/33 and
  apps/server/tests/tasks-and-channel.test.ts passed 20/20.
- npm test: 38 files, 198 tests passed.
- npm run test:contract: 10 files, 44 tests passed.
- npm run typecheck: passed and rebuilt the deterministic adapter output.
- npm run build:extension:test: passed and regenerated apps/extension/dist/test.
- Running HTTPS/WSS fixture acceptance: hi emitted accepted, progress, then one success terminal with
  no capability request; injected unsupported-page emitted one zh-TW page.unsupported recovery terminal.
- The deterministic test server was restarted on 18787 to load the rebuilt adapter. Restarting cleared
  its in-memory sessions/tasks, so the browser must sign in again before the final owner pass.
- T093/T094 remain open for the owner's eight-cell keyboard/NVDA/locale acceptance, certificate cleanup,
  and final POC exit decision.

## Phase 10: Convergence — Full-Height Result Workspace

**Purpose**: Close the 2026-08-29 real-Chrome finding where the terminal composer stopped mid-panel,
the submitted prompt remained in the textarea, and the completion label visually dominated the response.

- [x] T107 Add focused failing UI checks proving valid submission clears the textarea and terminal reading
  order presents response content before status; reproduce the exact 870-by-866 composer gap with a real
  Chrome layout harness in apps/extension/tests/side-panel-app.test.tsx and
  apps/extension/tests/side-panel-productization.test.tsx
- [x] T108 Recompose TaskPanel/TaskWorkspace content into an independently scrollable flex region above a
  non-absolute bottom composer; use 100dvh, remove browser form margin, reduce composer height, demote the
  terminal label, preserve review content and narrow-panel behavior, update quickstart, and rerun focused,
  full regression, contract, typecheck, and test-extension build evidence

### Automated full-height workspace convergence evidence — 2026-08-29

- Focused red: the submitted textarea retained answer only please after terminal.
- Focused red: terminal DOM/read order exposed Needs attention before the actual response summary.
- Chrome layout red at 870 by 866: composerBottom was 303 with a 563px bottom gap.
- Focused green: 3 side-panel files passed 17/17 tests.
- Chrome layout green: 870 by 866 and 300 by 700 both reported bottomGap 0 and zero horizontal overflow;
  response y-position preceded terminal-status y-position.
- npm test: 38 files, 198 tests passed.
- npm run test:contract: 10 files, 44 tests passed.
- npm run typecheck: passed.
- npm run build:extension:test: passed and regenerated apps/extension/dist/test.
- T093/T094 remain open for the owner's real Chrome keyboard/NVDA/locale sign-off, certificate cleanup,
  and final POC exit decision.

## Phase 11: Convergence — Task-State Exclusivity and Single Stop

**Purpose**: Close the 2026-08-29 owner-assisted real-Chrome finding where a new page-read review retained
the previous task's failure terminal and the busy workspace rendered two Stop controls.

- [x] T109 Add focused failing App-boundary checks proving a prior terminal disappears when a new task
  enters protected review and the busy/review workspace exposes exactly one Stop control in
  apps/extension/tests/side-panel-app.test.tsx
- [x] T110 Reset task-scoped terminal/review state before dispatching a new task, keep the global
  TaskPanel Stop as the sole busy-task control, update quickstart and acceptance evidence, and rerun
  focused, full regression, contract, typecheck, and test-extension build checks while leaving
  T093/T094 open

### Automated task-state convergence evidence — 2026-08-29

- Focused red 1: after a completed direct-answer task, entering page-read review still rendered the old
  terminal summary.
- Focused red 2: page-read consent rendered two buttons with the localized accessible name Stop.
- Focused green: each new regression passed independently; the four side-panel regression files passed
  19/19 tests.
- `npm test`: 38 files, 199 tests passed.
- `npm run test:contract`: 10 files, 44 tests passed.
- `npm run typecheck`: passed.
- `npm run build:extension:test`: passed and regenerated `apps/extension/dist/test`.
- T093/T094 remain open. The owner must reload this rebuilt unpacked extension and repeat the affected
  real-Chrome locale/keyboard journey; no owner signature is inferred from automated evidence.

## Phase 12: Convergence — Review/Control Semantics and Localized Progress

**Purpose**: Close the 2026-08-29 owner-retest finding where a pending origin-safety review simultaneously
claimed active tab control and the deterministic zh-TW journey displayed the fixed English progress text
Working.

- [x] T111 Add focused failing public-boundary checks proving an origin-safety review does not expose the
  active-control heading and the deterministic zh-TW provider emits locale-matched progress in
  apps/extension/tests/side-panel-app.test.tsx and packages/test-kit/src/ai-adapter.test.ts
- [x] T112 Separate generic task activity from approved browser control, localize deterministic progress,
  restart the in-memory test service, update acceptance guidance/evidence, and rerun focused, full
  regression, contract, typecheck, and test-extension build checks while leaving T093/T094 open

### Automated review/control convergence evidence — 2026-08-29

- Focused red 1: Origin safety check and Controlling this tab were simultaneously present.
- Focused red 2: a zh-TW task emitted Working instead of 處理中.
- Focused green: complete App composition passed 10/10; deterministic provider passed 2/2.
- npm test: 38 files, 199 tests passed.
- npm run test:contract: 10 files, 44 tests passed.
- npm run typecheck: passed and rebuilt the test-kit project output.
- npm run build:extension:test: passed and regenerated apps/extension/dist/test.
- The local test service was restarted on https://localhost:18787; its in-memory sessions/tasks were
  cleared. T093/T094 remain open until the owner reloads, signs in, and repeats the affected journey.

## Phase 13: Convergence — Unified Review Surfaces

**Purpose**: Close the 2026-08-29 owner-retest visual finding where the origin-safety content touched the
panel edge and its Continue action used an unstyled browser-default button unlike Consent and Plan.

- [x] T113 Add a focused CSS-aware computed-layout check proving Safety, Consent, and Plan use the same
  inset card spacing and primary-action geometry in
  apps/extension/tests/side-panel-productization.test.tsx and vitest.config.ts
- [x] T114 Apply the shared review card, content rhythm, and primary action tokens to SafetyReview, update
  quickstart/evidence, and rerun focused, full regression, contract, typecheck, and test-extension build
  checks while leaving T093/T094 open

### Automated unified-review evidence — 2026-08-29

- Initial seam check showed CSS was not processed by extension-ui tests; CSS processing was enabled before
  accepting a product red result.
- Focused red then isolated SafetyReview at empty/default margin, padding, minimum action height, and
  radius while Consent and Plan already measured 12px, 14px, 36px, and 18px respectively.
- Focused green: all three review surfaces measure the same 12px outer margin, 14px inner padding,
  36px minimum primary action height, and 18px action radius.
- Focused side-panel regressions: 4 files, 20 tests passed.
- npm test: 38 files, 200 tests passed.
- npm run test:contract: 10 files, 44 tests passed.
- npm run typecheck: passed.
- npm run build:extension:test: passed and regenerated apps/extension/dist/test.
- T093/T094 remain open until the owner reloads the rebuilt extension and completes the required signed
  browser/locale/keyboard/NVDA cells.

## Phase 14: Convergence — Localized Review Copy and Grouped Data Disclosure

**Purpose**: Close the 2026-08-29 owner-retest finding where the zh-TW Consent review retained fixed
English purpose text and repeated the Data field label for each disclosed category.

- [x] T115 Add focused failing provider and rendered-DOM checks proving deterministic page-read, action,
  and Plan review copy follows the requested locale, while multiple consent data categories appear under
  one semantic Data list in packages/test-kit/src/ai-adapter.test.ts and
  apps/extension/tests/side-panel-productization.test.tsx
- [x] T116 Thread the task locale through deterministic review output, group Consent data categories into
  one semantic list with localized human-readable labels, update quickstart and acceptance evidence, and
  rerun focused, full regression, contract, typecheck, and test-extension build checks while leaving
  T093/T094 open

### Automated localized-review convergence evidence — 2026-08-29

- Focused red reproduced the fixed English page-read, action, and Plan copy in zh-TW output; a separate
  rendered-DOM red reproduced two Data labels for two disclosed categories.
- Focused green: deterministic provider 4/4 and side-panel productization 7/7 passed.
- The first full regression identified one stale en-US lowercase Plan-summary expectation; after aligning
  it with the reviewed human-readable copy, control-port-task passed 33/33.
- npm test: 38 files, 202 tests passed.
- npm run test:contract: 10 files, 44 tests passed.
- npm run typecheck: passed.
- npm run build:extension:test: passed and regenerated apps/extension/dist/test.
- The local test service was restarted on https://localhost:18787 and cleared its in-memory session.
  T093/T094 remain open for owner-only real Chrome keyboard/NVDA/browser/locale sign-off.

## Phase 15: Convergence — Control-Port Failure Recovery

**Purpose**: Close the 2026-08-29 owner-retest finding where Continue could clear the Safety review after
a disconnected control-port send, leaving an indefinite progress state whose Stop action was also dropped.

- [x] T117 Add focused App-boundary red coverage for a control port that dies exactly while acknowledging
  Safety, plus worker coverage proving Stop remains effective while origin-safety assessment is pending,
  in apps/extension/tests/side-panel-app.test.tsx and apps/extension/tests/control-port-task.test.ts
- [x] T118 Make UI control sends report success, clear Safety/Consent/Plan only after successful delivery,
  locally settle Stop as cancellation when delivery is unavailable, update acceptance evidence, and rerun
  focused, full regression, contract, typecheck, and test-extension build checks while leaving T093/T094 open

### Automated control-port recovery evidence — 2026-08-29

- A pending origin-safety Promise did not reproduce the defect: Stop cancelled within the focused worker
  check, ruling out the assessment wait as the cause.
- Focused App red reproduced the owner symptom exactly: safety acknowledgement threw a disconnected-port
  error, the review disappeared, Stop was dropped, and no terminal alert appeared.
- Focused green: side-panel App 11/11 and control-port task 34/34 passed.
- npm test: 38 files, 204 tests passed.
- npm run test:contract: 10 files, 44 tests passed.
- npm run typecheck: passed.
- npm run build:extension:test: passed and regenerated apps/extension/dist/test.
- T093/T094 remain open for owner-only real Chrome keyboard/NVDA/browser/locale sign-off.

## Phase 16: Convergence — Extension-Reload Content Runtime Recovery

**Purpose**: Close the 2026-08-29 owner-retest failure where an already-open supported page could no
longer be collected after the unpacked extension was reloaded, and remove the misleading instruction
that every undifferentiated collection failure requires a page refresh.

- [x] T119 Add focused failing coverage for a stale content-runtime page guard after extension reload,
  same-document reinjection idempotence, the complete broker inject/probe/collect seam, and generic
  collection-failure recovery copy in apps/extension/tests/content-runtime-reload.test.ts and
  packages/test-kit/src/ai-adapter.test.ts
- [x] T120 Replace the permanent boolean guard with a replaceable Chrome runtime listener, preserve one
  active listener across reinjection, correct en-US/zh-TW generic recovery guidance, update acceptance
  evidence, and rerun focused, full regression, contract, typecheck, test-extension build, and service
  health checks while leaving T093/T094 open

### Automated extension-reload recovery evidence — 2026-08-29

- Focused red reproduced a stale page-global __pocContentRuntimeBound value with no active listener:
  the newly injected runtime registered zero listeners. A separate provider red proved the generic
  collect-failed branch incorrectly prescribed a page refresh without knowing that refresh was needed.
- The content runtime now stores the actual listener, removes it when possible, and registers a fresh
  listener on every bundle execution. Reinjection therefore leaves exactly one active listener and does
  not trust a stale boolean from the previous extension context.
- Focused green: extension-reload runtime 3/3; content broker/runtime group 4 files/15 tests; deterministic
  provider 5/5.
- npm test: 39 files, 208 tests passed.
- npm run test:contract: 10 files, 44 tests passed.
- npm run typecheck: passed.
- npm run build:extension:test: passed and regenerated apps/extension/dist/test.
- https://localhost:18787/health returned 204 after the rebuilt test service was started.
- T093/T094 remain open. This automated evidence covers the reload/injection seam and does not substitute
  for the product owner's eight signed keyboard/NVDA/browser/locale cells.

## Phase 17: Convergence — Packaged MV3 Core Runtime

**Purpose**: Replace source/private-function substitutes with executable evidence from the actual built
MV3 extension, repair the classic-script content runtime, and restore the complete US2/US3 vertical slice
before any further owner acceptance work.

- [x] T121 Add a post-build contract that parses the actual production and test `content-runtime.js` as
  classic scripts and rejects static imports, exports, and external chunk dependencies; first record the
  current built artifacts failing this focused check
- [x] T122 Split service-worker/side-panel module bundling from a no-export content-runtime bootstrap,
  emit a self-contained IIFE `content-runtime.js`, and make both production and test builds execute the
  artifact validator without widening manifests, CSP, Extension ID, or production host permissions
- [x] T123 Add a persistent bundled-Chromium unpacked-extension fixture and packaged runtime journey that
  proves real MV3 worker probe miss → packaged executeScript injection → probe → DOM collection, plus
  same-page reinjection, extension reload recovery, and exactly one active runtime listener
- [x] T124 Replace the skipped/private-function US2 browser substitute with zero-skip packaged side-panel
  journeys for health, sign-in, submit, safety, consent, ordinary/empty/form grants, denial, unsupported,
  Stop, stale tab, and exactly one terminal projection
- [x] T125 Restore packaged US3 journeys for real DOM scroll, non-navigation click, non-sensitive text
  entry, reviewed Plan execution, denial, Stop, document/origin invalidation, and no replay
- [x] T126 Preserve safe page-collection failure stages for injection, probe, stale context, invalid result,
  and collection; remove empty catches, emit only stable stage codes in test/dev diagnostics, and render
  recoverable en-US/zh-TW UI copy without URL, page content, grant, task payload, credentials, or raw errors
- [x] T127 Run artifact, packaged core, full regression, contract, typecheck, production build, and test
  build gates; update US2/US3 checkpoints, browser matrix, and evidence index with current results; rerun
  `speckit-analyze`, close only evidence-backed tasks, and leave T093/T094 owner-only gates open

### T025/T080/T127 proxy requalification evidence — 2026-09-01

- Focused red reproduced the public `npm run dev:test-proxy` exiting immediately as a T007 command stub.
  Focused green is 3/3: HTTP forwarding, a long-lived public CLI seam, and WebSocket upgrade/frame
  tunnelling. URL, Authorization, path, body, and frame sentinels traverse the proxy but diagnostics
  contain only stable `proxy.request.completed`, `proxy.websocket.opened`, or
  `proxy.upstream.unavailable` codes.
- The deterministic service now binds only the upstream HTTPS/WSS origin on 18786. Playwright starts
  upstream 18786 before the Extension-facing redacting proxy on 18787, so packaged tests cannot bypass
  the proxy while production permissions and public protocol remain unchanged.
- Final automated gates: focused proxy 3/3; `npm test` 42 files/252 tests;
  `npm run test:contract` 11 files/52 tests; typecheck, production build, and test build passed;
  `npm run test:e2e:extension-core` passed 6/6 with zero skips through the real proxy.
- The proxy-routed release matrix passed Chrome 150 en-US 6/6 and zh-TW 6/6. Chrome 151 en-US/zh-TW
  each failed closed during unpacked-load preflight with the documented branded-sideload automation
  block. T091, T093, and T094 remain open; no two-major or owner acceptance pass is claimed.

---
## Phase 18: Convergence — Bounded Capability Outcomes and Lifecycle Cleanup

**Purpose**: Close the finiteness and lifecycle gaps exposed while repairing the owner-reported
human-paced action-review deadlock. T001–T127 remain immutable; T091/T093/T094 stay owner/release
gates. No task here expands POC capability, permission, dependency, or protocol scope.

- [x] T128 Bound every content-script operation in
  `apps/extension/src/service-worker/content-broker.ts` (injection, probe, collection, execution,
  cancellation) with a finite upper limit that resolves to an existing stable failure stage code, so a
  content runtime that never answers cannot leave a task without a terminal while HTTP paths are already
  bounded at five seconds, per FR-003 and Constitution XI (missing)
- [x] T129 Wire `onDocumentOrOriginChange` from `apps/extension/src/service-worker/context-monitor.ts`
  to an approved Chrome navigation signal in the worker composition root, or remove it and record why
  lazy revalidation is sufficient; it is currently exported through
  `apps/extension/src/service-worker/runtime.ts` with no call site, so grants are never proactively
  expired on a mid-task document or origin change, per FR-005 and the spec "Page navigation or stale
  state" edge case (missing)
- [x] T130 Replace the silent early return in `handleCapabilityRequest`
  (`apps/extension/src/service-worker/control-port.ts`) that drops a `server.capability-request` while a
  safety or consent review is pending with a fail-closed submitted result, and cover it with focused
  coverage, so no protected request can be discarded without a result or terminal, per FR-003 (partial)
- [x] T131 Make the deterministic AI provider in `packages/test-kit/src/ai-adapter.ts` observe the abort
  signal that `apps/server/src/ports/ai-provider.ts` requires every provider to honour, and release its
  per-task waiters when a task ends without a capability or plan result, per plan: provider-neutral AI
  orchestration port (contradicts)
- [x] T132 Notify the AI orchestration port when `client.stop` terminalizes a task in
  `apps/server/src/task-channel/handler.ts`, so a cancelled task cannot leave a suspended generator and
  an unresolved per-task waiter behind, per FR-003 (partial)
- [x] T133 Close the task channel when `onTerminal` completes a task in
  `apps/extension/src/service-worker/control-port.ts`, matching the local-first lease release already
  performed by `haltTask`, so a terminal task's WSS connection and server-side channel session do not
  outlive it, per plan: Scale/Scope one task channel per runtime (partial)
- [x] T134 Evict terminal tasks and consumed tickets from `apps/server/src/domain/task-store.ts`, which
  currently retains every task and ticket for the process lifetime, per FR-003 transient task data and
  plan: Storage decision (partial)
- [x] T135 Honour the `deliver()` delivery result for the action and form-values consent projections in
  `apps/extension/src/service-worker/control-port.ts`, which currently ignore it while the T117/T118
  control-port recovery rule requires an undeliverable projection to be treated as undelivered, per
  FR-003 (partial)
- [x] T136 Record the origin-safety disclosure lifetime in
  `specs/001-ai-browser-assistant/contracts/extension-runtime.md`: one acknowledgment covers that exact
  canonical origin for the current task, and a lapsed service decision lifetime is re-assessed under the
  existing acknowledgment rather than shown as a second identical disclosure. The rule is currently only
  a code comment, per FR-004 and Constitution III (partial)
- [x] T137 Align the failure code used when the active page cannot be resolved inside the origin
  re-assessment path in `apps/extension/src/service-worker/control-port.ts` with the
  `unsupported-page` code the surrounding request path already uses for the same condition, so the
  user-visible reason does not depend on which internal path observed it, per FR-003 (partial)

### Convergence assessment note — 2026-09-02

- Findings were produced from the current code against `spec.md`, `plan.md`, `tasks.md`, and the
  constitution. No constitution MUST violation was found, so no CRITICAL task is emitted.
- The owner-reported deadlock itself is already repaired and evidence-backed; it is not restated here.
- No existing task was renumbered, reordered, or rewritten, and neither `spec.md` nor `plan.md` was
  modified.

### T128/T129 convergence evidence — 2026-09-02

- T128 focused red: four `apps/extension/tests/content-broker.test.ts` cases drove a fake runtime that
  accepts a message and never answers. Each returned the explicit `still-pending` sentinel rather than a
  failure, proving probe, injection, collection, and action round trips were all unbounded while every
  HTTP path already had a five-second limit.
- The broker now carries one finite termination bound on every page-facing operation, rejecting with the
  existing stable stage codes `content.probe`, `content.injection`, and `content.collection`. No new code,
  message, or user-facing string was added. A bounded action rejection deliberately reaches the existing
  `attention-required` / `execute-uncertain` outcome, so an unconfirmed effect is never reported as a
  clean failure. Focused green is 17/17.
- Review found that the concrete bound value is a numeric limit, which A-010 and Constitution IV reserve
  as an explicit product decision: a finite bound satisfies FR-003, but choosing the number does not.
  **The product owner approved ten seconds on 2026-09-02**, so the `NEEDS-CLARIFICATION` marker was
  removed and T138 is closed. The decision covers this content-operation termination bound only; it is
  not a latency target and does not extend the approved five-second HTTP bound to any other path.
- T129 focused red: with the handler neutralized, an **origin change** on the bound tab left the task's
  page-read grant projected as active mid-task, contradicting FR-008. Only the origin-change branch was
  proven red at runtime; the same-origin reload branch that expires form-value grants has no runtime red
  and is tracked by T139.
- `onDocumentOrOriginChange` is now reached from a `chrome.tabs.onUpdated` loading signal registered in
  `apps/extension/src/service-worker/index.ts`. The handler reads no URL from the event and adds no
  permission: it resolves the current origin through the active-page access the worker already uses. An
  origin change expires every task grant and clears the page bindings; a same-origin reload expires only
  form-value grants. It expires authorization only and never dispatches, allows, or replaces the
  revalidation each protected use still performs.
- Gates: `npm test` 42 files/262 tests; contract 11 files/52 tests; typecheck, production build, and test
  build passed; packaged core 7/7 with zero skips in `en-US` and 7/7 in `zh-TW`.

- [x] T138 Record an owner decision for the content-operation termination bound now marked
  `NEEDS-CLARIFICATION` in `apps/extension/src/service-worker/content-broker.ts`, then replace the
  provisional value and remove the marker, per A-010 and Constitution IV (contradicts)
- [x] T139 Add runtime coverage for the same-origin reload branch of the document-change handler, so the
  FR-008 form-value snapshot/grant invalidation is proven and not only the origin-change branch, and
  exercise the `changeInfo.status === "loading"` filter registered in
  `apps/extension/src/service-worker/index.ts`, per FR-008 (partial)
- [x] T140 Give the action round trip its own stable diagnostic stage code in
  `apps/extension/src/service-worker/content-broker.ts`, which currently reports a bounded execution
  failure as `content.collection`, per FR-003 observable failure staging (partial)
- [x] T141 Invalidate the document binding, pending action consent, and Plan on a same-origin document
  change in `apps/extension/src/service-worker/control-port.ts`, which
  `specs/001-ai-browser-assistant/contracts/permission-matrix.md` requires but which currently only
  fails closed at dispatch time, so a user can still be asked to approve an action against a dead
  handle (partial)

### T130/T131/T132/T135 convergence evidence — 2026-09-02

All four belong to the same family as the owner-reported deadlock: a path returns without producing a
capability result, so the task never reaches a terminal.

- T130/T135 focused red: a new `apps/extension/tests/control-port-capability-delivery.test.ts` drives the
  worker through a fake task channel. Delivering a capability request while a review is already open, and
  delivering one whose review cannot reach the panel, both ended with `timeout waiting for condition` —
  no result was ever submitted. Green 2/2.
- T130: the entry guard now distinguishes a halted task, which is already terminal and owed nothing, from
  a request arriving while a review is open, which fails closed with `review-in-progress`. The channel is
  one request at a time, so such a request can never be answered by the user.
- T135: all four review projections — action consent, general page-read consent, the chained form-values
  consent, and the origin-safety disclosure — now honour the `deliver()` result. An undelivered review is
  cleared and its request fails closed with `review-undeliverable` instead of blocking every later request
  behind a card that does not exist. Both codes are internal capability-result fields; no user-facing
  string, locale entry, or public runtime protocol field was added.
- T131 focused red: `packages/test-kit/src/ai-adapter.test.ts` aborted a task suspended on a capability
  waiter; `next()` stayed `still-pending`, contradicting the explicit contract in
  `apps/server/src/ports/ai-provider.ts`. Green 10/10.
- T131: the provider now observes the abort signal, settles the pending waiter, and releases every waiter
  and stored submission for that task, which also closes the map leak that kept a resolve function alive
  for the process lifetime.
- T132 is closed by T131 rather than by new handler code. Review of
  `apps/server/src/task-channel/handler.ts` confirmed `client.stop` already reaches
  `terminalizeOnce` → `teardown` → `controller.abort()`, and the orchestrator already passes that signal
  through. The signal was being sent and ignored; only the provider half was missing.
- Gates: `npm test` 43 files/265 tests; contract 11 files/52 tests; typecheck, production build, and test
  build passed; packaged core 7/7 with zero skips in `en-US` and 7/7 in `zh-TW`.
- **A regression introduced by T135 was caught in review and fixed before completion.** Three of the four
  new delivery checks projected to the port captured when the task started rather than to the live
  `activePort`. The worker already tolerates a panel reconnect mid-task, and after one the captured port
  is permanently dead, so the new fail-closed path would have failed every later review with
  `review-undeliverable` while a healthy panel was waiting. Before T135 the same stale port merely lost
  the projection silently; the new code turned that into an active task failure.
- Red for the fix: a reconnect case in `apps/extension/tests/control-port-capability-delivery.test.ts`
  accepts a replacement panel port, kills the original, then delivers a capability request. It failed
  with `timeout waiting for condition` because the review never reached the live panel. All four review
  projections now target `activePort`, matching `projectTerminal` and `projectGrants`, and the now-dead
  port parameters were removed from `handleCapabilityRequest`, `projectCapabilityConsent`, and
  `assessAndProjectConsent`. Focused green 3/3.
- The first review attempt for this batch stopped early on a provider rate limit and produced no
  verdict; it was re-run to completion rather than treated as a pass.
- Re-verified after the fix: `npm test` 43 files/266 tests; contract 11 files/52 tests; typecheck,
  production build, and test build passed; packaged core 7/7 with zero skips in `en-US` and 7/7 in
  `zh-TW`.
- Review also recorded two pre-existing issues outside this change, now tracked as T142 (progress and
  Plan projections still use the captured port) and T143 (`failCapability` does not thread the task
  generation).

- [x] T142 Project progress and Plan review to the live panel port rather than the port captured when
  the task started in `apps/extension/src/service-worker/control-port.ts`, so a panel that reconnects
  mid-task stops silently missing those updates the way the consent and safety projections did, per
  FR-003 (partial)
- [x] T143 Thread the task generation through `failCapability` in
  `apps/extension/src/service-worker/control-port.ts` as `abandonUndeliverableReview` already does, so
  a superseded task cannot submit a capability result, per FR-003 (partial)

### T142/T143 convergence evidence — 2026-09-02

- T142 focused red: with a replacement panel port accepted and the original dead, neither a progress
  frame nor a Plan review reached the live panel — `timeout waiting for condition` in
  `apps/extension/tests/control-port-capability-delivery.test.ts`. Both arrive from the server long
  after the task started, so they now follow `activePort` like every other post-start projection.
- Three other captured-port deliveries were examined and deliberately left alone, because each replies
  to the port it is currently serving rather than projecting later: the service-state projection at
  connect, the `ui.task.start` acknowledgement handled on that port's own listener, and the marker
  recovery projection whose delivery result decides whether the marker may be removed.
- T143 is hardening with no reachable red today, which review had already established: every
  `failCapability` call site is fenced by `safetyGeneration`, and that counter moves with
  `taskGeneration` at task start, terminal, and halt. The generation is now threaded explicitly at all
  ten call sites so the guarantee no longer depends on those two counters staying in step. No test is
  claimed for a path that cannot currently be reached.
- Gates: `npm test` 43 files/267 tests; contract 11 files/52 tests; typecheck, production build, and test
  build passed; packaged core 7/7 with zero skips in `en-US` and 7/7 in `zh-TW`.

### T141 convergence evidence — 2026-09-02

- Focused red: two new `apps/extension/tests/control-port-task.test.ts` cases drove a same-origin
  document change while an action review, and separately a Plan review, was pending. Both timed out
  waiting for a terminal — the card stayed up over a document that no longer existed and the task never
  ended. Green 48/48.
- The permission matrix requires a document change to invalidate the document binding, every form-value
  snapshot/grant, action grants, and the complete Plan. The binding is now cleared on any document
  change rather than only on an origin change; a pending action review is withdrawn and its request
  answered `stale-context`/`document-changed`; a pending Plan is withdrawn and answered as not approved,
  because the protocol has no separate invalidation outcome and inventing one is out of scope. Action
  grants need no separate expiry: they are minted and consumed inside a single dispatch.
- The change broke four packaged journey blocks. Rather than assume, the cause was bisected inside T141
  itself: clearing the binding alone kept the gate green, and withdrawing the pending review was the
  part that changed the journeys. That is the intended improvement — the user is no longer left holding
  an approve button for an element that is gone — so those blocks were updated to assert the
  invariant that actually matters, no effect plus an explicit failure, and to approve only while the
  control is still offered. Whether invalidation happens as the document changes or when approval is
  attempted is a browser timing detail; the deterministic assertion on withdrawal lives in the unit
  tests instead, so branded-Chrome behaviour cannot make the journey flaky. Review also noted a latent
  edge: `pageBindings.clear()` is not scoped to the navigated tab. Every entry shares one tab under the
  current single-document-per-task design, so it is equivalent today, but nothing enforces that. Review assumed a
  same-document `history.pushState` would never reach the handler; the bisect showed that block did in
  fact require the change, so the empirical result is recorded rather than the assumption.
- One earlier packaged failure was a harness fault, not a product one: `evaluatePanel` awaited a CDP
  response with no bound, so a stalled channel consumed the whole test timeout instead of reporting
  itself. It is now bounded.
- Gates: `npm test` 43 files/269 tests; contract 11 files/52 tests; typecheck, production build, and test
  build passed; packaged core 7/7 with zero skips in `en-US` and 7/7 in `zh-TW`.

- [x] T144 Give a Plan invalidated by a document change an outcome distinct from user denial in
  `apps/extension/src/service-worker/control-port.ts` and the task-channel contract; the fail-closed
  answer currently reuses the plan-denied decision, so the user is told "Plan denied" for something
  they did not do, per FR-003 understandable terminal reasons (partial)
- [x] T145 Withdraw a pending `form-values` consent on a document change alongside the action review in
  `apps/extension/src/service-worker/control-port.ts`; it is currently only failed closed if the user
  acts on it, so the card can still stand over a document that is gone, per FR-008 (partial)

### T133/T134 convergence evidence — 2026-09-02

- T133 focused red: delivering a terminal to the worker never closed the task channel — the fake
  channel's `closed` counter stayed at zero in
  `apps/extension/tests/control-port-capability-delivery.test.ts`. **Correction after review**: this is
  defense in depth, not a fixed leak. `apps/extension/src/service-worker/task-channel-client.ts` already
  closes the socket itself after delivering a terminal, so no socket was outliving its task in
  production. What was missing is that the worker did not release the lease on a terminal the way it
  already did on Stop, leaving the guarantee dependent on the transport layer. It no longer is.
- T134 focused red: two store-level cases in `apps/server/tests/tasks-and-channel.test.ts` showed a task
  record surviving the end of its channel session, and a task whose connection ticket expired without
  ever being used surviving indefinitely. The store now drops a record when its channel session ends and
  sweeps abandoned records on write. **No new numeric limit was introduced**: the sweep uses the
  connection ticket's existing expiry rather than inventing a retention period, so A-010 and
  Constitution IV are not re-engaged the way the T128 bound was.
- **Evidence-integrity correction.** Playwright's `webServer` entries use `reuseExistingServer: true`,
  and the deterministic service on 18786 had been running since before this work began. Every packaged
  run recorded earlier in this session therefore exercised the extension changes against a service that
  had never loaded the server-side changes from T131. The stale process was stopped so Playwright would
  start a current-code instance, and the packaged gate was re-run against it. T131 and T134 are executed
  end to end for the first time by these runs; the earlier packaged figures stand only as evidence for
  the extension-side changes.
- Gates: `npm test` 43 files/272 tests; contract 11 files/52 tests; typecheck, production build, and test
  build passed; packaged core 7/7 with zero skips in `en-US` and 7/7 in `zh-TW`, both against the
  restarted service.
- One zh-TW packaged run hung for 25 minutes with no artifacts and was killed; the immediate re-run
  passed 7/7. No root cause is claimed: the run's output had been piped through `tail`, which hid its
  progress. That pipe was removed so a recurrence is diagnosable.

### T145 convergence evidence — 2026-09-02

- Focused red: a same-origin document change while a `form-values` review was pending left the card
  standing over a document that no longer existed and the task never reached a terminal —
  `timeout waiting for projection` in `apps/extension/tests/control-port-task.test.ts`. Green 49/49.
- The withdrawal now covers every document-bound review rather than the action card alone. A
  `form-values` card is backed by a snapshot already collected from the old document, so it fails closed
  with `stale-context`/`document-changed`, and the test also pins that the collected page content is
  never delivered as if it were current. A `general-page-read` consent is deliberately kept: it is
  task-scoped, so approving it simply reads the document that is there now.
- **Review correction carried in from T133/T134.** Review found the T133 rationale overstated: the
  task-channel client already closes its own socket after delivering a terminal, so no socket was
  outliving its task. T133 is defense in depth — the worker now releases the lease itself instead of
  depending on the transport layer. The evidence text was corrected rather than left standing.
- Review also found the T134 claim had no coverage of its own wiring, only of the store in isolation. A
  real WebSocket session test was added in `apps/server/tests/tasks-and-channel.test.ts`: after a
  terminal, a later cancel returns 404 instead of 204. Reverting the handler wiring turns it red.
- Gates: `npm test` 43 files/274 tests; contract 11 files/52 tests; typecheck, production build, and test
  build passed; packaged core 7/7 with zero skips in `en-US` and 7/7 in `zh-TW`.
- **Packaged-gate stability is not clean.** Three unattributed intermittent failures occurred during this
  session's work: one 25-minute hang with no artifacts, one `clickButton` miss, and one core-journey
  failure that passed on immediate re-run. One contributor was found and fixed — `evaluatePanel` awaited
  a CDP response with no bound. The rest are unexplained, and Playwright clears `test-results/` on each
  run so their artifacts were overwritten before they could be read. T146 tracks this; no green run here
  should be read as evidence that the gate is stable.

- [x] T146 Make packaged-gate failures diagnosable and quantify the intermittent instability observed on
  2026-09-02: preserve failure artifacts across runs so they are not overwritten, and identify the
  remaining causes of the hang and the two one-off failures, per FR-003 observable, repeatable evidence
  (partial)

### T146 convergence evidence — 2026-09-02

- Focused red: a new case in `tests/contract/test-environment.contract.test.ts` imports the packaged
  gate config and asserts three properties. It failed on the first — the config had no `globalTimeout`.
- Diagnosis first, not a guess. The config already carried a 120s per-test timeout, so the 25-minute
  stall could not have been a hung test: it stalled where a per-test timeout cannot reach, in setup,
  teardown, or process exit. A run-level bound is the only thing that ends that class, so
  `globalTimeout` now bounds the whole run and a stall is reported instead of waited on.
- Each run now writes into its own `test-results/<profile>-<locale>-<timestamp>` directory. Playwright
  cleans its output directory when a run starts, which is why the artifacts of two earlier intermittent
  failures were destroyed by the very next run before they could be read. Seven run directories now
  persist side by side.
- **A defect in this change was found and fixed before completion.** The first version computed the run
  id at module scope. A one-off `[DEBUG-CFG]` marker proved Playwright loads the config once per
  process: the main process and the worker produced different ids, so worker attachments would have
  landed in a different directory than the run reported. The id is now pinned in the environment by
  whichever process reaches it first and inherited by the workers; the marker confirmed both processes
  share one id and was then removed. No `[DEBUG-` marker remains in any source or test.
- The contract also pins `retries: 0`. Retrying would turn an intermittent failure green and destroy the
  very signal this task exists to preserve.
- **Stability is sampled, not established.** Three consecutive `en-US` runs passed 7/7 after the change,
  and two `zh-TW` runs passed 7/7 earlier the same day. That sample is far too small to establish a
  failure rate, and the three intermittent failures seen earlier remain unexplained. Nothing here should
  be read as evidence that the gate is stable — only that a future failure will leave something to read.
- **A blocking review finding was fixed before completion.** A CLI `--reporter` flag replaces the
  configured reporter array wholesale instead of adding to it, and `tests/release/run-p1-matrix.ts`
  passed one. The machine-readable report was therefore never written on the release-matrix path — the
  multi-profile scenario that motivated this task. That flag is removed, and a contract case now pins
  both the configured JSON reporter and the absence of a CLI reporter override in that runner. This also
  explains why no `report.json` appeared during the first check: those runs were invoked by hand with
  the same flag. Through `npm run test:e2e:extension-core` the report is written, and a fresh run
  recorded `expected: 7, unexpected: 0`.
- The matrix runner now also pins a distinct `HALLPASS_GATE_RUN_ID` per profile, so an inherited value cannot
  make all four profiles share one output directory and clear each other's artifacts.
- Review confirmed the environment pinning is sound (workers inherit the parent environment at fork
  time) and that the `globalTimeout` value is not arbitrary — it is the sum of the timeouts already
  configured in the file. It also noted a limit worth stating plainly: the contract test checks the
  shape of `outputDir` from one module evaluation, so it cannot distinguish the shared pinning from an
  independently recomputed id. That property is only observable in a real multi-process run.
- Known trade-off: run directories accumulate under the ignored `test-results/` and are not pruned
  automatically. Cleanup is manual.
- Gates: `npm test` 43 files/274 tests; contract 11 files/54 tests; typecheck, production build, and test
  build passed; packaged core 7/7 with zero skips.

### T144 convergence evidence — 2026-09-02

- Focused red, in both locales: a Plan invalidated by a document change terminated as
  `plan.denied` — `expected 'plan.denied' to be 'plan.document-changed'`. The user was told they denied
  a plan they never acted on. The case is now parameterized over `en-US` and `zh-TW` so the reason and
  its wording are both pinned; green 50/50.
- No protocol was widened. The task-channel plan decision remains `approved` or `denied`, and the server
  is still told the Plan was not approved purely to unwind it. What changed is that the worker projects
  the accurate reason first: `worker.task.terminal` already carries a free-form `reasonCode` and
  `summary`, a terminal is projected exactly once, and the server's later plan-denied terminal is
  therefore suppressed rather than shown.
- The summary is a reviewed catalog entry in both locales — `status.planDocumentChanged`, "The page
  changed before the plan was approved" / "頁面在計畫核准前已變更" — so the fix cannot reintroduce the
  fixed-English class of defect the owner reported earlier. The locale parity contract covers the new key.
- **Two blocking review findings were fixed before completion, and both were real.**
  - The outcome was `failure`. Nothing had been dispatched, which is exactly the condition
    `apps/extension/src/service-worker/stop-controller.ts` already reports as a cancellation rather
    than a failure, and `spec.md` frames plan invalidation as stopping. Showing "Failed" / "失敗" for a
    normal browsing event the user did not cause is a milder form of the defect this task exists to
    fix. It is now `cancellation`, and the test pins that outcome rather than merely asserting it is
    not success.
  - The branch projected the terminal before tearing down local state, unlike every other termination
    path in the file, and left `running`/`starting`/`currentTaskKey` to be cleared by the server's
    later echo. In that window the panel had been told the task ended while the worker still believed
    one was live, so the next submission would have been dropped with no feedback at all — and if the
    round trip never completed, the state would never have cleared. The teardown is now local-first
    like `haltTask` and `onTerminal`, and the plan decision was replaced by the channel's existing Stop
    signal, which states nothing untrue, followed by closing the lease locally.
- The test now also asserts exactly one terminal reaches the panel, closing the exclusivity gap review
  identified: the property was relied on but never checked.
- Gates: `npm test` 43 files/275 tests; contract 11 files/54 tests; typecheck, production build, and test
  build passed; packaged core 7/7 with zero skips in `en-US` and 7/7 in `zh-TW`.

### T136/T139 convergence evidence — 2026-09-02

- T136 adds a "Disclosure lifetime" section to
  `specs/001-ai-browser-assistant/contracts/extension-runtime.md`. One acknowledgment covers that exact
  canonical origin for the current task; a lapsed classifier decision is re-assessed under the existing
  acknowledgment rather than shown as a second identical disclosure, and re-assessment stays fail-closed
  on deny, unknown, invalid or lapsed validity, unavailability, and tab or document drift. The rule was
  previously only a code comment, which is what let review question whether the behaviour was defensible
  at all. No spec or plan file was modified.
- T139 covers the two halves that were asserted but never proven.
  - The same-origin reload branch of FR-008: a new case in
    `apps/extension/tests/control-port-task.test.ts` holds the form-value collection open through the
    harness's own collector so the grant is genuinely live and the task still running when the document
    changes, then proves the form-value grant expires while the task's page-read grant survives.
    Neutralising the same-origin expiry turns it red (`expected true to be false`).
  - The navigation filter itself: `apps/extension/tests/service-worker-navigation-signal.test.ts` loads
    the real service-worker entrypoint against a fake `chrome`, captures the registered
    `tabs.onUpdated` listener, and proves a completion notice and a same-document URL change are both
    ignored while a document that starts loading is forwarded. Removing the filter turns it red
    (`expected [ 7, 7, 7 ] to deeply equal []`).
- Gates: `npm test` 44 files/277 tests; contract 11 files/54 tests; typecheck, production build, and test
  build passed.
- **The packaged gate could not be re-run: the test TLS leaf expired mid-session.** Every one of the
  seven cases failed with `net::ERR_CERT_DATE_INVALID`. The leaf `CN=localhost` was valid
  `2026-08-26 13:37:51` to `2026-09-02 13:47:50` and the run started at roughly 14:01; the CA itself
  (thumbprint `E21CCF46...`) remains valid until 2027-08-26, and `npm run test:certs:verify` still
  passes because it checks the CA, not the leaf. The leaf has a seven-day lifetime. Re-issuing it is an
  owner action because it touches the CurrentUser trust store, which this session does not modify.
  Neither T136 nor T139 changes product behaviour, so the blocked gate does not affect their evidence —
  but no fresh packaged figure exists after this change.
- The per-run `report.json` added by T146 is what identified this in one step rather than by re-running
  and guessing; before that change the failing run's artifacts would have been cleared by the next run.

- [ ] T147 Re-issue the expired test TLS leaf and record a fresh packaged gate result, then consider a
  pre-flight check that fails with the leaf's expiry rather than seven `ERR_CERT_DATE_INVALID`
  navigation errors, per the release evidence contract (partial)

### T137/T140 convergence evidence — 2026-09-02

- T137 red: an active page that becomes unresolvable while its origin is being re-assessed was reported
  as `origin-safety-unavailable`, sending whoever reads the failure to the safety service when the real
  cause was the page. The surrounding request path already calls that same condition `unsupported-page`.
  The two causes no longer share one catch: the page resolution has its own, and only the classifier
  call can report an outage. The test drives it deterministically by making the page unresolvable from
  inside the second assessment, which is the moment between the two resolutions.
- T140 red: a bounded action round trip reported the `content.collection` stage —
  `expected 'content.collection' to be 'content.execution'`. An action that may already have happened
  was filed under collection, which is the wrong place for a reader to start. The round trip now has its
  own stable stage code. This adds one code to the existing closed set; it carries no page, target, or
  argument data and the user-visible outcome is unchanged, still `attention-required` /
  `execute-uncertain` for an unconfirmed effect.
- Gates: `npm test` 44 files/278 tests; contract 11 files/54 tests; typecheck, production build, and test
  build passed.
- **No packaged figure: the gate is still blocked by the expired test TLS leaf recorded under T136/T139.**
  Neither change alters a packaged journey's observable behaviour, but no fresh packaged run exists and
  none is claimed. T147 covers re-issuing the leaf and recapturing that gate.

- Review of T136/T137/T139/T140 found no blocking issue. It verified the new contract text against the
  code line by line rather than taking it on trust, confirmed the new stage code never crosses the
  task-channel boundary and leaves the user-visible outcome unchanged, and confirmed both new tests fail
  if the behaviour they cover is removed. One nuance is recorded rather than actioned: nesting the page
  resolution inside its own catch changes the shape of a hypothetical synchronous throw from
  `submitCapabilityResult`, which would now be caught twice instead of propagating. That call cannot
  throw synchronously with the current channel client, and the same unguarded assumption already exists
  at several older call sites, so no task is raised for it.

