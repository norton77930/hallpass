# Phase 0 Research: Chrome AI Browser Assistant POC

**Date**: 2026-08-24

**Scope**: Resolve implementation-planning choices for the seven approved MUST requirements without
selecting a reference-extension dependency, copying reference implementation details, or adopting a
deferred product capability.

## Evidence Baseline

The repository contains Spec-Kit artifacts and product/reference evidence only. It has no application
source, package manifest, lockfile, build configuration, test configuration, or existing runtime to
preserve. Technology choices below are therefore new clean-room planning decisions. The Reference
Extension remains behavioral evidence only; none of its bundled code, private schemas, assets, internal
names, providers, endpoints, storage keys, or module topology informed these choices.

## R-001 — Language, Runtime, and Workspace

**Decision**: Use an npm workspace on Node.js 24 LTS with strict TypeScript 5.9 across the Extension,
product service, shared contracts, and tests. Use ESM throughout and pin exact package versions in the
implementation lockfile.

**Rationale**: One language reduces schema drift across four trust contexts while npm workspaces avoid
introducing a separate package-manager runtime. Node 24 is the current LTS line. TypeScript 5.9 provides
the strict modern configuration needed here while avoiding a just-released compiler-transition major.

**Alternatives considered**:

- Separate backend language: rejected for the POC because it duplicates contracts and toolchains.
- TypeScript 6/7 immediately: rejected for the initial lockfile because the 6-to-7 compiler transition
  is very recent; a later upgrade is a normal dependency review, not product scope.
- Plain JavaScript: rejected because discriminated runtime envelopes and security-state transitions
  benefit materially from static exhaustiveness checks.

