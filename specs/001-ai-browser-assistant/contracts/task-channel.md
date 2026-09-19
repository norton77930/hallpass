# Task Channel Contract

**Status**: Phase 1 design contract  
**Protocol version**: `1`  
**Transport**: task-scoped WebSocket over `wss://`

## Purpose and boundary

This contract connects the product-controlled service to the Extension service worker for one
transient, user-triggered task. It supports progressive output, plan review, declared capability
requests, observable results, cancellation, and one terminal outcome. It does not grant browser
authority: the service worker independently checks authentication, the active browsing context,
origin safety, current-task consent, plan approval, target freshness, and action policy before any
protected read or effect.

The channel carries no durable-history, attachment, saved-prompt, scheduling, workflow-recording,
export, hosted-assistant, connector, enterprise-policy, notification, telemetry, or reference-private
message.

Traceability: FR-002, FR-003, FR-004, FR-005, FR-007, FR-008; CT-004 through CT-009, CT-011, CT-013;
SC-002, SC-004 through SC-008.

## Bootstrap and binding

1. The service worker calls `POST /v1/tasks` from `product-api.openapi.yaml` with the valid product
   session and creates an in-memory local Task in `connecting` state.
2. The service returns `taskId`, protocol version `1`, a fixed-product-origin `wss://` URL, a
   single-use `connectionTicket`, and `ticketExpiresAt`.
3. The worker rejects an unexpected scheme or product origin, then opens the channel before the ticket
   expires. It never exposes the ticket or product credential to the side panel or content runtime.
   The bootstrap request itself carries a finite bound (default 5 s, a deployment input): a service
   that accepts it and never answers would otherwise leave the task with no channel, no result, and no
   terminal, which is an outcome the task can never reach on its own.
4. The first client frame MUST be `client.hello`. The service atomically consumes the ticket, validates
   its task/account/runtime binding, and replies with `server.accepted`. Any other first frame, reused or
   expired ticket, account mismatch, or protocol mismatch closes the channel with no capability work.
   Symmetrically, the first *server* frame MUST be `server.accepted`: until the channel is accepted
   there is no lease and no agreed capability profile, so the client closes on any other frame rather
   than running work the service never admitted.
5. A task has at most one accepted channel and one Extension runtime lease. Reconnection is not part of
   POC behavior. A lost accepted channel moves the task to an interruption terminal path; it never
   silently resumes an action.

The product session authorizes the product account only. It does not authorize a page read, browser
action, origin, target, or later task.

## Common envelope

Every accepted frame after the WebSocket handshake is a UTF-8 JSON object with exactly these common
fields plus its type-specific `payload`:

| Field | Type | Rule |
| --- | --- | --- |
| `protocolVersion` | string | MUST equal `"1"`. |
| `messageId` | non-empty opaque string | Unique for the sender within the task. |
| `taskId` | non-empty opaque string | MUST equal the bootstrapped task. |
| `runtimeEpochId` | non-empty opaque string | MUST equal the initiating Extension runtime epoch. |
| `sequence` | positive integer | Sender-local, contiguous, strictly increasing from `1`. |
| `sentAt` | RFC 3339 UTC timestamp | Diagnostic ordering aid only; never overrides sequence or policy. |
| `type` | closed string enum | One of the message types below. |
| `payload` | object | Closed schema selected by `type`; unknown properties are invalid. |

Receivers validate size before parsing and validate the complete closed schema before processing. A
single frame MUST NOT exceed the injected frame limit (default 64 KiB, `CHANNEL_MAX_FRAME_BYTES`);
the service enforces it at the transport as the WebSocket `maxPayload`, so an oversized frame closes
the connection before any of it is held or read, and the client checks the frame length before it
parses, so an oversized frame is never memory it has already spent.

Every string either side authors is bounded by the same injected object (`ProtocolBounds`, defaults
recorded as D9): a narrative string — `server.progress.textDelta`, `server.terminal.summary`, and any
request `purpose` — at 4,000 characters; entered text and a disclosed ordinary form value at 2,000;
collected `visibleText` at 8,000 across at most 200 semantic nodes; an accessible name at 80. The
bounds are a deployment input built into the schemas, not a value read from the wire, and a bound
that is not a positive integer fails at construction rather than at the first oversized frame.

An action's arguments are one closed shape per action, defined once and shared with the runtime
channel: whatever this boundary refuses, the content runtime refuses identically, and an argument
belonging to a different action — or a field no action takes — invalidates the frame rather than
being carried as far as the page and ignored there.

Unknown versions, types, fields, repeated `messageId`s, sequence gaps, task/epoch mismatch, or frames
after terminal state are protocol violations. A `client.capability-result` whose `requestId` does not
name an outstanding, still-unanswered `server.capability-request` is a protocol violation too: a
result is an answer to one request the service actually made. The receiver performs no protected
effect. Where a frame can still be sent, the service ends the channel with one `server.terminal`
`failure` / `protocol.violation` before closing, so the panel is not left to guess why its task
stopped; where it cannot, it closes.

## Client-to-service messages

### `client.hello`

First client frame only.

```json
{
  "connectionTicket": "opaque single-use value",
  "locale": "zh-TW",
  "capabilityProfile": "hallpass-v1",
  "capabilities": [
    "page.read",
    "browser.scroll",
    "browser.click",
    "browser.enter-text",
    "browser.key-press",
    "browser.hover",
    "browser.double-click",
    "browser.drag",
    "page.resolve",
    "page.wait"
  ]
}
```

