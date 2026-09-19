# Feature Specification: Chrome AI Browser Assistant

**Feature Branch**: `001-ai-browser-assistant` (logical feature identifier; this workspace has no Git metadata)

**Feature Directory**: `specs/001-ai-browser-assistant`

**Created**: 2026-08-24

**Status**: Approved POC specification; assistant-initiated navigation deferred and planning may proceed

**Input**: Formalize the Chrome AI Browser Assistant Product Requirements with clean-room traceability,
observable acceptance behavior, and explicit unresolved product decisions.

**Authoritative Source Order**: Constitution → `docs/product-requirements-draft.md` → documented
reference analysis and feature matrix.

## Clarifications

### Session 2026-08-24

- Q: Which capabilities belong in the first release? → A: The first release is a proof of concept
  containing only the seven MUST requirements; all SHOULD, COULD, and NEEDS-CLARIFICATION candidates
  are deferred, and F-016/F-017 remain REFERENCE-ONLY.
- Q: Where should AI provider integration and task orchestration run? → A: A product-controlled server
  owns AI provider integration and task/tool orchestration; the Extension mediates browser context,
  user consent, and browser action execution. The exact provider, protocol, and identity provider remain
  unresolved.
- Q: How should users authenticate? → A: The POC uses account-based product authorization only. The
  Extension MUST NOT accept or store user-supplied direct AI-service credentials; the exact identity
  provider and product-session token representation remain unresolved.
- Q: What should the POC persist, and how may storage evolve later? → A: Core task, page-context, and
  action data are transient and create no durable remote history. Only minimum session/security state
  and separately approved local state may persist; logout clears authorization and account-bound local
  state. Every later adopted capability requires an approved category-specific data matrix, and the
  product MUST NOT silently migrate or upload legacy local data.
- Q: Which browser actions and consent boundary belong in the POC? → A: The POC controls only the
  current tab and supports scrolling, non-navigation low-risk clicking, and non-sensitive text entry.
  Assistant-initiated full-document, link, form, script-driven, and other navigation effects are
  deferred. User- or page-initiated navigation remains a supported context change: it invalidates stale
  bindings and requires safety/consent re-evaluation before later protected work. A multi-step task
  requires an approved visible plan and sequential execution. Consent is limited to the current task;
  an origin change requires fresh consent. Batch or multi-tab execution, webpage file upload,
  irreversible high-risk actions, persistent grants, and bypass are excluded; later actions—including
  assistant navigation—require an approved action-policy matrix and release evidence.
- Q: How should the POC decide URL and cross-origin safety? → A: Local rules decide allow, deny, or
  unknown first. Only an unknown canonical origin—scheme, host, and effective port—may be sent to a
  product-controlled safety service; username/password, path, query, fragment, referrer, title, and page
  content MUST NOT be sent for classification. Remote deny, unknown, invalid, or unavailable results
  fail closed. An allow result is not consent, classification data remains transient, and no reference
  provider, endpoint, protocol, category scheme, or full-URL behavior is inherited.
- Q: Which Chrome versions and page contexts does the POC support? → A: At release, the POC supports
  the then-current and immediately preceding stable desktop Chrome major releases. Page reading and
  action support is limited to the current selected tab's ordinary top-level HTTP(S) HTML document,
  including revalidation after user- or page-initiated document navigation, reload, and same-origin
  single-page-application updates. This compatibility does not authorize assistant-initiated
  navigation in the POC. Content or
  targets available only through an iframe, Shadow DOM, PDF, Chrome internal, extension-origin, or Web
  Store page, file/data/blob URL, incognito context, or canvas/WebGL-only surface are outside the support
  contract and MUST produce an explicit unsupported-context result rather than attempted bypass.
- Q: Which launch locales, fallback, and localized surfaces does the POC require? → A: The POC supports
  `en-US` English and `zh-TW` Traditional Chinese across every adopted user-facing surface, with reviewed
  English as the fallback. Missing, invalid, or incomplete locale data MUST NOT expose an internal
  identifier or make safety text ambiguous. A full language-settings feature remains deferred, while
  future releases may add independently reviewed locales through the same complete-surface coverage and
  regression contract; no Reference Extension translation or locale resource is inherited by presence.
- Q: What accessibility and safety-state comprehension gate must the POC pass? → A: One designated
  product owner is the sole POC evaluator. On Windows 11, that evaluator MUST pass every declared
  keyboard-only and current-stable-NVDA acceptance step in both `en-US` and `zh-TW` on the then-current
  and immediately preceding stable desktop Chrome majors, and correctly explain the page/service,
  requested action or data category, allow/deny outcome, and running/stopped/failed state in every
  declared comprehension scenario. This is a POC owner-acceptance gate, not representative multi-user
  usability or accessibility evidence.
- Q: How should POC page reading expose current form data while preserving a path toward Reference
  Extension parity? → A: Use controlled parity. General page reading exposes no current form value by
  default. A task may receive bounded, task-relevant ordinary values and selected-option state only
  through a separately disclosed `page.form-values` category and a current-task/current-document grant.
  A closed local policy must classify each disclosed item as non-sensitive; password, hidden/file, OTP,
  payment-card, sensitive-autocomplete, product-credential, and ambiguous fields reveal no value,
  length, or partial content. Form-value data is transient, and reload, SPA/document change, origin
  change, Stop, revocation, or terminal state invalidates its snapshot/grant. Later profiles may expand
  toward confirmed Reference Extension behavior only through a new approved data/consent matrix.

### Session 2026-08-28

- Q: Who starts the local POC service during manual acceptance? → A: The tester starts it manually;
  the Extension may show the exact local startup instruction but does not launch or continuously poll it.
- Q: When and how does the side panel learn service availability? → A: Opening the side panel immediately
  starts one service check. An unavailable service produces startup guidance and one user-triggered retry;
  it never leaves the user in an authorization state or starts protected work.
- Q: How long may service-health and authorization HTTP operations remain pending? → A: Each operation
  has a five-second upper bound and then reaches a localized, understandable, recoverable state.
- Q: What workspace model and visual direction should the POC use? → A: A Chrome-native-feeling,
  bilingual single-task workspace with no chat history. Empty, running, review, and terminal task states
  are mutually understandable views of that one task.

### Session 2026-08-29

- Q: How does the POC obtain Chrome 142+ Local Network Access when a service-worker request cannot
  present the browser permission prompt? → A: Only after an explicit user recovery gesture, the visible
  side panel may issue one purpose-limited `GET /health` solely to trigger the browser permission
  decision. It discards the response and then requests one authoritative worker retry; it never uses
  this exception for authorization, session, task, page, or WebSocket traffic and never polls.

### Session 2026-08-30

- Q: What evidence is required before a P1 browser capability may be reported complete? → A: Unit,
  component, pure-domain, source-module, and transport-only checks are supporting evidence only. A P1
  page-read or browser-action capability is complete only after the packaged unpacked Extension executes
  its real MV3 worker, on-demand content runtime, side panel, deterministic service, and observable page
  effect in an automated Chromium journey.
- Q: When may the product owner resume the two-Chrome accessibility and locale acceptance matrix? → A:
  Freeze UI polish and T093 while a packaged core journey is red or skipped. Every build must first pass
  the automated Playwright Chromium gate; only then run one consolidated current/previous branded Chrome
  owner acceptance pass.

## User Scenarios & Testing *(mandatory)*

Each story is an independently valuable product increment. Its Independent Test supplies shared platform,
session, or page preconditions as controlled fixtures, so the story's user outcome can be demonstrated
without implementing another candidate story. The three P1 stories form separable core slices: session
entry, page understanding, and controlled action.

### User Story US-001 — Start an Authorized Assistant Session (Priority: P1)

As an assisted-browsing user, I can explicitly open an assistant associated with my current browsing
context and establish or restore an authorized service session, so I can begin work without abandoning
the page or accidentally sharing its contents.

**Why this priority**: Activation and authorization are the entry gate for every core assistant outcome.

**Independent Test**: On a supported page, activate the product with both valid and expired test
sessions. Verify the visible workspace association, signed-in state, and reauthentication boundary
without permitting any page action.

**Traceability**: `PR-001 → US-001 → FR-001`; `PR-002 → US-001 → FR-002`.

**Acceptance Scenarios**:

1. **Given** the user is viewing a supported webpage and the Extension is enabled, **When** the user
   activates the primary browser entry point, **Then** the assistant workspace visibly opens and is
   associated with the current browsing context without performing a browser action on the page.
2. **Given** the user has an expired or rejected service session, **When** the user submits a protected
   AI request, **Then** the product sends no unauthenticated browser task, clearly requests
   reauthentication, and resumes protected use only after successful authorization.
3. **Given** authorization is canceled or fails, **When** the authorization flow ends, **Then** the
   product returns to a usable signed-out state and does not claim an active session.
4. **Given** the workspace is already associated with a browsing context, **When** the user explicitly
   invokes an adopted focus or close operation, **Then** the product applies that requested visible state
   and does not perform a page action or misidentify the associated context.
5. **Given** the user is signed out or has a valid restorable session, **When** the user completes the
   approved authorization flow or returns to the product, **Then** the product establishes or restores
   the correct selected-service account and displays an accurate signed-in state.
6. **Given** an authorized session approaches expiry, **When** the product attempts the approved renewal
   behavior, **Then** it either renews the same account scope or requests reauthentication without
   silently switching account or organization.
7. **Given** the user has an authorized session, **When** the user logs out, **Then** protected requests
   and remote activity stop, the product shows signed out, clears authorization and account-bound local
   state, and leaves no Core task, page-context, or action data in durable remote history.
8. **Given** the local POC service is not running, **When** the user opens the side panel, **Then** the
   workspace checks availability immediately, does not show authorizing or permit protected work, and
   within five seconds shows the local service address, startup instruction, and a manual retry action.
9. **Given** the service was unavailable and the tester has started it, **When** the user invokes the
   localized recovery action once, **Then** the visible panel performs at most one bounded local-network
   permission bootstrap and sends exactly one retry to the worker; only the worker's subsequent
   successful availability projection continues to session restoration or sign-in without reopening.
10. **Given** an older availability or session-restoration operation finishes after a newer check,
    **When** its result arrives, **Then** it does not replace the state established by the newer operation.

---

### User Story US-002 — Ask About the Current Page (Priority: P1)

As an assisted-browsing user, I can submit a request and provide only explicitly allowed, bounded page
context, including separately approved non-sensitive form context when needed, so I receive progressive
output and a final answer without exposing sensitive, ambiguous, or unrelated browsing data.

**Why this priority**: Page understanding and a bounded conversation loop deliver the core product
value before browser control is introduced.

**Independent Test**: Provide an authorized test session and pages containing ordinary text, a bounded
non-sensitive ordinary form value, selected-option state, sensitive fields, and ambiguous fields under
locally allowed, locally denied, and locally unknown origins. For the unknown-origin fixture, return
remote allow, deny, unknown, and unavailable results. Verify separate `page.form-values` disclosure and
current-document consent, bounded allowed output, complete sensitive/ambiguous withholding, origin-only
classification, withheld page context before safety plus applicable consent, and explicit terminal states.

