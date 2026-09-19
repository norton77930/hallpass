# Clarification Queue: Chrome AI Browser Assistant

**Prepared**: 2026-08-24
**Specification**: [spec.md](spec.md)
**Questions asked / answered**: 9 / 9 total; 4 / 4 in the current clarification round
**Status**: Human product review required only for deferred items; Q-001–Q-004, Q-006–Q-008, Q-017, Q-019, and Q-020 are approved and all remaining recommendations are unapproved

This queue originally preserved the 18 Product Requirements Draft questions and adds Q-019 from the
formal specification quality review plus Q-020 from the approved form-context parity review. Q-001
through Q-004, Q-006 through Q-008, Q-017, Q-019, and Q-020 now
record the explicitly approved first-release POC scope, AI responsibility boundary, account-session
model, POC retention policy with governed per-capability evolution, current-tab action/consent boundary,
local-first origin-safety policy, Chrome/page support contract, bilingual locale/fallback/evolution
contract, single-owner POC accessibility/comprehension gate, and controlled form-value boundary. No
`BLOCKS-PLANNING` question remains.
All unresolved options are decision profiles for later discussion, not inferred requirements or POC
scope.

## Queue Summary

| Blocking level | Count | IDs |
| --- | ---: | --- |
| RESOLVED | 10 | Q-001–Q-004, Q-006–Q-008, Q-017, Q-019, Q-020 |
| BLOCKS-PLANNING | 0 | — |
| CAN-DEFER | 2 | Q-015, Q-016 |
| OPTIONAL | 8 | Q-005, Q-009–Q-014, Q-018 |
| **Total** | **20** | Q-001–Q-020 |

`F-016` and `F-017` remain `REFERENCE-ONLY` throughout this queue. Bringing either into product scope
would require newly approved Product Requirements; no option silently adopts them.

## Q-001 — Define the First-Release Product Scope

### Related Requirement

`PR-001`, `PR-009`–`PR-019`; `US-001`, `US-004`–`US-015`; `FR-001`, `FR-009`–`FR-019`;
`F-016`, `F-017`.

### Decision

Which candidate capabilities and entry points belong in the first release, and should either
reference-only companion/orchestrator ecosystem ever become a separately specified product?

**Decision status**: `RESOLVED` on 2026-08-24. The first release is a proof of concept containing only
the seven MUST requirements. Every candidate is deferred, and F-016/F-017 remain reference-only.

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | First release contains only the seven MUST requirements; all candidates remain deferred and F-016/F-017 stay reference-only. | Smallest scope and permission surface; delays productivity and onboarding candidates. |
| B | First release contains the seven MUST plus the four SHOULD requirements; COULD and NEEDS-CLARIFICATION items remain deferred. | Broader usable release; adds attachment, saved-task, onboarding, settings, and localization work. |
| C | First release contains the seven MUST plus a user-selected subset of candidates; F-016/F-017 stay reference-only. | Best product tailoring; requires an explicit item-by-item scope decision now. |
| D | Start separate companion/orchestrator product specification work and draft new PRs before reconsidering F-016/F-017. | Preserves clean boundaries; materially expands portfolio and trust-surface work. |

### Recommended Option

**Approved decision — 2026-08-24: Option A.** It creates the smallest coherent core, preserves least
privilege, and lets each candidate be added only after its own privacy and permission contract is
approved.

### Impact

- Scope: Defines the release boundary and backlog.
- UX: Determines which entry points and secondary journeys exist.
- Permission / Privacy: Controls whether optional sensitive capabilities expand baseline access.
- API / Architecture: Determines which external contracts and subsystems need planning.
- Testing: Defines the release acceptance matrix.

### Blocking Level

`RESOLVED`

## Q-002 — Select the AI Service and Responsibility Boundary

### Related Requirement

`PR-002`, `PR-003`; `US-001`, `US-002`; `FR-002`, `FR-003`; `CT-005`, `CT-006`.

### Decision

Which service provides conversation and browser-tool orchestration, and which responsibilities belong
inside the Extension versus a product-controlled server?

**Decision status**: `RESOLVED` on 2026-08-24. A product-controlled server owns AI provider integration
and task/tool orchestration; the Extension mediates browser context, user consent, and browser action
execution. The exact provider, protocol, and identity provider remain unresolved.

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | A product-controlled server owns AI/provider integration and tool orchestration; the Extension mediates browser context, consent, and actions. | Strong contract and credential boundary; requires backend operation and transmits approved task data through it. |
| B | The Extension calls the selected AI service directly and manages the task/tool loop locally. | Fewer product services; exposes provider integration complexity and credential handling to the Extension. |
| C | Hybrid: the server owns session/provider policy while the Extension manages a bounded task loop under a declared contract. | Can balance control and responsiveness; creates the most complex responsibility split. |