`locale` is `en-US` or `zh-TW` and affects server-authored display text only. The Extension localizes
all stable status and error codes itself. `capabilityProfile` and `capabilities` are a closed POC
advertisement: under protocol version `1`, the service accepts only `hallpass-v1` with exactly the ten
listed capabilities, in that exact order, and MUST NOT request an unadvertised capability. Any future
capability is an additive, explicitly reviewed profile/protocol change; absence, duplication,
reordering, or an unknown literal closes the task before protected work.

The last six were added by `specs/002-reference-parity` (FR-024 through FR-028, which amends 001/FR-005):
`browser.key-press`, `browser.hover`, `browser.double-click`, and `browser.drag` are actions under
every rule the original three carry; `page.resolve` is a read and `page.wait` a control instruction,
so neither is ever an action. `protocolVersion` is unchanged, so a peer from before that feature
refuses the hello in either direction — the correct fail-closed answer, and acceptable only because
both deployables ship together.

### `client.plan-decision`

```json
{
  "planId": "opaque plan identifier",
  "planVersion": 1,
  "planDigest": "Extension-computed canonical binding digest",
  "decision": "approved",
  "decisionId": "opaque idempotency key",
  "excludedStepIds": ["opaque step identifier the user removed"]
}
```

`decision` is `approved` or `denied`. `planDigest` is computed locally from each validated exact
context/capability/purpose/target/arguments/category binding; the server-supplied summary is not part
of the authority. Remote purpose is bounded inert display text, but its exact validated value is
included in the digest so it cannot change after review. Approval is valid only for that exact ordered
plan version/digest and current task; editing or replacing any binding requires a new version and
decision. Denial starts no step.

`excludedStepIds` is the optional set of steps the user removed before approving (002/FR-020). It
travels with the decision rather than as a message of its own: an approval and the exclusions that
qualify it are one act, and a second message could arrive apart from it, or not at all, leaving the
service holding an approval the user never gave. It is bounded by the plan bound, must name steps of
the cited plan, and may not repeat an identifier; the payload carries no step list, so the schema
refuses only the duplicate and the worker, which holds the plan, refuses an unknown one and with it
the whole approval. **The approved plan is exactly the kept steps, in their reviewed order.** The
service must treat an approval-with-exclusions as authorising only those steps; a later request for
an excluded step is refused by the worker as a denial regardless of what the service believes.
Removing every step is sent as a denial, never as an approval whose exclusion set covers the plan. A
denial may carry the set too — it is a record of what the user did, not an authorization — and the
reviewed positions of the excluded steps are projected to the panel on the terminal
(`worker.task.terminal.excludedSteps`, `extension-runtime.md`).

### `client.capability-result`

```json
{
  "requestId": "request being answered",
  "operationId": "Extension-generated idempotency key",
  "status": "succeeded",
  "result": {},
  "errorCode": null
}
```

`status` is `succeeded`, `denied`, `unsupported`, `inaccessible`, `stale-context`, `cancelled`,
`attention-required`, or `failed`. `result` is the bounded observable result allowed by the requested capability schema. It
never contains a raw Chrome tab ID, document ID, executable script, secret value, or unrequested page
data. `errorCode` is a stable non-localized code when status is not `succeeded`.

`attention-required` is the one status whose code the user is shown as a cause, so its codes are a
closed vocabulary (`ATTENTION_REQUIRED_CAUSES`, added by 002/FR-024 and FR-025): `document-changed`,
`focus-lost`, `target-not-visible`, `not-moved`, `execute-uncertain`, and `grant-revoked`. A result
whose status is `attention-required` and whose `errorCode` is anything else is refused by the schema.
Every other status keeps an open code: the worker's own refusal and failure codes travel on the same
field and are not this vocabulary.

### `client.stop`

```json
{
  "clientRequestId": "opaque idempotency key",
  "reason": "user-stop"
}
```

`reason` is `user-stop`, `panel-disconnect`, `lifecycle-interruption`, or `logout`. Sending this frame is
best effort after the Extension has already revoked the local control lease and blocked new actions.
The same four reasons are accepted by `POST /v1/tasks/{taskId}/cancel`, and whichever one the caller
gave becomes the `reasonCode` of the resulting `server.terminal` `cancellation` frame - a logout that
reported itself as a user stop would describe something the user never did.

### `client.heartbeat`

```json
{ "observedServerSequence": 12 }
```

The service worker sends a heartbeat every 20 seconds while a task is active. This is a lifecycle
mechanism, not a product latency SLA. It contains no page, account, prompt, or action data.

## Service-to-client messages

### `server.accepted`

```json
{
  "leaseId": "opaque lease identifier",
  "leaseExpiresAt": "2026-08-24T00:00:00Z",
  "capabilityProfile": "hallpass-v1"
}
```

The echoed `capabilityProfile` MUST exactly match the accepted `client.hello`; mismatch or omission
closes the task before any progress, Plan, capability request, or protected work.

The lease has a server-configured finite duration. Expiry or missed-heartbeat handling fails closed and
cannot authorize reconnection or replay.

### `server.progress`

```json
{
  "textDelta": "bounded user-visible progressive output"
}
```

