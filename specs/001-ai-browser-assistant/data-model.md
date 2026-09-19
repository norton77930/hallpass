# Phase 1 Data Model: Chrome AI Browser Assistant POC

**Date**: 2026-08-24

**Scope**: Data and state needed by PR-001–PR-005, PR-007, and PR-008 only. All Core task,
page-context, action, plan, consent, safety-assessment, and model-output records are transient.

## Data Placement Classes

| Class | Allowed placement | Lifetime | Examples |
| --- | --- | --- | --- |
| Session security | Trusted `chrome.storage.session`; product-service memory | Browser session or earlier logout/revocation/expiry | Opaque product session ID/credential, PKCE state/verifier, account binding |
| Lifecycle marker | Trusted `chrome.storage.session` | Active task or until interruption is reported | Runtime epoch, task ID, action request ID, dispatch phase |
| Extension task state | Service-worker memory | Active task only | Task, grant, plan, capability request/result, channel sequence |
| Page execution state | Content-runtime memory | Current top-level document only | Snapshot, optional granted form-value items/withholding metadata, opaque target registry, document epoch |
| UI projection | Side-panel memory | Open side-panel connection only | Safe session view, progress text, pending consent, terminal status |
| Server task state | Product-service memory | Active task lease only | Task channel, orchestration state, provider correlation held behind adapter |
| Remote inference processing | Approved provider transient processing only | One active inference call | Minimum approved prompt/context/result; no training, durable retention, history, analytics, or content log |
| Wire data | TLS request/channel only | One request/message | Auth exchange, task event, consent decision, capability result |
| Forbidden durable history | No POC placement | Not applicable | Prompts, outputs, page content, plans, action arguments/results, grants, assessments |

No Core entity below may be written to `chrome.storage.local`, IndexedDB, browser local storage, a
durable server database, analytics, traces, content-bearing logs, notifications, exports, or a cache.
The live AI adapter is disabled unless vendor contract and effective account/request settings meet the
same no-retention/no-training boundary; a provider's default history or logging is not an allowed POC
placement.
Infrastructure logs may not persist raw request paths, task/channel/message/request/operation IDs,
Origin, authorization material, bodies, tickets, or correlation fields. POC coarse state/stable codes
exist only in active process/UI memory and isolated test captures; no operational counter, metric, or
log is retained without the unresolved Q-015 data-matrix/processor/retention approval.

## Entity Overview

CT-002 governs every entity in this model. In particular, authentication/account fields, canonical
origins and page-derived fields, conversation content, action arguments/results, and browser-derived
context are separate sensitive data categories whose approved purpose, placement, and lifetime are
constrained by the placement table above.

| Entity | Authority | Key | Principal relationships | Traceability |
| --- | --- | --- | --- | --- |
| Runtime Epoch | Service worker | `runtimeEpochId` | Owns active Task and Operation Marker namespace | CT-011, SC-006 |
| Service Availability | Service worker | runtime epoch + probe generation | Gates session restore, sign-in, and protected work | FR-001, FR-002, CT-009, SC-012 |
| Authorized Service Session | Service worker/product service | `sessionId` | Binds Account to Task; gates protected work | FR-002, CT-002, CT-006 |
| Browsing Context | Service worker | local `tabId` + `documentEpoch` | Binds Task, Grant, Snapshot, and Action | FR-001, FR-004, FR-005, CT-002 |
| Origin Safety Assessment | Service worker | canonical origin + runtime epoch | Gates page read/action before Grant | FR-008, Q-007 |
| Assistant Task | Service worker/product service | `clientTaskId` + `serverTaskId` | Owns Plan, Grants, capability flow, terminal outcome | FR-003, FR-007, CT-002 |
| Task Plan / Plan Step | Service worker | `planId` + version + index | Constrains sequential actions and Grants | FR-005, Q-006 |
| Authorization Grant | Service worker | `grantId` | Binds user decision to Task/context/capability | FR-008 |
| Page Context Snapshot | Content runtime | `snapshotId` | Owns redacted nodes and Target Handles | FR-004, CT-002 |
| Target Handle | Content runtime | opaque `targetHandle` | Resolves one element within one snapshot/document | FR-004, FR-005 |
| Capability Request | Service worker | `requestId` | Evaluates server intent against Plan/Grant/context | FR-003, FR-008 |
| Browser Action | Service worker/content runtime | `requestId` | Closed action union and observed result | FR-005, FR-007, CT-002 |
| Capability Result | Service worker | `requestId` | Immutable bounded result returned to service | FR-003, CT-002, CT-009 |
| Operation Marker | Service worker | runtime epoch + request ID | Detects uncertain effect across worker loss | CT-011, SC-005/SC-006 |
| Task Channel Envelope | Both trusted runtimes | message ID + direction sequence | Carries versioned task protocol | FR-003 |
| Capability Profile | Shared protocol | `hallpass-v1` | Advertises the exact POC capability set and gates additive future profiles | FR-003, FR-005, CT-009 |
| Locale Bundle / Coverage Record | Build/side panel | locale + message key | Renders all fixed UI and fail-safe fallback | CT-012, SC-009–SC-011 |