### Recommended Option

**Approved decision — 2026-08-24: Option A.** It centralizes provider credentials and policy while
keeping privileged browser effects behind the Extension's local consent boundary, at the cost of a new
operated backend.

### Impact

- Scope / API: Selects a mandatory external contract.
- Privacy: Determines where page, conversation, action, and result data travel.
- Authentication: Shapes session and credential ownership.
- Architecture: Defines the primary trust and failure boundary.
- Testing: Determines integration, outage, retry, and cancellation coverage.

### Blocking Level

`RESOLVED`

## Q-003 — Select the User Authentication Model

### Related Requirement

`PR-002`; `US-001`; `FR-002`; `CT-006`.

### Decision

Will users authorize with a product/account session, provide direct AI-service credentials, or use both
under separate policies?

**Decision status**: `RESOLVED` on 2026-08-24. The POC uses account-based product authorization only.
The Extension does not accept or store user-supplied direct AI-service credentials. The exact identity
provider and product-session token representation remain unresolved.

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | Account-based authorization backed by the selected product/service session; no direct user API key. | Simplest user credential handling; requires an identity/session service. |
| B | User-supplied direct service credential only. | Avoids product account infrastructure; increases sensitive credential storage and support burden. |
| C | Support both account authorization and direct credentials with distinct onboarding, storage, logout, and revocation rules. | Maximum flexibility; doubles security, UX, and test matrices. |

### Recommended Option

**Approved decision — 2026-08-24: Option A.** It minimizes raw credential handling in the Extension and
provides one account lifecycle aligned with the approved Q-002 service boundary.

### Impact

- UX: Changes onboarding, reauthentication, logout, and account switching.
- Privacy / Security: Determines credential exposure and storage risk.
- API: Selects identity-provider and session contracts.
- Architecture: Shapes account partitioning and protected connections.
- Testing: Defines authorization, renewal, revocation, and recovery cases.

### Blocking Level

`RESOLVED`

## Q-004 — Define Persistence, Retention, and Deletion by Data Category

### Related Requirement

`PR-002`–`PR-006`, `PR-008`–`PR-017`, `PR-019`; `CT-002`, `CT-006`, `CT-007`; all
persistence-bearing entities.

### Decision

Which conversation, page, attachment, action, grant, schedule, workflow, hosted, connector, policy,
notice, setting, and account data is transient, locally durable, or remotely durable; for how long; and
what is removed on logout, account switch, item deletion, or user deletion request?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | Transient/local by default; only explicit user saves are durable; no remote history; logout clears authorization and account-bound local state. | Strongest minimization and simplest deletion story; limits cross-device continuity and recovery. |
| B | Local persistent history and user-owned artifacts with explicit deletion; no remote history. | Better continuity on one browser; increases local exposure and migration complexity. |
| C | Account-synchronized remote history and artifacts under an explicit retention/deletion schedule. | Cross-device continuity and recovery; largest privacy, backend, compliance, and account-isolation burden. |
| D | Create and approve a category-by-category matrix mixing transient, local, and remote retention. | Best fit per data type; requires the most decisions and test cases before planning. |

### Recommended Option

**Approved decision — 2026-08-24: Option A for the POC, with governed per-capability evolution toward
Option D.** Core task, page-context, and action data remain transient and create no durable remote
history. Only minimum session/security state and separately approved local state may persist; logout
clears authorization and account-bound local state. Every later adopted capability that needs durable
or remote data requires its own approved category-specific data matrix. Legacy local data MUST NOT be
silently migrated or uploaded.

### Impact

- Scope / UX: Determines history, recovery, deletion, and cross-device behavior.
- Privacy: Defines durable exposure and user-control obligations.
- API / Architecture: Determines storage and synchronization contracts.
- Authentication: Defines logout and account-switch cleanup.
- Testing: Requires retention, partitioning, deletion, restart, and failure coverage.

### Blocking Level

`RESOLVED`

## Q-005 — Decide Whether Advanced Page Diagnostics Exist

### Related Requirement

`PR-006`; `US-008`; `FR-006`.

### Decision

Are page-code execution, console observation, and network observation product capabilities, and what
authorization granularity applies if any are adopted?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | Exclude all advanced diagnostics from the first release. | Least permission and data exposure; no technical diagnostics persona. |
| B | Include read-only console and network metadata only; exclude page-code execution and network bodies. | Useful evidence with reduced risk; still requires high-risk browser access and careful redaction. |
| C | Include all three as separately controllable diagnostic categories. | Maximum diagnostic value; largest permission, consent, prompt-injection, and sensitive-data surface. |
| D | Approve a custom subset and authorization grouping. | Precise fit; needs an explicit capability-by-capability matrix. |