**Traceability**: `PR-003 → US-002 → FR-003`; `PR-004 → US-002 → FR-004`.

**Acceptance Scenarios**:

1. **Given** an authenticated user submits a request that can be completed without a browser action,
   **When** the selected AI service returns progressive content and a final response, **Then** the
   product displays progress, renders the final response, and leaves no task marked as still running.
2. **Given** a supported page contains ordinary text, an approved non-sensitive ordinary form value,
   selected-option state, and sensitive or ambiguous fields, **When** the user authorizes page reading
   and separately grants `page.form-values` for the current task and document, **Then** the task receives
   the bounded approved ordinary value and selected-option state, receives no sensitive or ambiguous
   value, length, or partial content, and sees any withholding, truncation, or access limitation.
3. **Given** current page content is empty or inaccessible, **When** the task requests that content,
   **Then** the product sends no invented content and reports an empty-content or access failure.
4. **Given** an approved capability returns an observable action result to the active task, **When** the
   task continues processing, **Then** the next output or final state reflects that observed result and
   does not claim an effect that the result failed to verify.
5. **Given** the local safety decision for the current origin is unknown, **When** the task requests page
   context, **Then** the product may send only the canonical origin to the product-controlled safety
   service, sends no path, query, fragment, referrer, title, or page content for classification, and
   collects or transmits no page context unless the result allows it and current-task consent exists.
6. **Given** ordinary form values or selected-option state exist on a supported page, **When** the user
   grants general page reading but does not grant `page.form-values`, **Then** the task may receive
   approved non-value structure but receives zero current form values or selected-option state.
7. **Given** the user is signed in with no current task, **When** the workspace is shown, **Then** it
   presents a clear empty single-task state and one available request composer without task history.
8. **Given** one task is running or waiting for safety, consent, capability, or Plan review, **When** the
   workspace updates, **Then** it presents exactly that active progress or review state, prevents a
   duplicate task submission, and shows only controls relevant to that state.
9. **Given** a task ends, **When** its final projection is shown, **Then** exactly one of success, denial,
   cancellation, attention required, or failure appears with an understandable reason and summary; no
   stale progress, empty grant section, inactive Stop control, raw JSON, or internal identifier remains.

---

### User Story US-003 — Delegate a Controlled Browser Task (Priority: P1)

As a browser-task user, I can approve a low-risk action or visible multi-step plan for my current tab,
see which page the assistant controls, and stop it immediately, so browser changes stay within the
current task, origin, action, and consent scope.

**Why this priority**: Controlled action is the principal differentiator of a browser assistant and its
largest user-safety boundary.

**Independent Test**: In the current test tab, exercise scrolling, a non-navigation low-risk click,
non-sensitive text entry, and one approved same-document multi-step plan. Deny one otherwise permitted
single-action request and verify zero dispatch plus an explicit continue-or-stop explanation. Attempt
assistant-initiated link/full-document navigation and verify explicit denial. Separately cause a user-
or page-initiated origin change while an action is pending under local allow, local deny, and local
unknown decisions; for unknown, return remote allow, deny, unknown, invalid, and unavailable results.
Attempt batch, multi-tab, webpage file upload, sensitive-field entry, an irreversible high-risk action,
a persistent grant, and bypass; then invoke Stop. Verify origin-only classification, sequential
execution, pre/post-change revalidation, zero dispatch for every non-allow safety outcome, fresh consent
after safety allow, visible control, explicit blocking reasons, and zero excluded effects.

**Traceability**: `PR-003 → US-003 → FR-003`; `PR-005 → US-003 → FR-005`;
`PR-007 → US-003 → FR-007`;
`PR-008 → US-003 → FR-008`.

**Acceptance Scenarios**:

1. **Given** the user approves scrolling, a non-navigation low-risk click, or non-sensitive text entry
   against a valid target in the current tab, **When** the page remains within the approved
   context, **Then** the product performs only that action, reports its observable result, and affects
   no unrelated target, tab, or browsing context.
2. **Given** the user or page navigates the approved tab to a different origin before an action runs,
   **When** the
   product re-evaluates the pending action, **Then** it invalidates prior approval and applies the local
   safety decision. A local deny stops; a local unknown may send only the canonical origin to the
   product-controlled safety service; remote deny, unknown, invalid, or unavailable stops. Only local or
   remote allow followed by fresh current-task consent permits protected work on the new origin.
3. **Given** the assistant is actively performing browser actions, **When** the user selects Stop,
   **Then** no new browser action starts, pending work is canceled where possible, and the product
   visibly reports stopped or explicitly warns that stop confirmation failed.
4. **Given** a task requires multiple browser actions, **When** it is ready to begin, **Then** the
   product shows the ordered plan and obtains explicit approval before the first action; it executes one
   step at a time, revalidates the current tab, origin, and target before each step, and pauses for fresh
   consent or stops if execution would leave the approved plan or origin.
5. **Given** required safety, consent, account, or policy state cannot be established, **When** a
   protected action is requested, **Then** the product performs no protected effect and exposes the
   blocking reason.
6. **Given** an authorized task begins controlling a browsing context, **When** control starts and later
   completes or the Extension context restarts, **Then** the affected context is visibly identified while
   active and no false active-control state remains afterward.
7. **Given** an authorization grant exists for the current task, **When** the user reviews and revokes it
   or the task reaches a terminal state, **Then** it expires visibly, authorizes no later task, and the
   next protected use requires fresh consent.
8. **Given** a request would use assistant-initiated navigation, batch or multi-tab execution, a webpage
   file upload, sensitive-field entry, an irreversible high-risk effect, a session- or site-persistent
   grant, or bypass, **When** the product evaluates it, **Then** it performs zero browser effects and
   identifies the unsupported
   capability.
9. **Given** a task requests scrolling, a non-navigation low-risk click, or non-sensitive text entry that
   is otherwise permitted, **When** the user denies that single-action request, **Then** the product
   dispatches no browser action and visibly reports whether the task can continue or why it stopped.

---

### User Story US-004 — Add Selected Visual or File Context (Priority: P2)

As a user, I can add only a file, pasted image, screenshot, region, or page element that I explicitly
select, so the current task can use visual information while the included scope remains visible.
This candidate remains deferred under Q-001 and does not authorize a webpage file-upload browser action.

**Why this priority**: This SHOULD capability expands useful context without being necessary for the
minimum text-and-page experience.

**Independent Test**: Select one supported image alongside an unselected file, then repeat with capture
permission denied. Verify only the selected material is added and failure adds nothing.

**Traceability**: `PR-009 → US-004 → FR-009`.

**Acceptance Scenarios**:

1. **Given** the user selects one adopted source—file, pasted image, visible-page screenshot, region, or
   page element—for the current task, **When** its source-specific validation succeeds, **Then** the
   product visibly adds only the selected scope and includes no unselected material.
2. **Given** capture access is unavailable or denied, **When** the user attempts a page capture,
   **Then** no material is attached and the product reports the access reason.
3. **Given** selected material has an unsupported type or exceeds the approved size limit, **When** it is
   validated, **Then** the product attaches nothing, identifies the failed constraint, and preserves the
   rest of the current task.

---

### User Story US-005 — Save and Reuse an Instruction (Priority: P2)

As a repeat-work user, I can create, organize, edit, delete, and reuse a named instruction, so I do not
have to rewrite routine tasks and reuse never becomes permanent site consent.

**Why this priority**: Reusable instructions are a SHOULD productivity capability built on the core
interactive task flow.

**Independent Test**: Save a valid instruction, retrieve and edit it, reuse it against a site requiring
fresh permission, then delete it. Verify each lifecycle state and current consent enforcement.

**Traceability**: `PR-010 → US-005 → FR-010`.

**Acceptance Scenarios**:

1. **Given** the user saves a valid named and categorized instruction, **When** the user later opens its
   category in the reusable-task list, **Then** the item is present in that category, can be edited or
   deleted, and reusing it does not bypass current authentication or site/action consent.
2. **Given** storage is unavailable, **When** the user tries to save a valid instruction, **Then** the
   product does not claim success, preserves the unsaved input where feasible, and reports the failure.

---

### User Story US-006 — Enter Through a Trusted Product Link (Priority: P2)

As a new or recovering user, I can follow an approved onboarding or product link to a known assistant,
settings, or recovery destination and review any starter content before submission.

**Why this priority**: Trusted handoff is a SHOULD capability that improves onboarding without changing
the core consent boundary.

**Independent Test**: Open one allowlisted link and one untrusted or malformed link. Verify the first
opens reviewable content and the second executes nothing.

**Traceability**: `PR-018 → US-006 → FR-018`.

**Acceptance Scenarios**:

1. **Given** a user selects an approved onboarding link carrying an allowlisted starter task, **When**
   the link is validated, **Then** the product opens the assistant with starter content visible for
   review and performs no privileged browser action until normal consent requirements are met.
2. **Given** a product link has an untrusted source, unknown task, or malformed payload, **When** it is
   received, **Then** the product rejects it and performs no embedded instruction or credential action.
3. **Given** assistant, settings, or recovery is an adopted link destination, **When** an approved link
   requests that destination with valid allowlisted data, **Then** the intended Extension surface opens,
   shows only that data, and starts no privileged action automatically.

---

### User Story US-007 — Review Effective Settings and Permissions (Priority: P2)

As a user, I can inspect adopted preferences and grants, revoke permission, choose a supported language,
and understand managed or update-required states, so the effective product behavior is visible.

**Why this priority**: This SHOULD capability provides the optional control surface for persisted
choices. Q-017 fixes the cross-cutting POC language contract without adopting the rest of PR-019 or
requiring a dedicated language-settings screen.

**Independent Test**: Review and revoke a current-task grant, then attempt the next protected action;
exercise `en-US`, `zh-TW`, and English-fallback fixtures, plus browser keyboard-entry handoff, update
notice, and an invalid or managed setting when those optional controls are adopted. No POC fixture
assumes a persisted site grant or a dedicated language-settings screen.

**Traceability**: `PR-019 → US-007 → FR-019`; mandatory grant review/revocation also supports `FR-008`.

**Acceptance Scenarios**:

1. **Given** an active current-task grant exists and the user opens its review surface, **When** the user
   revokes that grant, **Then** its effective state updates visibly and the next protected action
   requires fresh consent; no session- or site-persistent POC grant exists.
2. **Given** a value is invalid, unsupported, or controlled by administrator policy, **When** the user
   attempts to change it, **Then** the product retains the last valid effective value and explains why
   the requested change did not apply.
3. **Given** a language-selection control is adopted, **When** the user chooses `en-US` or `zh-TW`,
   **Then** all adopted user-facing surfaces use that locale or reviewed English fallback and expose no
   internal identifier as untranslated UI.
4. **Given** the product supports a browser-managed keyboard entry point, **When** the user requests to
   review or change it, **Then** the product opens the browser-supported destination and accurately
   reflects any resulting effective shortcut state it can observe.
5. **Given** a user-visible update or restart is required, **When** the product presents that state,
   **Then** the user receives an understandable next action and the product does not claim the new state
   is active before the approved restart completes.
