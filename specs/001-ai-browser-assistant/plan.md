# Implementation Plan: Chrome AI Browser Assistant POC

**Branch**: N/A (non-Git workspace; logical feature `001-ai-browser-assistant`) | **Date**: 2026-08-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-ai-browser-assistant/spec.md`

**Status**: Phase 0/1 planning complete and synchronized with the approved POC scope, including
R-013 navigation deferral and Q-020 controlled form-value parity. The existing task decomposition is
revalidated separately; this plan does not claim implementation readiness on its own.

**Note**: This plan ends after Phase 1 design. It creates no product implementation, deployment,
provider account, or reference-extension derivative.

## Summary

Build the seven approved MUST requirements as a clean-room Manifest V3 Chrome Extension plus a
product-controlled Node.js service. A React side panel provides the bilingual, keyboard-accessible
workspace; an MV3 service worker is the sole browser/security authority; an isolated, on-demand
top-frame content runtime collects redacted bounded DOM context and, only under a separate
current-task/current-document `page.form-values` grant, bounded task-relevant ordinary form values and
selected-option state that local policy conclusively classifies non-sensitive. It executes only three
approved action categories: scroll, non-navigation low-risk click, and non-sensitive text entry. The
service owns account-session validation and AI/task orchestration behind
provider-neutral adapters. Shared runtime schemas enforce consent, origin safety, sequencing,
cancellation, and exactly one terminal result without durable task/page/action history.

The manual-testability increment keeps that trust boundary: the service worker owns the authoritative
`GET /health` probe and all authorization HTTP calls; the side panel receives only typed projections.
For Chrome 142+ Local Network Access, one narrow exception permits the visible side panel to issue a
bounded `GET /health` only after the user presses the recovery action. That request exists solely to
present the browser permission decision; its response is discarded and cannot change product state.
Panel connection flows `checking → available → session restore` or `checking → unavailable`.
Unavailable state shows the pinned local service address, `npm run dev:test-server`, and one manual
retry action. Health and authorization HTTP calls share a five-second upper bound, while monotonic
probe/restore generations discard late results from older attempts.

## Technical Context

**Language/Version**: TypeScript 5.9 in strict mode; Node.js 24 LTS; standards-based HTML and CSS

**Primary Dependencies**: Chrome Manifest V3 public APIs; React 19.2; Vite 8.1; Fastify 5;
`@fastify/websocket` 11; Zod 4. No extension framework, component library, state-management library,
database, AI-provider SDK, identity-provider SDK, telemetry SDK, or reference-bundle dependency.

**Storage**: `chrome.storage.session` only for minimum account-session/in-progress-authorization
security material and opaque non-content operation markers needed to prevent replay; in-memory task,
plan, consent, page snapshot, target, action, origin-assessment, and server-session records. Operation
markers contain no prompt, URL/origin, page, target, argument, or result content. No
`chrome.storage.local`, IndexedDB, durable server database, task history, origin-assessment cache, or
telemetry store exists in the POC.

**Testing**: Vitest 5 for domain, schema, UI, server, and Chrome-adapter unit/integration tests;
Playwright 1.62 with a persistent bundled-Chromium context, the packaged unpacked MV3 Extension, and
deterministic local service for the mandatory automated core gate; current and previous branded Chrome
remain the final owner matrix rather than the inner development loop. The observable E2E must exercise
the built service worker, side panel, injected content runtime, and page effect rather than importing
private implementation functions. It includes the complete P1 suite on both recorded Chrome majors
rather than transport smoke alone;
axe-core checks plus keyboard-only automation; manual Windows 11 acceptance with current-stable NVDA
in `en-US` and `zh-TW` on the two Chrome majors recorded at release.

**Target Platform**: Windows 11 desktop Chrome, then-current and immediately preceding stable major;
ordinary top-level HTTP(S) HTML in the current selected tab. Product service targets Node.js 24 LTS
over HTTPS/WSS. Local development separates a `localhost` product endpoint from a `127.0.0.1` page
fixture, uses a deterministic proxy, a stable test Extension ID/configuration, and per-machine trusted
test TLS installed before browser E2E; it never disables certificate validation.

**Project Type**: Greenfield two-runtime application: Chrome Extension plus web service, with shared
domain and wire-contract packages in one npm workspace.

**Performance Goals**: Service-health and authorization HTTP operations have an approved five-second
upper bound. No other numeric latency, throughput, retry, or storage SLA is authorized. The design must
render progressive output without blocking primary controls, prioritize local Stop ahead of network
cancellation, process browser effects sequentially, and enforce configurable bounded payloads.

**Constraints**: Clean-room provenance; Manifest V3; least privilege; build-pinned product HTTPS/WSS
origins enforced by Extension CSP and exact service CORS/Origin checks. The current production baseline
has no network host permission; the unpacked deterministic build alone has exact
`https://localhost/*` host access for Chrome Local Network Access and no access to the `127.0.0.1` page
fixture. Assistant-initiated full-document, link, form, script-driven, and other navigation effects are deferred,
and production has no DNR/alarm containment authority. No `<all_urls>`, `tabs`, `webNavigation`, debugger, native messaging, remote code, arbitrary page script,
iframe/Shadow DOM traversal, telemetry, durable Core history, batch/multi-tab execution, webpage file
upload, irreversible high-risk effect, persistent consent, or action replay after lifecycle loss.