## Core Entities

### Service Availability

| Field | Type | Rules |
| --- | --- | --- |
| `state` | `checking` / `available` / `unavailable` | Only `available` permits restore, sign-in, or protected work |
| `probeGeneration` | positive integer | Increments for panel-open and each explicit retry; older completions are ignored |
| `serviceOrigin` | build-pinned origin | Projected only as a human-readable local address for POC recovery |
| `reasonCode` | optional stable local code | Required when unavailable; locale catalog supplies visible copy |
| `accessRequest` | `idle` / `requesting` | Side-panel-memory-only duplicate-click guard; never proves availability |

A panel connection initiates one check. An explicit `ui.service.retry` initiates exactly one newer
check. There is no continuous poll. A 204 response within five seconds transitions to `available`;
non-204, rejection, or timeout transitions to `unavailable`. Session restore is sequenced after
availability and shares the generation guard. When unavailable, one explicit recovery gesture may
temporarily set `accessRequest=requesting` while the visible panel makes one bounded, response-agnostic
`GET /health` to trigger Chrome's Local Network Access decision. Its completion, rejection, or timeout
returns `accessRequest` to `idle` and emits one `ui.service.retry`; only the worker probe may change
`state`.

### Runtime Epoch

| Field | Type | Rules |
| --- | --- | --- |
| `runtimeEpochId` | opaque random ID | New on every service-worker start; never reused |
| `startedAt` | timestamp | Diagnostic only in trusted memory; never telemetry |
| `status` | `active` / `replaced` | A replaced epoch cannot authorize a message or effect |

Any message, grant, or action bearing an older epoch fails as `stale` or `interrupted`.

### Authorized Service Session

| Field | Type | Rules |
| --- | --- | --- |
| `sessionId` | opaque ID | Product-session identifier; not an AI-provider identifier |
| `state` | session state enum | See transition table below |
| `accountId` | opaque ID | Required for protected work and isolation |
| `organizationId` | optional opaque ID | If supplied, cannot change silently during a session |
| `accountLabel` | optional reviewed display value | Trusted memory/UI projection only; never persisted or given to page code |
| `accessCredential` | opaque secret | Trusted service worker/session storage only |
| `refreshCredential` | optional opaque secret | Same boundary; absent when product policy requires reauth |
| `expiresAt` | timestamp | Expired sessions cannot start/continue protected work |
| `authFlowState` | optional state + PKCE verifier | Exists only during authorization and clears on completion/cancel |

The side panel receives only a safe session view. Content runtime and origin classifier receive none of
these fields. The exact `chrome.storage.session` session allowlist is opaque product `sessionId`,
access/refresh credential, expiry, account/organization binding, in-progress auth state/verifier, and
operation markers;
`accountLabel` is re-projected from a live session/refresh response or omitted after worker memory loss.
After worker memory loss, session-state validation must confirm the same binding before signed-in is
projected. Logout clears the Extension record before attempting remote revocation.

### Browsing Context