### Recommended Option

**Recommendation — not approved: Option A.** Diagnostics are not needed for the core P1 journeys and
would otherwise expand baseline permissions before a technical-user need is approved.

### Impact

- Scope / UX: Determines whether the technical-user story exists.
- Permission / Privacy: Controls high-risk page, console, and network access.
- Architecture: Affects browser diagnostic integration and conflict handling.
- Testing: Adds sensitive-data, origin-change, denial, and channel-conflict cases.

### Blocking Level

`OPTIONAL`

## Q-006 — Define Browser Actions and Consent Semantics

### Related Requirement

`PR-005`, `PR-007`, `PR-008`, `PR-009`, `PR-019`; `US-003`, `US-004`, `US-007`;
`FR-005`, `FR-007`, `FR-008`, `FR-009`, `FR-019`.

### Decision

Which browser actions ship initially; how are batch and multi-tab effects bounded; which decisions are
task/session/site persistent; when is plan review required; and is any bypass mode permitted?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | Current tab only; scroll, low-risk click, non-sensitive text entry, and same-origin navigation; visible plan approval and sequential execution for multi-step work; current-task consent and fresh consent on origin change; no batch, multi-tab, webpage file upload, irreversible high-risk action, persistent grant, or bypass; later actions require an approved matrix. | Smallest, clearest safety matrix; more prompts and less automation breadth. |
| B | Broader actions including bounded batch/multi-tab; plan approval for multi-step work; narrowly scoped persistent grants; no bypass. | More capable with review controls; larger stale-state, revocation, and cross-context test surface. |
| C | Broad expert action set with persistent grants and an explicit bypass mode. | Lowest interaction friction; highest compromise, prompt-injection, and accidental-effect risk. |
| D | Approve a custom action × sensitivity × consent-lifetime × plan-review matrix. | Best precision; requires detailed product decisions before architecture or tests can stabilize. |

### Recommended Option

**Approved decision — 2026-08-24: Option A.** It gives the POC an auditable current-tab, low-risk action
boundary: a visible approved plan for sequential multi-step work, consent limited to the current task,
fresh consent at an origin change, and no batch/multi-tab execution, webpage file upload, irreversible
high-risk action, persistent grant, or bypass. Later action categories require an approved action ×
sensitivity × consent-lifetime × plan-review matrix.

**Superseding approved POC scope decision — 2026-08-24:** Phase 0/1 research showed that safe
assistant-initiated full-document navigation would require a separate containment and permission
decision. The product owner therefore deferred that part of Option A. The POC executable actions are
scroll, non-navigation low-risk click, and non-sensitive text entry. Assistant-initiated link, form,
script-driven, full-document, and other navigation effects fail closed as unsupported. User- or
page-initiated navigation remains compatible but invalidates stale context/action/Plan bindings; later
protected work requires the applicable fresh probe, origin safety, consent, and review. Navigation may
return only through a separately approved action/data/permission matrix and two-Chrome release gate.

### Impact

- Scope / UX: Defines the core delegation experience and prompt frequency.
- Permission / Privacy: Determines browser reach, sensitive input, and grant lifetime.
- API / Architecture: Defines action schemas, state verification, and cancellation needs.
- Testing: Determines the central action/consent/revocation matrix.

### Blocking Level

`RESOLVED`

## Q-007 — Select the URL and Cross-Site Safety Model

### Related Requirement

`PR-004`, `PR-008`; `US-002`, `US-003`; `FR-004`, `FR-008`; `CT-005`.

### Decision

How will the product decide whether a URL or cross-site action is permitted, and may any origin, path,
or query be sent to a remote safety service?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | Local administrator/user rules and explicit user confirmation only; no remote URL classification. | Maximum URL privacy and offline behavior; requires a sufficient local safety policy. |
| B | Remote classification receives origin only and protected actions fail closed if classification is unavailable. | Better centralized safety intelligence with limited disclosure; adds latency and a required service. |
| C | Remote classification receives a normalized full URL including path/query after disclosure. | Most classification context; greatest sensitive-URL and availability risk. |
| D | Local rules return allow, deny, or unknown first; only unknown canonical origin may reach a product-controlled service; path/query/fragment and page data are not sent for classification; remote deny, unknown, invalid, or unavailable fails closed; allow is not user consent. | Balances privacy and coverage; adds hybrid policy complexity and a service dependency. |

### Recommended Option