### Packaged content-runtime build and browser gate

The MV3 service worker remains an ES module and the side panel remains a module-backed document. The
on-demand content runtime is a different execution target: `chrome.scripting.executeScript({ files })`
must receive one self-contained classic-script artifact. The Extension build therefore emits the worker
and panel in the primary Vite build, then emits a no-export content-runtime bootstrap as an IIFE with all
dependencies bundled. Both test and production builds fail if that artifact cannot be parsed as a classic
script or retains a static import/export/chunk dependency.

The inner browser gate launches Playwright's bundled Chromium in a persistent context with the packaged
test Extension. It uses the existing test-only `https://localhost/*` host permission and the localhost
alias of the page fixture; production retains zero host permissions and manual branded-Chrome acceptance
still exercises `activeTab`. The harness first proves probe-miss → real injection → probe → DOM collect,
then drives the side-panel US2 and US3 journeys. Chromium 151 rejects the documented CDP permission names
for Local Network Access, so the disposable automated context disables only the browser-owned LNA check
instead of changing the Extension manifest or product behavior. This is an explicit runner variance:
the branded-Chrome gate still owns the real permission prompt/denial evidence.
User-visible fixed UI must have reviewed `en-US` and `zh-TW` coverage with English fallback and must
fail closed if consent or safety copy is unavailable or ambiguous.

**Scale/Scope**: One active user-triggered task and one current-tab control lease per Extension runtime;
one sequential plan step at a time; exactly the seven MUST requirements. Automated tests use
deterministic auth, AI, and origin-safety adapters. AI and identity vendors remain replaceable deployment
choices and cannot change the approved Extension/service contract.

### Service availability and side-panel information architecture

The side panel is a Chrome-native-feeling, full-height single-task workspace rather than a chat log.
Its data flow and render ownership are:

```text
side-panel Port connect
    → service worker starts one generation-tagged GET /health probe
    → 204: worker projects available, then restores the session for that same generation
    → non-204 / rejection / five-second timeout: worker projects unavailable
    → older probe or restore completion: ignored

explicit unavailable-state recovery gesture
    → side panel starts at most one five-second GET /health permission bootstrap
      with targetAddressSpace=local; status, body, and error are discarded
    → while pending, duplicate recovery gestures are disabled
    → settle / reject / timeout: side panel emits exactly one ui.service.retry
    → service worker runs the sole authoritative generation-tagged probe above
```