| Field | Type | Rules |
| --- | --- | --- |
| `tabId` | Chrome-local integer | Never sent to product service or page code |
| `windowId` | Chrome-local integer | Must still identify the active current window |
| `documentId` | optional Chrome document ID | Re-read from injection result when available |
| `documentEpoch` | opaque ID | Changes after top-level document replacement/reinjection and every detected SPA/page-state change that invalidates form values or exact targets |
| `url` | local URL | Potentially sensitive; classifier never receives it |
| `canonicalOrigin` | scheme + host + effective port | Required for supported protected work |
| `contentType` | string | POC requires `text/html` |
| `topFrame` | boolean | Must be true |
| `incognito` | boolean | Must be false |
| `active` | boolean | Must be current selected tab immediately before each step |
| `supportState` | supported / unsupported / inaccessible / stale | Non-supported states authorize no read/action |

A changed tab, window, origin, content type, or support state invalidates the affected snapshot, target
handles, grant, and pending action before dispatch. A same-origin document-epoch change invalidates
snapshots, handles, pending operation bindings, and exact action/Plan-step grants, but does not by itself
revoke an otherwise valid general page-read grant bound to the same task/tab/origin/categories. It
always expires the distinct `page.form-values` grant and form-value snapshot.

### Origin Safety Assessment

| Field | Type | Rules |
| --- | --- | --- |
| `canonicalOrigin` | canonical origin | The only application field allowed in a remote request |
| `localDecision` | allow / deny / unknown | Always evaluated first |
| `remoteState` | not-needed / pending / received / unavailable / invalid / expired | Remote path exists only for local unknown |
| `remoteDecision` | optional allow / deny / unknown | Missing unless a valid remote result exists |
| `validUntil` | optional timestamp | Stale result is not allow; no persistent cache |
| `disclosureId` | optional opaque local ID | Created only for local unknown; never sent to classifier |
| `disclosureState` | not-needed / pending / presented / failed | Remote request requires matching `presented` evidence first |
| `reasonCode` | stable local code | UI maps it to reviewed locale text |
| `effectiveDecision` | allow / deny / blocked-unknown | Allow is safety-only, never consent |

The remote request contains no task/account/session/correlation field, full URL component, referrer,
title, page data, or cookie. Deny, unknown, invalid, expired, and unavailable block protected work.
For local unknown, the side panel must first present reviewed text naming the safety-classification
purpose and canonical-origin data category, then acknowledge the matching `disclosureId`. Missing or
ambiguous selected-locale and English-fallback copy sets `failed` and sends no request. Presentation is
not page-read consent; a separate current-task grant is still required after safety allow.

### Assistant Task

| Field | Type | Rules |
| --- | --- | --- |
| `clientTaskId` | opaque ID | Created locally; unique within runtime epoch |
| `serverTaskId` | optional opaque ID | Assigned at authenticated bootstrap |
| `runtimeEpochId` | Runtime Epoch key | Must equal current epoch |
| `accountId` | account binding | Must equal current Authorized Service Session |
| `contextBinding` | tab/document/origin tuple | Revalidated before protected work |
| `locale` | `en-US` / `zh-TW` | Controls fixed UI and requested response language |
| `userRequest` | text | Transient, externally transmitted only on explicit submit |
| `outputBuffer` | progressive text | Side-panel/service memory only; no durable history |
| `taskMode` | undecided / answer-only / page-read-only / single-action / approved-plan | Makes zero-capability and controlled-capability success non-vacuous |
| `state` | task state enum | Exactly one terminal transition |
| `inboundSequence` | non-negative integer | Strictly increasing server-to-client sequence |
| `outboundSequence` | non-negative integer | Strictly increasing client-to-server sequence |
| `channelLease` | active/expired + expiry | Loss/expiry stops requests and effects |
| `terminal` | optional object | Exactly `outcome`, stable `reasonCode`, and bounded inert `summary`; outcome is success/denial/cancellation/attention-required/failure |

Only one Task may own the Extension runtime's current-tab control lease. A second start request is
rejected until the first reaches a terminal state. A task starts `undecided`. A first accepted
`page.read` moves it to `page-read-only`; a first accepted unplanned browser effect moves an undecided or
page-read-only task to `single-action`; and an accepted multi-effect Plan moves it to `approved-plan`.
`answer-only` is assigned only when a success terminal arrives before any capability request or Plan.
Single-action/approved-plan commitment is irreversible, while page reads may precede either controlled
action mode or occur later without changing the committed action mode.

### Task Plan and Plan Step