Progress is advisory output, not executable instruction or proof of success. It cannot change consent,
the plan, or the browsing context. Bounds are configuration values exercised with test-injected limits;
the specification authorizes no production number.

### `server.plan-proposed`

```json
{
  "planId": "opaque plan identifier",
  "planVersion": 1,
  "revisionOf": null,
  "summary": "localized or user-readable summary",
  "steps": [
    {
      "stepId": "opaque step identifier",
      "position": 1,
      "bindingState": "exact",
      "capability": "browser.click",
      "purpose": "why this step is needed",
      "dataCategories": ["page.target-metadata", "action.observable-result"],
      "expectedContext": {
        "contextHandle": "opaque Extension-issued context handle",
        "canonicalOrigin": "https://example.test"
      },
      "arguments": {
        "targetHandle": "opaque Extension-issued handle"
      }
    },
    {
      "stepId": "second opaque step identifier",
      "position": 2,
      "bindingState": "exact",
      "capability": "browser.scroll",
      "purpose": "why the second step is needed",
      "dataCategories": ["action.observable-result"],
      "expectedContext": {
        "contextHandle": "opaque Extension-issued context handle",
        "canonicalOrigin": "https://example.test"
      },
      "arguments": {
        "mode": "viewport",
        "direction": "down",
        "magnitude": "small"
      }
    }
  ]
}
```

An initial Plan has `revisionOf: null`, at least two steps — of which at least one is a browser effect,
the rest being effects or the waits 002/FR-027 added — and unique contiguous absolute
`position` values starting at 1. A plan that includes an unknown, deferred, high-risk, parallel,
multi-tab, cross-origin-navigation, file-upload, arbitrary-code, or otherwise disallowed capability is
rejected and cannot be approved. A Plan is mandatory for any task with more than one step (two or more
steps, at least one of them a browser effect - a wait may be the other); a one-step initial Plan is
invalid and cannot replace the `single-action` path.

A step's `capability` is one of the seven actions or `page.wait` (002/FR-027) — the one control
instruction a Plan may carry, and the only non-action capability expressible as a step; `page.read`
and `page.resolve` are never steps. A wait step's `arguments` are checked here against the same closed
shape the later dispatch will refuse, so a Plan cannot be approved on the strength of arguments that
cannot run. A Plan of nothing but waits is refused: it would be reviewed and approved as work on the
page, hold the run until its last bound, and perform none of it, so at least one step must be an
action.

Each step is one closed discriminator:

- `bindingState: exact` requires `purpose`, `expectedContext`, exact `dataCategories`, and the complete
  capability-specific `arguments`. `sameOriginConstraint`, `argumentIntent`, and every other
  pending/deferred branch field are invalid in the POC schema.

Absent/unknown `bindingState`, fields from the wrong branch, or an empty step array fail schema
validation; absence never means `exact`.

Every executable action Plan step contains the same bounded `purpose`, closed `expectedContext`,
`dataCategories`, and capability-specific `arguments` that a later capability request must reproduce.
Before projection, the worker resolves each handle against the current authorized snapshot, derives
local target/action/text summaries, validates local risk/sensitivity, and computes a
canonical `planDigest` including the validated purpose value. The UI shows those exact bindings; it
never treats remote summary/purpose or `stepId` alone as authority. If
targets on the current document are not yet available, the server first requests an authorized page
read and proposes the Plan afterward.

POC Plans are exact, fully reviewable, and bound to one current document. Before any action from a Plan
has dispatched, the service may propose a strictly newer full exact version whose `revisionOf` names the
current worker-held plan ID and whose `planVersion` is strictly greater; accepting it for review revokes
the earlier approval immediately, so no step of the replaced Plan dispatches while its replacement is on
screen, and the user must decide again. A proposal that cites nothing, cites a different plan, or is not
strictly newer is refused; so is one that arrives while another review is open, one bound to a context
this worker did not mint, and one in a task that has already committed a browser effect. The worker
never projects a refused proposal and answers it with a `denied` `client.plan-decision`, so the task
cannot stall behind a Plan that will never run. After the first action dispatch, the Plan is immutable
through terminal outcome and every later `server.plan-proposed` is refused the same way. Any top-level
document change invalidates the entire Plan and all action grants and is not repairable inside the same
task: the expired Plan accepts no replacement and the task can start no free-standing action either.
Later protected work after a user- or page-initiated change requires a new task with a fresh probe,
applicable safety and consent, and a new Plan with a new `planId`; no completed prefix or earlier effect
can be cited, resumed, or replayed.

### Lease and heartbeat

`server.accepted` grants a lease whose `leaseExpiresAt` is the deadline the service actually enforces.
The client sends `client.heartbeat` every heartbeat interval with the highest server sequence it has
observed; the service answers `server.heartbeat` with the observed client sequence. Every valid frame
in either direction renews that side's deadline. A service that receives no valid client frame for a
whole lease ends the task with one `server.terminal` `cancellation` / `lifecycle-interruption`, aborts
the provider, and drops the task record; a client that receives no server frame for a whole lease ends
the task locally the same way. Neither side waits indefinitely, and neither replays anything after the
expiry. The two durations are deployment inputs, not protocol constants a peer may negotiate.

### `server.capability-request`