The panel never calls authorization, session, task, page, or WSS endpoints and never polls. Its only
direct product-origin request is the explicit-gesture, response-agnostic Local Network Access bootstrap
described above. It has a scrollable central state region
and fixed request composer. Empty, progress, review, and terminal content are mutually exclusive;
sign-in and task submission are disabled until service availability is confirmed, and duplicate task
submission is disabled during running or review states. Safety disclosure, consent, Plan, active Grant,
and active-control/Stop surfaces render only when their state is actionable. Closed protocol values are
resolved through reviewed `en-US`/`zh-TW` labels instead of raw identifiers or JSON.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Design Gate

| Principle / constraint | Status | Plan evidence |
| --- | --- | --- |
| I. Product Requirements are source of truth | PASS | Only PR-001–PR-005, PR-007, and PR-008 enter implementation scope; every candidate stays deferred. |
| II. Clean-room implementation | PASS | Architecture, schemas, names, and assets are independently designed from approved behavior and public platform documentation. |
| III. End-to-end traceability | PASS | Plan and later tasks must retain PR, FR, US, CT, SC, and F destination IDs; F-016/F-017 remain `REFERENCE-ONLY`. |
| IV. Explicit uncertainty | PASS | Vendor, distribution, numeric limits, and deferred-capability decisions remain bounded deployment or later product choices, never implicit POC behavior. |
| V. Least-privilege browser access | PASS | The pre-design production baseline uses `sidePanel`, `activeTab`, `scripting`, `storage`, and `identity` with zero host permissions; the isolated test-only LNA exception and navigation scope decision are evaluated explicitly in the post-design gate. |
| VI. Privacy, consent, minimization | PASS | Service worker gates every protected operation; classifier receives canonical origin only; Core task/page/action data remains transient. |
| VII. Observable/testable requirements | PASS | Quickstart and contract tests target public UI/effects and SC-001–SC-011; private functions are not acceptance criteria. |
| VIII. Manifest V3 baseline | PASS | MV3 service worker, side panel, on-demand scripting, and session storage are the only Extension platform baseline. |
| IX. Requirements before architecture | PASS | Blocking clarifications are resolved; architecture begins only in this authorized planning workflow. |
| X. Dependency discipline | PASS | Each dependency is justified in research and maps to UI, public Chrome integration, schema validation, product service, or required verification. |
| XI. Defined failure behavior | PASS | Runtime contracts include unsupported, denied, stale, interrupted, cancelled, uncertain-effect, unavailable, and terminal failure outcomes. |
| XII. Specification before implementation | PASS | Spec and planning gates are satisfied; this workflow writes design artifacts only and does not create product code. |

**Pre-design gate result**: PASS. No constitutional violation requires a waiver.

## Project Structure

### Documentation (this feature)

```text
specs/001-ai-browser-assistant/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── product-api.openapi.yaml
│   ├── task-channel.md
│   ├── extension-runtime.md
│   └── permission-matrix.md
└── tasks.md                    # Maintained by the separate speckit-tasks workflow
```

### Source Code (repository root)

```text
package.json                    # npm workspaces and repository-wide commands
package-lock.json
tsconfig.base.json

apps/
├── extension/
│   ├── public/
│   │   └── manifest.json
│   ├── src/
│   │   ├── service-worker/
│   │   │   ├── index.ts      # MV3 entrypoint and worker composition root
│   │   │   └── ...           # security authority, task channel, auth, policy, Stop
│   │   ├── side-panel/
│   │   │   ├── main.tsx      # side-panel application entrypoint/composition
│   │   │   └── ...           # consent/plan review, progress, status
│   │   ├── content-runtime/
│   │   │   ├── index.ts      # packaged on-demand top-frame runtime entrypoint
│   │   │   └── ...           # DOM read/action adapter
│   │   ├── chrome-adapters/   # narrow wrappers around approved public APIs
│   │   └── locales/           # independent en-US/zh-TW dictionaries and fallback
│   └── tests/
└── server/
    ├── src/
    │   ├── index.ts           # executable Node entrypoint
    │   ├── app.ts             # Fastify application composition
    │   ├── composition.ts     # explicit production/test port wiring
    │   ├── ports/             # identity, AI orchestration, and origin-safety ports
    │   ├── routes/            # auth, task bootstrap/cancel, origin assessment
    │   ├── task-channel/      # versioned WSS orchestration protocol
    │   ├── domain/            # transient sessions/tasks and terminal-state rules
    │   └── adapters/          # replaceable auth, AI, and safety implementations
    └── tests/

packages/
├── contracts/                 # Zod wire schemas and stable public error codes
├── domain/                    # pure state machines, policy, canonicalization
└── test-kit/
    ├── src/test-proxy.ts      # deterministic redacting HTTPS/WSS proxy
    ├── src/build-config.ts    # fixed test ID/endpoints/adapter-mode validation
    └── fixtures/              # deterministic adapters and safe page fixtures

scripts/
└── test-pki.ps1               # per-machine CurrentUser test CA/leaf install and exact cleanup

tests/
├── contract/                  # OpenAPI, WSS, runtime-message, privacy assertions
├── e2e/                       # unpacked-extension P1 journeys and failure cases
└── acceptance/                # two-Chrome, bilingual, keyboard, NVDA evidence forms
```