**Task Plan fields**: `planId`, positive `version`, optional prior-version lineage, `taskId`,
account/tab/origin/document context binding, ordered exact steps, review-safe summary, decision
(`pending`, `approved`, `denied`, `revoked`, `expired`), and a locally computed integrity digest covering
each exact purpose/execution binding.

**Plan Step fields**: positive one-based `position` (domain array index is not a contract field),
`bindingState` (`exact` only), closed capability category, bounded inert purpose and purpose digest,
expected context/target/normalized arguments/data categories, locally derived action/data summary, local
binding digest, risk/sensitivity result, state (`pending`, `authorized`, `executing`, `observed`,
`blocked`, `cancelled`, `failed`), and optional immutable result reference.

Rules:

- An initial Plan has no prior lineage, contains at least two browser-effect steps, and uses contiguous
  absolute positions from 1. A one-step initial Plan is invalid and uses `single-action` instead.
- A task with two or more browser-effect steps requires a reviewed Task Plan before its first action.
- A task requesting exactly one browser effect may omit a Plan. The first accepted unplanned action
  commits the task to `single-action` mode; a later browser action is denied. It still requires an
  explicit capability grant and all normal safety/context checks.
- Approval binds one exact plan ID/version/digest, ordered purpose/context/target/argument/category set,
  and creates action grants for its exact steps; any changed binding requires new review/version.
- `exact` requires full expected context/categories/arguments. Pending/deferred binding fields and a
  missing/unknown discriminator fail closed.
- Before any action dispatch, a full exact revision may cite the current plan/version/digest, revoke its
  approval, and require a new review. After the first dispatch, the Plan is immutable.
- Any top-level document change expires the entire Plan and its action grants. Later protected work after
  a user- or page-initiated change requires a fresh probe, applicable safety and consent, and a new Plan
  ID; no completed prefix or prior effect is resumed or replayed.
- One step executes at a time and only after the previous step has an observed result.
- A server request not matching the next approved step is denied.
- Origin change expires the plan approval even if the textual plan is unchanged.
- Approved-plan success requires every exact step in the approved version to have one observed result.
  Plan and steps disappear at terminal task state.

### Authorization Grant

| Field | Type | Rules |
| --- | --- | --- |
| `grantId` | opaque ID | Unique and transient |
| `decision` | pending / approved / denied | Only explicit approved permits the bound operation |
| `accountId` | account binding | Must match current session |
| `taskId` | Task key | Grant cannot authorize another task |
| `tabId` | local tab key | Grant cannot authorize another tab |
| `canonicalOrigin` | origin binding | Origin change expires grant |
| `documentEpoch` | optional document binding | Required for a `page.form-values` grant; any document/SPA/reload change expires it |
| `grantKind` | general-page-read / form-values / action | `form-values` is a distinct grant and cannot be implied by general page-read approval |
| `capability` | closed category | Page-read or one approved action category |
| `dataCategories` | explicit set | Cannot expand after approval |
| `executionMode` | page-read / single-action / approved-plan | Determines whether plan binding is allowed/required |
| `requestId` | optional Capability Request key | Required for `single-action`; an approved-Plan grant binds step/digest first and records request ID only in the later matching operation binding |
| `purposeDigest` | local canonical digest | Required for every grant; binds the exact bounded purpose value shown as inert request detail |
| `contextHandle` / `targetHandle` | optional exact action binding | Context required for every action; target required when its action schema uses one |
| `argumentDigest` | optional local canonical digest | Required for every action; absent for page read |
| `reviewDigest` | local canonical digest | Required for every grant; covers capability, purpose, context, categories, and action arguments when applicable |
| `planId` / `planVersion` / `stepId` | optional plan binding | Required only for `approved-plan`; absent for `single-action` |
| `state` | active / revoked / expired | Only active is usable |

Grant-kind invariants are closed: `general-page-read` MUST exclude `page.form-values`;
`form-values` MUST contain exactly `page.form-values`, require a matching active general
page-read grant, and bind the exact current document epoch; `action` follows the single-action or
approved-Plan fields. One grant can never change kind or absorb another kind's category.