```json
{
  "requestId": "opaque request identifier",
  "executionBinding": {
    "mode": "approved-plan-step",
    "planId": "opaque plan identifier",
    "planVersion": 1,
    "stepId": "opaque approved step identifier"
  },
  "capability": "browser.click",
  "purpose": "why this operation is needed",
  "dataCategories": ["page.target-metadata", "action.observable-result"],
  "expectedContext": {
    "contextHandle": "opaque Extension-issued context handle",
    "canonicalOrigin": "https://example.test"
  },
  "arguments": {
    "targetHandle": "opaque Extension-issued handle"
  }
}
```

The closed `capability` enum is:

- `page.read`
- `browser.scroll`
- `browser.click`
- `browser.enter-text`
- `browser.key-press` (002/FR-024)
- `browser.hover` (002/FR-025)
- `browser.double-click` (002/FR-025)
- `browser.drag` (002/FR-025)
- `page.resolve` (002/FR-026)
- `page.wait` (002/FR-027)

The seven `browser.*` literals are the action set; `page.read` and `page.resolve` are reads, and
`page.wait` is a control instruction. A key press names one key from the closed set `Enter`, `Tab`,
`Escape`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `Backspace`, `Delete`
(`KEY_PRESS_KEYS`), with `Shift` as the only modifier and only with `Tab`; a key outside the set is
refused at this boundary and at the runtime one. A drag names two distinct endpoints, `targetHandle`
and `dropTargetHandle`. Secondary (context-menu) activation is not a member and is not expressible
under any name: the frame fails this enum, the client closes the channel on `invalid-frame`, and the
task halts as a lifecycle interruption before any handler runs.

`browser.navigate-same-origin` and every other assistant-initiated navigation literal are outside
`hallpass-v1`. They fail closed as unadvertised/unsupported capability values before Plan review, consent,
operation-marker creation, content dispatch, or browser effect; the worker projects the stable local
unsupported-capability outcome while terminalizing the invalid request. A later navigation profile may be introduced only after
the separately approved containment, data, permission, contract, and two-release-Chrome gates in
R-013; it is not silently enabled by a server upgrade.

`executionBinding` is exactly one of:

- `page-read`, with no plan/step identifier, for `page.read` and `page.resolve` only;
- `single-action`, with no plan/step identifier, for exactly one browser effect in the entire task; or
- `approved-plan-step`, with exact `planId`, `planVersion`, and next `stepId`, for every step of a
  multi-step Plan (two or more steps, at least one of them a browser effect; `page.wait` is
  expressible only here).

Accepting the first `single-action` request commits the task to that mode; any later browser-effect
request is denied. Every mode still requires a separate local current-task capability grant. A
`page.read` request containing `page.form-values` requires two distinct grants: the ordinary
page-read grant and a current-document form-values grant. A server cannot avoid Plan review by issuing
several `single-action` requests.

`page.resolve` (002/FR-026) is a read, not an action: it takes the `page-read` binding, requires
`expectedContext` naming the document it is asked about, carries `arguments: { "description": string }`
bounded like a label, and names exactly `["page.target-metadata"]` and nothing else. It is admitted
only while the task holds an active general page-read grant — the consent the user already gave for
reading this page covers it, so it opens no consent card of its own; without that grant it is
`denied` / `consent-required`, and against a document this worker never bound it is `stale-context`.
A selector, an expression, or a URL has no field in `arguments` and is not expressible.

`page.wait` (002/FR-027) is a control instruction, not an action: it is expressible only as a step of
an approved plan, so `executionBinding.mode` must be `approved-plan-step` — a lone wait and a wait
asked for as a read are both refused by this schema. It requires `expectedContext`, names exactly
`["page.target-metadata"]`, and carries the closed triple
`arguments: { "targetHandle": string, "condition": one of "present" | "absent" | "enabled" | "visible-text-changed", "maxWaitMs": positive integer }`.
The conditions are `WAIT_CONDITIONS`, each decidable by the content runtime against one element it
already holds the handle for; a selector, an expression, a URL, and a network condition are
deliberately not members and are not expressible. `maxWaitMs` is required, positive, and at most the
injected wait bound: a wait performs no effect, but an unbounded one is a task that never reaches a
terminal. A wait carries no risk label and is never separately consented, because it performs no
effect; it is admitted through the same plan-step gate an action uses and under the task's active
general page-read grant. A plan of nothing but waits is invalid: an approved plan contains at least
one action step.

The task's explicit capability mode starts `undecided`. It becomes `page-read-only` on the first
accepted `page.read`, `single-action` on the first accepted unplanned browser effect, or
`approved-plan` when a valid multi-effect Plan is accepted for review. A success terminal received while
still undecided commits the terminal task to `answer-only`; that is valid only when no capability request
or Plan was ever received. Page-read-only may transition to either action mode, but single-action and
approved-plan never transition into each other. A later authorized `page.read` may occur in either
action mode without changing it. Terminal state rejects every later capability or Plan frame.

Task bootstrap sends `user.request` but no origin, tab, URL, title, page content, context handle, or
target. Therefore the first `page.read` request MUST use `executionBinding.mode = page-read`, omit
`expectedContext`, and use no target handle. The service worker resolves the current context locally,
runs safety disclosure/assessment and ordinary page-read consent. If `page.form-values` is
requested, the worker separately discloses and decides that current-document category; general page
reading may proceed without it and returns zero form values/selected-option state. A successful result
may return a fresh opaque `contextHandle` and canonical origin. Every later browser action MUST
echo that authorized context handle/origin. A service-provided wildcard or guessed context is invalid.