**Structure Decision**: Use one npm workspace because the repository is greenfield and both runtimes
benefit from one strict TypeScript model and shared validation. Keep privileged Chrome code, untrusted
page code, user-facing UI, and remote orchestration in separate packages/directories so trust boundaries
remain auditable. Each runtime has one explicit composition root and executable entrypoint; tests may
inject deterministic ports, but production startup rejects missing live deployment adapters and never
silently selects a test adapter. No directory or dependency is reserved for a deferred or
reference-only capability.

### Implementation Slice Dependencies

The product stories remain independently valuable acceptance slices, but their implementation is not
falsely parallelized:

1. Foundation and US-001 establish shared contracts, account/session state, and the packaged entrypoints.
2. US-002 owns the first runnable end-to-end task loop: server app/entrypoint composition, the
   provider-neutral AI orchestration port, deterministic test wiring, progressive answer/page-read
   channel, controlled form-value grants, shared worker/side-panel Stop, and final result-transmission
   fences.
3. US-003 explicitly depends on that US-002 runtime and extends its target registry, Plan, marker, Stop,
   and channel composition with browser effects. It does not introduce a second task loop or overwrite
   the shared files in parallel.

Internal deterministic POC acceptance may compose the server with `packages/test-kit` adapters under
an explicit test configuration. A production/external-pilot composition has no default AI or identity
vendor; it must fail startup until separately approved live adapters are supplied.

### Post-Design Gate