Any terminal task outcome, Stop, panel disconnect, logout, account change, origin change, leased-tab
loss, or explicit revocation expires the grant. A same-origin document/SPA/reload change may preserve a
general page-read task/origin/category grant, but always expires the distinct `page.form-values` grant
and every exact target/action/Plan-step grant. A single-action grant
permits one matching request/dispatch; an approved-Plan grant permits only a later request that exactly
matches its step/digest, at which point that operation binds the request ID. Purpose/argument/target/
context mutation requires a new review. There is no
site/session persistent grant.

### Page Context Snapshot and Target Handle

**Snapshot fields**: `snapshotId`, opaque product-facing `contextHandle`, task ID, tab/document/origin binding,
collection purpose, observed content type, optional bounded/redacted title when `page.title` is granted,
optional bounded/redacted current top-level text selection (empty when none) when `page.selection` is
granted, optional `formValueItems` and non-value withholding metadata only when the separate
`page.form-values` grant is active, redaction categories applied, truncation flag and disclosed
reason, semantic nodes, and creation epoch.

**Semantic node fields**: bounded text, role, accessible label, non-form-value state needed for
understanding, and optional opaque target handle. Raw HTML, script/style content, event handlers,
unchecked/checked radio or checkbox state, ungranted form values, and excluded-frame/shadow/canvas
content are absent.

**Form-value item fields**: one snapshot/document-bound non-executable control reference; bounded
control kind and non-value label metadata; classification `allowed-ordinary`,
`withheld-sensitive`, or `withheld-ambiguous`; and, only for `allowed-ordinary`, either
a bounded ordinary current value or bounded selected-option display labels. A withheld item contains
no value, length, hash, token, character class, or partial content. These items are page-derived content,
not target authority.

**Target Handle fields**: opaque handle, snapshot ID, document epoch, element connection token,
expected role/label/type, allowed capability set, and sensitivity/risk classification. The actual DOM
reference/fingerprint exists only in content-runtime memory.

The initial `contextHandle` is revealed only after authorized `page.read`; it lets the server bind later
requests to that approved snapshot/document without receiving Chrome tab/document IDs. Task bootstrap
and the first page-read request contain no origin or context handle. Any document change invalidates the
old handle. After an observed authorized non-navigation action that changes the ordinary DOM without
replacing the document, the worker may issue a replacement handle only after it independently confirms
the same document/origin and probes again; that replacement is a new binding and does not revive any old
target/action/Plan-step grant. Document replacement during an attempted POC action is non-success and
invalidates the entire Plan.

Rules:

- Without a distinct active `page.form-values` grant, every current form-control value and
  selected-option state is excluded.
- With that current-task/current-document grant, only bounded task-relevant ordinary values and
  selected-option display state conclusively allowed by the closed local policy may enter
  `formValueItems`. Password, hidden/file, OTP, payment-card, sensitive-autocomplete,
  product-credential, and ambiguous values expose no value, length, hash, or partial content. Checkbox
  and radio checked state remain outside `hallpass-v1`.
- Form-value data remains memory-only and is invalidated by reload, SPA/document or origin change,
  Stop, revocation, or any terminal task outcome.
- Local target metadata may retain only non-value role/label/type/editability and sensitivity
  classification when a value is not allowed.
- Numeric size bounds are configuration inputs; exceeding them sets `truncated` or returns a limit error.
- A stale snapshot/handle is never silently re-resolved by model-provided selector text.
- Same-origin SPA/DOM change requires a fresh probe and target validation before the next effect.

### Capability Request, Browser Action, and Capability Result

**Capability Request fields**: request ID, task ID, server sequence, execution binding (`page-read`,
`single-action`, or exact approved plan step), capability enum, bounded inert purpose/data categories,
opaque target handle when the action uses one, optional expected context, and provider-neutral arguments
validated by the shared schema. Expected context is absent for the first page read and required for later browser actions.
The worker includes the exact validated purpose value in the local review/Plan digest; changing it after
review invalidates the binding even though purpose text never serves as authority by itself.

The closed task `DataCategory` enum is `user.request`, `page.canonical-origin`, `page.title`,
`page.visible-text`, `page.structure`, `page.selection`, `page.target-metadata`,
`page.form-values`, `action.text-input`, and `action.observable-result`. Capability-specific
subsets and closed
argument/result discriminators are normative in [task-channel.md](./contracts/task-channel.md); unknown
or inapplicable categories fail closed and cannot become remote-authored UI labels.