### `server.capability-request-sequence`

```json
{
  "sequenceId": "opaque sequence identifier",
  "requests": [
    {
      "requestId": "opaque request identifier",
      "executionBinding": {
        "mode": "approved-plan-step",
        "planId": "opaque plan identifier",
        "planVersion": 1,
        "stepId": "first kept step"
      },
      "capability": "browser.click",
      "purpose": "why this operation is needed",
      "dataCategories": ["page.target-metadata", "action.observable-result"],
      "expectedContext": {
        "contextHandle": "opaque Extension-issued context handle",
        "canonicalOrigin": "https://example.test"
      },
      "arguments": { "targetHandle": "opaque Extension-issued handle" }
    }
  ]
}
```

Added by 002/FR-022: one frame may carry an ordered sequence of capability requests instead of exactly
one, so an approved plan runs without a round trip per step. Each element of `requests` is exactly the
`server.capability-request` payload above; nothing about `server.capability-request` changes, and a
service that never sends a sequence is unaffected.

A sequence is a transport grouping, never a bulk effect. Every request in it is admitted, revalidated,
fenced, marked, dispatched, and verified individually, exactly as a lone request is. The requests
execute in the order given, **one at a time**; concurrency is not expressible in this shape.

Sequential execution exists only for an approved Plan, so the schema requires every request to bind to
an `approved-plan-step`, every one of them to cite the same `planId` and `planVersion`, and no `stepId`
or `requestId` to repeat. What the schema cannot see — that the plan is the one the user approved, that
the steps are the next kept ones in order, and that none of them was excluded — the worker checks
against the plan it holds, refusing the whole sequence before any step runs. A sequence refused whole
is answered whole: every position receives the same refusal, so silence is never mistaken for a run in
progress.

The first request that cannot be admitted, or whose effect cannot be verified, ends the sequence: later
requests are never prepared, and the service learns the sequence ended from that request's own result —
the first result that is not `succeeded` — and MUST NOT expect a result for any later position. Results
are correlated by `requestId`, never by arrival order. While a sequence is executing, no other request
is accepted: a lone request or a second sequence arriving from outside the run while a step is in
flight is refused `run-in-progress` rather than admitted as the run's next step.

`requests` carries at least one element and at most the injected `maxRequestSequenceLength`, which may
not exceed the plan bound: a sequence longer than any plan could only describe work the user never saw.
The frame is a new closed member and `protocolVersion` is unchanged, so an extension from before this
feature closes the channel on `invalid-frame` when it receives one — fail-closed, and acceptable only
because both deployables ship together.

## Canonical data categories and capability shapes

The task boundary uses this closed, non-localized `DataCategory` enum. UI labels/descriptions come only
from reviewed Extension dictionaries; an unknown category, remote-authored category label, duplicated
category, or category not allowed for the capability fails closed.

- `user.request`
- `page.canonical-origin`
- `page.title`
- `page.visible-text`
- `page.structure`
- `page.selection`
- `page.target-metadata`
- `page.form-values`
- `action.text-input`
- `action.observable-result`

`user.request` is transmitted only by the explicit task submit in `POST /v1/tasks`.
`page.canonical-origin` is the only category permitted at the origin-safety endpoint and its disclosure
precedes that request. Capability-request `dataCategories` must be unique and exactly cover every
user-supplied, page-derived, target, and observable-effect argument/result item according
to the corresponding row.

Bounded non-content protocol metadata is not a `DataCategory`: envelope/plan/request identifiers and
sequence, opaque context bindings, closed status/reason/error codes, and schema-defined support,
truncation, or lifecycle flags. Such metadata never substitutes for category disclosure or consent,
cannot carry user/page/action content, and is accepted only in its closed schema. Effect facts such as
document change, target visibility, and character count remain `action.observable-result`; canonical
origin remains `page.canonical-origin`.

`page.selection` means only the current text selection in the supported top-level ordinary DOM (empty
when none). It does not adopt file/image/screenshot/region/element selection, upload, attachment UI, or
any PR-009 capability.

`page.form-values` means only bounded task-relevant ordinary current values and select
selected-option display state that the Extension's closed local policy conclusively classifies
non-sensitive. It is not authorized by any other page category and requires its own
current-task/current-document grant. Password, hidden/file, one-time-code, payment-card,
sensitive-autocomplete, product-credential, ambiguous values, checkbox/radio checked state, and all
value length/hash/partial representations are outside `hallpass-v1`.