6. **Given** remote configuration requests a capability or privilege expansion, **When** it is evaluated,
   **Then** the product does not apply that expansion unless the Q-016 policy explicitly permits it and
   all normal permission and consent boundaries remain satisfied.

---

### User Story US-008 — Run Separately Authorized Page Diagnostics (Priority: P3)

As a technical user, I may run a diagnostic capability adopted under Q-005 against the current page,
so I can investigate page behavior without treating ordinary page-read consent as diagnostic approval.

**Why this priority**: `PR-006` is `NEEDS-CLARIFICATION`; it is high risk, optional to the core value,
and excluded from baseline permissions until a product decision adopts some or all diagnostics.

**Independent Test**: In a build configured with the inclusion and authorization granularity approved
in Q-005, request one operation inside the approved diagnostic scope and one outside it.

**Traceability**: `PR-006 → US-008 → FR-006`.

**Acceptance Scenarios**:

1. **Given** Q-005 defines the adopted diagnostic categories and authorization granularity, **When** a
   task requests one operation inside and one outside its approved diagnostic scope, **Then** the product
   performs only the in-scope operation and distinctly reports the denied or unavailable operation.
2. **Given** the required diagnostic access is denied, unavailable, or conflicts with another user of
   the browser diagnostic channel, **When** the task requests it, **Then** no diagnostic operation occurs
   and the product reports the denial, conflict, or unsupported state.

---

### User Story US-009 — Schedule a Saved Task (Priority: P3)

As a repeat-work user, I may schedule a saved task and inspect whether each run completed, failed, or
needs attention, so known work can occur at an approved time without ambiguous results.

**Why this priority**: `PR-011` is a COULD capability whose unattended authority, catch-up, retry, and
consent semantics require product decisions before adoption.

**Independent Test**: In a build where scheduling is adopted, schedule one deterministic occurrence,
simulate a normal Extension restart, and verify the restart alone creates neither a second occurrence
nor a second final status; effect-uncertain retry policy remains a Q-009 fixture.

**Traceability**: `PR-011 → US-009 → FR-011`.

**Acceptance Scenarios**:

1. **Given** a user has a valid saved task and creates a supported schedule, **When** the due time occurs
   while authentication and required unattended permission are valid, **Then** the product starts one
   occurrence, records one final status for it, and does not create another occurrence solely because
   the Extension context restarts.
2. **Given** a due run lacks valid authentication or unattended consent, **When** its due time occurs,
   **Then** no protected action runs and the schedule is marked attention required.

---

### User Story US-010 — Teach a Workflow by Demonstration (Priority: P3)

As a repeat-work user, I may visibly record supported browser steps, optionally narrate them, review the
captured workflow, and save only what I approve.

**Why this priority**: `PR-012` is `NEEDS-CLARIFICATION`; step scope, processing location, persistence,
server behavior, and dynamic availability are not confirmed.

**Independent Test**: In a build where non-voice teaching is adopted, deny microphone permission,
record a deterministic sequence, edit it, and verify nothing is saved before confirmation.

**Traceability**: `PR-012 → US-010 → FR-012`.

**Acceptance Scenarios**:

1. **Given** workflow teaching is adopted and the user denies microphone access, **When** the user
   explicitly starts, demonstrates, and stops a supported non-voice workflow, **Then** the product
   captures a reviewable sequence without audio, allows approved edits, and saves nothing until the
   user confirms.
2. **Given** a capture or transformation step is unavailable, **When** recording or processing fails,
   **Then** the product does not fabricate a step and exposes a recoverable draft or explicit failure
   according to the still-unapproved product policy.

---

### User Story US-011 — Export Selected Task Records (Priority: P3)

As a user, I may export a selected conversation or action record after seeing its content scope, so I
can keep or share a durable artifact without accidentally exporting unrelated data or credentials.

**Why this priority**: `PR-013` is a COULD capability; formats, redaction, replay, branding, and file
lifetime require a product decision.

**Independent Test**: In a build with one adopted portable format, select a bounded conversation scope,
confirm the warning, and verify exactly one artifact or an explicit failure.

**Traceability**: `PR-013 → US-011 → FR-013`.

**Acceptance Scenarios**:

1. **Given** the user has a completed conversation and selects a supported export, **When** the user
   confirms the displayed content scope, **Then** the product produces one downloadable artifact
   containing only that scope or reports generation failure without claiming success.
2. **Given** the selected scope would contain product or AI-service authentication material, **When**
   export is prepared, **Then** that material is excluded and the product does not create an artifact
   that claims to contain the prohibited secret.

---

### User Story US-012 — Use an Alternate Hosted Assistant (Priority: P3)

As a user, I may enter and leave a separately hosted assistant while retaining the core Extension's
account, consent, policy, and approved browser-capability scope.

**Why this priority**: `PR-014` is `NEEDS-CLARIFICATION`; iframe internals, ownership, origin, session,
persistence, fallback, and server-side orchestration remain unconfirmed.

**Independent Test**: In a build where Q-011 defines a hosted experience and capability contract,
request one browser capability outside the approved hosted scope and verify boundary rejection without
prescribing how that contract is represented.

**Traceability**: `PR-014 → US-012 → FR-014`.

**Acceptance Scenarios**:

1. **Given** the hosted experience is adopted, authenticated, and operating under the Q-011 contract,
   **When** it requests a browser capability outside its approved hosted scope, **Then** the Extension
   rejects the request, performs no browser action, and exposes an integration error without disrupting
   the core assistant.
2. **Given** the hosted experience is unavailable, unauthorized, or account-mismatched, **When** a user
   attempts to use it, **Then** no hosted browser action occurs and the core experience remains usable
   or exposes an approved recovery path.

---

### User Story US-013 — Use an Authorized External Service Tool (Priority: P3)

As a connected-service user, I may discover an approved service capability, authorize it under the
Q-012 scope model, receive an attributed result, and revoke the approved access.

**Why this priority**: `PR-015` is `NEEDS-CLARIFICATION`; service scope, authorization, data flow,
transport, server mediation, and error contracts are not confirmed.

**Independent Test**: In a build with one approved connector and one declared capability, request a
different capability and verify it is not invoked or granted implicitly.

**Traceability**: `PR-015 → US-013 → FR-015`.

**Acceptance Scenarios**:

1. **Given** a supported connector is authorized for one declared capability, **When** a task requests a
   different undeclared or unapproved capability, **Then** the product does not invoke it, identifies
   the missing authorization, and leaves the existing authorized capability unchanged.
2. **Given** a connector is unavailable, expired, malformed, or times out, **When** its tool is
   requested, **Then** that invocation fails in an attributed way and the unrelated core task remains
   usable.

---

### User Story US-014 — Apply Enterprise Destination and Account Policy (Priority: P3)

As an enterprise administrator, I may restrict product use by destination and organization/account, so
managed restrictions override ordinary user preferences and cannot be bypassed by another entry path.

**Why this priority**: `PR-016` is `NEEDS-CLARIFICATION`; enterprise market scope and the managed-policy
contract are not approved.

**Independent Test**: In a build with an approved managed-policy contract, configure a permitted
organization and a blocked destination and verify the block across page read and action paths.

**Traceability**: `PR-016 → US-014 → FR-016`.

**Acceptance Scenarios**:

1. **Given** administrator policy permits one organization and blocks a destination path, **When** a user
   in the permitted organization requests an action on that path, **Then** the product performs no page
   read or action for that path and displays a non-overridable policy-block state.
2. **Given** effective managed policy changes during an active task, **When** a pending action becomes
   disallowed, **Then** the product starts no newly disallowed action and updates the visible task state.

---

### User Story US-015 — Receive an Asynchronous Task Notice (Priority: P3)

As a user waiting on an off-screen task, I may opt into selected non-sensitive completion, failure, or
attention notices and return to the related status without triggering a retry.

**Why this priority**: `PR-017` is a COULD capability; defaults, categories, sound, quiet hours, and the
denied-notification fallback require a product decision.

**Independent Test**: In a build with failure notifications adopted and enabled, complete one task with
failure and select its notice. Verify one non-sensitive notice, safe navigation, and no retry.

**Traceability**: `PR-017 → US-015 → FR-017`.

**Acceptance Scenarios**:

1. **Given** the user enabled failure notifications for scheduled tasks, **When** a scheduled task
   reaches failure, **Then** the product emits one non-sensitive failure notice and selecting it opens
   the related status context without retrying the task automatically.
2. **Given** the related task or tab no longer exists, **When** the user selects its notice, **Then** the
   product opens only a safe status view and does not recreate the action.

### Edge Cases

- **Unsupported or restricted page**: The product MUST NOT claim page access or attempt to bypass Chrome.
  A PDF, Chrome internal, extension-origin, or Web Store page, file/data/blob URL, or incognito context
  is outside the POC support contract. Content or targets available only through an iframe, Shadow DOM,
  canvas, or WebGL surface are also outside that contract. The product exposes an unsupported-context
  result for `PR-001`, `PR-004`, or `PR-005` and performs no protected read or browser action there.
- **Permission denied, dismissed, or revoked**: The product performs no newly denied page/host read,
  action, capture, microphone use, diagnostic operation, notification, or external invocation; it
  updates the effective state and explains whether an active task can continue.
- **Content inaccessible or empty**: The product sends no fabricated context and returns an explicit
  empty or inaccessible state.
- **Missing, invalid, or incomplete locale data**: The affected user-facing message uses reviewed
  English fallback and exposes no internal message identifier. If an unambiguous safety or consent
  message cannot be rendered, the protected read or action remains blocked with a safe visible error.
- **Context too large**: The product returns a disclosed bounded subset or a clear limit error; exact
  limits remain a later measurable decision.
- **Form-value sensitivity is ambiguous**: The product withholds the entire current value and selected
  state, including its length and partial content; it may retain approved non-value role/label/type
  metadata and reports that form context was withheld.
- **Page navigation or stale state**: A changed origin, missing target, closed tab, stale element, or
  changed top-level document invalidates the affected context and authorization before execution.
  After an origin change, the product MUST NOT read, transmit, or act on the new page until the Q-007
  safety decision allows it and Q-006 current-task consent is renewed.
- **User cancellation**: Stop prevents new actions; if in-flight cancellation cannot be confirmed, the
  UI MUST show that uncertainty rather than claim a completed stop.
- **Network, AI service, or backend unavailable**: The product avoids unbounded retry, preserves only a
  safe recoverable state, and exposes retry, reauthentication, or failure as applicable.
- **Origin-safety service unavailable or inconclusive**: Protected work that requires a remote decision
  fails closed with a visible reason. Work whose current origin is still locally allowed may continue;
  the product does not treat outage, timeout, malformed response, or unknown as allow.
- **Authentication unavailable**: Protected work stops; no prior or account-mismatched session is used.
- **Partial failure**: A multi-step or multi-system task reports the failed step, starts no unsafe
  dependent step, and does not label the overall outcome successful.
- **Invalid attachment or capture**: Unsupported type, excessive size, denied access, or stale selection
  adds nothing and produces an actionable reason.
- **Browser context restart**: Only approved minimum session/security state may be restored. No browser
  action or scheduled run is duplicated, no stale active-control indicator remains, and no durable Core
  task history is created.