**Browser Action union** (the same canonical capability literals are used in domain, WSS, and
Extension-runtime schemas; only their UI labels are localized):

- `browser.scroll`: bounded direction/target intent.
- `browser.click`: one locally classified low-risk target.
- `browser.enter-text`: explicit non-sensitive text plus a locally classified non-sensitive field.

`browser.navigate-same-origin` and all other assistant-initiated navigation literals are absent from
the POC union and fail as unsupported before authorization or dispatch.

**Post-POC Navigation Lab — not a POC entity/profile**: R-013 retains the possible transient Navigation
Guard design as research evidence only. The POC creates no guard record, DNR rule, alarm, destination
category, pending navigation Plan step, or navigation result. A future additive capability profile must
first receive explicit product approval and define its own action/data/permission/lifecycle contracts,
cleanup invariants, and focused evidence on both release Chrome majors.

**Capability Result fields**: request ID, status (`succeeded`, `denied`, `cancelled`, `unsupported`,
`inaccessible`, `stale-context`, `attention-required`, or `failed`), stable reason code, bounded observable evidence, current
context binding, and whether the claimed effect was verified.

The result is immutable. Unknown effect is never `succeeded`. No result authorizes the next step by
itself; the service worker re-evaluates every gate.

### Operation Marker

| Field | Type | Rules |
| --- | --- | --- |
| `runtimeEpochId` | epoch key | Previous epoch cannot dispatch |
| `taskId` | Task key | No prompt/content included |
| `requestId` | Capability Request key | No arguments/target data included |
| `phase` | prepared / dispatched / observed / uncertain | `dispatched` is a write-ahead boundary persisted before the content-effect call |
| `accountId` | account binding | Detects session mismatch |
| `expiresAt` | timestamp | Cleared at terminal task/logout/expiry |

The worker MUST persist and confirm `dispatched` before crossing into the content runtime; the name means
the effect may occur, not that it is known to have occurred. If that write fails, no effect call is made.
After that await and every other asynchronous pre-dispatch boundary, the worker rechecks the nonterminal
task/control lease, grant, selected tab, document/origin, and target under its dispatch fence immediately
before initiating the content call. If Stop/revoke/context change won the race, no content call occurs;
the active task reports cancellation/denial and removes the marker only after terminal projection. A
crash before that cleanup remains conservatively `uncertain`.

On worker start, a prior-epoch marker maps deterministically: `prepared` → cancellation with
`lifecycle-interruption` and no dispatch; `dispatched` or `uncertain` → attention-required; and
`observed` without its memory-only exact result → failure with `lifecycle-interruption`, never success
or replay. The marker remains until that terminal/interruption projection is delivered to an accepted
side-panel Port or its finite safety/privacy expiry is reached, then is removed. No prior task is resumed.

### Task Channel Envelope

All WSS messages carry: `protocolVersion`, direction-specific `messageId`, `taskId`, `runtimeEpochId`,
strictly increasing `sequence`, `sentAt`, discriminant `type`, and validated `payload`. `client.hello`
also advertises `capabilityProfile: hallpass-v1` and exactly `page.read`, `browser.scroll`, `browser.click`,
and `browser.enter-text`.

Server message types: accepted, progress, plan proposed, capability requested, heartbeat, terminal.
Extension message types: client hello, plan decision, capability result, Stop, heartbeat.

Rules:

- The connection ticket is accepted only once and is not an envelope field after hello.
- Duplicate/out-of-order messages cannot produce a new effect.
- Exactly one terminal server event is accepted; later events are protocol violations.
- Unrecognized version/type/payload closes the task fail-closed.
- A server request outside the advertised capability profile is unsupported and performs no protected work.

### Locale Bundle and Coverage Record

| Field | Type | Rules |
| --- | --- | --- |
| `locale` | `en-US` / `zh-TW` | Exactly two POC locales |
| `messages` | key → reviewed text/template | Keys and placeholders must match English baseline |
| `fallbackLocale` | `en-US` | Fixed for both locales |
| `surfaceCoverage` | adopted surface/state matrix | Must be 100% before release |
| `reviewStatus` | pending / approved | Unapproved fixed copy cannot ship |
| `keyboardResult` | pass/fail | Required for each release matrix cell |
| `nvdaResult` | pass/fail | Required manual owner evidence |