| Principle / constraint | Status | Phase 1 evidence |
| --- | --- | --- |
| I. Product Requirements are source of truth | PASS | [quickstart.md](./quickstart.md) names exactly the seven MUST requirements and explicitly excludes every candidate/deferred capability. |
| II. Clean-room implementation | PASS | [research.md](./research.md) derives choices from the approved spec and public primary documentation; no reference code, private protocol, provider, identifier, asset, or bundle is a dependency. |
| III. End-to-end traceability | PASS | The API, task-channel, runtime, permission, data, and acceptance artifacts cite their FR/CT/SC destinations; later tasks must preserve PR/FR/US/CT/SC/F IDs. |
| IV. Explicit uncertainty | PASS | Provider/identity vendors, release browser major numbers, distribution, numeric production limits, and deferred capabilities remain explicit later decisions. R-013 is resolved for POC scope and its containment design is clearly post-POC. |
| V. Least-privilege browser access | PASS | [permission-matrix.md](./contracts/permission-matrix.md) fixes exactly five production API permissions and the isolated test-only LNA host exception. POC capability schemas exclude assistant navigation, DNR, and alarms. |
| VI. Privacy, consent, minimization | PASS | [data-model.md](./data-model.md), [product-api.openapi.yaml](./contracts/product-api.openapi.yaml), and [task-channel.md](./contracts/task-channel.md) make Core data transient, bind ordinary page-read and `page.form-values` grants separately, bind form values to one current document, minimize origin classification, and prohibit sensitive/history/telemetry data. |
| VII. Observable/testable requirements | PASS | [quickstart.md](./quickstart.md) defines deterministic observable journeys, privacy/network inspection, lifecycle failures, and eight owner-run browser/locale/accessibility passes. |
| VIII. Manifest V3 baseline | PASS | [extension-runtime.md](./contracts/extension-runtime.md) defines the MV3 service worker authority, Side Panel Port, on-demand isolated top-frame runtime, session markers, lifecycle epoch, and no-replay behavior. |
| IX. Requirements before architecture | PASS | The product owner's navigation-deferral decision is encoded in the spec, research, data/action/permission contracts, and acceptance guide before task decomposition. |
| X. Dependency discipline | PASS | [research.md](./research.md) records the need and rejected alternatives for every runtime/test dependency; no SDK/framework is reserved for an unselected vendor or deferred feature. |
| XI. Defined failure behavior | PASS | [task-channel.md](./contracts/task-channel.md) and [extension-runtime.md](./contracts/extension-runtime.md) define denial, unsupported, stale, interruption, uncertain effect, cancellation, attention-required, failure, idempotency, and one terminal state. |
| XII. Specification before implementation | PASS | Phase 0/1 artifacts are synchronized. This planning synchronization creates no product code, dependencies, deployment, or deferred-feature scaffolding; tasks are maintained only by their separate authorized workflow. |

**Post-design gate result**: PASS. Dependency-ordered tasks must still pass their own cross-artifact
analysis. This planning workflow creates no implementation.

## Post-POC Progressive Parity Roadmap

The product direction is to approach the Reference Extension's confirmed externally observable behavior
incrementally after the POC. This table orders evaluation; it is not a release commitment and grants no
authority to prebuild deferred UI, state, permissions, dependencies, or protocol branches.

| Stage | Observable scope | Entry gate | Required exit evidence |
| --- | --- | --- | --- |
| 0 — POC `hallpass-v1` | Seven MUST requirements; page read with separately granted controlled non-sensitive form values/selected-option state, plus scroll, non-navigation low-risk click, and non-sensitive text entry | Current approved spec and five-permission contract | P1 deterministic coverage on both recorded Chrome majors, exact manifest/contracts, two Chrome majors × two locales, keyboard and owner NVDA acceptance |
| 1 — Navigation Lab | Deferred PR-005/F-004 assistant navigation gap | New owner scope decision; R-013 threat/data/permission/contract proposal | Redirect/download/unsupported-document containment and cleanup evidence on both release Chrome majors; additive profile approval |
| 2 — SHOULD increments | PR-009, PR-010, PR-018, PR-019, each independently | Observable-gap and traceability review per requirement | Updated spec, action/data/permission matrices, clean-room contracts, and full POC regressions per increment |
| 3 — COULD increments | PR-011, PR-013, PR-017, each independently | Explicit product priority after earlier profiles remain stable | Same gates as Stage 2 plus evidence that optional behavior does not weaken Core consent, Stop, privacy, or accessibility |
| 4 — Unresolved increments | PR-006, PR-012, PR-014–PR-016 | Resolve the existing product/server/iframe/connector uncertainties without inference | New approved requirement and acceptance criteria before planning; F-016/F-017 remain `REFERENCE-ONLY` unless separately promoted |

Every shipping increment uses an additive versioned capability profile when it changes remote/browser
authority. Older `hallpass-v1` peers reject new literals. Each increment preserves Reference Feature → PR →
Spec → Plan → Task → Implementation → Test traceability and independently re-runs both locale,
accessibility, privacy, permission, Stop, lifecycle, and no-replay coverage.

## Complexity Tracking

No complexity exception is approved. Navigation deferral keeps the POC on the exact five-permission
baseline and removes all destination, DNR-rule, cleanup-alarm, and post-navigation-Plan state. Any future
Navigation Lab is an isolated expansion decision and cannot add POC complexity by anticipation.