**Approved decision — 2026-08-24: Option D.** It keeps sensitive path/query data local while allowing a
bounded remote decision for cases the local policy cannot settle. Only canonical origin—scheme, host,
and effective port—may be transmitted. The safety purpose is disclosed to the user but is not an
additional transmitted data category; username/password, path, query, fragment, referrer, title, and
page content are not sent for classification. Remote deny, unknown, invalid, or unavailable fails
closed; allow still requires Q-006 current-task consent. Classification data is transient under Q-004,
and no reference provider, endpoint, protocol, category scheme, cache, or full-URL behavior is inherited.

### Impact

- UX: Changes warning, denial, latency, and recovery behavior.
- Permission / Privacy: Determines whether sensitive URL data leaves the browser.
- API: May add a required safety-classification contract.
- Architecture: Defines policy precedence and availability behavior.
- Testing: Requires cross-site, fail-closed, normalization, and administrator-policy cases.

### Blocking Level

`RESOLVED`

## Q-008 — Define Supported Chrome and Page Contexts

### Related Requirement

`PR-001`, `PR-004`, `PR-005`, `PR-009`; `US-001`–`US-004`; `FR-001`, `FR-004`,
`FR-005`, `FR-009`; `CT-010`, `SC-008`.

### Decision

Which Chrome release range, page schemes, top-level pages, frames, restricted contexts, local pages,
and complex document cases are supported?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | At release, the then-current and immediately preceding stable desktop Chrome major releases; current-tab ordinary top-level HTTP(S) HTML only, including normal navigation/reload and same-origin SPA updates; iframe/Shadow DOM/PDF/internal/extension/Web Store/file/data/blob/incognito/canvas-WebGL-only contexts are explicitly unsupported. | Clear, bounded compatibility; excludes older browsers and nonstandard contexts. |
| B | Latest stable desktop Chrome release only; same ordinary HTTP(S) top-level page scope. | Smallest test matrix; shortest compatibility window for users. |
| C | Broader approved matrix including selected frames, local/file pages, or older versions; browser-internal restricted pages remain unsupported. | Greater reach; materially expands permissions, security review, and compatibility testing. |
| D | Provide a custom version × scheme × frame × page-complexity matrix. | Exact product fit; requires detailed testable entries before planning. |

### Recommended Option

**Approved decision — 2026-08-24: Option A.** It establishes a testable two-major desktop Chrome window.
Page reading and browser actions are limited to the current selected tab's ordinary top-level HTTP(S)
HTML document. Normal document navigation, reload, and same-origin SPA updates remain in the
page-compatibility contract. Under Q-006's superseding POC decision, that compatibility does not
authorize any assistant-initiated navigation.
Content or targets available only through an iframe, Shadow DOM, PDF, Chrome internal, extension-origin,
or Web Store page, file/data/blob URL, incognito context, or canvas/WebGL-only surface fail as
unsupported. No Reference Extension version floor or broad-access declaration is inherited.

### Impact

- Scope / UX: Defines where core promises apply and how unsupported states appear.
- Permission / Privacy: Affects host/page access and frame boundaries.
- Architecture: Influences context collection and action targeting constraints.
- Testing: Defines the browser, page, navigation, and complex-document matrix.

### Blocking Level

`RESOLVED`

## Q-009 — Decide Scheduled-Task Semantics

### Related Requirement

`PR-011`, `PR-017`; `US-009`, `US-015`; `FR-011`, `FR-017`.

### Decision

If scheduling is adopted, what cadence and lifecycle operations exist, and what happens after browser
closure, sleep, missed due time, expired authentication, missing consent, unavailable page, or an
effect-uncertain retry?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | Keep scheduling out of the first release. | Avoids unattended authority and duplicate-effect risk; users run saved tasks manually. |
| B | One-time schedules only; no automatic catch-up or effect-uncertain retry; unmet preconditions become attention required. | Simple predictable semantics; limited automation and no recurring work. |
| C | One-time and recurring schedules; preauthorized scope; catch-up only under a declared window; retry only when duplicate effects can be ruled out. | Useful automation with safety controls; requires detailed idempotency and consent contracts. |
| D | Approve a custom cadence, edit/pause/run/delete, catch-up, retry, history, and unattended-consent matrix. | Full product control; largest policy and testing effort. |

### Recommended Option

**Recommendation — not approved: Option A.** The core is interactive and user-triggered; unattended
authority should wait until scope, consent, persistence, and notification policies are approved.

### Impact

- Scope / UX: Determines automation, history, attention, and lifecycle controls.
- Permission / Privacy: Governs unattended authority and retained run data.
- Architecture: Affects lifecycle recovery, deduplication, and time-based state.
- Testing: Adds sleep, closure, missed-time, retry, and duplicate-effect scenarios.