- **Scheduled preconditions fail**: A due run with missing authentication, consent, browser availability,
  or target readiness performs no protected effect; catch-up and retry semantics remain unresolved.
- **Hosted or connector boundary invalid**: Invalid origin, account binding, capability, schema, service
  result, or transport state is rejected without corrupting the core task.
- **Managed policy invalid or unavailable**: Enterprise behavior remains unresolved; no fail-open or
  last-known-good policy is selected by this specification.
- **Notification denied**: The underlying task result remains correct; whether an in-product fallback is
  required remains unresolved.
- **Dynamic capability unavailable**: A gated candidate MUST NOT appear as available or expand data,
  permission, or dependency behavior without an approved product policy.

### Cross-Cutting Acceptance Scenarios

1. **Given** a task would transmit page, attachment, action, hosted, or connector data externally,
   **When** the user has not crossed the approved trigger and disclosure boundary, **Then** that data is
   not transmitted and the task exposes the missing authorization.
2. **Given** a user logs out or switches account/organization, **When** protected work or account-bound
   state is next evaluated, **Then** the old account cannot authorize new work or expose its data to the
   new account; authorization and account-bound local state are cleared, and no Core task, page-context,
   or action data remains as durable remote history.
3. **Given** normal Extension suspension or restart occurs during an adopted journey, **When** state is
   restored, **Then** no browser effect or scheduled occurrence is duplicated solely by the restart,
   the product either restores transient in-flight status or reports interruption, stale active
   indicators are corrected, and no durable Core task history is created.
4. **Given** a page, model, hosted surface, or connector output contains text claiming user approval,
   **When** it requests a protected capability, **Then** that text is treated as untrusted input and no
   capability proceeds without the actual approved user or administrator decision.
5. **Given** a candidate or reference-only capability is not adopted, **When** the P1 stories run,
   **Then** they require none of that capability's permission, data flow, external dependency, or state.
6. **Given** operational diagnostics are adopted, **When** an event is recorded or transmitted, **Then**
   product/AI-service credentials are absent and page, conversation, connector, and task content is
   limited to the Q-015-approved schema.
7. **Given** the declared accessibility test setup, **When** an evaluator uses keyboard and the approved
   assistive technology through activation, consent, active control, Stop, status, and adopted settings,
   **Then** each control and state is operable and understandable under the Q-019-approved target.
8. **Given** external transmission is authorized for an active task, **When** the product reaches the
   approved submission or invocation boundary, **Then** it identifies the relevant data categories and
   purpose to the user and transmits no category outside the disclosed approved scope.
9. **Given** underlying page/host, capture, microphone, diagnostic, or notification permission is
   revoked, **When** a pending or subsequent protected use is evaluated, **Then** no new protected effect
   occurs, the effective permission state is updated visibly, and the task reports whether it can
   continue without that capability.
10. **Given** a later capability proposes durable or remote storage, **When** that capability is adopted,
    **Then** an approved category-specific data matrix declares its purpose, data categories, placement,
    account binding, lifetime, logout/deletion behavior, and migration path; legacy local data is not
    silently migrated or uploaded.
11. **Given** a protected request has a local unknown safety decision, **When** remote classification is
    attempted, **Then** the safety purpose is disclosed to the user but the classification request
    contains only the canonical origin; it contains no username/password, path, query, fragment,
    referrer, page title, or page content, and neither request nor result becomes durable history.
12. **Given** release qualification records the then-current and immediately preceding stable desktop
    Chrome major releases, **When** the core P1 journeys run on ordinary top-level HTTP(S) HTML fixtures
    covering user- or page-initiated navigation, reload, and same-origin SPA updates, **Then** both
    recorded majors satisfy
    those journeys. Each iframe-only, Shadow-DOM-only, PDF, internal/Web Store, file/data/blob, incognito,
    and canvas/WebGL-only fixture instead produces an explicit unsupported or inaccessible result with
    zero protected read or browser action.
13. **Given** every adopted POC user-facing surface and message state, **When** the release localization
    matrix runs in `en-US` and `zh-TW` and repeats with missing, invalid, or incomplete locale data,
    **Then** each supported-locale case shows reviewed text in that locale, each fallback case shows
    reviewed English, no internal identifier appears, and no ambiguous consent or safety text permits a
    protected effect.

## Requirements *(mandatory)*

### Scope Classification

| Classification | Product Requirements | Specification effect |
| --- | --- | --- |
| MUST | PR-001–PR-005, PR-007, PR-008 | Core scope and normative acceptance behavior |
| SHOULD | PR-009, PR-010, PR-018, PR-019 | Strong candidate capability; release placement still requires approval |
| COULD | PR-011, PR-013, PR-017 | Optional capability; conditional behavior applies only if adopted |
| NEEDS-CLARIFICATION | PR-006, PR-012, PR-014–PR-016 | Not baseline scope; product decision required before planning |
| REFERENCE-ONLY | F-016, F-017 | No Product Requirement, story, permission, dependency, or implementation scope |

### Functional Requirements

- **FR-001 (PR-001 — MUST)**: The product MUST let the user open, focus, and close an AI assistant
  workspace associated with the current browsing context through at least one explicit browser entry
  point. Opening the workspace alone MUST NOT transmit page content or perform a page action. It MUST
  immediately expose a finite service-availability check and then one of an available workspace or an
  actionable unavailable state; the unavailable state MUST NOT be presented as authorization in progress.
- **FR-002 (PR-002 — MUST)**: The product MUST establish, restore, renew as permitted, and end an
  authorized session for the selected AI service; it MUST require reauthentication when authorization
  is invalid and MUST expose accurate signed-in, signed-out, reauthentication, and policy-block states.
  The product-controlled server MUST own AI provider integration and task/tool orchestration; the
  Extension MUST mediate browser context, user consent, and browser action execution. This requirement
  MUST use an account-based product session and MUST NOT accept or store user-supplied direct AI-service
  credentials in the Extension. It selects no AI provider, protocol, identity provider, or session-token
  representation. Only minimum session/security state required for authorization and data categories
  separately approved for local storage MAY persist in the POC. Logout MUST clear authorization and
  all account-bound local state. Service-health and authorization HTTP operations MUST settle within
  five seconds as an available, signed-out, signed-in, reauthentication-required, policy-blocked, or
  unavailable state. An unavailable state MUST block sign-in and protected work, show a recovery action,
  and allow exactly one new authoritative worker check for each explicit user retry without continuous
  polling. On Chrome versions that gate loopback access, the visible side panel MAY make one bounded
  `GET /health` after that explicit recovery gesture solely to present the browser's local-network
  permission decision. It MUST ignore the response and MUST NOT infer availability, restore a session,
  authorize, submit a task, open a product channel, or access page data; those remain worker-owned.
- **FR-003 (PR-003 — MUST)**: The product-controlled server MUST accept and orchestrate an authorized
  user request, provide progressive task output, request only declared capabilities, incorporate
  observable results, and finish without unbounded work. The Extension MUST enforce the approved
  context and consent scope, execute only authorized adopted capabilities, and return observable action
  results. The task MUST finish in success, denial, cancellation, attention-required, or explicit
  failure. POC task requests, outputs, capability requests/results, and outcomes MUST remain transient
  and MUST NOT be retained as durable local or remote history. Every loading or review state MUST be
  finite and reach an actionable result. The single-task workspace MUST distinguish empty, running,
  safety/consent/Plan review, and the five terminal outcomes, prevent duplicate submission while work
  or review is active, and expose no ineffective Stop, empty grant section, raw structured payload, or
  internal identifier.
  A packaged browser capability MUST NOT be reported complete from tests that bypass its built Extension
  artifacts or call private domain/runtime functions instead of the observable MV3 journey.
- **FR-004 (PR-004 — MUST)**: Within the CT-010-supported page context, the product MUST collect only
  user-authorized, task-relevant, bounded page structure and text from the top-level document's ordinary
  DOM and MUST disclose truncation or inaccessibility. General page reading MUST expose no current form
  value or selected-option state by default. The POC MUST support a separately disclosed
  `page.form-values` category whose current-task/current-document grant may return only bounded,
  task-relevant ordinary values and selected-option state that a closed local policy conclusively
  classifies as non-sensitive. Password, hidden/file, one-time-code, payment-card,
  sensitive-autocomplete, product-credential, and ambiguous fields MUST expose no value, length, or
  partial content. POC page/form context MUST be used only for the active task and MUST NOT be retained
  as durable local or remote history. Before context is collected from a locally unknown origin, the
  Q-007 remote origin-only decision MUST allow it and Q-006 current-task consent MUST exist; otherwise
  no page context is collected or transmitted. A read that depends only on an excluded iframe, Shadow
  DOM, canvas, or WebGL surface MUST return unsupported or inaccessible rather than fabricated content
  or a partial-success claim. Any later form-context expansion requires a separately approved closed
  data/sensitivity/consent matrix and additive capability-profile review.
- **FR-005 (PR-005 — MUST)**: The product MUST execute only an adopted set of observable browser
  actions in the current selected tab's supported top-level document under CT-010. The POC executable
  action set is exactly scrolling, activating a locally classifiable low-risk control whose effect is
  non-navigation and not a form submission, and entering text in a field not identified as sensitive.
  Assistant-initiated full-document, link, form, script-driven, and other navigation effects are
  deferred and MUST return an explicit unsupported-capability result with zero such effect. User- or
  page-initiated document navigation, reload, and SPA changes remain supported context changes rather
  than POC browser actions; before later protected work the product MUST revalidate the selected tab,
  top-level document, origin, consent, and target. Before a multi-step task begins, the product MUST show its
  ordered plan and obtain explicit approval; it MUST execute one step at a time and revalidate the tab,
  origin, target, and authorization before each step. Batch means parallel or bulk effects without
  per-step target and result validation; it does not include an approved plan executed and verified
  sequentially. The product MUST NOT perform batch or multi-tab execution,
  MUST NOT perform a webpage file-upload action, and MUST NOT perform a purchase/payment confirmation,
  destructive deletion, account/security change, public/final submission, or another irreversible
  high-risk effect. If field sensitivity or effect risk cannot be established, the product MUST perform
  no action. POC plan, action, and result data MUST remain transient under Q-004. Every later action
  category requires an approved action × sensitivity × consent-lifetime × plan-review matrix.
  Post-POC assistant navigation remains traceable to PR-005/F-004 but requires a separately approved
  navigation-containment design, permission/data update, and two-Chrome release evidence before adoption.
  - **Amended by 002/FR-028** (`specs/002-reference-parity/spec.md`): the executable action set is
    extended with key press, hover, double activation and drag under the same local classification and
    non-navigation rules; resolution (`page.resolve`) and waiting (`page.wait`) are reads/control
    instructions, not actions.
- **FR-006 (PR-006 — NEEDS-CLARIFICATION)**: `UNRESOLVED — product decision required.` If advanced page
  diagnostics are adopted, the product MUST perform only the diagnostic categories and authorization
  granularity approved in Q-005, MUST distinguish what ran from what was denied or unavailable, and MUST
  NOT inherit diagnostic authority from ordinary page-read consent. No diagnostic enters baseline scope
  or permissions before that decision.