| Capability | Required/allowed `dataCategories` | Closed `arguments` shape | Successful bounded result shape |
| --- | --- | --- | --- |
| `page.read` | Requires `page.canonical-origin`; may additionally request `page.title`, `page.visible-text`, `page.structure`, `page.selection`, `page.target-metadata`, `page.form-values`. The last category requires a second distinct document-bound grant. | `{ "scope": "current-top-document" }`; no expected context/target | New `contextHandle`, canonical origin, only requested and granted snapshot fields/targets; optional bounded allowed ordinary form values/select selected-option state plus non-value withholding/access metadata; truncation and unsupported/inaccessible disclosures |
| `browser.scroll` | Requires `action.observable-result`; target mode also requires `page.target-metadata` | Either `{ "mode": "target", "targetHandle": string }` or `{ "mode": "viewport", "direction": "up" or "down", "magnitude": "small" or "medium" or "large" }` | `{ "contextHandle", "effect": "scrolled", "scrollTop": number, "targetVisibility": "visible" or "not-visible" or "not-applicable" }`; viewport mode reports `not-applicable` |
| `browser.click` | Exactly `page.target-metadata`, `action.observable-result` | `{ "targetHandle": string }` | `{ "contextHandle", "effect": "activated", "clicks": positive integer, "documentChanged": false }` |
| `browser.enter-text` | Exactly `page.target-metadata`, `action.text-input`, `action.observable-result` | `{ "targetHandle": string, "text": string, "editMode": "insert" or "replace" }` | `{ "contextHandle", "effect": "text-entered", "charactersChanged": non-negative integer, "valueEchoed": false, "documentChanged": false }` |
| `browser.key-press` | Exactly `page.target-metadata`, `action.observable-result` — the key comes from a closed protocol set, so no user-supplied text crosses with it | `{ "targetHandle": string, "key": one of the eleven named keys, "modifiers": ["Shift"] optional, only with Tab }` | `{ "contextHandle", "effect": "key-pressed", "key", "focusRetained": true, "valueEchoed": false, "documentChanged": false }` |
| `browser.hover` | Exactly `page.target-metadata`, `action.observable-result` | `{ "targetHandle": string }` | `{ "contextHandle", "effect": "hovered", "targetVisible": true, "documentChanged": false }` |
| `browser.double-click` | Exactly `page.target-metadata`, `action.observable-result` | `{ "targetHandle": string }` | `{ "contextHandle", "effect": "double-activated", "clicks": integer at least 2, "documentChanged": false }` |
| `browser.drag` | Exactly `page.target-metadata`, `action.observable-result` | `{ "targetHandle": string, "dropTargetHandle": string }`, the two distinct | `{ "contextHandle", "effect": "dragged", "moved": true, "documentChanged": false }` |
| `page.resolve` | Exactly `page.target-metadata` | `{ "description": string }`, bounded like a label; `page-read` binding with `expectedContext` | `{ "contextHandle", "outcome": "resolved", "candidates": [ { "targetHandle", "role", "label" optional, "kind" } ] }` with one to the injected candidate bound, or `{ "contextHandle", "outcome": "no-match" }`, or `{ "contextHandle", "outcome": "too-broad" }` |
| `page.wait` | Exactly `page.target-metadata` | `{ "targetHandle": string, "condition": one of the four wait conditions, "maxWaitMs": positive integer at most the injected wait bound }`; `approved-plan-step` binding only | `{ "contextHandle", "outcome": "condition-met", "condition", "waitedMs": non-negative integer }` |

`result` is a closed union: exactly one of the succeeded shapes above, or the empty object `{}`
for every non-success status. `documentChanged` and `valueEchoed` are literal `false` on a succeeded
result, and `focusRetained`, `targetVisible` and `moved` are literal `true`; they exist to make the
verified state explicit on the wire. An action is
transmitted as `succeeded` only after the Extension's post-effect verification: the content runtime
saw no synchronous URL change, the leased tab reported no new top-level document during a bounded
settle window, and a re-probe of the already-bound runtime returned the same document epoch and
origin — and, for the capabilities whose evidence says so, the focused element kept its identity, the
hovered target is still shown, and the dragged element moved relative to the drop target. Any other
observation yields `attention-required` with an empty `result` and one cause from the closed
`ATTENTION_REQUIRED_CAUSES` set: `document-changed` when the document was replaced or navigated,
`focus-lost` for a key whose target lost focus, `target-not-visible` for a hovered target no longer
shown, `not-moved` for a drag the page ignored, `execute-uncertain` when the executor threw after the
effect may have begun and nothing observed it either way, and `grant-revoked` when the effect ran and
was observed but its covering grant was withdrawn before the result was submitted. Only
`document-changed` invalidates the bindings and expires the Plan; the others leave the document and
its handles standing and put the attribution of that one effect in doubt. The service must not treat
any of them as success.

A resolution answers with exactly one of the three outcomes: past the candidate bound the answer is
`too-broad` with no list at all — never a truncated one and never a silent choice — and each candidate
carries only `targetHandle`, `role` from the closed target-role set, an optional bounded `label`, and
`kind`. No form value, selector, attribute, or element text appears on a candidate under any input. A
wait's `condition-met` is its only succeeded shape: a bound reached, a Stop, and a document change are
statuses with an error code, not results, and nothing the wait observed travels on it — the runtime's
answer is a boolean the worker never sends on. `waitResultSchema` joins the top-level result union and
deliberately not the action union: a wait is not an action and has no `effect`.

All strings/arrays/returned nodes use service-worker-injected configuration bounds; this contract does
not invent a production numeric limit. Without the distinct form-values grant, page reads return zero
form values and zero selected-option state. With it, only the `page.form-values` shape above may
cross the channel; sensitive/ambiguous fields contain non-value withholding metadata only. Form-value
data is absent from storage, logs, telemetry, errors, and durable history. Text-entry result never
echoes the entered or resulting value. An argument/result field outside its discriminated closed shape
is invalid.