### Blocking Level

`OPTIONAL`

## Q-010 — Define Workflow-Teaching Scope and Processing

### Related Requirement

`PR-012`; `US-010`; `FR-012`; `CT-005`, `CT-007`.

### Decision

If workflow teaching is adopted, which steps, visual context, and voice are captured; where processing
occurs; what the user may edit; what is saved or transmitted; and what happens when processing fails?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | Keep workflow teaching out of the first release. | Avoids capture, microphone, schema, and server uncertainty; users create reusable instructions manually. |
| B | Local, non-voice demonstration capture that produces a user-edited reusable instruction; no remote transformation. | Smaller privacy boundary; may offer less automatic interpretation. |
| C | Demonstration plus optional voice and approved visual context, transformed by a product service under explicit retention/deletion rules. | Richest experience; adds sensitive media, backend, recovery, and consent complexity. |
| D | Approve a custom capture × processing × edit × persistence matrix. | Best fit; requires detailed data and failure decisions first. |

### Recommended Option

**Recommendation — not approved: Option A.** PR-012's server, schema, transmission, and flag behavior is
not confirmed, and the core product already supports manual reusable instructions.

### Impact

- Scope / UX: Determines recording, review, editing, narration, and recovery flows.
- Permission / Privacy: Affects page capture, microphone, screenshots, and retained workflow data.
- API / Architecture: May require a transformation service and workflow schema.
- Testing: Adds recording visibility, denial, partial capture, recovery, and deletion cases.

### Blocking Level

`OPTIONAL`

## Q-011 — Decide Whether a Hosted Assistant Experience Exists

### Related Requirement

`PR-014`; `US-012`; `FR-014`; `CT-005`, `CT-008`.

### Decision

Does the product need a separately hosted assistant; if so, who owns its UI, origin, account/session,
conversation, approved browser-capability contract, persistence, and fallback?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | No alternate hosted experience; use only the core Extension workspace. | One UX and trust boundary; forfeits a web-hosted alternate experience. |
| B | Hosted conversation only; it receives no Extension browser capability. | Adds a web experience with a narrow boundary; creates separate session and persistence UX. |
| C | Hosted experience may use an explicitly approved browser-capability scope under a defined origin/account/contract and fallback. | Preserves feature parity potential; adds cross-origin, account, protocol, and end-to-end ownership risk. |

### Recommended Option

**Recommendation — not approved: Option A.** It avoids duplicating the core assistant and does not
invent iframe or server behavior that the evidence cannot confirm.

### Impact

- Scope / UX: Determines whether a second assistant surface exists.
- Privacy / Authentication: Adds hosted data, account, origin, and persistence boundaries.
- API / Architecture: Requires a hosted capability and failure contract if adopted.
- Testing: Adds cross-origin, account mismatch, availability, fallback, and capability-scope cases.

### Blocking Level

`OPTIONAL`

## Q-012 — Define Connected-Service Scope and Authorization

### Related Requirement

`PR-015`; `US-013`; `FR-015`; `CT-005`, `CT-008`.

### Decision

If connected services are adopted, which services/tools ship; what authorization and consent model,
scopes, revocation, data flows, error contract, transport, and server mediation apply?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | No connected services in the first release. | Avoids third-party data and transport dependencies; no connector value. |
| B | Product-approved launch-service allowlist mediated by a product server with declared scopes, attribution, revocation, and sensitive-invocation consent. | Strong product control; requires backend and service-specific contracts. |
| C | User-configurable generic connectors used directly by the Extension under user-provided endpoints/credentials. | Broad flexibility; largest credential, schema, transport, and support risk. |
| D | Hybrid approved catalog plus an advanced user-configurable path under separate policy. | Maximum reach; combines both implementation and threat surfaces. |

### Recommended Option

**Recommendation — not approved: Option A.** Connector transport and server responsibility are
unconfirmed, and no connector is necessary for the P1 product proposition.

### Impact

- Scope / UX: Defines service discovery, connection, consent, attribution, and revocation.
- Permission / Privacy: Determines external scopes and third-party data flows.
- API / Architecture: Selects registry, transport, mediation, and error contracts.
- Testing: Requires service-specific auth, schema, timeout, revocation, and failure isolation.

### Blocking Level

`OPTIONAL`

## Q-013 — Decide Enterprise Product and Invalid-Policy Behavior

### Related Requirement

`PR-016`; `US-014`; `FR-016`.

### Decision