- **FR-007 (PR-007 — MUST)**: The product MUST make active browser control and its affected browsing
  context visibly distinguishable; MUST provide an immediately reachable Stop control; MUST prevent new
  actions after Stop; and MUST clear or correct stale activity state after completion or restart.
- **FR-008 (PR-008 — MUST)**: Before protected page access, browser action, any later product-initiated
  cross-site transition, or external invocation, the product MUST evaluate applicable site, origin,
  data, action, account, and policy state; obtain consent limited to the current task; expose review and
  revocation in the active workspace even if the broader PR-019 settings candidate is not adopted; and
  fail closed when required authorization cannot be established. General page-read consent MUST NOT
  authorize `page.form-values`; that category requires its own disclosed grant bound to the current
  task and current document. The local safety decision MUST be allow, deny, or unknown. Local
  deny is not user-overridable. Only local unknown may invoke the product-controlled safety service,
  sending only the canonical origin—scheme, host, and effective port. The safety purpose MUST be
  disclosed to the user, but no other data category may be transmitted in the classification request.
  The product MUST NOT transmit URL username/password, path, query, fragment, referrer, page title, or
  page content for classification. Remote deny, unknown, invalid, expired, or unavailable MUST cause no
  protected read, transmission, action, or transition that depends on that decision. Local or remote
  allow means only that safety policy did not block the origin; it is not consent and does not make page
  content trusted. Reload, SPA/document change, or a user- or page-initiated origin change MUST
  invalidate any form-value snapshot/grant. An origin change also pauses protected work until safety is
  re-evaluated and fresh current-task consent is obtained. Every task grant MUST expire on Stop,
  revocation, or any terminal task outcome. The POC MUST NOT create a session-persistent or
  site-persistent grant,
  and no bypass mode is adopted. The classifier provider, endpoint, protocol, category scheme, timing,
  and cache behavior remain unselected and MUST NOT be inherited from the Reference Extension.
- **FR-009 (PR-009 — SHOULD)**: The product SHOULD let the user add an explicitly selected file, pasted
  image, visible-page screenshot, region, or page element to the current task; it SHOULD make the
  included scope visible and report capture, permission, type, or size failure without adding unrelated
  material. This deferred selected-task-context capability is distinct from, and does not enable, the
  webpage file-upload action excluded from the POC by Q-006. If adopted without a separately approved
  Q-008 expansion, visible-page capture and element selection remain limited to the supported top-level
  HTTP(S) HTML context.
- **FR-010 (PR-010 — SHOULD)**: The product SHOULD let the user create, name, categorize, view, edit,
  delete, and reuse an instruction or task template; reuse MUST re-evaluate current authentication and
  site/action consent. Whether reuse only populates or may immediately start a task remains unresolved.
- **FR-011 (PR-011 — COULD)**: If scheduled tasks are adopted, the product MUST let the user schedule a
  saved task for an approved cadence, expose its effective schedule, and record one completed, failed,
  or attention-required status for each occurrence. A normal Extension restart MUST NOT create an extra
  occurrence by itself. Cadence options, missed-run, effect-uncertain retry, lifecycle-operation,
  deduplication, and unattended-consent policies are unresolved.
- **FR-012 (PR-012 — NEEDS-CLARIFICATION)**: `UNRESOLVED — product decision required.` If workflow
  teaching is adopted, the product MUST visibly capture approved browser steps and optional narration,
  let the user review and edit the captured workflow, and save only the user-confirmed version without
  inventing unobserved steps. Server-side transformation, final schema, persistence, transmission,
  feature-flag behavior, and edit granularity are not confirmed.
- **FR-013 (PR-013 — COULD)**: If export is adopted, the product MUST let the user select the
  conversation or action scope, disclose included sensitive categories, confirm the export, and receive
  one supported durable artifact or explicit failure. Formats, redaction policy, visual replay,
  branding, deletion, and temporary-file lifetime are unresolved.
- **FR-014 (PR-014 — NEEDS-CLARIFICATION)**: `UNRESOLVED — product decision required.` If a separately
  hosted assistant is adopted, the product MUST preserve the core account, consent, policy, and approved
  browser-capability scope when entering, using, or leaving it. Hosted UI ownership, origin, session,
  conversation persistence, iframe-internal behavior, server orchestration, representation of the
  capability contract, and fallback are not confirmed.
- **FR-015 (PR-015 — NEEDS-CLARIFICATION)**: `UNRESOLVED — product decision required.` If connected
  service tools are adopted, the product MUST let the user discover approved tools, understand and
  control authorization under the Q-012 scope model, identify result attribution, isolate failures, and
  revoke approved access. Whether consent is connection-wide, scope-based, per invocation, or combined,
  plus launch services, data flows, transport, server mediation, and error contracts, is not confirmed.
- **FR-016 (PR-016 — NEEDS-CLARIFICATION)**: `UNRESOLVED — product decision required.` If enterprise
  deployment is adopted, the product MUST apply administrator destination and organization/account
  restrictions ahead of user preferences and expose a clear non-bypassable block. Policy source,
  syntax, precedence details, updates, audit, recovery, and invalid-policy behavior are not confirmed.
- **FR-017 (PR-017 — COULD)**: If asynchronous notices are adopted, the product MUST let the user
  control participation for selected completion, failure, or attention events; MUST use non-sensitive
  default content; and MUST return safely to existing task status without triggering an action. Initial
  defaults, categories, sound, quiet hours, and denied-permission fallback are unresolved.
- **FR-018 (PR-018 — SHOULD)**: The product SHOULD let approved onboarding and product links open a
  known Extension destination and optionally carry a validated starter task or recovery target; it MUST
  reject untrusted sources and MUST NOT accept arbitrary instructions, credentials, permission grants,
  or automatic privileged actions from a link.
- **FR-019 (PR-019 — SHOULD)**: The product SHOULD expose coherent settings for adopted preferences,
  permission review and revocation, language, browser-supported keyboard entry, and necessary update or
  restart communication; it MUST distinguish user choices from administrator policy and MUST NOT let
  remote configuration silently expand privilege. The broader settings feature remains deferred by
  Q-001. If a language-selection control is later adopted, its initial choices are `en-US` and `zh-TW`
  with reviewed English fallback under CT-012. Optional settings, feature flags, and server-controlled
  behavior remain unresolved; a language control does not authorize any other setting.

### Cross-Cutting Product Constraints

- **CT-001 — Clean-room boundary**: Only approved externally observable product behavior is normative.
  Reference code, private identifiers, protocols, assets, providers, endpoints, and architecture MUST
  NOT be copied or selected by implication.
- **CT-002 — Sensitive data categories**: URLs, titles, page text and structure, selected text, form
  values, screenshots, files, conversation content, actions and results, authentication/session state,
  account/organization identity, connector data, voice, schedules, settings, and browser-derived state
  MUST be treated according to their sensitivity and approved purpose.
- **CT-003 — User-trigger boundary**: Opening the product or viewing a page MUST NOT itself authorize
  page collection, external transmission, browser action, diagnostic access, export, notification,
  recording, or connector invocation. Each protected behavior requires its approved trigger and scope.
- **CT-004 — Least privilege**: Every Chrome capability, host scope, and external-service scope MUST
  trace to an adopted Product Requirement and MUST be requested no earlier or more broadly than needed.
  Candidate and reference-only capabilities MUST NOT expand baseline access.
- **CT-005 — External transmission**: Before or at the approved task boundary, the product MUST identify
  which relevant data categories may leave the browser and for what purpose. For Q-007, only a canonical
  origin with a local unknown decision may leave the browser. The safety purpose is disclosed to the
  user but is not an additional transmitted data category; URL username/password, path, query, fragment,
  referrer, page title, and page content MUST remain local to classification. No reference endpoint,
  provider, protocol, category scheme, hosted service,
  connector, telemetry processor, or workflow backend is selected by this specification.
- **CT-006 — Authentication handling**: Protected work requires valid authorization for the selected
  service and account scope. Credentials MUST be isolated from webpages, notifications, exports,
  telemetry, ordinary logs, and unrelated accounts. Logout and account switch MUST terminate old
  authorization and clear its account-bound local state before another account can use protected work.
- **CT-007 — Persistence**: POC Core task, page-context, and action data MUST remain transient and MUST
  NOT become durable local or remote history. Durable POC state is limited to minimum session/security
  state and a local data category separately approved by a product decision, with a deletion path;
  that exception does not approve a durable action plan, step record, result, or authorization grant.
  Current-task plans, steps, results, and grants expire with the task, and logout clears authorization
  and account-bound local state. Q-007 safety requests and results are transient and MUST NOT form local
  or remote history. Every later adopted capability that needs durable or remote data MUST first have an
  approved category-specific data matrix covering purpose, placement, account binding, lifetime,
  logout/deletion behavior, and migration. The product MUST NOT silently migrate or upload legacy local
  data, and no reference retention behavior is inherited.
- **CT-008 — Untrusted input**: Page content, model output, hosted content, connector data, and remote
  instructions MUST be treated as untrusted and MUST NOT serve as user consent or expand capability.
- **CT-009 — Failure behavior**: Every initiated journey MUST expose success, denial, cancellation,
  attention-required, or failure and MUST NOT imply success for an unverified effect. Every checking,
  authorizing, restoring, submitting, or review state MUST have a finite bound and fall through to an
  understandable state with an applicable recovery action. A stale response MUST NOT replace a newer
  availability, session, review, progress, or terminal projection. A local-network permission denial,
  dismissal, rejection, or timeout MUST return to the same recoverable unavailable state and MUST NOT
  be reported as service availability.
- **CT-010 — Platform baseline**: Manifest V3 is the platform baseline. At release, the POC MUST support
  the then-current and immediately preceding stable desktop Chrome major releases, and release
  qualification MUST record their actual major numbers. Core page reading and browser actions apply
  only to the current selected tab's ordinary top-level HTTP(S) HTML document. User- or page-initiated
  document navigation, reload, and same-origin SPA route or DOM updates remain within this
  page-compatibility contract, subject to Q-006 action and consent limits and Q-007 safety checks; this
  compatibility does not authorize assistant-initiated navigation in the POC. Content or targets
  available only through an iframe, Shadow DOM, PDF, Chrome internal, extension-origin, or Web Store
  page, file/data/blob URL, incognito context, or canvas/WebGL-only surface are unsupported and MUST fail
  explicitly without bypass. The distribution channel remains unresolved, and no Reference Extension
  version floor or broad-access declaration is inherited.
- **CT-011 — Lifecycle resilience**: Normal Extension context suspension or restart MUST NOT duplicate
  browser effects or scheduled runs or leave false active-control state. If transient in-flight status
  cannot be restored, the product MUST report interruption rather than invent a final result or create
  durable Core task history.