Runtime lookup returns reviewed English on missing/invalid non-safety text and never exposes a key. If
reviewed consent/safety fallback is unavailable, the protected operation is blocked.

## State Transitions

### Service availability

```text
panel-open / explicit-retry → checking
checking → available → session restore
checking → unavailable
unavailable → checking          (explicit retry only)

unavailable + recovery gesture → accessRequest=requesting
accessRequest=requesting → accessRequest=idle + ui.service.retry
```

Only the latest probe generation may transition state. Every HTTP operation settles within five
seconds; timeout is unavailable, never authorizing. The permission bootstrap has no availability
transition and duplicate recovery gestures are ignored while it is requesting.

### Session

```text
signed-out → authorizing → active → renewing → active
                         ↘ reauth-required → authorizing
                         ↘ policy-blocked
active / renewing / reauth-required / policy-blocked → signed-out
```

A refresh `409` never creates a new session state: the worker stops protected work, clears local
credentials/account binding, transitions to `reauth-required`, and projects stable reason
`auth.account-mismatch`. It cannot keep the old session active or silently adopt the returned account.

Cancel, invalid redirect/state, exchange failure, expiry without renewal, logout, or account mismatch
cannot transition to active.

### Task

```text
created → connecting → running
running ↔ awaiting-consent
running ↔ awaiting-plan-decision
running ↔ awaiting-capability-result
running ↔ executing
any nonterminal → success | denial | cancellation | attention-required | failure
```

Terminal states are mutually exclusive and final. Stop immediately selects cancellation unless an
already-started effect is unconfirmed, which selects attention-required.

### Safety

```text
local-pending → local-allow
              → local-deny
              → local-unknown → remote-pending → remote-allow
                                               → remote-deny
                                               → remote-unknown
                                               → remote-invalid/expired/unavailable
```

Only local-allow or remote-allow can proceed to a separate consent decision.

### Capability / Effect

```text
requested → evaluated → awaiting-consent → authorized → prepared → dispatched → observed
     ↘ denied / unsupported / inaccessible / stale-context / cancelled / failed
dispatched → uncertain / attention-required when completion cannot be verified
```

No transition skips evaluation or consent. `observed` is required before success.

## Cross-Entity Invariants

1. Session account, Task account, Grant account, and channel account must match.
2. Task runtime epoch must equal the current service-worker epoch.
3. Task context, Grant context, Snapshot/context handle, Target Handle, purpose digest, normalized
   arguments, local review digest, and Action context must match immediately before dispatch.
4. Local safety deny is final; local unknown may invoke only the origin-only remote endpoint.
5. Safety allow is never a Grant.
6. A multi-step action must be the next exact purpose/context/target/argument/category binding of the
   approved plan version/digest; an unplanned single-action task may dispatch one exactly reviewed effect total.
7. Every action request ID produces at most one dispatch and one immutable result.
8. Stop/revoke/terminal state invalidates all grants and queued requests before remote cancellation.
9. Side-panel disconnect is Stop; service-worker/channel loss is interruption, never transparent replay.
   Every protected read/effect dispatch and result transmission rechecks Stop/grant/context after its
   last awaited prerequisite; invalidation wins the race and starts/sends nothing further.
   Form-value collection/transmission additionally requires the distinct current-document
   `page.form-values` grant at both checks; a general page-read grant can never substitute for it.
10. Content, arguments, results, grants, assessments, and task/correlation identifiers never enter
    durable storage or correlatable content/access logs.
11. Candidate/deferred features introduce no entity instance, permission, dependency, or state.
12. User-facing reason codes resolve through selected locale then reviewed English fallback; unresolved
    or ambiguous safety copy blocks disclosure acknowledgment and the remote request.
13. Every transmitted user/page/target/effect argument or result item has a disclosed
    canonical DataCategory allowed by its capability; unknown, missing-required, extra, or expanded
    categories fail closed. Closed non-content envelope, opaque-binding, status/reason/error, support,
    truncation, and lifecycle metadata is schema-bound rather than category-bearing and cannot carry
    content or substitute for disclosure/consent.