Is managed enterprise deployment a target; if so, what policy source/schema, rule precedence, update,
account restriction, audit, recovery, and invalid/unavailable-policy behavior apply?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | Defer enterprise deployment and managed policy from the first release. | Keeps consumer scope focused; delays managed-market support. |
| B | Adopt managed URL/account policy and fail closed whenever effective policy is invalid or unavailable. | Strongest administrator control; outages or malformed policy can block legitimate use. |
| C | Adopt managed policy with a signed/validated last-known-good state and explicit expiry; block when neither valid current nor unexpired prior policy exists. | Better resilience; adds policy history, expiry, and audit complexity. |
| D | Approve a custom policy, precedence, invalid-state, audit, and recovery contract. | Exact enterprise fit; requires administrator/product decisions before planning. |

### Recommended Option

**Recommendation — not approved: Option A.** Enterprise scope is not established, and adding it now
would expand distribution, identity, policy, support, and cross-entry testing substantially.

### Impact

- Scope / UX: Adds administrator and managed-user personas and recovery states.
- Permission / Privacy: Governs destinations, accounts, and managed data.
- Architecture: Adds managed policy ingestion, precedence, update, and audit state.
- Testing: Requires policy mutation, invalid state, account, and non-bypass coverage.

### Blocking Level

`OPTIONAL`
## Q-014 — Define Notification and Sound Policy

### Related Requirement

`PR-011`, `PR-017`; `US-009`, `US-015`; `FR-011`, `FR-017`.

### Decision

Which task events may notify; what is the initial/default behavior; are categories, sound, and quiet
hours separate; and what happens when browser notification permission is denied?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | No browser/system notifications in the first release; status remains in product UI. | No interruption or notification permission; users must return to inspect status. |
| B | Opt-in failure and attention-required notifications only; generic text, no sound; in-product status remains the fallback. | Useful high-value alerts with limited exposure; does not notify ordinary completion. |
| C | Category-level opt-in for completion, failure, and attention; optional sound and quiet hours; generic lock-screen text. | Most user control; largest settings and notification test matrix. |
| D | Notifications enabled by default for selected events, with user opt-out. | High discoverability; greater interruption and shared-screen privacy risk. |

### Recommended Option

**Recommendation — not approved: Option A.** Notification behavior is unnecessary without adopted
asynchronous work, and omitting it avoids a new permission and lock-screen disclosure surface.

### Impact

- Scope / UX: Determines interruption, task-return, fallback, settings, and sound behavior.
- Permission / Privacy: Affects notification permission and shared-screen disclosure.
- Architecture: Adds event routing and related-context restoration if adopted.
- Testing: Requires event categories, denial, duplicate notice, quiet-hour, and click behavior.

### Blocking Level

`OPTIONAL`

## Q-015 — Define Privacy-Safe Operational Observability

### Related Requirement

`CT-013`; Cross-Cutting Scenario 6; risk and failure handling across all adopted PRs.

### Decision

What analytics, error reporting, and performance diagnostics are necessary, and what purpose, fields,
page/task content, consent, processors, redaction, sampling, and retention are allowed?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | No external telemetry initially; provide only user-triggered local diagnostic export with reviewed content. | Strong privacy and no processor dependency; weak automatic incident visibility. |
| B | Privacy-minimized error/performance events only; no credentials or page/conversation/task content; explicit processor and short retention policy. | Useful operational visibility; still creates external processing and governance obligations. |
| C | Add product-usage analytics under explicit consent plus the error/performance profile. | Better product insight; largest event, consent, retention, and compliance surface. |
| D | Approve an event-by-event purpose × field × processor × consent × retention matrix. | Precise governance; requires substantial product/privacy work before instrumentation. |

### Recommended Option

**Recommendation — not approved: Option A.** It prevents reference telemetry vendors or unknown event
payloads from becoming dependencies before the product approves a concrete event schema.

### Impact

- Privacy: Determines external processing, content minimization, consent, and retention.
- API / Architecture: Selects processors, event contracts, sampling, and diagnostic flows.
- Testing: Requires credential/content exclusion, consent, deletion, outage, and schema tests.
- Scope: Can be deferred while external telemetry remains absent.

### Blocking Level

`CAN-DEFER`

## Q-016 — Define Dynamic Feature-Flag Authority

### Related Requirement

`PR-012`, `PR-014`, `PR-015`, `PR-019`; `US-007`, `US-010`, `US-012`, `US-013`;
`FR-012`, `FR-014`, `FR-015`, `FR-019`; reference-only `F-017` evidence.

### Decision