- **CT-012 — Accessibility and localization**: Primary activation, authorization and reauthorization,
  assistant workspace and request entry, consent and plan review, active-control and Stop state,
  progress and terminal status, errors and unsupported states, and mandatory current-task grant review
  and revocation MUST provide reviewed `en-US` English and `zh-TW` Traditional Chinese text. The POC
  initially uses `zh-TW` when the browser preference resolves to `zh-TW` and otherwise uses `en-US`;
  reviewed English is the fallback for missing, invalid, unsupported, or incomplete locale data. No
  internal message identifier may appear as user-facing text, and ambiguous consent or safety text MUST
  fail closed. This contract does not adopt deferred settings, notification, or onboarding surfaces; if
  later adopted, each joins the locale-coverage matrix before release. Every future locale requires an
  approved complete-surface translation, review, fallback, layout, keyboard, assistive-technology, and
  regression matrix. Service checking/unavailable guidance, local startup instructions, manual retry,
  empty/single-task workspace states, human-readable capabilities/data categories/lifetimes/action
  arguments, the explicit local-network permission/retry action and its pending state, and all five
  terminal outcomes are part of the mandatory fixed UI coverage. Reference
  locale files are evidence only and are neither copied nor automatically
  adopted. Under Q-019, one designated product owner performs the POC accessibility and comprehension
  gate on Windows 11 across both supported Chrome majors and both POC locales, using separate
  keyboard-only and current-stable-NVDA passes. This gate is owner acceptance rather than representative
  multi-user evidence.
- **CT-013 — Privacy-safe observability**: Operational diagnostics MUST exclude credentials and
  minimize page, conversation, connector, and task content. Event purpose, consent, processors,
  fields, redaction, sampling, and retention require approval before any telemetry dependency exists.

### Cross-Cutting Acceptance Destinations

| Constraint | Observable destination |
| --- | --- |
| CT-001 | Specification Quality Gates SQG-001/SQG-002 and the Reference Feature traceability table |
| CT-002 | US-002.2–3, US-004.1–3, Cross-Cutting Scenarios 1/6 |
| CT-003 | US-001.1/4, US-003.4–5, Cross-Cutting Scenario 1 |
| CT-004 | US-003.4–5/7, Cross-Cutting Scenario 9, SC-002, SC-007 |
| CT-005 | US-002.5, US-003.2, Cross-Cutting Scenarios 1/8/11, and Q-002/Q-004/Q-007/Q-010–Q-012/Q-015 |
| CT-006 | US-001.2–3/5–7 and Cross-Cutting Scenario 2 |
| CT-007 | Cross-Cutting Scenarios 2/3/10/11 and Q-004/Q-007; no numeric retention value is invented |
| CT-008 | Cross-Cutting Scenario 4 |
| CT-009 | SC-004 and all story failure scenarios |
| CT-010 | Q-008, Cross-Cutting Scenario 12, the unsupported/restricted-page edge case, and SC-001/SC-008 |
| CT-011 | US-003.6, US-009.1, Cross-Cutting Scenario 3, SC-006 |
| CT-012 | Cross-Cutting Scenarios 7/13, SC-009–SC-011, Q-017, and Q-019 |
| CT-013 | Cross-Cutting Scenario 6 and Q-015 |

### Key Entities *(include if feature involves data)*

- **Browsing Context**: The currently associated page, tab, top-level document scope, origin,
  accessibility state, and task relationship. POC page reading and browser actions are limited to the
  current selected tab's ordinary top-level HTTP(S) HTML document under CT-010; context association is
  not itself consent to read, transmit, or act on content.
- **Origin Safety Assessment**: The canonical origin, local allow/deny/unknown decision, optional remote
  allow/deny/unknown result, disclosed purpose, freshness state, and observable blocking reason. It is
  transient, contains no path/query/fragment or page content, grants no consent, and is re-evaluated
  after an origin change.
- **Authorized Service Session**: The account-based product authorization state, expiry or validity,
  and organization binding needed for protected use. Direct user-supplied AI-service credentials are
  excluded; only minimum session/security state may be durable, logout clears authorization and
  account-bound local state, and the identity provider and product-session token representation are not
  specified.
- **Assistant Task**: A user-triggered request, approved context, progressive output, adopted capability
  requests and results, activity state, and exactly one observable outcome category. Its POC lifecycle
  is transient and creates no durable local or remote history.
- **Page Context Snapshot**: Bounded task-relevant page structure or text, collection scope, applicable
  data-category grants, optional bounded non-sensitive ordinary form values and selected-option state,
  withholding/redaction status, truncation status, and the page state against which it remains valid.
  It is transient, limited to the active POC task/document, and contains no sensitive or ambiguous form
  value, length, or partial content.
- **Browser Action**: An adopted action category, target context, arguments, consent/policy state,
  sensitivity/risk classification, expected effect, observed result, and failure or cancellation state.
  POC categories are scroll, non-navigation low-risk click, and non-sensitive text entry in the current
  tab; arguments and results are transient and create no durable local or remote history.
- **Authorization Grant**: The user or administrator decision bound to a site/service, data or action
  category, task scope, lifetime, account, and revocation state. A POC grant is limited to one current
  task; a `page.form-values` grant is additionally bound to the current document. Every grant expires
  on Stop, revocation, or any terminal task outcome and cannot persist by session or site. Any later
  durable grant requires a separate approved action and data policy.
- **Action Policy Matrix**: The approved mapping of action category, sensitivity/risk, consent lifetime,
  and plan-review behavior required before any post-POC browser action or persistent grant is adopted.
- **Capability Data Matrix**: The approved per-capability declaration of purpose, data categories,
  placement, account binding, lifetime, logout/deletion behavior, and migration path required before a
  later capability stores durable or remote data; it never authorizes silent migration or upload of
  legacy local data.
- **Selected Attachment**: User-selected file or visual context, source and scope, type/size validation,
  task association, transmission disclosure, and bounded lifetime. It is a deferred task-context
  capability, not a POC webpage file-upload action.
- **Reusable Instruction**: User-owned name, content, category, optional adopted metadata, and lifecycle
  state; it carries no standing browser permission.
- **Schedule and Task Run**: Conditional schedule/cadence plus an individual due occurrence, effective
  preconditions, deduplication identity, outcome, timestamps, and attention reason.
- **Workflow Draft**: Conditional recorded step and narration data, review/edit state, processing status,
  confirmation state, and persistence/transmission policy once approved.
- **Export Artifact**: Conditional user-selected content scope, format, warning/confirmation, generation
  status, and durable-file boundary.
- **Hosted Session**: Conditional trusted origin, account/task binding, declared capabilities, and
  availability state; internal iframe and server representation are unspecified.
- **Connector Authorization and Invocation**: Conditional service identity, declared tools, account
  scope, consent, inputs/results, attribution, revocation, and isolated failure state.
- **Managed Policy**: Conditional administrator rules, effective revision, applicable account and URL
  scope, precedence, and allow/block outcome.
- **Product Setting or Notice Preference**: Adopted effective user value, managed override, validation
  state, and the event categories or locale it controls.
- **Locale Coverage Matrix**: The approved locale identifier, English fallback, adopted user-facing
  surfaces and message states, translation/review completeness, layout, keyboard and assistive results,
  and regression status. The POC entries are `en-US` and `zh-TW`; a later locale is not supported merely
  because the Reference Extension contains a resource for it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001 — Core user outcome**: In 100% of deterministic acceptance cases on both desktop Chrome
  majors recorded for release qualification under CT-010, the user can enter an authorized session,
  obtain a page-related result, and
  complete or stop one current-tab scroll, non-navigation low-risk click, or non-sensitive text entry
  with an explicit terminal state; an assistant-navigation request instead ends in one explicit
  unsupported state with zero navigation effect.
  Before those branded-Chrome release cases begin, the same packaged build MUST pass the automated
  Chromium core journey with zero skipped page-read or browser-action step.
- **SC-002 — No unauthorized effect**: Across the protected-read and protected-action acceptance set,
  every case with denied, missing, expired, stale, account-mismatched, or policy-blocked authorization
  or with an action outside the approved POC set produces zero protected page, browser, or
  external-service effects and one observable blocking state. Local deny and remote deny, unknown,
  invalid, expired, or unavailable likewise produce zero protected effect that depends on that safety
  decision.
- **SC-003 — Controlled form-value disclosure**: Across every deterministic form fixture, general page
  reading without a `page.form-values` grant returns zero current form values or selected-option state.
  With that current-task/current-document grant, every approved bounded non-sensitive ordinary value
  and selected-option state is returned, while every password, hidden/file, one-time-code,
  payment-card, sensitive-autocomplete, product-credential, and ambiguous value is absent together with
  its length and partial content. Form values are absent from durable storage, ordinary logs, telemetry,
  notifications, and exports in every applicable case. Every Q-007 remote safety request contains only
  canonical origin; URL username/password, path, query, fragment, referrer, page title, page content,
  and form values are absent from the classification request.
- **SC-004 — Explainable terminal state**: Every user-triggered task acceptance case ends in exactly one
  observable outcome category—success, denial, cancellation, attention required, or failure—and no
  test records unverified work as successful.
- **SC-005 — Effective Stop**: In every Stop acceptance case, no new browser action begins after the Stop
  decision is received. Any in-flight action whose cancellation cannot be confirmed is displayed as
  uncertain rather than stopped or successful.
- **SC-006 — Lifecycle safety**: In every declared normal Extension suspension/restart acceptance case,
  no action or due run is duplicated, transient in-flight status is restored or interruption is reported,
  no false active-control indicator remains, and no durable Core task history is created.
- **SC-007 — Candidate isolation**: In 100% of P1 acceptance cases, a user can complete the core journey
  while every omitted SHOULD, COULD, NEEDS-CLARIFICATION, and REFERENCE-ONLY capability contributes zero
  capability-specific permission, data flow, external dependency, or visible broken control.
- **SC-008 — Context and effect accuracy**: Across every Q-008 supported and excluded fixture, the
  product identifies the current selected tab, top-level document, pre/post-change origin, safety state,
  and final effect accurately. Zero cases affect an unrelated tab, iframe, Shadow DOM, or other excluded
  context, reuse authorization across an origin change, or claim an unverified effect; every excluded
  fixture produces an explicit unsupported or inaccessible result with zero protected effect.
- **SC-009 — Accessible primary control**: In 100% of declared POC accessibility steps, one designated
  product-owner evaluator on Windows 11 can, in separate keyboard-only and current-stable-NVDA passes,
  activate the product, understand consent, identify active control, invoke Stop, and understand the
  resulting status in both `en-US` and `zh-TW` on the then-current and immediately preceding stable
  desktop Chrome majors recorded for release qualification.
- **SC-010 — User-understandable safety state**: In 100% of declared consent and execution-state
  scenarios across the SC-009 OS, browser, and locale matrix, the same sole evaluator can correctly state
  the page/service, requested action or data category, allow/deny outcome, and running/stopped/failed
  state. This result establishes POC owner acceptance only and MUST NOT be reported as representative
  multi-user usability or accessibility evidence.
- **SC-011 — Complete bilingual POC UI**: Across 100% of adopted POC user-facing surfaces and message
  states, release tests in both `en-US` and `zh-TW` display reviewed text in the selected locale. Every
  missing, invalid, unsupported, or incomplete locale fixture displays reviewed English fallback; zero
  fixtures expose an internal identifier or permit protected work through ambiguous consent or safety
  text.