**Primary evidence**: [Node release status](https://nodejs.org/en/about/previous-releases),
[TypeScript 5.9](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html), and
[TypeScript 6 transition notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html).

## R-002 — UI and Build Tooling

**Decision**: Use React 19.2 for the side-panel UI and Vite 8.1 for explicit multi-entry builds. Keep
state in typed reducers/domain state machines and semantic HTML; add no component system,
state-management library, CSS framework, or Chrome-extension framework.

**Rationale**: The side panel has progressive output, consent, plan review, active control, Stop,
terminal states, localization, and accessibility states that benefit from declarative rendering. A
small React/Vite stack supports later visible feature growth while explicit build entries keep the
service worker and injected content runtime auditable.

**Alternatives considered**:

- Vanilla DOM only: smaller, but raises transition and bilingual-state maintenance cost as the UI grows.
- WXT, Plasmo, or another extension framework: useful for larger products, but unnecessary abstraction
  and dependency surface for this narrowly scoped POC.
- Copying the reference UI technology or CSS: forbidden and unnecessary; observable behavior is
  independently implemented.

**Primary evidence**: [React versions](https://react.dev/versions) and
[Vite 8.1 announcement](https://vite.dev/blog/announcing-vite8-1).

## R-003 — Runtime Trust Boundary

**Decision**:

- The side panel owns user input, progressive rendering, consent and plan review, grant revocation,
  active-control presentation, and Stop. It never invokes Chrome actions or receives raw session
  credentials.
- The MV3 service worker is the single security authority. It owns account-session access, one active
  task lease, origin policy, consent grants, capability validation, server transport, sequencing,
  tab/document revalidation, action dispatch, and local-first Stop.
- A packaged content runtime is injected on demand into frame 0 in the isolated world. It reads/redacts
  bounded ordinary DOM and executes only enum-defined approved actions. It has no server access,
  storage access, page-world bridge, arbitrary-code path, iframe traversal, or Shadow DOM traversal.
- The product service owns transient AI/task orchestration. It can request product capabilities but has
  no direct tab, Chrome API, selector-execution, or consent authority.

Closing or disconnecting the side panel immediately invokes Stop. Continuing invisible work would
remove the required immediately reachable Stop surface and is therefore not a POC mode.

**Rationale**: One privileged broker prevents model output, page content, and UI code from bypassing
the same authorization path. Closing-is-Stop is the fail-safe interpretation of FR-007 and CT-009.

**Alternatives considered**:

- Side panel directly executes Chrome APIs: rejected because it duplicates policy enforcement.
- Persistent static content scripts: rejected because they broaden page presence before a task and
  consent boundary.
- Continuing tasks after panel close: rejected because no approved alternate visible Stop surface exists.

**Primary evidence**: [MV3 service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers),
[content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), and
[extension security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure).

## R-004 — Entry Point, Permissions, and Page Eligibility

**Decision**: The POC manifest uses only `activeTab`, `scripting`, `sidePanel`, `storage`, and `identity`.
It declares no page `host_permissions`, `optional_host_permissions`, `tabs`, `webNavigation`,
`<all_urls>`, debugger, native messaging, notifications, downloads, clipboard, or remote-code access.
It declares `incognito: not_allowed`.

Action click and the `_execute_action` command open the side panel for the active tab. This platform
gesture obtains temporary `activeTab` access, but product safety and current-task consent remain
separate mandatory gates. All page work is injected on demand with frame 0 and isolated-world settings.
Each step rechecks active tab, window, document epoch, canonical origin, and target. Ordinary reload and
same-origin SPA changes are observed through re-probing and `tabs.onUpdated`; no browsing-history
permission is needed.

The Extension page CSP allows network connection only to the configured product HTTPS/WSS origin.
Product endpoints explicitly allow the fixed Extension origin through CORS, so page host access is not
used for service calls. This host-permission-free HTTPS path is acceptable only if the exact POST and
preflight behavior passes on both release Chrome majors; a failure reopens the permission decision
rather than allowing a silent manifest fallback.

The deterministic unpacked test build is the sole exception: Chrome 142+ Local Network Access can block
a service-worker call to loopback before the worker can prompt, so that build adds exactly
`https://localhost/*` as a test-only host permission. Its product service uses `localhost`, while the
ordinary page fixture uses `127.0.0.1`; therefore the exception cannot satisfy page access or mask the
`activeTab` tests. Production remains at zero host permissions and rejects the test pattern/configuration.

The `identity` permission supports provider-neutral `launchWebAuthFlow`; it does not choose an identity
vendor. Page eligibility is allowlisted to top-frame HTTP(S), `text/html`, and non-incognito contexts.
Every excluded scheme/page/frame/surface returns an explicit unsupported or inaccessible result.

**Rationale**: `activeTab` aligns browser access with a deliberate invocation and automatically ends on
cross-origin navigation. Omitting broad host and navigation permissions minimizes install-time access.

**Alternatives considered**:

- Required or optional all-site host permission: rejected because the POC never needs standing access.
- `webNavigation`: rejected because revalidation can use current-tab events and per-step probes without
  the broader browsing-history warning.
- A page-world script: rejected because approved DOM read/action behavior does not need page internals.

**Primary evidence**: [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab),
[Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting),
[Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel),
[Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands),
[permissions guidance](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions),
[incognito manifest behavior](https://developer.chrome.com/docs/extensions/reference/manifest/incognito),
and [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access).

## R-005 — Interactive Task Transport

**Decision**: The service worker owns a task-scoped WSS connection after an authenticated HTTPS task
bootstrap. The bootstrap returns a single-use, short-lived connection ticket rather than putting the
product session credential in a URL. The first WSS message authenticates the ticket and protocol
version. While a task is active, either peer sends an application heartbeat inside the 30-second worker
activity window; the implementation target is 20 seconds. Completion, Stop, panel disconnect, invalid
sequence, lease expiry, or channel loss closes the connection and makes the task terminal/interrupted.

REST is limited to provider-neutral authorization exchange/refresh/logout, task bootstrap and idempotent
cancel fallback, anonymous origin assessment, and health. WSS carries progressive output, plan
proposals/decisions, capability requests/results, heartbeat, Stop, and one terminal event.

**Rationale**: Chrome 116+ explicitly supports keeping an extension service worker alive through active
WebSocket traffic, and both release-target majors are far newer. One duplex channel avoids split SSE and
result-posting state while keeping credentials and capability validation in the security authority.
Server leases ensure a disconnected worker cannot leave remote work running.

**Alternatives considered**:

- Streaming fetch/SSE in the worker: rejected because long response/lifecycle behavior is less suitable
  for bidirectional tool results and cancellation.
- Side-panel-owned stream: viable, but rejected because it separates the credential/transport broker
  from the capability authority.
- Durable queue/reconnect replay: rejected because the POC forbids durable Core history and effect replay.

**Primary evidence**: [WebSockets in extension service workers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets),
[service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle),
and [Fastify WebSocket plugin](https://github.com/fastify/fastify-websocket).

## R-006 — Account Authorization and Session Handling

**Decision**: Use a product-owned Authorization Code plus PKCE boundary launched by
`chrome.identity.launchWebAuthFlow`. The Extension generates state and verifier, validates the redirect,
and exchanges the code only with the product service. The identity vendor remains behind a server
adapter. The product service returns opaque, short-lived product-session credentials; their exact vendor
token never enters the Extension.

PKCE is S256-only: the Extension generates a high-entropy RFC 7636 verifier of 43–128 unreserved
characters, sends its unpadded base64url SHA-256 challenge, and the product service emits and verifies
`code_challenge_method=S256`. Plain PKCE, malformed challenge/verifier, state mismatch, redirect mismatch,
or transaction replay is rejected.

OAuth `state` is a separate Extension-generated high-entropy unpredictable opaque value. The server
binds it to one redirect URI, S256 challenge, authorization transaction, and finite configured expiry,
then atomically consumes it at exchange. Constant/low-entropy, missing, expired, mismatched, duplicated,
or replayed state is rejected; no production entropy number is invented by this plan.

Each production or deterministic-test build has a stable, known Extension ID. The Extension derives the
only accepted callback with `chrome.identity.getRedirectURL('auth/callback')`; the product service and
identity-provider allowlist require that exact HTTPS URI. The same build identity binds the exact HTTPS
CORS allowlist and WSS Origin allowlist. Missing/mismatched IDs, redirect URIs, CORS origins, or WSS
origins fail build/startup or authorization rather than falling back to a wildcard.

Only the opaque product session ID, access/refresh credential, expiry, account/organization binding,
auth-flow state/verifier, and minimal operation markers may use `chrome.storage.session`. Content
scripts keep the default no-access policy.
Logout is local-first—clear the trusted session area and stop work—then invokes server revocation.
Server-side POC sessions are opaque in-memory records, so server restart safely requires reauthentication.
After service-worker memory loss, an unexpired stored product credential is projected as active only
after the product session-state endpoint validates the same account/organization binding; 401 becomes
reauthentication-required and 403 becomes policy-blocked. No optional login hint is transmitted by the
POC auth bootstrap.

Refresh `409` is the account-binding mismatch path: local work/session credentials are cleared and the
existing closed UI state becomes `reauthentication-required` with stable reason
`auth.account-mismatch`; a sixth auth state or silent account switch is not introduced.

A deterministic loopback identity adapter supplies test accounts. Selecting a live identity vendor is a
separate deployment choice and cannot alter account isolation, session cleanup, or UI states.

**Rationale**: `launchWebAuthFlow` supports non-Google providers without selecting one, and session
storage is in-memory, cleared on browser restart/reload/update, and not exposed to content scripts by
default.

**Alternatives considered**:

- Direct user AI keys: prohibited by Q-003.
- Provider tokens in side panel or content script: rejected because they widen exposure.
- Durable local refresh token: rejected for the POC; reauthentication is safer than hidden persistence.
- Cookie-only browser session: rejected because account/logout behavior across the product origin would
  be harder to make explicit and test in the Extension boundary.

**Primary evidence**: [Chrome Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
and [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage).

## R-007 — Transient State, Lifecycle Loss, and Replay Safety

**Decision**: Task, plan, grant, page snapshot, target registry, capability payload, action arguments,
action results, model output, and origin assessment remain memory-only. `chrome.storage.session` may hold
only non-content security/lifecycle markers: runtime epoch, task identifier, action request identifier,
phase (`prepared`, `dispatched`, `observed`, or `uncertain`), account binding, and expiry.

Every service-worker start creates a new runtime epoch. Every document injection creates a document
epoch. Envelopes include protocol version, task ID, runtime epoch, message/request ID, and monotonic
sequence. Grants additionally bind account, tab, canonical origin, capability/data category, plan
version, and document epoch where applicable.

Duplicate or out-of-order requests never repeat an effect. If a previous in-memory result still exists,
the same transient result may be returned. After lifecycle loss, prior `prepared` maps to cancellation/
interruption, `dispatched` or `uncertain` to attention-required, and `observed` without its memory-only
result to failure/interruption. None is replayed or treated as success, and no task is reconstructed after
browser restart. The marker remains only until the terminal/interruption projection is delivered or its
finite cleanup expiry is reached.

`dispatched` is a write-ahead state: the service worker persists it and waits for storage confirmation
before calling the content effect. It means the effect may occur, not that occurrence or success was
observed. Failed marker persistence starts no effect, closing the crash gap between `prepared` and the
content call. After that await, a final worker-owned dispatch fence rechecks Stop, grant, task/channel,
tab/document/origin, and target immediately before the call. Protected page-read collection and result
transmission use the same final-recheck rule after their last awaited prerequisite.

**Rationale**: Small phase markers allow the Extension to detect uncertain effects after worker loss
without storing page data, arguments, outputs, or history. Runtime/document epochs make stale messages
fail closed.

**Alternatives considered**:

- Durable checkpoints and automatic resume: rejected by Q-004 and CT-011.
- Memory only with no marker: rejected because a worker death during an effect could cause accidental
  replay or a false success claim.
- Persisting complete action request/result: rejected as forbidden Core history.

## R-008 — Origin Safety

**Decision**: Use a pure local policy adapter returning allow, deny, or unknown. Rules may recognize
unsupported contexts and an independently maintained product allow/deny fixture set; they do not inherit
reference categories. Only local unknown invokes `POST /v1/origin-assessments` with credentials omitted,
cookies omitted, cache disabled, and a body containing only canonical scheme, host, and effective port.
No account, task, URL username/password, path, query, fragment, referrer, title, page data, or application
correlation identifier is sent.

The response contains a decision and bounded freshness metadata. Deny, unknown, malformed, stale, or
unavailable fails closed. Neither request nor response is cached or logged as history. Allow still
requires current-task consent, and any origin change invalidates the prior grant.

**Rationale**: A dedicated anonymous endpoint makes the data-minimization rule mechanically testable
and keeps the classifier independent of the authenticated task channel.

**Alternatives considered**:

- Full URL classification: prohibited by Q-007.
- Authenticated classifier request: rejected because product account/session metadata is not part of
  the approved classification payload.
- Persistent allow result: rejected because safety assessment is not consent and caching policy is not
  approved.

## R-009 — Page Context and Browser Actions

**Decision**: The content runtime creates a bounded semantic DOM snapshot rather than serializing HTML.
It includes ordinary top-level text/structure, accessible labels/roles needed for the task, redaction and
truncation metadata, and opaque target handles. General page reading contains no current form value or
selected-option state. Under R-015's distinct `page.form-values` grant, the snapshot may additionally
contain only bounded task-relevant ordinary values and selected-option state that closed local policy
conclusively classifies non-sensitive. Password, hidden/file, OTP, payment, sensitive-autocomplete,
product-credential, and ambiguous values are absent together with their length and partial content.
Exact numeric bounds are injected configuration and tested with small fixtures; no product limit is
invented.

Target handles bind to snapshot ID and document epoch and map only in content-runtime memory. Server
messages never carry executable selectors, JavaScript, Chrome API names, or tab IDs. Before an effect,
the worker and content runtime revalidate context, origin, document, target connection/visibility,
expected role/name, risk, sensitivity, consent, and approved plan step.

Single-action consent and each executable Plan step bind the exact locally resolved context/target and
canonical normalized arguments/categories through a local digest; a matching server step ID is not
authority. POC Plans are exact and same-document. Any user- or page-initiated document change invalidates
the Plan and action grants; later protected work requires a fresh probe, applicable safety/consent, and
a new Plan ID. No old step or result resumes.

The action executor is a closed union: scroll, non-navigation low-risk click, and non-sensitive text
entry. Assistant-initiated navigation, ambiguous risk/sensitivity, form submit, download/upload,
irreversible/high-risk semantics, stale handle, missing target, or observed-result uncertainty fails
closed. Anchors, links, forms, and script-driven effects that may navigate are denied before activation.
Multi-step plans execute serially; server requests outside the approved capability profile and exact
plan version/digest are denied.

**Rationale**: Opaque document-bound handles prevent model-authored selectors or stale page state from
becoming browser authority. Revalidation before every step safely detects user/page document and SPA
changes without granting assistant navigation or standing page access.

**Alternatives considered**:

- Raw HTML or screenshots: excessive data and the latter is deferred.
- General CSS/XPath selectors from the model: rejected as stale and injection-prone.
- Arbitrary script action: excluded from the POC and separately high-risk.
- Parallel plan execution: prohibited by Q-006.

## R-010 — Service Framework, Schemas, and Provider Adapters

**Decision**: Use Fastify 5 plus `@fastify/websocket` 11 for the Node service. Use Zod 4 schemas in the
shared contracts package at every external/runtime boundary. Convert validation failures to stable,
localized-in-the-Extension error codes; never expose library errors or internal IDs as UI copy.

Define production-owned provider ports for identity, AI orchestration, and origin safety. The executable
server entrypoint composes routes, WSS handlers, task orchestration, and those ports through one explicit
composition root. Automated acceptance uses deterministic adapters located only in `packages/test-kit`
and imported only by an explicit test composition. Production code may depend on the ports but may not
import a deterministic adapter or silently select one; production startup fails closed when a required
deployment adapter is absent. A live AI adapter is required only for a live external demonstration or
pilot, while the vendor and vendor protocol remain an explicit deployment selection. No provider SDK or
reference protocol is part of this baseline. The task-channel contract and Extension capability
vocabulary remain stable regardless of that selection.

A live AI adapter is eligible only when vendor contract and effective account/request configuration
prohibit training use and durable storage of prompts, page/action context, outputs, task history,
analytics, and content-bearing logs for this workload. The product service disables provider-side
application logging where configurable and keeps vendor request IDs only in transient call memory. The
deployment gate records the effective zero-retention/no-training evidence; a vendor that cannot meet
CT-007 cannot be used for the POC pilot.

Product-service and fronting proxy/CDN/WebSocket logs must redact or suppress Authorization, cookies,
bodies, raw task-ID paths, query strings, Origin values, channel/ticket IDs, and task/message/request/
operation correlation IDs. The POC persists no operational log/counter/metric; stable codes and coarse
state are active-memory/test-capture only. Any later aggregate, processor, sampling, or retention needs
the unresolved Q-015/CT-013 approval rather than being inferred from this architecture.

**Rationale**: Fastify supplies a small typed request lifecycle and official WebSocket integration.
Shared runtime parsing is necessary because TypeScript types do not validate network/page input.
Provider ports preserve the approved product-controlled boundary without importing unapproved vendors.

**Alternatives considered**:

- Express plus hand validation: more boilerplate and weaker default contract discipline.
- Provider SDK types as the product contract: rejected because they leak a deployment dependency into
  Extension behavior.
- Database-backed job framework: unnecessary and conflicts with transient POC tasks.

**Primary evidence**: [Fastify 5 documentation](https://fastify.dev/docs/v5.12.x/Reference/),
[Fastify WebSocket](https://github.com/fastify/fastify-websocket), and [Zod 4](https://zod.dev/packages/zod).

## R-011 — Localization and Accessibility

**Decision**: Maintain independently authored `en-US` and `zh-TW` dictionaries with a typed key union.
Generate Chrome `_locales/en_US` and `_locales/zh_TW` manifest resources from the reviewed source
dictionaries and declare `en_US` as manifest fallback. Runtime locale resolution canonicalizes
`chrome.i18n.getUILanguage`; only exact `zh-TW` selects Traditional Chinese, otherwise `en-US`.

Build tests require identical keys/placeholders and 100% adopted-surface coverage. Runtime lookup uses
reviewed English fallback and never returns the key. Missing/invalid consent or safety copy blocks the
protected operation. Semantic controls, deterministic focus movement, visible focus, labelled status,
and polite/assertive live regions support keyboard and NVDA review. The UI renders server error codes
through local dictionaries rather than accepting remote safety copy.

**Rationale**: A generated single source prevents manifest/runtime dictionary drift and directly tests
Q-017/SC-011. Local rendering prevents an unavailable locale from weakening consent.

**Alternatives considered**:

- Reference locale JSON: forbidden and does not include Traditional Chinese.
- Server-delivered UI copy: rejected because offline/failure consent must remain reviewed and fail-safe.
- Chrome automatic locale resolution alone: insufficient for the approved exact `zh-TW` rule and
  explicit runtime fallback checks.

**Primary evidence**: [Chrome i18n API](https://developer.chrome.com/docs/extensions/reference/api/i18n)
and [Chrome accessibility guidance](https://developer.chrome.com/docs/extensions/how-to/ui/a11y).

## R-012 — Verification Strategy and Browser Matrix

**Decision**: Use Vitest 5 for pure state machines, policies, schemas, React UI, Fastify injection, and
adapter tests. Use Playwright 1.62 persistent Chrome-for-Testing contexts for unpacked-extension E2E,
observable UI/effects, worker lifecycle, user/page document-change handling, and isolated profile tests.
Add axe-core and keyboard-only checks. Do not assert private Extension state when an observable result is available.

At release, resolve and record the then-current and preceding stable Chrome majors rather than
hard-coding the planning-day values. The complete deterministic P1 E2E suite—not only transport/load
smoke—runs against both recorded majors and both locales where sideload automation is supported. Any
browser-channel limitation is surfaced, not replaced by a claim based only on Playwright's bundled
browser. The sole product owner completes the required eight manual passes: two Chrome majors × two
locales × keyboard-only/current-stable NVDA.

If an exact Chrome major cannot be automated for unpacked sideload, the same complete deterministic P1
cases must be executed and recorded through the supported manual Load unpacked workflow on that major;
the limitation cannot reduce SC-001 to transport smoke.

Both exact Chrome majors also have a release transport/load smoke gate: load the unpacked build through
the browser-supported developer workflow; prove HTTPS POST and CORS preflight with Authorization and
Content-Type; accept the fixed Extension Origin on WSS; and reject missing/wrong WSS Origin. If an exact
browser build blocks automated sideload, the gate records that limitation and uses the supported manual
Load unpacked path with observable transport assertions. Bundled Chromium can add regression coverage
but cannot stand in for either required Chrome-major result.

Local deterministic HTTPS/WSS uses a per-machine repository-generated test CA/leaf with DNS SAN
`localhost` and IP SAN `127.0.0.1`. A deterministic proxy and product service use a stable test
Extension ID plus exact test-only endpoint/CORS/WSS configuration. The CA is trusted only in Windows
CurrentUser Root by exact thumbprint and must be installed and verified before the proxy, service, or
browser E2E starts; missing/wrong thumbprint or SAN fails startup. It is removed, together with ignored
key material, after the run. Automated/manual Chrome keeps normal certificate validation. Production
build/configuration rejects the test CA, test Extension ID, deterministic adapters, and all loopback
values. No certificate-ignore browser flag is acceptable evidence.

The matrix includes answer-only success with zero capability frames, auth failure/renew/logout,
sensitive redaction, local/remote safety outcomes,
consent deny/revoke, each action, plan sequencing, cross-origin invalidation, tab switch, reload/SPA,
restricted fixtures, Stop, panel close, WSS loss, worker termination, duplicate/out-of-order messages,
missing locale/fallback, and zero deferred permissions/dependencies.

**Rationale**: Unit/schema tests make policy exhaustive; real Extension E2E validates public Chrome
behavior; the manual matrix proves browser-chrome, keyboard, NVDA, bilingual, and owner-comprehension
outcomes that automation cannot honestly establish.

**Alternatives considered**:

- Unit tests only: insufficient for MV3 lifecycle, permission, injection, focus, and browser-context risk.
- Headless-only release evidence: insufficient for side-panel browser chrome and NVDA.
- A single current browser: contradicts Q-008 and SC-001/SC-009.

**Primary evidence**: [Chrome Extension E2E guidance](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing),
[Playwright Extension testing](https://playwright.dev/docs/chrome-extensions),
[Playwright 1.62 notes](https://playwright.dev/docs/release-notes),
[Vitest releases](https://main.vitest.dev/releases),
[New-SelfSignedCertificate](https://learn.microsoft.com/powershell/module/pki/new-selfsignedcertificate),
and [certutil user-store operations](https://learn.microsoft.com/windows-server/administration/windows-commands/certutil).

## R-013 — Full-document Navigation Scope Resolution (RESOLVED — DEFERRED FROM POC)

**Planning finding**: Validating a requested same-origin destination is insufficient to contain an HTTP
redirect to another origin, a response-triggered download, or an unsupported top-level document.
`tabs.onUpdated` and post-navigation probing detect those outcomes only after the browser has begun the
transition. The five-permission baseline therefore cannot honestly promise both ordinary assistant
full-document navigation and the FR-008 transition/download boundary.

**Approved POC decision — 2026-08-24**: Keep the five-permission baseline and defer every
assistant-initiated full-document, link, form, script-driven, or other navigation effect. User- or
page-initiated navigation remains compatible: the Extension treats it as a context change, invalidates
the complete old Plan plus stale context/targets/action grants, and re-runs applicable origin safety and
current-task consent before later protected work. Scroll, non-navigation low-risk click, non-sensitive
text entry, page read, answer-only work, and same-document exact Plans remain. The spec, capability
profile, data model, permission matrix, runtime contracts, and acceptance guide encode this choice.

Post-POC full-document navigation remains an explicit expansion track. It starts with a focused
two-Chrome technical spike and returns to product review before changing permissions or shipping.

**Navigation Lab candidate — not approved for implementation**: Add the production
`declarativeNetRequest` and `alarms` API
permissions. Immediately before one leased-tab full-document action, atomically install confirmed,
tab-scoped DNR session rules with explicit priority layers:

1. highest-priority response-header blocks for an attachment response, a missing `Content-Type`, or a
   declared type outside the supported `text/html` contract;
2. a middle-priority request-stage allow for the exact approved canonical origin; and
3. a lower-priority request-stage block for every other HTTP(S) `main_frame` request on that tab.

Only after `updateSessionRules` succeeds may the worker initiate navigation. It retains the guard through
same-origin HTML verification and removes it immediately on observation, denial, Stop, terminal state,
or tab removal. A one-shot alarm plus worker-startup rule enumeration provides an independent eventual
cleanup path, but Chrome may delay an alarm arbitrarily and it does not wake a sleeping device; session
rules otherwise clear at browser shutdown/update. There is no hard wall-clock TTL. If immediate cleanup
fails, the fail-closed guard may temporarily interfere with normal browsing until the next alarm/worker
wake. Rule/alarm installation or cleanup uncertainty blocks later Extension actions and is surfaced as
attention-required. A redirect request to another origin is blocked before that request is sent. A
response-header block occurs only after the approved same-origin server received the request, but Chrome
terminates handling of the response; neither case is reported as navigation success.

The three response cases are separate rules because header-present and header-absent matching have
different DNR semantics. This conservative HTML-only profile also rejects common redirect responses
that omit `Content-Type`, including some otherwise valid same-origin 3xx chains; DNR has no status-code
condition that safely distinguishes all redirect and download cases. Approving this option therefore
accepts that compatibility limit for the POC rather than weakening the download boundary.

This candidate could preserve ordinary navigation but is a material permission/data-placement change:
the API permission has install-warning impact, an additional alarm authority is introduced, and a DNR
session rule temporarily contains the approved origin. It therefore requires product-owner approval, a
reviewed least-privilege/data-matrix and contract update, orphan-rule cleanup, and focused tests on both
release Chrome majors before any future navigation release gate can pass.

The release gate must exercise cross-origin and same-origin 3xx chains (with and without declared
`Content-Type`), attachment responses, missing/non-HTML content types, page Service Worker/CacheStorage
and synthetic-redirect fixtures, rule/alarm install and removal failure, Stop, worker termination,
orphan discovery, and alarm cleanup. Chrome documents that DNR may
not see responses fulfilled entirely by a page Service Worker or CacheStorage, so this expansion is
conditional on those real-browser cases proving the observable boundary on both release majors. If any
case bypasses containment or the guard fails to clear on its documented exit/alarm/startup events,
full-document navigation cannot ship under this option and the reduced-scope recommendation applies.

**Other alternative requiring a spec decision**:

- Accept that an unexpected redirect or response-triggered download may begin before detection, then
  fail/attention-required. This weakens FR-008/SC-002 and is not recommended.

POC implementation tasks MUST NOT include a navigation capability, destination category, dispatcher,
DNR rule, or cleanup alarm. A future task may use this candidate only after a new product decision
approves the observable scope, exact capability profile, data/permission matrices, lifecycle contract,
and required two-Chrome evidence.

**Primary evidence**: Chrome documents that Declarative Net Request can apply `block`/`allow` rules
before a request and that the `declarativeNetRequest` permission supplies implicit access for those rule
types, response-header conditions are available in Chrome 128+, and session rules may be tab scoped:
[chrome.declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest).
Cleanup wake-up uses the public [chrome.alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
API rather than relying on a service-worker timer; the API explicitly permits delayed firing, so it is
a scheduled fallback rather than a hard TTL.

## R-014 — Progressive Observable-Parity Evolution (APPROVED DIRECTION)

**Decision**: Use the POC to validate the clean-room browser-assistant loop, then move toward the
Reference Extension through small, additive capability profiles. The target is close externally
observable behavior—not its source, bundled/minified code, proprietary assets, private identifiers,
private architecture, or undocumented protocols. The roadmap is an ordering and approval boundary, not
a release commitment and not permission to prebuild deferred state.

The approved progression is:

1. **POC `hallpass-v1`** — workspace, account/session, transient task/output, bounded page read with the
   controlled `page.form-values` subset, scroll, non-navigation low-risk click, non-sensitive text
   entry, Plan/consent/grant/Stop, bilingual and accessibility acceptance.
2. **Navigation Lab** — revisit the deferred PR-005/F-004 observable navigation gap using R-013's
   containment evidence; no production capability or permission changes before a separate approval.
3. **SHOULD increments** — evaluate PR-009, PR-010, PR-018, and PR-019 independently, one observable
   gap and capability profile at a time.
4. **COULD increments** — evaluate PR-011, PR-013, and PR-017 only after earlier profiles remain stable.
5. **Unresolved increments** — clarify PR-006, PR-012, and PR-014–PR-016 before planning any behavior.
   F-016 and F-017 remain `REFERENCE-ONLY` and never enter scope automatically.

Every increment MUST have an observable-gap/traceability record, explicit product-owner scope approval,
closed action/data/permission matrices, clean-room provider-neutral contracts, and regression evidence
for the two release Chrome majors, both locales, keyboard behavior, and the designated accessibility
pass. A future profile is additive and versioned; `hallpass-v1` peers fail closed on new literals. A deferred
feature creates no POC entity, dependency, permission, storage placement, UI affordance, or hidden code path.

## R-015 — Controlled Form-Value Parity (APPROVED FOR POC)

**Decision**: Treat current form values as a distinct optional data category, not as ordinary page text
and not as a new browser capability. General `page.read` authorization returns zero current form
values and zero selected-option state. If the task requests them, the Extension presents a separate
locally authored `page.form-values` disclosure and creates a separate grant bound to the current task,
tab, origin, and document. The content runtime then applies a closed local classifier and may return
only bounded task-relevant ordinary values and selected-option display state that it conclusively marks
non-sensitive.

Password, hidden/file, one-time-code, payment-card, sensitive-autocomplete, product-credential, and any
ambiguous field is withheld without value, length, hash, or partial content. The user may see non-value
withholding metadata. Selected-option state means select/listbox option display state only; checkbox
and radio checked state remains outside `hallpass-v1`. The origin-safety service receives only canonical origin and never receives form
data or classifier inputs. Form-value snapshots remain transient and absent from storage, logs,
telemetry, errors, and durable history. Reload, SPA/document change, origin change, Stop, revocation, or
any terminal task outcome invalidates the grant and snapshot. Immediately before collection and again
before WSS result forwarding, the worker rechecks task/channel, Stop, both applicable grants, selected
tab, document, and origin; invalidation wins and the payload is dropped.

This is a data/consent-contract change only. It uses the same `activeTab` plus on-demand `scripting`
boundary and adds no Chrome permission, host permission, background observer, iframe traversal, or
storage. Later form-context parity—such as additional confirmed form states or a broader ordinary-value
profile—requires a new additive capability-data matrix, owner approval, and full privacy/two-Chrome
regression evidence. It cannot silently broaden `hallpass-v1`.

**Rationale**: Pure structural page reading is too weak for the approved parity direction, while
returning every value except heuristically detected secrets places too much privacy risk in one POC
classifier. A separate fail-closed category/grant preserves a usable proof while keeping expansion
explicit and measurable.

**Alternatives considered**:

- Exclude every current form value/state forever: safer but unnecessarily blocks the approved
  reference-alignment path.
- Include every value not detected as sensitive under ordinary page-read consent: rejected because
  classifier false negatives would silently disclose ambiguous data.

**Primary evidence**: Q-020, FR-004, FR-008, and SC-003 in [spec.md](./spec.md), plus the confirmed
externally observable F-005 behavior recorded in
the reference analysis (private archive; public summary in `docs/design-notes.md`). No private reference
code, identifier, protocol, or asset is adopted.

## Research Traceability Matrix

| Decision | Approved destinations |
| --- | --- |
| R-001 — language/runtime | PR-003; FR-003; CT-009, CT-010, CT-011 |
| R-002 — UI/build | PR-001, PR-007; FR-001, FR-007; CT-012; SC-009, SC-010, SC-011 |
| R-003 — runtime boundary | PR-002–PR-005, PR-007, PR-008; FR-002–FR-005, FR-007, FR-008; CT-004–CT-011 |
| R-004 — permissions/activation | PR-001, PR-004, PR-005, PR-007, PR-008; FR-001, FR-004, FR-005, FR-007, FR-008; CT-003, CT-004, CT-010 |
| R-005 — task transport | PR-003, PR-007; FR-003, FR-007; CT-009, CT-011; SC-004, SC-005, SC-006 |
| R-006 — account authorization | PR-002; FR-002; CT-002, CT-006, CT-007, CT-011 |
| R-007 — transient/no-replay state | PR-003–PR-005, PR-007; FR-003–FR-005, FR-007; CT-007, CT-011, CT-013; SC-005, SC-006 |
| R-008 — origin safety | PR-004, PR-008; FR-004, FR-008; CT-004, CT-005, CT-008, CT-009, CT-013; SC-002, SC-003 |
| R-009 — page/actions | PR-004, PR-005, PR-007, PR-008; FR-004, FR-005, FR-007, FR-008; CT-002, CT-004, CT-008, CT-010, CT-011; SC-002, SC-003, SC-005, SC-008 |
| R-010 — service/schemas/adapters | PR-002, PR-003, PR-008; FR-002, FR-003, FR-008; CT-002, CT-006, CT-007, CT-009, CT-013 |
| R-011 — localization/accessibility | PR-001–PR-005, PR-007, PR-008; FR-001–FR-005, FR-007, FR-008; CT-012; SC-009, SC-010, SC-011 |
| R-012 — verification | PR-001–PR-005, PR-007, PR-008; CT-009–CT-013; SC-001–SC-011 |
| R-013 — navigation scope resolution / future containment lab | PR-005, PR-008; FR-005, FR-008; CT-004, CT-008, CT-010; SC-001, SC-002, SC-008 |
| R-014 — progressive observable-parity evolution | PR-005, PR-006, PR-009–PR-019; CT-001, CT-004, CT-007, CT-010, CT-012; SC-007; F-001–F-021 |
| R-015 — controlled form-value parity | PR-004, PR-008; FR-004, FR-008; CT-002, CT-004, CT-007–CT-009, CT-011, CT-013; SC-002, SC-003, SC-008; F-005 |

## Research Resolution

R-013 is resolved for the POC by approved navigation deferral and R-015 records the Q-020 controlled
form-value decision, so no Phase 0/1 research blocker remains for task decomposition. AI and identity
vendors, production distribution, operational numeric targets,
the Navigation Lab, and all other deferred capabilities remain deliberately outside this POC plan.
Deterministic provider-neutral adapters can support POC implementation and acceptance; no later choice
may alter permissions, data categories, retention, consent, or observable behavior without an explicit
product decision, an additive capability profile where applicable, and full artifact revalidation.