For an approved Plan step, the later request's normalized context, capability, purpose, target,
arguments, and category set must equal the reviewed step binding and stored digest. For a single action, the current
request itself is projected with a locally computed binding digest and must receive exact consent before
dispatch. No category-bearing response field outside the granted categories is returned; any category
expansion requires new single-action consent or a new Plan version. Unknown or content-bearing protocol
metadata is rejected by the closed result schema.

`browser.click` eligibility is decided before the effect. Anchors, link-like targets, form-associated
submit/reset controls, file inputs, controls with any URL/form action, and controls whose script-driven
activation may navigate or cannot be classified as low-risk and non-navigation are denied. Post-effect
context validation remains mandatory but cannot be used as permission to discover a navigation or
high-risk effect after it occurred. The same classification decides `browser.hover` and
`browser.double-click`, and both endpoints of a `browser.drag` — the stricter of the two deciding.
`browser.key-press` adds a submission guard: the confirmation key is refused wherever its default
effect on the focused element would submit a form or navigate. A refusal the content runtime decides
from policy at effect time — the submission guard, a key outside the set, a target the read policy
withholds — is transmitted as `denied` naming that guard, never as `failed`, which would invite a
retry, and never as `unsupported`, which would say the capability is absent from the profile.

The server may name only an opaque target handle previously returned in a bounded page result for this
task/document epoch. It cannot send CSS/XPath selectors, raw Chrome identifiers, JavaScript, page-world
code, a URL outside the currently approved origin, or vendor tool payloads. `browser.enter-text` carries
the bounded text to enter but never targets a field classified as sensitive. Each step permits at most
one outstanding capability request, or one request sequence
(`server.capability-request-sequence`); within a sequence exactly one step is outstanding at a time,
and a request arriving from outside the run while one is in flight is refused `run-in-progress`.

### `server.heartbeat`

```json
{ "observedClientSequence": 9 }
```

### `server.terminal`

```json
{
  "outcome": "success",
  "reasonCode": "task.completed",
  "summary": "bounded user-visible final summary"
}
```

`outcome` is exactly one of `success`, `denial`, `cancellation`, `attention-required`, or `failure`.
For a `cancellation` the `reasonCode` is the reason the cancelling caller gave: `user-stop`,
`panel-disconnect`, `lifecycle-interruption`, or `logout`.
`reasonCode` is an open vocabulary but a bounded one: at most `REASON_CODE_MAX_CHARS` (80) characters
matching `REASON_CODE_PATTERN` (`^[a-z][a-z0-9.-]*$`). It is a code, never free text — the panel keys
reviewed copy off it and exposes it in the DOM — so a sentence, an HTTP status line, or a forwarded
`Error.message` is refused at the frame rather than displayed as if it were a code.
This is the only remote terminal frame. The Extension records one in-memory terminal transition and
ignores later frames. A remote success is accepted only under exactly one explicit task mode:

- `answer-only`: no capability request or Plan was ever received and no local failure/interruption exists;
- `page-read-only`: every requested page read completed with verified `succeeded`;
- `single-action`: every requested page read and the one committed unplanned effect completed with
  verified `succeeded`; or
- `approved-plan`: every requested page read and every required step of the exact approved Plan was
  observed with verified `succeeded`.

Any denied, inaccessible, unsupported, `stale-context`, cancelled, uncertain, attention-required, or
failed required operation prevents a success terminal transition. An empty/nonmatching Plan cannot make
success vacuously true, and `answer-only` cannot be selected after any capability/Plan frame.

For a task that ran an approved Plan, the remote frame is not the record of how far the run got. The
worker projects that itself, from the results it verified, on `worker.task.terminal.run`
(`extension-runtime.md`): how many kept steps the Plan had, how many it saw run, the reviewed position
of the first kept step that did not run, and — when it knows — why the run stopped, from the closed
`RUN_STOP_REASONS` vocabulary (002/FR-022): `completed`, `step-not-admitted`, `step-failed`,
`effect-unverified`, `user-stopped`, `document-changed`, and `wait-bound-reached`. `completed` is the
only reason a run may end with every kept step observed; each of the others names the first thing that
stopped it, and a record keeps only the first. `wait-bound-reached` is the reason a `page.wait` step
produces when it reaches its bound with the condition still unmet — distinct from `step-failed`
because nothing failed: the page simply never reached the state the Plan was waiting for. Only a step
already committed to dispatch ends a run for good and records a reason; a refusal before dispatch
leaves the Plan where it was, so the terminal says where the run got to without inventing a cause. An
expired Plan is the exception — it can never continue, whichever step noticed. That decision also ends
the Plan for admission: every later request or sequence for it, including a continuation from the next
kept step, is refused `plan.run-ended`, so a service cannot run past the stop the user was shown. The
`reasonCode` a service sends on `server.terminal` is a separate, open code and never a member of this
closed set.

## Authorization and execution rules

For every `server.capability-request` — and, unchanged, for every request inside a
`server.capability-request-sequence`, individually and in order — the service worker MUST, immediately
before dispatch:

1. confirm the task and channel are active and not stopped or terminal;
2. confirm the product session, account binding, and runtime epoch;
3. resolve the current selected tab locally and confirm it is the leased top-level context;
4. recompute the canonical origin and require an unexpired `allow` safety decision;
5. require a current-task grant covering the capability, exact validated purpose digest, data
   categories, and origin; if `page.form-values` is requested, additionally require its distinct
   current-document grant and never infer it from ordinary page-read consent;