- **SC-012 — Recoverable local-service outage**: In 100% of deterministic local-service-offline
  acceptance cases, the side panel shows an unavailable state plus the service address, startup
  instruction, and manual recovery action within five seconds. Zero cases report that outage as
  authorizing or allow sign-in/protected work; after service recovery, one explicit retry continues to
  session restoration or sign-in and no stale earlier result replaces it. In 100% of Local Network
  Access-gated cases, one recovery gesture starts at most one bounded permission bootstrap plus one
  authoritative worker retry; the bootstrap response alone never displays available.

No permanently fixed Chrome major number is embedded in this specification: Q-008 approves a moving
window of the then-current and immediately preceding stable desktop majors, whose actual numbers are
recorded during release qualification. The approved five-second upper bound applies only to
service-health and authorization HTTP operations. No other numeric latency, availability, throughput,
retention, storage, or retry target is approved by the Product Requirements; those values remain
explicit inputs for clarification, planning, and testing rather than assumptions in this specification.

### Specification Quality Gates

- **SQG-001 — Traceability**: `19/19` Product Requirements and `21/21` Reference Features have explicit
  destinations; `F-016` and `F-017` remain `REFERENCE-ONLY`.
- **SQG-002 — Provenance**: No unsupported reference behavior, private implementation detail, provider,
  protocol, dependency, or product choice is promoted to normative scope.
- **SQG-003 — Acceptance coverage**: Every MUST and SHOULD clause has an observable story scenario or
  cross-cutting acceptance destination; conditional capabilities remain visibly conditional.

## Assumptions

- **A-001**: The Product Requirements Draft and the two reference-evidence documents are the complete
  evidence set for this specification. Additional approved evidence requires revalidation.
- **A-002**: The product remains a Chrome Extension whose core proposition is AI-assisted understanding
  and controlled interaction with the current page.
- **A-003**: At least one remote AI inference capability is required for `PR-003`. A product-controlled
  server owns AI provider integration and task/tool orchestration, while the Extension mediates browser
  context, user consent, and browser action execution. The exact provider and protocol remain unresolved.
- **A-004**: Confirmed externally observable reference behavior may support product evidence, while
  reference implementation details remain outside the design and dependency boundary.
- **A-005**: The core product is user-triggered and interactive. Unattended authority is not baseline
  behavior and exists only if the scheduled-task decisions are approved.
- **A-006**: MUST/SHOULD/COULD/NEEDS-CLARIFICATION classifications from the Product Requirements Draft are
  preserved recommendations, not approval of a release package.
- **A-007**: No dynamic feature flag is assumed enabled, and no undocumented server, hosted-frame, or
  connector behavior is treated as a requirement.
- **A-008**: No reference AI provider, connector provider, telemetry vendor, native companion, remote
  orchestrator, or private protocol is preselected.
- **A-009**: Least privilege and explicit consent remain governing product constraints; no POC bypass
  mode is approved.
- **A-010**: Except for the approved five-second service-health, Local Network Access bootstrap, and
  authorization HTTP upper bound; one response-agnostic bootstrap plus one authoritative worker probe
  per explicit manual recovery gesture; numeric limits, retry counts, and storage quotas require
  explicit later evidence or decisions. Locale expansion beyond Q-017 and browser or page-context
  expansion beyond Q-008 each require a separately approved coverage decision.
- **A-011**: During POC manual acceptance, the tester starts the local product service. The product may
  display the exact local address and startup command as recovery guidance but does not launch the
  service itself.
- **A-012**: The Chrome 142+ Local Network Access decision is browser-owned. The POC may trigger it only
  from the visible side panel after an explicit recovery gesture; denial grants no fallback authority,
  and the service worker remains the sole authority for availability and all protected product traffic.

## Scope and Product Boundaries

### Core Scope

The approved first-release proof-of-concept scope is exactly the seven MUST Product Requirements:
explicit assistant activation (`PR-001`), authorized service session (`PR-002`), bounded
conversation/task loop (`PR-003`), bounded page context (`PR-004`), verified browser actions
(`PR-005`), visible control and Stop (`PR-007`), and scoped consent/site safety (`PR-008`). Their
cross-cutting privacy, failure, lifecycle, and testability constraints are also core.

### Candidate Scope

- SHOULD: `PR-009`, `PR-010`, `PR-018`, `PR-019`.
- COULD: `PR-011`, `PR-013`, `PR-017`.
- NEEDS-CLARIFICATION: `PR-006`, `PR-012`, `PR-014`, `PR-015`, `PR-016`.

Q-001 explicitly defers every candidate above from the first-release proof of concept. Candidate
classification preserves evidence and a testable conditional contract for later consideration; it does
not authorize baseline permission expansion, dependency selection, planning, or implementation.

### Approved Evolution Boundary

The POC is an independently valuable first increment, not a permanent feature ceiling. Later releases
MAY progressively approach confirmed externally observable Reference Extension behavior, but this
direction does not approve any deferred capability, private implementation, dependency, permission, or
data flow. The default review sequence is:

1. prove and separately approve assistant-initiated navigation containment under PR-005/F-004;
2. consider the SHOULD capabilities PR-009, PR-010, PR-018, and PR-019 individually;
3. consider the COULD capabilities PR-011, PR-013, and PR-017 individually; and
4. clarify PR-006, PR-012, and PR-014–PR-016 before any planning for those capabilities.

F-016 and F-017 remain REFERENCE-ONLY unless a new approved Product Requirement changes their
destination. Every increment requires a refreshed observable-gap/traceability review, explicit product
approval, capability-specific action/data/permission matrices, clean-room architecture and contract
updates, and regression evidence on the supported Chrome/locale/accessibility matrix. The sequence is a
risk-ordered evolution path, not a release commitment or permission to prebuild deferred features.

### Explicitly Out of Scope

- Chat history, multiple simultaneous tasks, dark theme, a settings page, onboarding expansion, and any
  product capability not already approved for the POC are outside this usability pass.
- Assistant-initiated full-document, link, form, script-driven, or other navigation effects are deferred
  from the POC; user- or page-initiated navigation compatibility remains under CT-010.
- `F-016` desktop/CLI cloud or native companion control is `REFERENCE-ONLY`.
- `F-017` remote sandbox/orchestrator browser-worker behavior is `REFERENCE-ONLY`.
- Reference code, bundled/minified logic, private identifiers, assets, protocols, endpoints, providers,
  telemetry vendors, native hosts, remote orchestrators, storage keys, exact retry timing, and internal
  architecture are not product requirements.
- No UI framework, bundler, state-management approach, persistence engine, test framework, module
  topology, or internal messaging architecture is selected.
- No application source, manifest/runtime implementation, external-service client, package
  installation, deployment, or modification of the Reference Extension is authorized here.

### External Dependency Status

| Dependency category | Status | Specification boundary |
| --- | --- | --- |
| Chrome Extension platform | Required platform capability | Manifest V3; then-current and immediately preceding stable desktop Chrome majors; current-tab top-level ordinary HTTP(S) HTML under CT-010; distribution channel unresolved; no reference version floor or broad access inherited |
| AI conversation/orchestration service | Required product capability, provider unknown | Product-controlled server owns provider integration and task/tool orchestration; Extension mediates browser context, consent, and action execution; no reference provider or endpoint is inherited |
| Authentication service/session contract | Required product capability; account-based product session approved, identity provider unknown | Direct user-supplied AI-service credentials are excluded; only minimum session/security state may persist, logout clears authorization and account-bound local state, and exact renewal mechanics remain unresolved |
| Origin-safety classification service | Required only when local Q-007 rules return unknown; provider/protocol unknown | Product-controlled service receives canonical origin only; path/query/fragment and page data are not sent for classification; deny/unknown/invalid/unavailable fails closed; no reference endpoint or category scheme is inherited |
| Workflow processing service | Unknown and conditional on PR-012 | Server responsibility, schema, persistence, and fallback are unconfirmed |
| Hosted assistant service | Unknown and conditional on PR-014 | Origin, account, iframe behavior, persistence, server orchestration, and fallback are unconfirmed |
| Connector registry/services/transport | Unknown and conditional on PR-015 | Launch services, scopes, data flows, transport, server mediation, and errors are unconfirmed |
| Enterprise management contract | Unknown and conditional on PR-016 | Policy source, schema, precedence, invalid state, update, audit, and recovery are unresolved |
| Notification, export, and scheduling capabilities | Conditional on PR-011/013/017 | No related permission, file, or unattended authority belongs to baseline until adoption |
| Telemetry processors | Not a selected product dependency | Event purpose, content, consent, redaction, processors, sampling, and retention require Q-015 |
| F-016/F-017 companion or orchestrator services | REFERENCE-ONLY | No dependency, permission, connection, story, task, or acceptance scope |

## Requirement Traceability

### Product Requirement → User Story → Functional Requirement

Acceptance IDs preserve the Product Requirements Draft's 19 acceptance groups. A group may contain more
than one Given/When/Then scenario; the exact story scenario locations are shown below.

| Product Requirement | Classification | Reference evidence | User Story | Functional Requirement | Acceptance destination |
| --- | --- | --- | --- | --- | --- |
| PR-001 | MUST | F-001 | US-001 | FR-001 | AC-001 → US-001.1/4 |
| PR-002 | MUST | F-002 | US-001 | FR-002 | AC-002 → US-001.2–3/5–7 |
| PR-003 | MUST | F-003 | US-002; US-003 action-denial support | FR-003 | AC-003 → US-002.1/4; US-003.9 |
| PR-004 | MUST | F-005; F-009 page-context evidence | US-002 | FR-004 | AC-004 → US-002.2–3/6 |
| PR-005 | MUST | F-004; F-009 webpage file-input evidence | US-003 | FR-005 | AC-005 → US-003.1–2 |
| PR-006 | NEEDS-CLARIFICATION | F-006 | US-008 | FR-006 | AC-006 provisional → US-008.1–2 |
| PR-007 | MUST | F-007 | US-003 | FR-007 | AC-007 → US-003.3/6 |
| PR-008 | MUST | F-008; F-018 safety-policy evidence | US-003; US-007 grant-review support | FR-008 | AC-008 → US-003.4–5/7; US-007.1 |
| PR-009 | SHOULD | F-009 selected-context evidence | US-004 | FR-009 | AC-009 candidate → US-004.1–3 |
| PR-010 | SHOULD | F-010 | US-005 | FR-010 | AC-010 candidate → US-005.1–2 |
| PR-011 | COULD | F-011 | US-009 | FR-011 | AC-011 optional → US-009.1–2 |
| PR-012 | NEEDS-CLARIFICATION | F-012 | US-010 | FR-012 | AC-012 provisional → US-010.1–2 |
| PR-013 | COULD | F-013 | US-011 | FR-013 | AC-013 optional → US-011.1–2 |
| PR-014 | NEEDS-CLARIFICATION | F-014 | US-012 | FR-014 | AC-014 provisional → US-012.1–2 |
| PR-015 | NEEDS-CLARIFICATION | F-015 | US-013 | FR-015 | AC-015 provisional → US-013.1–2 |
| PR-016 | NEEDS-CLARIFICATION | F-018 | US-014 | FR-016 | AC-016 provisional → US-014.1–2 |
| PR-017 | COULD | F-019; F-011 task-status evidence | US-015 | FR-017 | AC-017 optional → US-015.1–2 |
| PR-018 | SHOULD | F-020 | US-006 | FR-018 | AC-018 candidate → US-006.1–3 |
| PR-019 | SHOULD | F-021; preference evidence from F-002/F-003/F-008/F-019 | US-007 | FR-019 | AC-019 candidate → US-007.1–6 |