Will the product use remote dynamic flags; who controls them; what may be gated; and may a flag change
permission, data transmission, or external-dependency behavior after release?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | No remote dynamic flags; capability set changes only through a tested product release. | Maximum reproducibility and permission clarity; slower rollout and rollback. |
| B | Flags may hide or show already shipped UI only and may never change permission, transmission, dependency, or accepted behavior. | Some rollout flexibility; limited operational power and still needs deterministic tests. |
| C | Flags may gate predeclared optional capabilities, but every permission/data/dependency change still requires normal user disclosure and approval. | Greater rollout control; creates configuration security and combinatorial test burden. |
| D | Remote flags may broadly change capability and service behavior. | Maximum operational flexibility; unacceptable reproducibility and silent-privilege risk without much stronger governance. |

### Recommended Option

**Recommendation — not approved: Option A.** Static release scope is easiest to audit and prevents an
unconfirmed server flag from silently changing the privacy or permission contract.

### Impact

- Scope / UX: Determines capability visibility and rollout behavior.
- Permission / Privacy: Governs whether remote configuration can alter sensitive boundaries.
- API / Architecture: May add a configuration service and secure evaluation state.
- Testing: Changes reproducibility, combination, rollback, and support matrices.

### Blocking Level

`CAN-DEFER`

## Q-017 — Select Launch Locales and Fallback

### Related Requirement

`PR-019`; `US-007`; `FR-019`; `CT-012`.

### Decision

Which locales are required at launch, which locale is the fallback, and which assistant, consent,
status, error, settings, notification, and onboarding surfaces must be localized?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | English-only launch; English fallback; all adopted user-facing surfaces use reviewed English. | Smallest content/test scope; excludes users who require another language. |
| B | English and Traditional Chinese at launch; English fallback; both cover every adopted user-facing surface. | Serves two audiences; roughly doubles content, layout, and language QA. |
| C | Adopt all locale resources observed in the reference as launch targets after independent translation review. | Broad reach; largest content operations and regression burden, and reference presence does not prove demand. |
| D | Provide a custom launch-locale set, fallback, and per-surface coverage matrix. | Product-specific fit; requires explicit market and content decisions. |

### Recommended Option

**Approved decision — 2026-08-24: Option B.** The POC provides reviewed `en-US` English and `zh-TW`
Traditional Chinese on every adopted user-facing surface, with reviewed English fallback. Missing,
invalid, unsupported, or incomplete locale data exposes no internal identifier and cannot make consent
or safety text ambiguous. This decision does not adopt the broader PR-019 settings feature or require a
dedicated language-settings screen. Future releases may add locales through the same complete-surface
translation, review, fallback, layout, keyboard, assistive-technology, and regression matrix; Reference
Extension locale resources are evidence only and are neither copied nor automatically adopted.

### Impact

- Scope / UX: Defines audience, content operations, fallback, and layout behavior.
- Testing: Determines locale, truncation, fallback, assistive, and release matrices.
- Architecture: Influences resource and update planning without selecting an implementation.

### Blocking Level

`RESOLVED`

## Q-018 — Define Export Formats and Sensitive-Content Policy

### Related Requirement

`PR-013`; `US-011`; `FR-013`; `CT-002`, `CT-007`.

### Decision

If export is adopted, which formats and content scopes exist, and what redaction, selection, warning,
branding, visual replay, deletion, and temporary-file lifetime apply?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | Keep export out of the first release. | Avoids durable disclosure and format work; users cannot keep/share product-generated records. |
| B | Structured selected-conversation export only, with explicit scope preview, secret exclusion, and no screenshots/action replay. | Useful portable record with smaller privacy surface; limited visual sharing. |
| C | Structured conversation plus visual action replay under an approved screenshot redaction, warning, branding, and file-lifetime policy. | Richest sharing; largest durable sensitive-data and generation burden. |
| D | Approve a custom format × content × redaction × lifetime matrix. | Precise fit; requires detailed privacy and product decisions. |

### Recommended Option

**Recommendation — not approved: Option A.** Export is not core, and its durable privacy boundary should
not be implemented before format, redaction, and lifetime rules are approved.

### Impact

- Scope / UX: Determines sharing, preview, selection, and failure behavior.
- Permission / Privacy: Governs durable copies of conversation, page, connector, and visual data.
- Architecture: Adds generation and temporary-file lifecycle if adopted.
- Testing: Requires scope accuracy, redaction, failure, download, and cleanup cases.

### Blocking Level

`OPTIONAL`

## Q-019 — Set Accessibility and User-Comprehension Success Targets

### Related Requirement

`CT-012`; Cross-Cutting Scenario 7; `SC-009`, `SC-010`; Specification Quality Checklist.

### Decision