6. branch on capability: `page.read` requires `executionBinding = page-read`, a valid exact page-read
   grant, and an undecided/page-read-only task or an existing action mode that the read does not change;
   `page.resolve` requires the same binding and the task's active general page-read grant, and opens no
   card of its own; `page.wait` requires the exact next approved plan/version/step and that same
   general page-read grant, and creates no action grant, no marker, and no risk classification;
   a browser effect instead requires either the exact next approved plan/version/step or an unused
   `single-action` execution slot;
7. confirm strictly sequential execution and no outstanding operation;
8. resolve and revalidate the opaque target in the current top-level document when applicable;
9. for an effect, write `prepared`, then persist and confirm the write-ahead `dispatched` marker; if
   marker persistence fails, make no effect call;
10. after every awaited prerequisite—including marker persistence or page probe—recheck task/channel
    nonterminal state, Stop/control lease, exact grant, selected tab, document/origin, and target under
    the worker dispatch fence immediately before initiating `content.collect-page` or the effect call;
    any intervening Stop/revoke/context change wins and starts no protected content call; and
11. return one observable result and move an effect marker to `observed`, or to `uncertain` when a begun
    effect cannot be conclusively observed.

Any failed or ambiguous check returns a non-success result and starts no effect. Page/model/service data
is untrusted input and never changes these checks. Before transmitting a collected page/result, the
worker rechecks task/channel/Stop, every applicable grant—including the distinct form-values
grant—selected tab, document, and origin once more after the last awaited prerequisite and drops the
payload if any binding was invalidated.

## Ordering, idempotency, and interruption

- `messageId`, `decisionId`, `clientRequestId`, `requestId`, and `operationId` are opaque and
  task-scoped, and a `messageId` is used once per sender per task. Because `sequence` is contiguous
  and strictly increasing, a resend is not a legitimate frame in the first place: a repeated
  `messageId` is a protocol violation, handled as above. The remaining identifiers are what make a
  decision idempotent - a repeated `decisionId`, `clientRequestId`, `requestId` or `operationId`
  retains the prior outcome and never repeats an action.
- A capability request can bind to only one operation marker. The marker changes from `prepared` to
  `dispatched` to `observed`, or to `uncertain` if interruption occurs after dispatch but before a
  conclusive result. `dispatched` is a write-ahead risk boundary persisted before the content call: it
  means the effect may occur, not that occurrence or success was observed.
- On a new worker epoch, prior `prepared` maps to cancellation/`lifecycle-interruption`, prior
  `dispatched` or `uncertain` maps to attention-required, and prior `observed` without its non-durable
  exact result maps to failure/`lifecycle-interruption`. None resumes, replays, or becomes success. The
  marker remains until the matching terminal/interruption projection reaches an accepted panel Port or
  finite expiry permits cleanup.
- On `uncertain`, restart, service-worker epoch change, channel loss, lease expiry, malformed traffic,
  or panel disconnect, the worker terminalizes/Stops and starts no further action. An effect is never
  guessed, retried, or reported as successful.
- An unexpected/unconfirmed document change during an attempted action is never action success. It
  invalidates old context/target/action grants and the entire Plan, starts no later action, and yields a
  non-success or attention-required result according to effect certainty.
- A user- or page-initiated document change while the task remains otherwise eligible is a compatibility
  event, not assistant navigation authority. Later protected work requires the applicable fresh
  invocation, safety/consent, context probe, and a new exact Plan with a new ID; old Plan steps and
  results cannot resume or replay. Every form-value snapshot and `page.form-values` grant expires
  on reload, SPA/document change, or origin change even when a general same-origin page-read grant may
  otherwise remain valid.
- The server maintains a short in-memory lease and terminalizes abandoned tasks. It performs no
  unbounded retry and stores no task history after transient cleanup.
- Stop is local first: revoke the local task/grant/control lease, cancel queued content operations, mark
  an in-flight indeterminate effect `uncertain`, update the UI, then send `client.stop` and/or the HTTPS
  cancellation fallback on a best-effort basis.

## Privacy and retention

Only data declared for the approved active task may traverse the channel. Credentials, PKCE material,
passwords, hidden/file values, one-time codes, payment-card values, sensitive-autocomplete values,
product credentials, ambiguous form values and their length/partial content, unrestricted DOM,
browser-history data, raw Extension storage, and unrelated account metadata are prohibited. Logs and
diagnostics are limited to stable
codes and coarse operational state; they exclude prompt, output, URL, origin, title, page content,
targets, arguments, action results, credentials, account identifiers, task/message/request/operation
IDs, channel URLs, and connection tickets. Product-service, reverse-proxy, CDN, and WebSocket access logs
must disable or redact Authorization, cookies, request/response bodies, raw URL paths containing task
IDs, query strings, Origin values, upgrade tickets, and correlation identifiers before persistence.
The POC persists no operational log, counter, or metric: coarse state/stable codes exist only in active
process/UI memory and isolated test captures. Any later persistent aggregate, processor, sampling, or
retention requires the unresolved Q-015 observability decision. Task/channel records are memory-only and
removed after terminal cleanup.