**Product Requirement result**: `19/19` requirements have a stable story, functional requirement, and
acceptance destination.

### Reference Feature → Specification Destination

This table records all many-to-many destinations rather than treating each Reference Feature's primary
classification as the classification of every behavior it supports.

| Reference Feature | Specification destination | Disposition |
| --- | --- | --- |
| F-001 | PR-001 / US-001 / FR-001 | Mapped — core activation evidence |
| F-002 | PR-002 / US-001 / FR-002; PR-019 / US-007 / FR-019 preference evidence | Mapped — product-server boundary and account-session model approved; provider and exact identity/session mechanics not selected |
| F-003 | PR-003 / US-002 / FR-003; PR-003 / US-003 / FR-003 action-denial support; PR-019 / US-007 / FR-019 preference evidence | Mapped — product server orchestrates and Extension mediates browser effects; private reference loop not inherited |
| F-004 | PR-005 / US-003 / FR-005 | Mapped — Q-006 approves three current-tab POC actions; assistant navigation is a separately gated post-POC expansion |
| F-005 | PR-004 / US-002 / FR-004 | Mapped — bounded page context gated by Q-007 local-first origin safety and current-task consent |
| F-006 | PR-006 / US-008 / FR-006 | Mapped — conditional advanced diagnostics |
| F-007 | PR-007 / US-003 / FR-007 | Mapped — active control and Stop |
| F-008 | PR-008 / US-003 / FR-008; PR-019 / US-007 / FR-019 preference evidence | Mapped — Q-007 approves local-first, origin-only remote fallback and fail-closed outcomes; reference full-URL classifier/provider is not inherited |
| F-009 | PR-004 / US-002 / FR-004; PR-005 / US-003 / FR-005; PR-009 / US-004 / FR-009 | Mapped — bounded page context remains Core; webpage file-upload action is excluded from the POC; selected task context is deferred |
| F-010 | PR-010 / US-005 / FR-010 | Mapped — reusable instructions |
| F-011 | PR-011 / US-009 / FR-011; PR-017 / US-015 / FR-017 | Mapped — optional scheduling and related status evidence |
| F-012 | PR-012 / US-010 / FR-012 | Mapped — conditional; server/flag behavior unconfirmed |
| F-013 | PR-013 / US-011 / FR-013 | Mapped — optional export outcome, no proprietary format/assets |
| F-014 | PR-014 / US-012 / FR-014 | Mapped — conditional; iframe/server internals unconfirmed |
| F-015 | PR-015 / US-013 / FR-015 | Mapped — conditional; connector transport/server mediation unconfirmed |
| F-016 | No Product Requirement or User Story | REFERENCE-ONLY — desktop/CLI companion ecosystem excluded |
| F-017 | No Product Requirement or User Story | REFERENCE-ONLY — remote orchestrator ecosystem excluded |
| F-018 | PR-008 / US-003 / FR-008; PR-016 / US-014 / FR-016 | Mapped — core policy precedence plus conditional enterprise product |
| F-019 | PR-017 / US-015 / FR-017; PR-019 / US-007 / FR-019 | Mapped — optional notices plus preference evidence |
| F-020 | PR-018 / US-006 / FR-018 | Mapped — trusted generic handoff, not reference domains/IDs |
| F-021 | PR-019 / US-007 / FR-019 | Mapped — user-visible settings/locale/update; private flag mechanics remain evidence-only |

**Reference Feature result**: `21/21` features have explicit destinations. `F-016` and `F-017` remain
`REFERENCE-ONLY`; neither creates product scope, permissions, dependencies, acceptance behavior, or code.

## Open Decisions and Planning Gate

Ten of the 18 original source questions remain `UNRESOLVED`; Q-001 through Q-004, Q-006 through Q-008,
and Q-017 are resolved by explicit user approval. Quality-validation Q-019 and controlled form-context
Q-020 are also resolved, leaving ten unresolved questions in total and no `BLOCKS-PLANNING` decision.
The approved scope, responsibility
boundary, account-session model, POC retention/evolution policy, current-tab action/consent boundary,
local-first origin-safety policy, Chrome/page support contract, bilingual locale/fallback/evolution
contract, and single-owner POC accessibility/comprehension gate were not inferred from convention or
reference behavior. The separate clarification queue records each question's decision options,
recommendation status, impact, and blocking level.

The three specially protected uncertainty areas remain unchanged:

- **PR-012**: workflow-processing location, server behavior, final schema, persistence/transmission, and
  dynamic feature-flag behavior are not confirmed.
- **PR-014**: iframe-internal behavior, hosted UI/session ownership, persistence, capability contract,
  server orchestration, and fallback are not confirmed.
- **PR-015**: connector catalog, authorization contract, transport, service data flow, server mediation,
  and server-side failure behavior are not confirmed.

| ID | Related requirement/story | Decision required | Status |
| --- | --- | --- | --- |
| Q-001 | PR-001, PR-009–PR-019; F-016/F-017 | First-release candidate scope and entry points; whether either reference-only ecosystem is ever a separate product | RESOLVED — POC contains only seven MUST requirements; all candidates deferred; F-016/F-017 remain REFERENCE-ONLY |
| Q-002 | PR-002/PR-003; US-001/US-002 | AI conversation/browser-tool service and Extension-versus-server responsibilities | RESOLVED — product-controlled server owns AI provider integration and task/tool orchestration; Extension mediates browser context, consent, and browser actions; provider/protocol remain unselected |
| Q-003 | PR-002; US-001 | Account authorization, direct credential, product-backend session, or approved subset | RESOLVED — account-based product authorization only; no direct user AI-service credentials; identity provider/session representation remain unselected |
| Q-004 | PR-002–PR-006, PR-008–PR-017, PR-019 | Local/remote persistence, retention, account isolation, deletion/logout, grant, managed-policy, notice, and settings behavior by data category | RESOLVED — POC Core task/page/action data is transient with no durable remote history; only minimum session/security and separately approved local state may persist; logout clears authorization/account-bound local state; later capabilities require approved category matrices and no silent legacy-data upload |
| Q-005 | PR-006; US-008 | Which page-code, console, or network diagnostics are adopted and what authorization granularity applies | UNRESOLVED |
| Q-006 | PR-005/PR-007–PR-009; US-003/US-004 | Initial action set, batch/multi-tab scope, consent lifetime, plan approval, and bypass policy | RESOLVED — current tab only; scroll, non-navigation low-risk click, and non-sensitive text entry; assistant navigation deferred; approved visible plan for sequential same-document work; current-task consent; user/page navigation invalidates stale bindings and origin change requires fresh consent; no batch/multi-tab, webpage file upload, irreversible high-risk effect, persistent grant, or bypass; later expansion requires an action-policy matrix and release evidence |
| Q-007 | PR-004/PR-008; US-002/US-003 | URL/cross-site safety mechanism and any remote URL path/query transmission | RESOLVED — local allow/deny/unknown first; only unknown canonical origin may reach a product-controlled service; path/query/fragment and page data are not sent for classification; remote deny/unknown/invalid/unavailable fails closed; allow is not consent; classification is transient; no reference provider/protocol/category scheme/full-URL behavior is inherited |
| Q-008 | PR-001/PR-004/PR-005/PR-009 | Supported Chrome versions, page/frame types, restricted contexts, and complex-page cases | RESOLVED — at release, current and immediately preceding stable desktop Chrome majors; current-tab top-level ordinary HTTP(S) HTML only, including revalidation after user/page navigation, reload, and same-origin SPA updates; this does not authorize assistant navigation; iframe/Shadow DOM/PDF/internal/extension/Web Store/file/data/blob/incognito/canvas-WebGL-only contexts explicitly unsupported |
| Q-009 | PR-011/PR-017; US-009/US-015 | Cadence, missed schedule, sleep/closure, auth/consent, effect-uncertain retry/deduplication, and schedule lifecycle behavior | UNRESOLVED |
| Q-010 | PR-012; US-010 | Workflow capture, processing, editing granularity, persistence, transmission, and recovery | UNRESOLVED |
| Q-011 | PR-014; US-012 | Hosted experience scope, ownership, origin, account/session, capability-contract representation, persistence, and fallback | UNRESOLVED |
| Q-012 | PR-015; US-013 | Connectors, tools, authorization/consent model, scopes, revocation, data flow, errors, transport, and server mediation | UNRESOLVED |
| Q-013 | PR-016; US-014 | Enterprise target and complete managed-policy contract, including invalid-policy behavior | UNRESOLVED |
| Q-014 | PR-011/PR-017; US-009/US-015 | Notice events, initial/default behavior, categories, sound, quiet hours, and denial fallback | UNRESOLVED |
| Q-015 | CT-013; cross-cutting | Analytics/error/performance purpose, fields, content, consent, processors, redaction, sampling, and retention | UNRESOLVED |
| Q-016 | PR-012/PR-014/PR-015/PR-019; F-017 | Dynamic flags, control authority, gated capabilities, and whether flags may change permission/data/dependency behavior | UNRESOLVED |
| Q-017 | PR-019; US-007 | Launch locales, fallback locale, and localized user-facing surfaces | RESOLVED — `en-US` English and `zh-TW` Traditional Chinese across every adopted POC user-facing surface; reviewed English fallback; no internal identifiers or ambiguous safety text; broader settings remain deferred; future locales require a complete reviewed coverage matrix and are not inherited from reference resources |
| Q-018 | PR-013; US-011 | Export formats, content scope, redaction, warning, branding, replay, deletion, and file lifetime | UNRESOLVED |
| Q-019 | CT-012; SC-009/SC-010 | Accessibility test target/setup and user-comprehension evaluator and success threshold | RESOLVED — one designated product owner; Windows 11; both supported Chrome majors; `en-US` and `zh-TW`; separate keyboard-only and current-stable-NVDA passes; 100% of declared accessibility and comprehension cases pass; POC owner acceptance only, not representative multi-user evidence |
| Q-020 | PR-004/PR-008; US-002; F-005 | POC form-value visibility, consent granularity, sensitive/ambiguous handling, and parity evolution | RESOLVED — controlled parity: `page.form-values` is separately disclosed and granted per current task/document; only bounded task-relevant ordinary values and selected-option state conclusively classified non-sensitive may be returned; sensitive/ambiguous values reveal no value/length/partial; data is transient and invalidated by context/lifecycle change; later expansion requires a new approved matrix/profile |

Planning may now begin because the clarification queue contains no `BLOCKS-PLANNING` decision. Every
unresolved question above remains non-authoritative and cannot expand the approved POC scope; its
corresponding deferred or optional capability requires a later explicit decision before adoption.

## Document Change Boundary

This workflow creates or updates only Spec-Kit governance and specification artifacts. It does not
modify the reference analysis documents (private archive), or
`docs/product-requirements-draft.md`, and it creates no implementation code.