What accessibility test setup/target and moderated participant sample/success threshold make the
primary safety state measurably acceptable?

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | 100% pass in the approved keyboard/assistive matrix and 5 of 5 moderated participants correctly explain context, request, decision, and state. | Strict small early gate; limited participant diversity. |
| B | 100% pass in the approved keyboard/assistive matrix and at least 9 of 10 moderated participants meet the comprehension check. | Broader evidence; more recruiting and iteration time. |
| C | Require the deterministic accessibility matrix before planning, but defer a numeric moderated-comprehension target to a beta validation gate. | Lets planning start sooner; leaves SC-010 incomplete until beta criteria are approved. |
| D | Provide a custom accessibility setup, participant profile/sample, and success threshold. | Best fit for product risk and audience; needs a complete test contract. |

### Recommended Option

**Approved decision — 2026-08-24: Option A accessibility matrix with a user-specified single-owner
threshold.** One designated product owner is the sole POC evaluator. On Windows 11, that evaluator must
pass 100% of the declared keyboard-only and current-stable-NVDA steps in both `en-US` and `zh-TW` on the
then-current and immediately preceding stable desktop Chrome majors, and correctly explain context,
request, allow/deny outcome, and running/stopped/failed state in every declared comprehension scenario.
This is a strict POC owner-acceptance gate, but it is not representative multi-user usability or
accessibility evidence.

### Impact

- UX / Accessibility: Defines whether users can understand and stop sensitive browser activity.
- Scope: Adds owner-run accessibility and comprehension review to the acceptance contract without
  participant recruiting; broader external-user evidence remains outside this POC gate.
- Testing: Supplies the missing executable target for SC-009/SC-010 and two checklist items.

### Blocking Level

`RESOLVED`

## Q-020 — Define POC Form-Value Visibility and Parity Evolution

### Related Requirement

`PR-004`, `PR-008`; `US-002`; `FR-004`, `FR-008`; `F-005`;
`SC-003`.

### Decision

How may the POC expose current ordinary form values and selected-option state while protecting
sensitive or ambiguous fields and preserving a safe path toward the Reference Extension's confirmed
observable behavior?

**Decision status**: `RESOLVED` on 2026-08-24. Use controlled parity. General page reading exposes
zero current form values and selected-option state. A separate `page.form-values` disclosure and
current-task/current-document grant may return only bounded task-relevant ordinary values and select
selected-option state conclusively classified non-sensitive by closed local policy. Sensitive and
ambiguous fields reveal no value, length, hash, or partial content. Data is transient and reload,
SPA/document or origin change, Stop, revocation, or terminal state invalidates it. Later expansion
requires a new approved data/consent profile.

### Options

| Option | Description | Primary trade-off |
| --- | --- | --- |
| A | Structural page context only; exclude every current form value and selected-option state. | Lowest POC privacy risk but too little utility and a larger later contract migration. |
| B | Include every value not heuristically detected as sensitive under ordinary page-read consent. | Closest broad behavior quickly, but one classifier false negative silently discloses ambiguous content. |
| C | Separate `page.form-values` disclosure/grant; include only conclusively non-sensitive bounded ordinary values/select state and fail closed for sensitive/ambiguous fields. | Adds a small consent/data-contract layer while preserving useful parity and safer staged expansion. |

### Recommended Option

**Approved decision — 2026-08-24: Option C.** It validates useful form-context behavior without
granting broad value access or inheriting the reference implementation's private code, protocol,
identifiers, or assets.

### Impact

- Scope / UX: Adds controlled form context to US-002 without adding another browser capability.
- Permission / Privacy: Adds no Chrome permission; requires separate current-document consent and
  fail-closed local sensitivity classification.
- API / Architecture: Adds one WSS/runtime DataCategory and transient grant/snapshot shape; the origin
  safety endpoint remains canonical-origin only.
- Testing: Requires with/without-grant, allowed ordinary/select, sensitive/ambiguous, lifecycle,
  forwarding-race, storage/log, and two-Chrome regression evidence.

### Blocking Level

`RESOLVED`

## Human Review Protocol

1. Review `BLOCKS-PLANNING` questions first. No planning is authorized while any remains unanswered.
2. A recommendation becomes a decision only when the user explicitly approves it or provides another
   answer. Silence, common practice, and reference behavior are not approval.
3. After each accepted answer, record the question and answer in the specification's Clarifications
   section, update the affected requirement/scenario/criterion, and revalidate only changed checklist
   states.
4. `OPTIONAL` questions may remain unanswered only while the corresponding capability stays outside
   adopted scope. `CAN-DEFER` questions may remain unanswered only while the related dependency or
   mechanism remains absent.
5. Any proposal to adopt `F-016` or `F-017` requires new Product Requirements and a new specification
   review; this queue does not provide that approval.
