# Clean-room Product Requirements Draft — Chrome AI Browser Assistant

> Status: Phase 2 draft for product review  
> Date: 2026-08-24  
> Derived from the observable behaviour of an existing browser assistant (the analysis itself is not published; the public account is <code>docs/design-notes.md</code>)  
> Evidence boundary: Static analysis only; dynamic feature flags, hosted iframe internals, and server-side behavior are not confirmed.

## 1. Document Purpose

This document converts confirmed, user-observable behavior from the Reference Extension into a clean-room product requirements draft for a new Chrome Extension. It defines product outcomes, user journeys, data and consent expectations, failure behavior, and open product decisions. It does not prescribe a software architecture or authorize implementation.

The Reference Extension is evidence of product behavior, not a template for the new implementation. Bundle names, internal symbols, private identifiers, storage keys, proprietary assets, exact message protocols, and existing module boundaries are intentionally excluded from normative requirements.

### Requirement language

| Classification | Meaning in this draft |
| --- | --- |
| MUST | Required for the core product proposition or its safety boundary. |
| SHOULD | Strongly supported product capability, but release placement remains a product decision. |
| COULD | Confirmed reference behavior that is optional for the initial product. |
| NEEDS-CLARIFICATION | A candidate capability whose product importance, UX, dependency, or security boundary is unresolved. |
| REFERENCE-ONLY | Observed in the Reference Extension but not adopted as a new-product requirement. |
| OUT-OF-SCOPE | Explicitly excluded from this phase or product boundary. |

Each <code>PR-XXX</code> is a feature-level Product Requirement. Its matching <code>FR-XXX</code> is the normative statement of what the product does. Acceptance criteria test observable behavior only.

### Draft totals

- Product Requirements: 20 (PR-020 added 2026-09-08 by owner decision, feature 003)
- MUST: 8
- SHOULD: 4
- COULD: 3
- NEEDS-CLARIFICATION: 5
- REFERENCE-ONLY reference features: 1 (F-017; F-016 moved to PR-020 on 2026-09-08)
- Reference traceability: all F-001 through F-021 accounted for

## 2. Product Summary

The proposed product is a Chrome-based AI browsing companion that remains available alongside the user’s current browsing context. Its core value is to let a user:

1. Open an assistant for the current browsing task.
2. Ask questions using explicitly allowed page context.
3. Request visible browser actions such as navigation, clicking, typing, scrolling, and tab operations.
4. Understand what the assistant is controlling, approve sensitive actions, and stop activity immediately.
5. Receive a clear result or an actionable failure state.

The reference evidence also supports candidate capabilities for screenshots and attachments, reusable instructions, scheduling, workflow teaching, export, enterprise controls, notifications, hosted experiences, and external connectors. Their inclusion and priority are not inferred solely from their presence in the Reference Extension.

The product does not require the same UI framework, runtime topology, network providers, storage layout, or inter-component communication design as the reference.

## 3. Product Boundary

### 3.1 Product responsibilities

The product boundary includes:

- User-facing activation and assistant interaction inside Chrome.
- User-authorized acquisition of browser context.
- User-authorized browser actions and multi-step task execution.
- Activity visibility, consent, cancellation, and site-safety controls.
- Authentication state needed to reach the chosen AI service.
- Product-owned preferences, reusable tasks, and candidate automation data.
- Clear handling of unsupported pages, denied permission, network failure, authentication failure, and stale browser state.

The boundary does not include undocumented behavior inside a hosted iframe, an unknown server implementation, native desktop applications, or proprietary reference-service internals.

### 3.2 Trust boundaries

| Boundary | Product concern |
| --- | --- |
| User ↔ Extension | Informed consent, clear triggers, action visibility, stop control, understandable failures. |
| Extension ↔ Current webpage | Untrusted page content, prompt injection, sensitive fields, stale or changed page state. |
| Extension ↔ AI service | Authentication, page-data transmission, tool-call validation, retry and cancellation. |
| Extension ↔ Other external services | Separate authorization, minimum data disclosure, connector-specific consent. |
| Extension ↔ Browser platform | Restricted pages, permission grants, lifecycle interruption, supported Chrome behavior. |
| Administrator ↔ Managed browser | Policy precedence, blocked destinations, permitted organization/account scope. |

### 3.3 Technical Constraints

| ID | Constraint |
| --- | --- |
| TC-001 | The deliverable is a Chrome Extension and must comply with the applicable Chrome Extension platform and browser security model. |
| TC-002 | The product must handle browser pages or contexts where extension access is unavailable without claiming success or attempting to bypass Chrome restrictions. |
| TC-003 | Permission selection must follow least privilege; broad host access is not a default product requirement and requires separate planning justification. |
| TC-004 | Long-running or scheduled user outcomes must tolerate normal Extension context suspension or restart without duplicating actions or silently losing final status. |
| TC-005 | Webpage content and remote tool instructions are untrusted input and must be validated before privileged browser actions. |
| TC-006 | External authentication and service contracts must be specified before implementation; the Reference Extension’s providers and endpoints are not automatically selected. |
| TC-007 | The minimum supported Chrome version and distribution channel require an explicit planning decision. The reference version is evidence, not the new target. |
| TC-008 | No frontend framework, state library, bundler, architecture pattern, persistence engine, or test framework is selected in this phase. |

## 4. Personas / Users

| ID | Persona | Needs | Relevant requirements |
| --- | --- | --- | --- |
| P-001 | Assisted browsing user | Ask about a page and receive useful answers without leaving the browsing task. | PR-001–PR-004, PR-007–PR-009 |
| P-002 | Browser task user | Delegate visible browser actions while retaining consent and stop control. | PR-003–PR-009 |
| P-003 | Repeat-work user | Save, teach, schedule, and monitor recurring browser tasks. | PR-010–PR-012, PR-017 |
| P-004 | Technical user | Inspect page behavior with advanced JavaScript, console, or network context when explicitly authorized. | PR-006 |
| P-005 | Connected-service user | Use separately authorized external tools from the assistant. | PR-015 |
| P-006 | Enterprise administrator | Restrict destinations and authorized organization/account use. | PR-016 |
| P-007 | Product administrator / operator | Configure product defaults, releases, localization, and privacy-safe operational visibility. | PR-019, NFR-007–NFR-010 |

Personas P-004 and P-005 represent candidate scope, not assumed core users.

## 5. User Journeys

### UJ-001 — Start an authenticated browsing session

<strong>Related requirements:</strong> PR-001, PR-002, PR-003

    User opens a supported webpage
      → activates the assistant
      → signs in or restores an authorized session
      → submits a request
      → sees streamed or progressive output
      → receives a result or explicit failure

### UJ-002 — Ask about the current page

<strong>Related requirements:</strong> PR-001, PR-003, PR-004, PR-008

    User asks a page-related question
      → product identifies the requested context
      → requests consent if required
      → collects only allowed page information
      → excludes or redacts sensitive fields
      → sends the approved context to the AI service
      → presents an answer or page-access failure

### UJ-003 — Delegate a browser task

<strong>Related requirements:</strong> PR-003, PR-004, PR-005, PR-007, PR-008

    User requests a browser outcome
      → product proposes or selects the next browser action
      → checks site and action authorization
      → visibly marks active control
      → performs the action against the current verified page
      → verifies the resulting state
      → repeats or returns a final result
      → user may stop at any time

### UJ-004 — Add visual or file context

<strong>Related requirements:</strong> PR-003, PR-008, PR-009

    User chooses a file, pasted image, screenshot, region, or page element
      → product previews or identifies the chosen material
      → user confirms its use where required
      → material is attached to the current task
      → product reports success, unsupported format, size limit, or capture failure

### UJ-005 — Reuse and optionally schedule a task

<strong>Related requirements:</strong> PR-010, PR-011, PR-017

    User saves an instruction
      → names and categorizes it
      → optionally assigns a start page and schedule
      → product launches it at the requested time
      → user can inspect completion or failure status

### UJ-006 — Teach a workflow by demonstration

<strong>Related requirements:</strong> PR-009, PR-010, PR-012

    User starts workflow teaching
      → demonstrates browser steps
      → optionally narrates by voice
      → reviews and edits captured steps
      → saves the result as a reusable task

This journey is provisional because remote transformation and feature-gating behavior are unconfirmed.

### UJ-007 — Export a conversation or action replay

<strong>Related requirements:</strong> PR-013

    User selects export
      → product identifies included conversation and action data
      → warns about sensitive content
      → creates a user-downloadable artifact
      → reports completion or generation failure

### UJ-008 — Use a hosted experience or connected service

<strong>Related requirements:</strong> PR-014, PR-015

    User chooses an alternate hosted experience or connector
      → product checks the relevant account authorization
      → displays available capability
      → asks for tool-specific permission
      → returns the external result in the browsing task

This journey remains unresolved because iframe internals, connector transport, and server behavior are outside the confirmed evidence.

### UJ-009 — Apply enterprise policy

<strong>Related requirements:</strong> PR-002, PR-008, PR-016

    Administrator configures allowed organization/account and blocked destinations
      → product observes the effective policy
      → user attempts a restricted login or page action
      → product blocks the operation
      → user receives a clear reason and permitted recovery action

### UJ-010 — Onboard and configure the product

<strong>Related requirements:</strong> PR-001, PR-018, PR-019

    User follows a trusted onboarding entry
      → assistant opens with the intended starter task
      → user reviews permissions and preferences
      → product retains supported choices
      → subsequent sessions reflect the effective configuration

## 6. Functional Requirements

### PR-001 — Activate the Assistant for the Current Browsing Context

#### Reference

Derived from F-001.

#### Classification

MUST.

#### Functional Requirement

<strong>FR-001:</strong> The product must let the user open, focus, and close an AI assistant workspace associated with the current browsing context through at least one explicit browser entry point.

#### User

P-001 Assisted browsing user; P-002 Browser task user.

#### User Goal

Start or resume an AI-assisted task without abandoning the webpage being used.

#### Preconditions

- The Extension is installed and enabled.
- Chrome exposes a supported user-facing activation surface.

#### Trigger

Toolbar action or configured keyboard shortcut. Trusted onboarding and automation handoffs are alternative triggers covered by PR-018 and PR-011.

#### Main Flow

Step 1: The user explicitly activates the product.  
→ Step 2: The product identifies the current browsing context.  
→ Step 3: The assistant workspace becomes visible and indicates which page or task it relates to.  
→ Expected Result: The user can enter or resume a request and can close or toggle the workspace.

#### Alternative Flows

- The user activates the product when the workspace is already open; it is focused or closed according to the documented toggle behavior.
- A trusted product handoff opens the workspace with a starter task or settings destination.

#### Failure Flows

- Unsupported browser capability: show that the assistant surface cannot be opened and provide a supported recovery path.
- No accessible current tab: open the workspace without claiming page context is available, or show a clear access failure.

#### Inputs

User activation, current tab/window context, prior workspace state.

#### Outputs

A visible assistant workspace, focus/toggle result, or explicit activation error.

#### Data Involved

Current page URL/title where permitted, tab/window identity, current task association, UI open state.

#### Privacy / Security

Opening the workspace must not by itself imply consent to transmit page contents. Page access and external transmission are governed by PR-004 and PR-008.

#### Acceptance Criteria

**Given** the user is viewing a supported webpage and the Extension is enabled  
**When** the user activates the primary browser entry point  
**Then** the assistant workspace is visibly opened and associated with the current browsing context without performing a browser action on the page.

### PR-002 — Authenticate and Manage an Authorized Session

#### Reference

Derived from F-002.

#### Classification

MUST for an authorized service session; API-key mode is unresolved in Q-003.

#### Functional Requirement

<strong>FR-002:</strong> The product must establish, restore, refresh, and end an authorized session for the selected AI service, and must require reauthentication when authorization is no longer valid.

#### User

All users who access a non-local AI service; P-006 Enterprise administrator for organization restrictions.

#### User Goal

Access the AI service securely without repeatedly signing in, and reliably end access when logging out.

#### Preconditions

- An AI service and authentication contract have been selected.
- The user has a valid account or other approved credential method.

#### Trigger

First use, explicit sign-in, expired session, rejected credential, account switch, or logout.

#### Main Flow

Step 1: The product explains the account or credential needed.  
→ Step 2: The user completes the approved authorization flow.  
→ Step 3: The product verifies the resulting account/session.  
→ Step 4: The user enters the authenticated assistant state.  
→ Expected Result: Authorized requests can proceed until logout, expiry, revocation, or policy mismatch.

#### Alternative Flows

- A valid session is restored without interactive sign-in.
- An expiring session is refreshed without interrupting the current task.
- A direct API credential can be used only if Q-003 adopts that mode and defines its storage and revocation policy.

#### Failure Flows

- Network or provider unavailable: retain no false signed-in state and offer retry.
- Invalid, expired, or revoked credential: stop protected requests and request reauthentication.
- Organization/account policy mismatch: block use and offer an allowed account switch or logout.
- Authorization canceled: return to a usable signed-out state.

#### Inputs

User authorization action, identity-provider response, session expiry, account and organization identity, logout action.

#### Outputs

Signed-in state, signed-out state, reauthentication prompt, or policy-block explanation.

#### Data Involved

Authentication state, access/refresh material where applicable, expiry, account identifier, organization identifier, failure reason.

#### Privacy / Security

Credentials must be isolated from webpages, scoped to the required service, protected according to sensitivity and lifetime, and cleared or invalidated according to the logout/account-switch policy. Raw credentials must not appear in logs, exports, page context, or telemetry.

#### Acceptance Criteria

**Given** the user has an expired or rejected service session  
**When** the user submits a protected AI request  
**Then** the product does not send an unauthenticated browser task, clearly requests reauthentication, and resumes protected use only after successful authorization.

### PR-003 — Conduct an AI Conversation and Task Loop

#### Reference

Derived from F-003.

#### Classification

MUST.

#### Functional Requirement

<strong>FR-003:</strong> The product must accept a user request, present progressive task output, execute only authorized browser capabilities requested during the task, feed observable action results back into the task, and terminate with a result, cancellation, or explicit failure.

#### User

P-001 Assisted browsing user; P-002 Browser task user.

#### User Goal

Describe an outcome in natural language and receive either an answer or a completed browser task.

#### Preconditions

- PR-001 workspace is available.
- PR-002 authorization is valid.
- Any requested page data or browser action satisfies PR-008.

#### Trigger

The user submits text, a reusable instruction, or approved attached context.

#### Main Flow

Step 1: The user submits a request.  
→ Step 2: The product shows that processing has started and progressively presents available output.  
→ Step 3: If browser context or an action is needed, the product obtains the required consent.  
→ Step 4: The authorized capability runs and returns a result to the task.  
→ Step 5: The product continues until no further authorized action is needed.  
→ Expected Result: The user sees a final answer, completed outcome, or precise failure.

#### Alternative Flows

- The request is answered without using browser context or actions.
- The user cancels during generation or action execution.
- The product offers a bounded retry after a transient service failure.
- Model choice or custom instructions are applied only if adopted under PR-019.

#### Failure Flows

- AI service unavailable, rate-limited, or stalled: stop unbounded work, preserve a safe recoverable state, and show retry/cancel guidance.
- Tool result invalid or action fails: report the failed step; do not invent success.
- User denies a requested action: continue without it when meaningful, or explain why the task cannot continue.
- Authentication becomes unavailable: pause protected work and invoke PR-002.

#### Inputs

User text, conversation context, approved page context, attachments, saved instructions, approved tool results.

#### Outputs

Progress indication, assistant content, action status, final result, cancellation state, or failure reason.

#### Data Involved

Conversation messages, selected model/preferences if supported, approved page data, attachments, action plans, action inputs/results, task/session identifiers.

#### Privacy / Security

The product must identify what user/page data may be sent to the AI service and must not include denied or unrelated browser context. The loop must be bounded and cancelable; remote instructions are untrusted until validated against PR-008.

#### Acceptance Criteria

**Given** an authenticated user submits a request that can be completed without a browser action  
**When** the AI service returns progressive content and a final response  
**Then** the product displays progress, renders the final response, and leaves no task marked as still running.

**Given** a request needs a browser action  
**When** the user denies that action  
**Then** the product performs no denied action and reports whether the task can continue or why it stopped.

### PR-004 — Acquire Bounded Page Context

#### Reference

Derived from F-005 and the context-reading portion of F-009.

#### Classification

MUST.

#### Functional Requirement

<strong>FR-004:</strong> The product must obtain only the user-authorized, task-relevant page structure and text needed to answer or act, must bound collection, and must redact known sensitive form values from general page-context output.

#### User

P-001 Assisted browsing user; P-002 Browser task user.

#### User Goal

Let the assistant understand the current page well enough to answer questions or identify an actionable element.

#### Preconditions

- The current page is supported and accessible to the Extension.
- The user has granted the required page/context access.

#### Trigger

An explicit page-related request or an authorized task step that requires current page context.

#### Main Flow

Step 1: The product identifies the current page and requested context scope.  
→ Step 2: It checks page access and consent.  
→ Step 3: It collects bounded, task-relevant structure/text and identifies actionable elements.  
→ Step 4: It redacts known sensitive form values.  
→ Expected Result: The task receives usable context or a clear reason that context is unavailable.

#### Alternative Flows

- Read only main page text.
- Read the visible viewport or a user-selected element/region.
- Read a specific supported frame when the user’s task identifies it.

#### Failure Flows

- Browser-internal or restricted page: report unsupported page access.
- Page denies access or permission is denied: collect nothing and explain the failure.
- Page changes during collection or an element reference becomes stale: discard the stale result and request refresh/retry.
- Content exceeds safe limits: return a bounded subset and disclose truncation, or fail clearly.

#### Inputs

Page URL/title, rendered page structure/text, element labels/roles/geometry, selection or viewport scope, permission state.

#### Outputs

Bounded page context, actionable element descriptions, redacted fields, truncation notice, or access error.

#### Data Involved

Page URL/title, DOM-derived text and structure, element metadata, selected options and non-sensitive values, viewport/frame context.

#### Privacy / Security

Passwords, one-time codes, payment-card values, and other identified sensitive autocomplete/form values must not appear in general page-context output. Screenshots, script execution, and network inspection can expose data beyond this redaction and are governed separately.

#### Acceptance Criteria

**Given** the user is on a supported page containing ordinary text and a password field  
**When** the user authorizes the assistant to read the page  
**Then** the assistant receives bounded page structure/text, the password value is excluded or redacted, and the UI reports any truncation or access limitation.

### PR-005 — Execute Authorized Browser Actions

#### Reference

Derived from F-004 and the website file-input portion of F-009.

#### Classification

MUST.

#### Functional Requirement

<strong>FR-005:</strong> The product must execute an approved set of observable browser actions within the active task scope, verify that each action still targets the intended page state, and report success or failure for every attempted step.

#### User

P-002 Browser task user.

#### User Goal

Delegate concrete browser work such as navigating, clicking, typing, scrolling, keyboard interaction, file selection, and task-related tab operations.

#### Preconditions

- The task is active and authenticated where required.
- The page and requested action are supported.
- PR-008 grants the relevant site/action permission.

#### Trigger

The user requests a browser outcome and the task selects a supported action needed to reach it.

#### Main Flow

Step 1: The product identifies the intended page, target, action, and expected effect.  
→ Step 2: It checks consent, site safety, and current page state.  
→ Step 3: It visibly marks the task as controlling the browser.  
→ Step 4: It performs the action.  
→ Step 5: It verifies the resulting page/tab state and returns the result.  
→ Expected Result: The task proceeds from verified results rather than assumed success.

#### Alternative Flows

- A multi-step task executes sequential actions and stops at the first unsafe or failed step.
- Navigation opens a task-related tab rather than replacing the current page, if the user’s request permits it.
- A user-selected file is placed into a supported webpage file input after explicit approval.
- The user approves a plan before the first action when plan review is enabled.

#### Failure Flows

- Target is stale, missing, hidden, or changed: do not act on a substitute target; refresh context or report failure.
- The page URL/origin changes between approval and execution: re-evaluate authorization before continuing.
- Tab closes or navigates unexpectedly: stop the affected sequence and report it.
- Browser restriction or unsupported action: report unsupported capability.
- User stops the task: invoke PR-007 and perform no new actions.

#### Inputs

Task intent, target page/tab, element or coordinates, text/keys, navigation destination, selected file, permission state.

#### Outputs

Visible page/tab change, step result, updated task context, or precise action failure.

#### Data Involved

Page URL/origin, element metadata, typed content, selected file metadata/bytes, tab/window state, action arguments/results.

#### Privacy / Security

User-selected sensitive form values, uploaded files, and cross-origin navigation are high-sensitivity actions. Product/AI-service authentication material must never be exposed to the webpage. A user-selected website form value may be entered only under consent bound to the intended site, field, action, and task; approval must not be reused after a material page/origin change without the policy defined by PR-008.

#### Acceptance Criteria

**Given** the user has approved typing a specific value into a specific field on the current site  
**When** the page remains on the approved origin and the target is still valid  
**Then** the product enters the value, reports the action result, and does not interact with unrelated fields or tabs.

**Given** the approved page navigates to a different origin before the action runs  
**When** the product re-evaluates the pending action  
**Then** it does not silently reuse the prior approval and requests new authorization or stops.

### PR-006 — Provide Advanced Page Diagnostics

#### Reference

Derived from F-006.

#### Classification

NEEDS-CLARIFICATION.

#### Functional Requirement

<strong>FR-006:</strong> If included, the product must separately authorize and visibly report (a) execution of diagnostic JavaScript in a webpage and (b) observation of console or network diagnostic data.

#### User

P-004 Technical user.

#### User Goal

Diagnose technical page behavior that cannot be understood from ordinary visible page context.

#### Preconditions

- Q-005 adopts one or more advanced diagnostic capabilities.
- The page and Chrome environment support the chosen capability.
- The user grants explicit high-risk permission for the current scope.

#### Trigger

An explicit technical-diagnostics request and a separate high-risk consent action.

#### Main Flow

Step 1: The product identifies whether code execution, console observation, or network observation is requested.  
→ Step 2: It explains the data and page effects involved.  
→ Step 3: The user approves or denies that specific diagnostic capability.  
→ Step 4: The product performs only the approved diagnostic operation and shows its result.  
→ Expected Result: The user receives technical evidence without granting unrelated browser control.

#### Alternative Flows

- The user approves read-only console observation but denies code execution.
- The user limits access to the current site/task rather than persistent access.

#### Failure Flows

- Permission denied: no diagnostic access occurs.
- Browser diagnostic channel unavailable or already occupied: report the conflict and offer a safe retry.
- Page changes origin: stop and request renewed authorization.
- Exact behavior for partial network bodies or unsupported protocols is not confirmed.

#### Inputs

Diagnostic request, optional script, current origin, console events, network metadata/content when approved.

#### Outputs

Script result, console/network diagnostic report, denial, conflict, or unsupported-capability error.

#### Data Involved

Page execution results, console messages, request/response metadata and possible bodies, current URL/origin.

#### Privacy / Security

These capabilities can expose credentials, personal data, and application internals or alter the page. They must not inherit ordinary page-read consent and remain outside default scope until Q-005 is resolved.

#### Acceptance Criteria

**Given** advanced diagnostics are enabled and the user approves console observation but not JavaScript execution  
**When** the task requests both capabilities  
**Then** the product returns the permitted console data or an explicit console-read error, performs no script execution, and clearly reports the denied portion.

### PR-007 — Show Active Control and Stop Immediately

#### Reference

Derived from F-007.

#### Classification

MUST.

#### Functional Requirement

<strong>FR-007:</strong> The product must make active browser control and its affected browsing context visibly distinguishable, and must provide an immediately reachable stop control that prevents new task actions.

#### User

All users during browser action execution.

#### User Goal

Know when and where the assistant is acting, return to the task, and stop control if behavior is unexpected.

#### Preconditions

An active task has begun reading or controlling one or more pages.

#### Trigger

Start of browser control, a task-related tab becoming active, user selecting Stop, or the task ending.

#### Main Flow

Step 1: The product marks the affected page/task as active.  
→ Step 2: The user can identify the related assistant workspace and stop control.  
→ Step 3: If Stop is selected, the product cancels pending work and prevents new actions.  
→ Step 4: The product clears active-control indicators when control has ended.  
→ Expected Result: The user sees a reliable transition from active to stopped/completed.

#### Alternative Flows

- The user switches between multiple task-related tabs while the same task remains active.
- The product organizes task-related tabs, but the organization method is not prescribed.

#### Failure Flows

- Stop delivery cannot be confirmed: warn the user that cancellation is not yet confirmed and continue retry/cleanup without claiming stopped state.
- An affected tab closes: clear its indicator and update task status.
- Browser context restarts: recover or clear stale active indicators before new actions.

#### Inputs

Task activity state, affected browsing contexts, user stop action, tab visibility/lifecycle state.

#### Outputs

Active indicator, current task/page association, stopped/completed state, or cancellation warning.

#### Data Involved

Task identifier, affected tab identities, activity/stop status; no page contents are needed merely to display status.

#### Privacy / Security

The indicator must not expose task secrets in page-visible text. Stop must take precedence over queued actions. Exact visual assets, colors, grouping, and timing remain design decisions.

#### Acceptance Criteria

**Given** the assistant is actively performing browser actions  
**When** the user selects Stop  
**Then** no new browser action starts, pending work is canceled where possible, and the product visibly reports stopped or explicitly warns that stop confirmation failed.

### PR-008 — Enforce User Consent and Site Safety

#### Reference

Derived from F-008 and the user-safety portion of F-018.

#### Classification

MUST.

#### Functional Requirement

<strong>FR-008:</strong> The product must evaluate site, origin, data sensitivity, and action risk before privileged browser behavior; must obtain appropriately scoped user consent; must allow supported grants to be reviewed and revoked; and must fail closed when required safety state cannot be established.

#### User

All browser task users; P-006 administrator when enterprise policy applies.

#### User Goal

Control what the assistant can read or do, on which sites, for how long, and recover from an unsafe or mistaken grant.

#### Preconditions

- A request needs page data, a browser action, a cross-site transition, or an external tool.
- A risk/consent policy has been defined for that capability.

#### Trigger

First use on a site, sensitive action, cross-origin transition, plan review, external-tool request, or explicit permission-settings action.

#### Main Flow

Step 1: The product identifies the site, action, data, and task scope.  
→ Step 2: It applies administrator policy where present.  
→ Step 3: It determines whether prior consent is valid for the current scope.  
→ Step 4: If needed, it asks the user to allow once, persist an appropriately limited grant, or deny.  
→ Step 5: It revalidates the destination/page before execution.  
→ Expected Result: Only authorized behavior proceeds; the decision remains inspectable and revocable.

#### Alternative Flows

- The user reviews and approves a task plan before actions begin.
- An administrator policy blocks the destination without offering a user override.
- A low-risk task proceeds under an existing still-valid site/action grant.

#### Failure Flows

- User denies or dismisses the prompt: treat as denial and perform no action.
- Safety classification or policy state is unavailable: do not silently execute the protected behavior.
- Page or origin changes after approval: re-evaluate before continuing.
- Expert bypass/skip-all behavior is not adopted; its product status remains unresolved in Q-006.

#### Inputs

Page URL/origin, action category, requested data, current task, prior grants, administrator policy, optional safety assessment.

#### Outputs

Allow/deny decision, consent prompt, policy-block explanation, grant record, revocation result.

#### Data Involved

Site/origin, action type, grant scope/lifetime, task identity, policy settings, optional URL safety input/result.

#### Privacy / Security

Persistent grants must be narrower than unrestricted global access where feasible. Sending full URLs to any external safety service requires separate disclosure and data-minimization review. Prompt injection in page content must not be treated as user consent.

#### Acceptance Criteria

**Given** a task is authorized to read the current site but has no approval to type or navigate cross-origin  
**When** it requests a cross-origin navigation followed by form input  
**Then** the product obtains the required new consent, performs neither action if consent is denied, and records no broader grant than the user selected.

### PR-009 — Add User-Selected Visual and File Context

#### Reference

Derived from the context-capture portion of F-009.

#### Classification

SHOULD.

#### Functional Requirement

<strong>FR-009:</strong> The product should let the user add an explicitly selected file, pasted image, visible-page screenshot, region, or page element to the current AI task and should report the included scope and any capture/format/size failure.

#### User

P-001 Assisted browsing user; P-002 Browser task user.

#### User Goal

Provide visual or file information that page text alone cannot convey.

#### Preconditions

- The assistant workspace and current task are available.
- The source material is accessible and uses a supported type/size.
- Required page or media access is granted.

#### Trigger

Attachment chooser, paste action, screenshot action, region selection, element selection, or an explicitly approved task request for visual context.

#### Main Flow

Step 1: The user selects the source and scope.  
→ Step 2: The product identifies or previews the material to be included.  
→ Step 3: It validates support, size, and access.  
→ Step 4: It attaches the material to the current task.  
→ Expected Result: The user sees that the intended material is included in the current task.

#### Alternative Flows

- Paste one or more images from the clipboard.
- Capture the visible page, a region, or a specific element.
- Use a screenshot captured during an authorized browser action.
- Uploading a selected file into a webpage is handled as a browser action under PR-005, not as task context.

#### Failure Flows

- Unsupported file type or size: reject it with an actionable explanation.
- Page capture unavailable or permission denied: attach nothing and report the reason.
- Element/page changes during selection: invalidate stale selection and request a new one.
- Measurable size and retention limits are not confirmed and must be set during planning/testing.

#### Inputs

Selected file bytes/metadata, pasted image, page pixels, selection bounds, element metadata, user confirmation.

#### Outputs

Attachment preview/indicator, attached context, or capture/validation error.

#### Data Involved

File names/types/bytes, image pixels, page URL/title, screenshot/region/element metadata, task identifier.

#### Privacy / Security

Screenshots and files may include information that DOM redaction cannot detect. The product must make user selection explicit, limit temporary retention, prevent unrelated attachments, and disclose external transmission before or at task submission.

#### Acceptance Criteria

**Given** the user selects a supported image for the current task  
**When** validation succeeds  
**Then** the product visibly adds that image to the current task and does not include any unselected file.

### PR-010 — Manage Reusable Instructions

#### Reference

Derived from F-010.

#### Classification

SHOULD.

#### Functional Requirement

<strong>FR-010:</strong> The product should let the user create, name, categorize, view, edit, delete, and reuse instructions or task templates.

#### User

P-003 Repeat-work user.

#### User Goal

Avoid rewriting common instructions and keep repeatable work organized.

#### Preconditions

- The user has an instruction or completed workflow worth saving.
- Product storage is available.

#### Trigger

Save instruction, manage reusable tasks, select a saved item, or save an output from PR-012.

#### Main Flow

Step 1: The user enters a name, instruction, and optional category.  
→ Step 2: The product validates and saves the item.  
→ Step 3: The item appears in the user’s reusable-task list.  
→ Step 4: The user selects it in a later task.  
→ Expected Result: The saved instruction is populated or executed according to the confirmed run policy.

#### Alternative Flows

- Edit name, instruction, category, optional start page, or other adopted metadata.
- Delete an item.
- Save a demonstrated workflow as a reusable item if PR-012 is adopted.

#### Failure Flows

- Invalid or empty required fields: identify the field and do not save.
- Storage unavailable or quota exceeded: preserve the user’s unsaved input and report failure.
- Saved item references an unavailable model/page: allow editing or report incompatibility before execution.

#### Inputs

Name, instruction, category, optional start page/model metadata, create/edit/delete action.

#### Outputs

Saved-item list, populated task, update/delete confirmation, or storage error.

#### Data Involved

User-authored instructions, categories, optional page/model metadata, created/updated timestamps if adopted.

#### Privacy / Security

Saved instructions may contain confidential text or destinations. The product must expose deletion, avoid treating a saved instruction as perpetual site consent, and apply PR-008 again at execution time.

#### Acceptance Criteria

**Given** the user saves a valid named instruction  
**When** the user later opens the reusable-task list  
**Then** the item is present, can be edited or deleted, and reusing it does not bypass current authentication or site/action consent.

### PR-011 — Schedule a Saved Task

#### Reference

Derived from F-011.

#### Classification

COULD.

#### Functional Requirement

<strong>FR-011:</strong> The product could let the user schedule a saved task for one-time or recurring execution and inspect whether each run completed, failed, or requires attention.

#### User

P-003 Repeat-work user.

#### User Goal

Run a known browser task at a chosen time without manually reopening and resubmitting it.

#### Preconditions

- PR-010 saved task exists.
- Schedule frequency/time and start context are valid.
- Authentication and unattended-consent policy are defined.
- Chrome and the device can support the chosen execution semantics.

#### Trigger

User creates/enables a schedule; scheduled time occurs.

#### Main Flow

Step 1: The user selects a saved task, time, recurrence, and optional start page.  
→ Step 2: The product summarizes unattended behavior and required permissions.  
→ Step 3: The user confirms and the schedule becomes visible/manageable.  
→ Step 4: At the scheduled time, the product starts the task if preconditions are valid.  
→ Step 5: It records and exposes the final run status.  
→ Expected Result: The user can distinguish completed, failed, and attention-required runs.

#### Alternative Flows

- One-time, daily, weekly, monthly, or annual recurrence if adopted.
- A bounded retry occurs under a documented policy.
- Editing, pausing, ad-hoc running, and deleting a schedule are Behavior not confirmed; Q-009 must decide whether they are required.

#### Failure Flows

- Browser closed, device asleep, or Extension unavailable at due time: exact catch-up/skip behavior is not confirmed; resolve in Q-009.
- Authentication expired: do not perform protected actions; mark attention required.
- Target page unavailable or not ready: fail or retry according to the documented policy and notify where PR-017 is available.
- Required consent is not valid for unattended use: do not broaden it automatically; mark attention required.

#### Inputs

Saved task, schedule, recurrence, start page, user confirmation, current authentication/permission state.

#### Outputs

Schedule record, next-run information, run status/history, failure or attention notification.

#### Data Involved

Saved instruction, schedule, start page, run identifier, status, timestamps, failure reason, action results required for the run.

#### Privacy / Security

Unattended execution is higher risk than an interactive task. A schedule must not convert an interactive or site-specific grant into unrestricted background authority. Retention of run logs and page data requires an explicit policy.

#### Acceptance Criteria

**Given** a user has a valid saved task and creates a supported schedule  
**When** the due time occurs while authentication and required unattended permission are valid  
**Then** the product starts one run, records exactly one final status, and does not duplicate the run after an Extension context restart.

### PR-012 — Teach a Reusable Workflow by Demonstration

#### Reference

Derived from F-012.

#### Classification

NEEDS-CLARIFICATION.

#### Functional Requirement

<strong>FR-012:</strong> If included, the product must let the user demonstrate browser steps, optionally add text or voice narration, review/edit the captured workflow, and save it as a reusable instruction without silently adding unobserved actions.

#### User

P-003 Repeat-work user.

#### User Goal

Create an automation by showing the desired process rather than writing the complete instruction manually.

#### Preconditions

- Q-010 resolves workflow scope, data model, processing location, and feature availability.
- Page/action capture is supported and authorized.
- Microphone permission is granted only if voice narration is selected.

#### Trigger

Explicit Start teaching/recording action.

#### Main Flow

Step 1: The product explains what actions, visual context, and optional voice data will be captured.  
→ Step 2: The user starts and demonstrates the workflow.  
→ Step 3: The product records visible task-relevant steps and optional narration.  
→ Step 4: The user stops recording and reviews/edits the proposed workflow.  
→ Step 5: The user saves or discards it.  
→ Expected Result: Only the reviewed workflow becomes reusable.

#### Alternative Flows

- Record without voice when microphone access is unavailable or declined.
- Pause/resume recording if adopted.
- Remove or edit individual captured steps before saving.

#### Failure Flows

- Microphone denied/not found: continue non-voice recording if supported and explain the limitation.
- Page capture/action observation unavailable: stop or mark the missing step; do not fabricate it.
- Workflow transformation service unavailable: Behavior not confirmed; Q-010 must define local fallback or recoverable draft behavior.
- Feature disabled by dynamic configuration: Behavior not confirmed; Q-016 must define user-visible availability.

#### Inputs

Observed user actions, page/element context, screenshots if adopted, text description, optional voice transcript, user edits.

#### Outputs

Reviewable workflow draft, saved reusable instruction, discarded draft, or capture/processing error.

#### Data Involved

Page URLs/titles, action sequence, element/visual context, optional audio/transcript, workflow metadata.

#### Privacy / Security

Demonstrations may capture secrets and unrelated page content. Recording must be visibly active, user-controlled, bounded to the demonstrated session, and subject to redaction and explicit retention/transmission disclosure.

#### Acceptance Criteria

**Given** workflow teaching is enabled and the user denies microphone access  
**When** the user explicitly starts, demonstrates, and stops a supported non-voice workflow  
**Then** the product captures a reviewable sequence without audio, allows edits before save, and does not save until the user confirms.

### PR-013 — Export Conversation or Action Records

#### Reference

Derived from F-013.

#### Classification

COULD.

#### Functional Requirement

<strong>FR-013:</strong> The product could let the user explicitly export selected conversation data as a portable artifact and/or selected action history as a visual replay, with a clear preview or warning about included sensitive content.

#### User

P-001, P-002, and P-003 users who need a record or shareable artifact.

#### User Goal

Keep, inspect, or share a conversation or browser-action record outside the Extension.

#### Preconditions

- Exportable conversation/action data exists.
- The user selects an available export format and scope.
- Local download/save capability is available.

#### Trigger

Explicit Export or Share action.

#### Main Flow

Step 1: The user selects the content and supported output format.  
→ Step 2: The product explains whether messages, tool details, screenshots, or action indicators are included.  
→ Step 3: The user confirms.  
→ Step 4: The product generates and offers the artifact for download.  
→ Expected Result: The user receives the requested artifact or a clear generation/download failure.

#### Alternative Flows

- Portable structured conversation export.
- Visual action replay export.
- Redacted or user-selected subset if adopted after Q-018.

#### Failure Flows

- Generation fails or data is incomplete: create no misleading artifact and report failure.
- Download permission/action denied: retain only a bounded temporary result, if any, and explain how to retry.
- Exact redaction, watermark, and format behavior are not confirmed for the new product.

#### Inputs

Selected conversation/messages, selected action records, screenshots/frames, output format, confirmation.

#### Outputs

Downloadable artifact, preview/warning, or generation/download error.

#### Data Involved

Conversation content, tool inputs/results, page URLs/titles, screenshots/action frames, timestamps, export metadata.

#### Privacy / Security

Export produces a durable copy outside product retention controls. The product must make scope visible, avoid exporting credentials, and warn when page content, screenshots, or external-tool results are included.

#### Acceptance Criteria

**Given** the user has a completed conversation and selects a supported portable export  
**When** the user confirms the displayed content scope  
**Then** the product produces one downloadable artifact containing only that scope, or reports a generation failure without claiming a successful export.

### PR-014 — Offer an Alternate Hosted Assistant Experience

#### Reference

Derived from F-014.

#### Classification

NEEDS-CLARIFICATION.

#### Functional Requirement

<strong>FR-014:</strong> If the product includes a separately hosted assistant experience, it must let an authorized user enter and leave that experience while preserving the same user-consent and browser-action safety boundaries as the core Extension experience.

#### User

P-001 or P-002 user who selects the alternate experience.

#### User Goal

Use a hosted assistant workspace without losing access to explicitly authorized browser capabilities.

#### Preconditions

- Q-011 confirms that a second hosted experience is a product requirement.
- Ownership, origin, account/session, capability contract, and fallback are specified.
- The hosted application is authenticated and available.

#### Trigger

User selects the hosted experience through an approved product setting or trusted handoff.

#### Main Flow

Step 1: The product checks hosted-service availability and authorization.  
→ Step 2: It presents the hosted experience and its browser-capability boundary.  
→ Step 3: The hosted experience requests only declared capabilities.  
→ Step 4: The Extension validates consent/account/task scope before each privileged action.  
→ Expected Result: The user can complete hosted tasks or return to the core experience safely.

#### Alternative Flows

- User switches back to the core Extension experience.
- Hosted task uses conversation only and requests no browser action.
- Authentication is completed in the hosted service before the workspace becomes available.

#### Failure Flows

- Hosted service unavailable, unauthorized, or blocked: offer the core experience or a clear retry/sign-in action.
- Message/capability contract invalid: reject the request and report a hosted integration error.
- Account mismatch: perform no browser action.
- Hosted iframe internals, conversation persistence, and server orchestration are Behavior not confirmed.

#### Inputs

User experience preference, hosted authentication state, declared capabilities, task/browser requests, current tab context.

#### Outputs

Hosted workspace, core-workspace fallback, browser action result, or integration/authentication error.

#### Data Involved

Account/task identifiers, current page metadata, declared tool inputs/results, hosted conversation/session data as defined by the future contract.

#### Privacy / Security

A hosted document is an external trust boundary. Only explicitly trusted origins and validated message schemas may request a minimum allowlist of capabilities. Hosted content must not bypass PR-008 or infer Extension authorization from web login alone.

#### Acceptance Criteria

**Given** the hosted experience is adopted, authenticated, and loaded from an approved origin  
**When** it requests a browser capability outside its declared allowlist  
**Then** the Extension rejects the request, performs no browser action, and exposes an integration error without disrupting the core assistant.

### PR-015 — Use Authorized External Service Tools

#### Reference

Derived from F-015.

#### Classification

NEEDS-CLARIFICATION.

#### Functional Requirement

<strong>FR-015:</strong> If connected services are included, the product must let the user discover available service tools, authorize each service and sensitive invocation, understand the tool source, receive its result, and revoke access.

#### User

P-005 Connected-service user.

#### User Goal

Use data or actions from a separately authorized service as part of an AI-assisted browsing task.

#### Preconditions

- Q-012 defines supported connectors, transport, account model, scopes, and server responsibility.
- The user is authenticated to the product and selected external service.
- Tool metadata is current and valid.

#### Trigger

User opens connected services, connects a service, or a task requests an available external tool.

#### Main Flow

Step 1: The product shows the service, available capability, requested data/action, and authorization state.  
→ Step 2: The user connects or grants the required scope.  
→ Step 3: A task requests a declared tool.  
→ Step 4: The product applies tool-specific consent and sends only required data.  
→ Step 5: The result is attributed to the service and returned to the task.  
→ Expected Result: The user can distinguish service results from local browser results and can revoke the connection.

#### Alternative Flows

- Discover tools without invoking them.
- Deny one invocation while keeping the service connected.
- Reconnect after an expired external-service authorization.

#### Failure Flows

- Connector list or tool schema unavailable: do not invent capabilities; report service unavailable.
- External authorization expires: stop the invocation and request reconnection.
- Tool result malformed or times out: isolate the failure and keep the core task usable.
- Direct Extension transport versus server mediation is Behavior not confirmed.

#### Inputs

Connector metadata, service authorization/scopes, tool name/schema, task arguments, permission decision.

#### Outputs

Connected/disconnected status, attributed tool result, consent prompt, or connector error.

#### Data Involved

Product account/organization, connector identity/scopes, tool inputs/results, external service data, error/status metadata.

#### Privacy / Security

Each connector is a separate data controller/trust boundary. The product must disclose data flow, scope access to declared tools, validate tool schemas, prevent connector prompts from expanding browser permission, and support revocation.

#### Acceptance Criteria

**Given** a supported connector is authorized for one declared capability  
**When** a task requests a different undeclared or unapproved capability  
**Then** the product does not invoke it, identifies the missing authorization, and leaves the existing authorized capability unchanged.

### PR-016 — Enforce Enterprise URL and Account Policy

#### Reference

Derived from F-018.

#### Classification

NEEDS-CLARIFICATION.

#### Functional Requirement

<strong>FR-016:</strong> If enterprise deployment is in scope, the product must let administrators restrict browser destinations and permitted organization/account use, must apply those restrictions ahead of user preferences, and must provide a clear non-bypassable block state.

#### User

P-006 Enterprise administrator and enterprise-managed end user.

#### User Goal

Ensure the product operates only on approved destinations and under approved organizational identities.

#### Preconditions

- Q-013 confirms enterprise scope and defines the managed-policy contract.
- The browser/device supplies valid managed configuration.

#### Trigger

Policy change, user login/account switch, page navigation, or browser action that enters a policy-controlled scope.

#### Main Flow

Step 1: The product reads the effective administrator policy.  
→ Step 2: It compares current account and requested destination/action with policy.  
→ Step 3: Allowed use continues under ordinary consent.  
→ Step 4: Disallowed use is blocked before page data or action execution.  
→ Expected Result: The user sees the restriction reason and only administrator-approved recovery actions.

#### Alternative Flows

- Multiple organization/account identities are allowed.
- A destination rule applies to an entire domain or a defined path pattern.
- The user logs out and signs in with a permitted account.

#### Failure Flows

- Policy is invalid or cannot be interpreted: Behavior not confirmed; Q-013 must define fail-closed versus last-known-good behavior.
- User preference conflicts with administrator policy: administrator policy wins.
- Policy changes during an active task: stop newly disallowed actions and update the user-visible state.

#### Inputs

Managed destination rules, permitted organization/account identifiers, current account, requested URL/action.

#### Outputs

Allow/block decision, policy status, permitted recovery action, or policy-configuration error.

#### Data Involved

Managed URL patterns, organization/account identifiers, policy revision/effective state, blocked request metadata.

#### Privacy / Security

Users must not be able to override managed restrictions through ordinary settings, saved tasks, scheduled tasks, hosted experiences, or connectors. Block messages should disclose enough to recover without exposing unnecessary policy internals.

#### Acceptance Criteria

**Given** an administrator policy permits one organization and blocks a destination path  
**When** a user in the permitted organization requests an action on that blocked path  
**Then** the product performs no page read or action for that path and displays a policy-block state that the user cannot override.

### PR-017 — Notify the User About Asynchronous Task Status

#### Reference

Derived from F-019 and the status needs of F-011.

#### Classification

COULD.

#### Functional Requirement

<strong>FR-017:</strong> The product could let the user opt into notifications for selected completion, failure, or attention-required events and return from a notification to the related task context when that context still exists.

#### User

P-003 Repeat-work user and any user waiting on a background/asynchronous task.

#### User Goal

Learn that an off-screen task completed or needs attention without continuously watching the assistant.

#### Preconditions

- A feature can complete or fail while not visible.
- The user has enabled the relevant notification category and browser permission.

#### Trigger

Task completion, task failure, authentication/permission attention state, or user clicking a product notification.

#### Main Flow

Step 1: An opted-in event reaches a final or attention-required state.  
→ Step 2: The product emits a concise notification that avoids sensitive details.  
→ Step 3: The user selects it.  
→ Step 4: The product focuses the related task/page when safe and available.  
→ Expected Result: The user can understand the event and return to relevant context.

#### Alternative Flows

- Notifications are disabled globally or by category.
- Optional sound is enabled independently if adopted.
- Download status remains in-product when no system notification is needed.

#### Failure Flows

- Browser notification permission denied: Behavior not confirmed; Q-014 must decide whether an in-product notification center is required.
- Related tab/task no longer exists: open a safe status view without recreating the action.
- Notification delivery fails: do not change the underlying task result.

#### Inputs

Task/event identifier, status, user notification preferences, optional related tab/page target.

#### Outputs

System/in-product notification, focused task context, or no notification according to preference.

#### Data Involved

Task status, event category, minimal task label, destination context, notification preference.

#### Privacy / Security

Notifications may be visible on a locked/shared screen. Default content must omit page text, credentials, form values, connector results, and other sensitive task details.

#### Acceptance Criteria

**Given** the user has enabled failure notifications for scheduled tasks  
**When** a scheduled task reaches a failure state  
**Then** the product emits one non-sensitive failure notification and selecting it opens the related status context without retrying the task automatically.

### PR-018 — Support Trusted Onboarding and Product Deep Links

#### Reference

Derived from F-020.

#### Classification

SHOULD.

#### Functional Requirement

<strong>FR-018:</strong> The product should let approved onboarding and product links open a known Extension destination and optionally carry a validated starter task or recovery target, without accepting arbitrary instructions or credentials from untrusted pages.

#### User

New users and users following a product-owned recovery/settings link.

#### User Goal

Reach the correct assistant, settings, or recovery state directly from a trusted product surface.

#### Preconditions

- Approved source origins and supported link/task identifiers are defined.
- The target Extension view exists.

#### Trigger

User selects a trusted onboarding CTA or supported product deep link.

#### Main Flow

Step 1: The product validates the source and requested destination/task identifier.  
→ Step 2: It opens the corresponding Extension surface.  
→ Step 3: It populates only allowlisted starter data or selects the supported settings/recovery view.  
→ Expected Result: The user lands in the intended state and remains in control of submission or recovery.

#### Alternative Flows

- Open the assistant with a reviewed starter prompt.
- Open permission/settings management.
- Focus an existing task-related tab or initiate a supported reconnect action if such products are adopted.

#### Failure Flows

- Untrusted source, unknown task, malformed link, or unknown tab: reject the request and do not execute embedded instructions.
- Assistant cannot open: display a recoverable activation error.
- Reference-specific domains, paths, and task identifiers are not product requirements.

#### Inputs

Source origin, destination type, allowlisted task identifier or prompt, optional task/tab reference.

#### Outputs

Opened assistant/settings/recovery state, populated starter content, or rejected-link error.

#### Data Involved

Source origin, product link parameters, starter task content, optional tab/task identity. Authentication credentials are not valid link payload.

#### Privacy / Security

Links must be treated as untrusted until origin and schema validation succeeds. Starter content must not auto-execute privileged actions or grant site access.

#### Acceptance Criteria

**Given** a user selects an approved onboarding link carrying an allowlisted starter task  
**When** the link is validated  
**Then** the product opens the assistant with the starter content visible for review and performs no privileged browser action until normal consent requirements are met.

### PR-019 — Manage User Settings, Language, and Update Communication

#### Reference

Derived from the user-visible portion of F-021 and preference aspects of F-002/F-003/F-008/F-019.

#### Classification

SHOULD.

#### Functional Requirement

<strong>FR-019:</strong> The product should provide a coherent settings experience for adopted user preferences, permission review/revocation, language, keyboard entry points, and necessary update/restart communication.

#### User

All users; P-007 Product administrator/operator for supported defaults and release communication.

#### User Goal

Understand and change effective product behavior without editing browser internals or hidden state.

#### Preconditions

- The relevant capability has a user-configurable preference.
- A supported locale/configuration is available.

#### Trigger

Open Settings, follow a permission prompt/recovery link, change a preference, select a locale, or receive an update-required state.

#### Main Flow

Step 1: The user opens settings and sees current effective values.  
→ Step 2: The user changes a supported preference or revokes a grant.  
→ Step 3: The product validates and applies/persists the change.  
→ Step 4: Affected user-facing surfaces reflect the new value.  
→ Expected Result: The user can verify the effective setting and recover from an invalid/unavailable choice.

#### Alternative Flows

- Configure notifications or microphone access.
- View/change the keyboard shortcut through the browser-supported settings flow.
- Choose model/custom instructions or core/hosted experience only if those options are adopted.
- Change locale among supported languages.
- Review an update state and perform a user-safe restart when required.

#### Failure Flows

- Invalid or unsupported value: reject it and retain the last valid setting.
- Browser denies microphone/notification permission: show the effective denial and a browser-supported recovery path.
- A setting is disabled by administrator policy: show it as managed and non-overridable.
- Dynamic feature-flag visibility and server-controlled settings are Behavior not confirmed; Q-016 applies.

#### Inputs

User preference changes, current grants, browser permission state, supported locales, version/update state, administrator policy.

#### Outputs

Effective settings, grant revocation, language change, browser-settings handoff, update/restart notice, or validation error.

#### Data Involved

User preferences, locale, permission decisions, selected model/experience if adopted, version/update state. Internal diagnostics are excluded from the user requirement.

#### Privacy / Security

Settings must distinguish user preferences from administrator policy, must not reveal credentials, and must make high-impact permission revocation understandable. Remote feature configuration must not silently expand privileges.

#### Acceptance Criteria

**Given** the user has a persistent site grant and opens permission settings  
**When** the user revokes that grant  
**Then** the effective setting updates visibly and the next protected action on that site requires fresh authorization.

### PR-020 — Pair a Trusted Local Agent

#### Reference

Derived from F-016 (local bridge and native messaging), brought into scope by the product owner on
2026-09-07 (session record; decisions D-003-1 to D-003-4 in `specs/003-local-agent-mcp-bridge/spec.md`).
F-017 stays reference-only.

#### Classification

MUST.

#### Functional Requirement

<strong>FR-020:</strong> The product must let the owner pair one or more locally running agents with the extension once, after which a paired agent may read, act on, navigate and diagnose pages in its own tabs through a defined tool surface, governed by a per-site mode the owner controls, until the owner unpairs it.

#### User

P-004 Technical user (the owner running a coding agent on the same device for automated browser testing).

#### User Goal

Drive the owner's real browser from a trusted local agent without a prompt for every action, while keeping visibility of what the agent controls and one Stop.

#### Preconditions

- A local bridge is installed on the device and the agent is configured to use it.
- The owner accepted this agent's pairing request.

#### Trigger

An agent connects through the bridge; on its first connection the owner is asked to pair.

#### Main Flow

Step 1: The agent connects and identifies itself.  
→ Step 2: The extension shows the pairing request; the owner accepts once.  
→ Step 3: The agent receives its tool surface and a tab group of its own.  
→ Step 4: Each effect is admitted by the current site's mode (`ask` / `follow-a-plan` / `skip-checks`); reads and tab management are never prompted.  
→ Step 5: The extension shows the agent as active on its tabs and offers Stop.  
→ Expected Result: The agent completes multi-step browser work with the owner's standing consent per site.

#### Alternative Flows

- The owner sets a site to `follow-a-plan`: the agent states a plan, the owner approves once, only that plan's steps run unprompted.
- The owner grants diagnostics for a site: console, network and script evaluation become available there (PR-006, resolved for this caller only).
- The owner unpairs the agent: open sessions lose their tools immediately.

#### Failure Flows

- Bridge missing or not running: the agent is told so; the extension is unaffected.
- Agent not paired or declined: every tool answers "not paired".
- Reference stale, tab gone, tab busy, page restricted: explicit answers; no substitute target, no partial data.
- Owner presses Stop: no queued step runs; an effect already delivered is reported done or uncertain.

#### Inputs

Agent identity, tool name and arguments, tab identifier, element references, site modes, diagnostics grants.

#### Outputs

Tool answers (page text, element tree, references, images, action outcomes, console/network records, script results), pairing state, per-site mode state, activity and Stop in the extension.

#### Data Involved

Page content and structure, screenshots, typed text, uploaded file bytes, console and network records, tab and window state — all confined to the device.

#### Privacy / Security

The extension transmits page-derived data only to the paired local agent on the same device; the agent may forward it to its own model, which the pairing prompt discloses. Broad host access and the diagnostics permission are justified only by FR-045 and FR-049 of the feature specification and remain unused until an agent is paired. The remote-service caller's consent model (PR-008) is unchanged.

#### Acceptance Criteria

**Given** the bridge is installed and no agent is paired  
**When** an agent connects  
**Then** the owner sees a pairing request naming the agent, and no tool runs before the owner accepts.

**Given** a paired agent and a site in `ask` mode  
**When** the agent requests an effect on that site  
**Then** the owner is shown the site, target and action, and the effect runs only after the owner's yes.

**Given** a paired agent  
**When** it names a tab outside its own group  
**Then** the call is refused and the owner's tab is untouched.

#### Amendment 2026-09-09 (feature 004)

Owner decisions D-004-2 and D-004-3 in `specs/004-reference-parity-bridge/spec.md` amend this requirement:

- **Concurrent sessions.** One or more sessions of one or more paired agents may use the browser at the same time. Each session has its own tab group; a tab belongs to at most one live session; a session asking for a tab another live session holds is refused and told which session holds it. The "one session per device" constraint of feature 003's planning was interim, not a product decision.
- **The owner's tabs.** A paired session may list every tab in the browser (title, address, active state, window, and who holds it) and may take a tab no session holds into its own group, after which it is treated as the session's own. Reading or acting on a tab the session does not hold stays refused. The third acceptance criterion above therefore reads: **Given** a paired agent, **When** it reads or acts on a tab it does not hold, **Then** the call is refused naming the holder (another session) or "not yours" (the owner's), and that tab is untouched.
- **Link recovery and release.** Loss of the link between the browser and the agents is recovered without the owner's intervention and without ending sessions; a session whose agent process ends is released, and its tabs return to the owner.

**Given** two live sessions of paired agents  
**When** each runs its first tool  
**Then** both succeed, each in its own tab group, and neither is told the bridge is unavailable.

**Given** a tab the owner opened by hand and no session holds  
**When** a paired session lists tabs and takes that tab  
**Then** the tab is listed as the owner's, joins the session's group on taking, and the session can read it.


## 7. Feature Traceability Matrix

| Reference ID | Reference Feature | Product Requirement | Classification | Confidence | Open Question |
| ------------ | ----------------- | ------------------- | -------------- | ---------- | ------------- |
| F-001 | Open/toggle assistant side workspace | PR-001 / FR-001 — Activate an assistant associated with current browsing context | MUST | High | Q-001: Which entry points ship initially? |
| F-002 | OAuth/API-key/account session | PR-002 / FR-002 — Establish, maintain, refresh, and end an authorized service session | MUST | High | Q-002, Q-003, Q-004 |
| F-003 | Classic conversation and tool loop | PR-003 / FR-003 — Progressive, bounded AI task loop with authorized action results | MUST | High | Q-002, Q-004 |
| F-004 | Browser interaction tools | PR-005 / FR-005 — Execute verified, authorized browser actions | MUST | High | Q-006, Q-008 |
| F-005 | Page understanding and find | PR-004 / FR-004 — Acquire bounded, redacted, task-relevant page context | MUST | High | Q-007, Q-008 |
| F-006 | JavaScript/console/network diagnostics | PR-006 / FR-006 — Separately authorize advanced diagnostics if included | NEEDS-CLARIFICATION | High behavior evidence; product priority unknown | Q-005 |
| F-007 | Active tab/task indicators and stop | PR-007 / FR-007 — Visible control scope and immediate stop | MUST | High | Q-006: stop semantics and task-tab scope |
| F-008 | Site permission, plan approval, URL safety | PR-008 / FR-008 — Scoped consent, policy, revocation, and fail-closed safety | MUST | High | Q-006, Q-007 |
| F-009 | Files, screenshots, region/element selection, page file input | PR-009 / FR-009 for task context; PR-005 for website file-input action | SHOULD | High | Q-004, Q-006, Q-008 |
| F-010 | Reusable instructions / saved prompts | PR-010 / FR-010 — CRUD and reuse of task templates | SHOULD | High | Q-001: initial release scope |
| F-011 | Scheduled tasks | PR-011 / FR-011 — Optional one-time/recurring execution with run status | COULD | High | Q-009 |
| F-012 | Teach-by-demonstration workflow recording | PR-012 / FR-012 — Provisional reviewable/editable workflow teaching | NEEDS-CLARIFICATION | Medium | Q-010, Q-016 |
| F-013 | Conversation and visual action export | PR-013 / FR-013 — Optional portable and/or visual export | COULD | High | Q-018 |
| F-014 | Alternate hosted/Cowork experience | PR-014 / FR-014 — Provisional hosted experience under the same safety boundary | NEEDS-CLARIFICATION | High for host flow; iframe/server internals unconfirmed | Q-011 |
| F-015 | Connected apps / remote tools | PR-015 / FR-015 — Provisional discovery, authorization, invocation, attribution, revocation | NEEDS-CLARIFICATION | High for discovery; Medium for transport | Q-012 |
| F-016 | Desktop/CLI cloud and native bridge | PR-020 (local agent pairing; the cloud-bridge half stays out of scope) | PR-020 | High | Q-001 answered 2026-09-07: a locally running coding agent is a first-class caller (feature 003) |
| F-017 | Feature-gated remote orchestrator/browser hand | No product requirement adopted; retained in Section 20 pending an orchestrator-product decision | REFERENCE-ONLY | High for code path; activation unconfirmed | Q-001, Q-016: Is a remote orchestrator part of the product, and can gated behavior be verified? |
| F-018 | Enterprise URL and organization policy | PR-016 / FR-016 — Provisional managed destination/account restrictions | NEEDS-CLARIFICATION | High behavior evidence; market scope unknown | Q-013 |
| F-019 | Notifications, sound, download status | PR-017 / FR-017 — Optional asynchronous task notifications | COULD | High | Q-014 |
| F-020 | Onboarding handoff and deep links | PR-018 / FR-018 — Trusted, validated onboarding and product links | SHOULD | High | Q-001; product-owned sources/targets TBD |
| F-021 | User settings, locale, update, internal flags | PR-019 / FR-019 for user-visible settings/locale/update; internal flags retained in Section 20 | SHOULD | High; visibility may be dynamic | Q-016, Q-017 |

### Traceability result

- F-001 through F-021 each have exactly one primary disposition.
- 20 features map to a PR/FR (F-016 → PR-020 since 2026-09-08); F-017 is explicitly REFERENCE-ONLY.
- No reference feature is silently omitted.
- Classification counts: 7 MUST, 4 SHOULD, 3 COULD, 5 NEEDS-CLARIFICATION, 2 REFERENCE-ONLY.

## 8. Acceptance Criteria Index

Detailed Given/When/Then criteria appear inside each Product Requirement. This index identifies their test focus and whether the criterion is release-normative or provisional.

| AC ID | Requirement | Observable test focus | Status |
| --- | --- | --- | --- |
| AC-001 | PR-001 | Explicit activation opens an assistant tied to current context without acting on the page | Normative |
| AC-002 | PR-002 | Expired authorization blocks protected work and produces reauthentication | Normative |
| AC-003 | PR-003 | Progressive response reaches final state; denied action is not performed | Normative |
| AC-004 | PR-004 | Supported page context is bounded and password value is redacted | Normative |
| AC-005 | PR-005 | Approved action targets only intended page/field; origin change forces re-evaluation | Normative |
| AC-006 | PR-006 | Approval for console observation does not authorize JavaScript execution | Provisional pending Q-005 |
| AC-007 | PR-007 | Stop prevents new actions and yields confirmed or explicitly uncertain stop state | Normative |
| AC-008 | PR-008 | Cross-origin/sensitive action requires new consent and denial blocks all requested effects | Normative |
| AC-009 | PR-009 | Only selected supported attachment is added and remains removable before submission | Candidate |
| AC-010 | PR-010 | Saved instruction remains editable/deletable and does not persist site consent | Candidate |
| AC-011 | PR-011 | Due schedule produces one run/final status without restart duplication | Optional pending Q-009 |
| AC-012 | PR-012 | Non-voice demonstration remains reviewable and unsaved until confirmation | Provisional pending Q-010 |
| AC-013 | PR-013 | Confirmed content scope produces one artifact or explicit generation failure | Optional pending Q-018 |
| AC-014 | PR-014 | Hosted request outside declared capability is rejected without breaking core assistant | Provisional pending Q-011 |
| AC-015 | PR-015 | Connector cannot invoke undeclared/unapproved capability | Provisional pending Q-012 |
| AC-016 | PR-016 | Managed destination block prevents page read/action and cannot be user-overridden | Provisional pending Q-013 |
| AC-017 | PR-017 | Opted-in failure event creates one non-sensitive notification and no automatic retry | Optional pending Q-014 |
| AC-018 | PR-018 | Valid onboarding pre-populates reviewable content without auto-executing privileges | Candidate |
| AC-019 | PR-019 | Revoked persistent site grant takes effect for the next protected action | Candidate |

## 9. Data Requirements

### 9.1 Data inventory

| ID | Data category | Allowed product purpose | Sensitivity | Persistence requirement | Related requirements |
| --- | --- | --- | --- | --- | --- |
| DR-001 | Current page URL/title and tab/task association | Associate requests, context, actions, and status with the intended browsing context | Medium; URLs can be highly sensitive | Task/session only unless a user saves a task or history policy is adopted | PR-001, PR-004, PR-005, PR-007 |
| DR-002 | DOM-derived page text/structure and element metadata | Answer page questions and identify authorized action targets | High | Transient by default; external/server retention unresolved in Q-004 | PR-003–PR-005, PR-008 |
| DR-003 | Screenshots, selected regions/elements, file bytes/metadata | User-selected task context, authorized upload, optional visual export | High | Bounded temporary retention; durable only by explicit save/export | PR-005, PR-009, PR-012, PR-013 |
| DR-004 | Conversation messages and task state | Maintain the active AI task and present results | High | Session/server retention and deletion unresolved in Q-004 | PR-003, PR-014 |
| DR-005 | Browser action plans, inputs, results, and failures | Execute and explain the task, recover from failure, support user-visible history if adopted | High | Active task plus explicitly defined diagnostic/history window | PR-003, PR-005–PR-008 |
| DR-006 | Authentication credentials, expiry, account and organization identity | Authorize service access and enforce account policy | Critical | Credential lifetime only; non-secret identity retained only as needed | PR-002, PR-014–PR-016 |
| DR-007 | Site/action grants, denial, scope, and lifetime | Apply consent consistently and support revocation | Medium–High | Until expiry/revocation; once grants bounded to one task/use | PR-008, PR-019 |
| DR-008 | Saved instructions, categories, optional start context | Reuse user-authored tasks | High | Persistent until user edits/deletes | PR-010, PR-011 |
| DR-009 | Schedule, run state, status, and failure reason | Trigger and report optional unattended tasks | High | Persistent according to schedule/history retention policy | PR-011, PR-017 |
| DR-010 | Workflow actions, screenshots, narration/audio/transcript | Build a reviewable workflow draft | High | Temporary until save/discard; saved form and server processing unresolved | PR-012 |
| DR-011 | Connector identity/scopes, tool arguments/results | Use an authorized external service | High | Minimum needed for connection/task; connector retention disclosed separately | PR-015 |
| DR-012 | Enterprise destination/account policy | Enforce administrator restrictions | Medium–High | Controlled by managed policy lifecycle | PR-016 |
| DR-013 | User preferences, locale, notification and media choices | Apply user-visible configuration | Low–Medium | Persistent until change/reset, subject to policy | PR-017, PR-019 |
| DR-014 | Exported conversation/action artifact | Fulfill explicit user download/share | High; outside product control after export | Product temporary copy deleted promptly; downloaded copy user-controlled | PR-013 |
| DR-015 | JavaScript result, console messages, network metadata/body | Optional technical diagnostics | Critical on sensitive pages | Transient to task unless user explicitly exports/saves | PR-006 |
| DR-016 | Product diagnostics/telemetry | Reliability and product analysis only if adopted | Unknown until event schema exists | Requires purpose-specific retention and redaction policy | NFR-009, Q-015 |

### 9.2 Data handling rules

- <strong>DR-R01 — Data minimization:</strong> Collect and transmit only data required for the user-approved task and capability.
- <strong>DR-R02 — Purpose separation:</strong> Page context, authentication secrets, connector data, product telemetry, and exports must not be silently repurposed across categories.
- <strong>DR-R03 — Sensitive-field protection:</strong> General page reading must redact known password, one-time-code, payment-card, and other identified sensitive form values.
- <strong>DR-R04 — Explicit durable copies:</strong> Screenshots, audio, files, conversations, and tool traces become durable only under a defined retention feature or explicit user save/export.
- <strong>DR-R05 — User control:</strong> Users must be able to delete saved instructions, revoke grants, logout, and manage other adopted persistent data; account-switch cleanup must follow Q-004.
- <strong>DR-R06 — Credential isolation:</strong> Product/AI-service authentication material must never be included in page context, webpage actions, notifications, exports, logs, or telemetry. A sensitive value that the user explicitly chooses to enter into a website may exist only as scoped action data; it must be excluded from general page context, notifications, exports, logs, and telemetry and handled under PR-005/PR-008 consent.
- <strong>DR-R07 — Account isolation:</strong> Cached conversation, connector, permission, and account data must not cross account or organization boundaries.
- <strong>DR-R08 — Retention specification:</strong> Numeric capacity, expiry, history, and deletion targets need measurable values during planning/testing; reference values are not inherited.

## 10. Browser Capability Requirements

| ID | Product capability | Product-level requirement | Related PR |
| --- | --- | --- | --- |
| BC-001 | Assistant activation surface | Provide an explicit, visible Chrome entry point associated with the current browsing context | PR-001 |
| BC-002 | Current browsing context | Identify the current tab/page only to the extent needed for the active task | PR-001, PR-004, PR-005 |
| BC-003 | Page context acquisition | Read bounded, authorized text/structure across supported page/frame contexts | PR-004 |
| BC-004 | Page interaction | Perform the adopted click/type/scroll/key/navigation/file-input actions under scoped consent | PR-005, PR-008 |
| BC-005 | Advanced diagnostics | Execute or observe high-risk technical diagnostics only if separately adopted and authorized | PR-006 |
| BC-006 | Task scope visibility | Identify affected pages/tabs and offer an immediate stop path | PR-007 |
| BC-007 | Visual/file context | Capture visible user-selected page material and accept selected attachments | PR-009 |
| BC-008 | Tab/window task handling | Create, focus, close, or organize task-related tabs/windows only when required by an adopted user flow | PR-005, PR-011 |
| BC-009 | Scheduled wake-up | Trigger and deduplicate an optional scheduled task across normal Extension lifecycle events | PR-011 |
| BC-010 | Notification | Emit optional user-approved background status notifications | PR-017 |
| BC-011 | File export | Create a local download only after explicit export confirmation | PR-013 |
| BC-012 | Microphone/voice | Request microphone access only from an explicit voice/workflow action and preserve non-voice use after denial | PR-012, PR-019 |
| BC-013 | Managed policy | Read and enforce administrator-supplied destination/account policy if enterprise scope is adopted | PR-016 |
| BC-014 | Browser authentication | Complete the selected browser-safe authorization flow and return to a valid product state | PR-002 |

The requirement is the observable capability, not the reference mechanism. For example, identifying controlled tabs is a requirement; automatic tab grouping is one possible implementation.

## 11. Permission Implications

Permission names below are planning inputs, not decisions. The final manifest must be derived from adopted PRs and least-privilege testing.

| Capability | Why access may be needed | Potential Chrome permission implication | Product decision |
| --- | --- | --- | --- |
| Open a companion workspace | Persistent assistant UI beside current browsing task | Side-panel/action/command capabilities | Select the least intrusive supported activation surface during planning |
| Identify current tab metadata | Associate task with the active page and focus task tabs | <code>activeTab</code> and/or limited <code>tabs</code> access | Prefer user-triggered/temporary access where it satisfies PRs |
| Read or interact with a page | Acquire context and execute authorized actions | <code>scripting</code> plus host access | Do not assume permanent <code>&lt;all_urls&gt;</code>; compare active-tab, optional host, and per-site models |
| Observe supported frames/navigation | Find requested frame and revalidate cross-site changes | Navigation/frame-related capability | Restrict observation to active tasks and policy scope where feasible |
| Run advanced diagnostics | JavaScript/console/network capability | <code>debugger</code> or equivalent high-risk access | Exclude unless PR-006 is approved; request separately and explain risk |
| Manage task tabs/windows | Navigation, multi-tab tasks, scheduling | <code>tabs</code>, window and optional tab-group access | Tab grouping is not required unless selected by design |
| Store auth/settings/tasks/grants | Restore authorized state and user-owned configuration | <code>storage</code>; managed storage for PR-016 | Choose session/persistent stores by DR sensitivity/lifetime, not reference keys |
| Schedule work | Wake optional task at a user-selected time | <code>alarms</code> or platform scheduler | Include only if PR-011 is adopted |
| Notify off-screen user | Optional completion/failure/attention alert | <code>notifications</code> | Request at point of value and honor category preferences |
| Export files | User-requested local artifact | <code>downloads</code> or browser save capability | Include only if PR-013 is adopted; no background download without user request |
| Authenticate | Browser-safe service authorization | <code>identity</code> or standards-based web auth flow | Exact implication follows Q-002/Q-003 and threat model |
| Capture visible page | Screenshot/region/element context | Visible-tab capture and page-overlay capability | Invoke only from explicit selection or authorized task step |
| Use microphone | Optional voice narration | Web microphone/media permission | Request only from explicit user action; denial must preserve non-voice path |
| Play sound or generate media off-screen | Optional notification audio or visual export | Background/off-screen media capability | Implementation choice; do not require a specific hidden document model |
| Read enterprise policy | Enforce managed URL/account rules | Managed storage/configuration | Include only if PR-016 is adopted |
| Modify outbound request headers | Reference client identification | DNR/header modification | No clean-room product requirement; exclude unless a future service contract requires it |
| Unlimited local storage | Reference cache capacity | <code>unlimitedStorage</code> | No product requirement; set measured limits before considering it |
| Communicate with native applications | Reference desktop/CLI bridge | <code>nativeMessaging</code> | REFERENCE-ONLY; exclude from baseline manifest |

### Least-privilege decisions required during planning

1. Compare user-triggered temporary access with persistent per-site access for PR-004/PR-005.
2. Keep PR-006 diagnostic access separable from ordinary page context/action access.
3. Delay optional permissions until the user activates the corresponding candidate feature.
4. Verify that revocation immediately changes observable behavior.
5. Document unavoidable broad permission prompts in product language before release.

## 12. External Dependency Analysis

| Dependency | Reference Usage | Product Requirement? | Decision |
| ---------- | --------------- | -------------------- | -------- |
| Chrome Extension platform | User surface, browser context, permissions, lifecycle | Yes | <strong>Required Product Dependency</strong> — exact Chrome compatibility target remains Q-008. |
| AI inference/tool-selection capability | Conversation, progressive output, selection of browser actions | Yes for PR-003 | <strong>Required Product Dependency</strong> — provider, SDK, protocol, model, and endpoint are not selected. |
| Authorized-session / identity capability | Account authorization, refresh, profile/organization binding | Yes for the selected protected service | <strong>Required Product Dependency</strong> — the capability is required by PR-002; the reference identity provider is not selected. |
| Reference AI API/SDK and exact endpoints | Existing conversation and profile traffic | No | <strong>Existing Implementation Dependency</strong> — do not inherit without an explicit service decision. |
| Reference remote URL classifier | Existing cross-site/category check | No; the safety outcome is required, not a remote service | <strong>Existing Implementation Dependency</strong> — resolve a local or remote product mechanism in Q-007. |
| Reference hosted alternate assistant application | Existing alternate experience and browser-tool relay | Unknown | <strong>Existing Implementation Dependency</strong> — PR-014 remains NEEDS-CLARIFICATION; no reference host or protocol is selected. |
| Connected-service registry and transport | Existing discovery of remote service tools | Conditional on PR-015 | <strong>Unknown</strong> — Q-012 must decide whether a generic connector dependency exists and how it is mediated. |
| Connector-specific third parties | Catalog entries for productivity services | Unknown | <strong>Unknown</strong> — no connector becomes a dependency before Q-012 defines launch scope and authorization. |
| Workflow processing backend/schema | Possible conversion of recorded demonstration into reusable workflow | Unknown | <strong>Unknown</strong> — static evidence confirms UI/capture, not server responsibility. |
| Conversation/session persistence backend | Possible account/session query persistence | Unknown | <strong>Unknown</strong> — Q-004 must choose session/local/server persistence and deletion. |
| Desktop/CLI cloud bridge | Existing remote client can request browser tools | PR-020 covers the local (native-messaging) half only | <strong>Partly adopted 2026-09-08</strong> — the local agent pairing of F-016 is PR-020 (feature 003); the cloud-bridge half remains reference-only. |
| Native companion applications | Existing local client bridge | No baseline requirement | <strong>Existing Implementation Dependency</strong> — F-016 is REFERENCE-ONLY; exclude high-risk native access from the baseline. |
| Remote sandbox/orchestrator service | Feature-gated browser worker/hand | No baseline requirement | <strong>Existing Implementation Dependency</strong> — F-017 is REFERENCE-ONLY unless Q-001 establishes an orchestrator-product need. |
| Remote feature-configuration service | Existing dynamic capability visibility | Unknown | <strong>Unknown</strong> — the new product may use static releases or a separately governed flag system; Q-016 applies. |
| Telemetry/error/trace providers | Multiple existing analytics and observability vendors | Not a user product dependency | <strong>Existing Implementation Dependency</strong> — new diagnostics require Q-015 and a separate privacy decision. |
| Chrome-managed distribution/update | Existing packaged update path | Conditional on distribution channel | <strong>Unknown</strong> — the distribution channel is not selected in this phase. |
| Reference onboarding website/short links | Existing starter task and recovery handoff | No | <strong>Existing Implementation Dependency</strong> — PR-018 defines only a generic trusted handoff. |
| Dynamic sound/file sources | Existing optional media/notification path | No inherent requirement | <strong>Existing Implementation Dependency</strong> — local or independently selected resources can satisfy the observable behavior. |

## 13. Authentication Requirements

| ID | Requirement |
| --- | --- |
| AR-001 | The product must expose a clear signed-in, signed-out, reauthentication-required, and policy-blocked state. |
| AR-002 | A protected request must not proceed without valid authorization for the selected service and account scope. |
| AR-003 | Session renewal must not silently switch accounts or organizations. |
| AR-004 | Failed renewal or rejected credentials must stop protected work and lead to an understandable recovery flow. |
| AR-005 | Logout must invalidate/clear active authorization material according to the chosen provider contract and terminate protected remote connections. |
| AR-006 | Authentication secrets must be isolated from webpages, page scripts, notifications, exports, product analytics, and ordinary logs. |
| AR-007 | Account/organization changes must invalidate or partition account-bound conversation, connector, permission, and cache state. |
| AR-008 | API-key support is not assumed. If Q-003 adopts it, the product must define secure input, storage lifetime, validation, rotation, removal, and UI disclosure separately from account login. |
| AR-009 | Enterprise organization restrictions, if adopted, must be evaluated after identity is known and before protected page data/actions are allowed. |

Authentication protocol, provider, token type, refresh mechanics, and exact storage are technical-planning decisions after Q-002/Q-003 are resolved.

## 14. Privacy & Security Requirements

| ID | Requirement | Related PR |
| --- | --- | --- |
| PSR-001 | Treat webpage content, model output, hosted content, connector output, and remote instructions as untrusted input. | PR-003–PR-006, PR-014, PR-015 |
| PSR-002 | Require user-visible, appropriately scoped consent before protected page reads, writes, cross-site actions, advanced diagnostics, or external-tool use. | PR-004–PR-006, PR-008, PR-015 |
| PSR-003 | Do not treat text on a webpage or in model output as evidence of user consent. | PR-003, PR-005, PR-008 |
| PSR-004 | Bind action authorization to the intended task, site/origin, action category, and lifetime; re-evaluate after material page/navigation change. | PR-005, PR-008 |
| PSR-005 | Provide a visible active-control state and stop path; stop takes precedence over queued browser actions. | PR-007 |
| PSR-006 | Redact known sensitive form values from general page-reading output; isolate product/AI-service authentication material completely; and prevent user-selected website secrets from entering telemetry, notifications, or exports. | PR-004, PR-005, PR-013, PR-017 |
| PSR-007 | Apply least privilege to Chrome capabilities and external service scopes; optional/candidate features must not expand baseline permissions before use. | All |
| PSR-008 | When required safety, policy, account, or consent state is unavailable, fail closed for the protected action rather than assume authorization. | PR-002, PR-005, PR-008, PR-015, PR-016 |
| PSR-009 | Validate origin, sender identity, account binding, capability allowlist, and input schema at every external/hosted integration boundary. | PR-014, PR-015, PR-018 |
| PSR-010 | Minimize page URL/content disclosed to any remote risk-assessment service and document whether path/query data leaves the browser. | PR-008, Q-007 |
| PSR-011 | Give users a way to review/revoke persistent site/tool grants and delete adopted user-owned persistent artifacts. | PR-008, PR-010, PR-019 |
| PSR-012 | Prevent account/organization data from crossing session boundaries; logout/account switch behavior must cover active tasks and caches. | PR-002, PR-014–PR-016 |
| PSR-013 | Warn before durable export of page, conversation, connector, or screenshot data; never include product/AI-service authentication material; and redact or exclude detected website secrets according to the Q-018 policy. | PR-013 |
| PSR-014 | Show non-sensitive notification text by default because browser notifications can be visible outside the active session. | PR-017 |
| PSR-015 | Administrator policy, if adopted, must take precedence across interactive, saved, scheduled, hosted, and connected-service flows. | PR-008, PR-011, PR-014–PR-016 |
| PSR-016 | An expert permission-bypass mode must not be assumed or enabled by default; adoption requires an explicit product and threat-model decision in Q-006. | PR-008 |
| PSR-017 | Voice/workflow recording must be visibly active and must stop collecting when the user stops, closes, or discards the recording. | PR-012 |

## 15. Failure / Edge Cases

| Condition | Required observable behavior | Evidence status | Related PR |
| --- | --- | --- | --- |
| Unsupported/restricted browser page | Do not claim page access; explain that page context/action is unavailable | Confirmed failure class | PR-001, PR-004, PR-005 |
| User denies/dismisses permission | Perform no denied read/action; state whether task can continue | Confirmed | PR-003–PR-006, PR-008 |
| Page/target changes after approval | Reject stale target and re-evaluate context/authorization | Confirmed | PR-004, PR-005, PR-008 |
| Tab closes or navigates unexpectedly | Stop affected sequence, clear stale status, and report the changed state | Confirmed | PR-005, PR-007 |
| User selects Stop | Prevent new actions, cancel pending work where possible, and report confirmed/uncertain stop | Confirmed | PR-003, PR-007 |
| AI/network unavailable or rate-limited | Avoid unbounded retry; expose retry/cancel and retain only a safe recoverable task state | Confirmed pattern; exact limits not inherited | PR-003 |
| Authentication expires or is rejected | Stop protected requests and request reauthentication | Confirmed | PR-002, PR-003 |
| Safety classifier/policy unavailable | Fail closed for actions that require that decision | Confirmed pattern | PR-008, PR-016 |
| Context too large | Bound or truncate with disclosure, or return a clear limit error | Confirmed bounded behavior; targets TBD | PR-004, PR-009 |
| Attachment unsupported/too large | Add nothing and report type/size/access reason | Confirmed failure class; targets TBD | PR-009 |
| Advanced diagnostic channel unavailable/conflicted | Perform no diagnostic operation and report conflict/unsupported state | Confirmed class | PR-006 |
| Saved-task storage fails | Preserve unsaved user input where feasible and report save failure | Inference from product necessity; implementation behavior not confirmed | PR-010 |
| Scheduled run occurs while browser/device unavailable | Behavior not confirmed; define catch-up, skip, and deduplication in Q-009 | Unconfirmed | PR-011 |
| Scheduled run lacks auth/consent | Do not broaden authority; mark attention required | Supported by safety boundary; exact UX unconfirmed | PR-011, PR-017 |
| Workflow microphone denied | Continue non-voice path where supported and explain limitation | Confirmed | PR-012 |
| Workflow processing/server unavailable | Behavior not confirmed; define recoverable local draft or failure in Q-010 | Unconfirmed | PR-012 |
| Export generation/download fails | Do not claim success or leave an unexplained artifact; report retryable failure | Confirmed class | PR-013 |
| Hosted experience unavailable/unauthorized | Keep core assistant usable or present a clear sign-in/retry path | Reference host fallback supported; internals unconfirmed | PR-014 |
| Hosted/connector message invalid | Reject at boundary; isolate failure from core assistant | Confirmed security pattern | PR-014, PR-015 |
| Connector auth expires/tool fails | Stop that invocation, attribute the failure, and preserve core task usability | Partially confirmed; transport contract TBD | PR-015 |
| Enterprise policy invalid/unavailable | Behavior not confirmed; choose fail-closed or last-known-good in Q-013 | Unconfirmed | PR-016 |
| Browser notifications denied | Behavior not confirmed; define in-product fallback in Q-014 | Unconfirmed | PR-017 |
| Invalid/untrusted product deep link | Reject embedded task/action and do not grant privilege | Confirmed validation pattern | PR-018 |
| Invalid/managed setting | Retain last valid/effective value and explain why change did not apply | Supported behavior | PR-019 |
| Extension execution context restarts | Restore only durable authorized state, avoid duplicate scheduled/action execution, and clear stale active indicators | Chrome nature plus reference recovery evidence | PR-007, PR-011, NFR-005 |

## 16. Non-functional Requirements

| ID | Requirement | Measurement status |
| --- | --- | --- |
| NFR-001 — Least privilege | The released permission set and external scopes must be traceable to adopted PRs, with optional capability requested no earlier than needed. | Permission review/test plan required |
| NFR-002 — Consent clarity | Consent UI must identify the site/service, requested data/action, scope, and allow/deny consequence in user language. | Usability criteria required |
| NFR-003 — Data minimization | Page/context/tool data collected, persisted, and transmitted must be limited to the active approved purpose. | Data-flow tests and retention targets required |
| NFR-004 — Failure isolation | A failed page, connector, hosted view, notification, export, or optional diagnostic capability must not corrupt unrelated tasks or settings. | Fault-injection coverage required |
| NFR-005 — Lifecycle resilience | Normal Chrome context suspension/restart must not duplicate actions, lose durable schedules, or leave false active-control state. | Recovery scenarios required; numeric recovery target TBD |
| NFR-006 — Cancellation | User Stop must be prioritized over queued work and produce an observable terminal or explicitly uncertain state. | Maximum stop-confirmation target needed during planning/testing |
| NFR-007 — Accessibility | Primary activation, consent, task status, stop, settings, and errors must be operable and understandable with keyboard and assistive technology. | Conformance level and audit process TBD |
| NFR-008 — Localization | User-facing text must support a defined locale set and safe fallback; internal identifiers must not appear as untranslated UI. | Supported locales resolved in Q-017 |
| NFR-009 — Privacy-safe observability | Operational diagnostics must exclude credentials and minimize page/conversation content; event purpose, sampling, and retention require approval. | Event schema/retention resolved in Q-015 |
| NFR-010 — Compatibility | The product must declare and test a supported Chrome/version/page matrix, including restricted-page behavior. | Resolve Q-008; no inherited minimum version |
| NFR-011 — Bounded resources | Page traversal, task loops, screenshots/files, caches, retries, and exports must have explicit safe limits. | Needs measurable target during planning/testing |
| NFR-012 — Explainable outcomes | Every user-triggered task/action must end in success, denial, cancellation, attention-required, or failure state that does not imply unverified success. | Acceptance coverage required across PRs |
| NFR-013 — Security boundary consistency | Interactive, scheduled, hosted, connector, and enterprise flows must use equivalent consent/account/policy enforcement for the same privileged action. | Cross-entry security test matrix required |

No latency, availability, throughput, storage, or retry SLA is invented here. Each numeric target is marked for planning/testing.

## 17. In Scope

The current core scope contains the seven MUST Product Requirements:

1. <strong>PR-001:</strong> Explicitly activate an assistant for the current browsing context.
2. <strong>PR-002:</strong> Establish and manage an authorized AI-service session.
3. <strong>PR-003:</strong> Conduct a progressive, bounded, cancelable AI conversation/task loop.
4. <strong>PR-004:</strong> Acquire bounded, user-authorized, sensitive-field-redacted page context.
5. <strong>PR-005:</strong> Execute a defined set of verified, authorized browser actions.
6. <strong>PR-007:</strong> Make active browser control visible and immediately stoppable.
7. <strong>PR-008:</strong> Enforce scoped consent, site/navigation safety, revocation, and fail-closed behavior.

The baseline also includes the cross-cutting data, authentication, privacy, failure, and non-functional requirements necessary to make those seven capabilities safe. Inclusion in this section does not select a framework, UI architecture, AI provider, manifest permission set, or server design.

## 18. Candidate Scope

### SHOULD candidates

- <strong>PR-009:</strong> User-selected files, images, screenshots, regions, and element context.
- <strong>PR-010:</strong> Reusable instructions/task templates.
- <strong>PR-018:</strong> Trusted onboarding and product deep links.
- <strong>PR-019:</strong> User settings, language, permission review, and update communication.

### COULD candidates

- <strong>PR-011:</strong> Scheduled tasks.
- <strong>PR-013:</strong> Conversation/action export.
- <strong>PR-017:</strong> Asynchronous task notifications and optional sound.

### NEEDS-CLARIFICATION candidates

- <strong>PR-006:</strong> Advanced JavaScript/console/network diagnostics.
- <strong>PR-012:</strong> Teach-by-demonstration workflow recording and voice narration.
- <strong>PR-014:</strong> Alternate hosted assistant experience.
- <strong>PR-015:</strong> Connected external-service tools.
- <strong>PR-016:</strong> Enterprise destination/account policy.

Candidates do not enter implementation or baseline permission scope until the related Open Questions are resolved and classification is approved.

## 19. Out of Scope

The following are explicitly out of scope for this Phase 2 draft and for any implementation work before product review:

- Running <code>/speckit.specify</code> or <code>/speckit.plan</code>.
- Creating a Chrome Extension project or production code.
- Selecting React, Vue, another framework, state library, bundler, test framework, module pattern, or runtime topology.
- Copying or translating reference source, minified bundles, function/class/module names, message constants, storage keys, IDs, assets, icons, sounds, prompts, or visual branding.
- Reconstructing undocumented server behavior, hosted iframe internals, dynamic feature-flag behavior, or connector internals.
- Treating exact reference endpoints, SDKs, telemetry vendors, authentication clients, native hosts, or orchestration services as selected dependencies.
- Requiring a popup, context menu, tab-group design, fixed window dimensions, fixed colors, fixed retry timings, or a specific hidden/off-screen mechanism.
- Assuming permanent all-sites access, unlimited storage, native-app access, or advanced debugger access before least-privilege planning and scope approval.
- Shipping internal diagnostic/test controls as user-facing settings without a separate requirement.

## 20. Reference-only Behaviors

| Reference behavior | Reference ID | Reason it is not a Product Requirement |
| --- | --- | --- |
| Desktop/CLI clients can pair with and remotely request browser tools through cloud and native channels | F-016 | This is a separate companion-product ecosystem with a critical local/remote trust boundary. No new-product need is established. |
| A feature-gated remote sandbox/orchestrator can register the Extension as a browser worker | F-017 | This depends on a specific, unconfirmed orchestration service and is not inherent to an AI browsing assistant. |
| Exact hosted iframe path, message names, nonce/port protocol, and web origin | F-014 | Only the user-visible possibility of a hosted experience is a candidate; the reference protocol is private implementation detail. |
| Exact connector bootstrap route, transport, and catalog domains | F-015 | Connector product behavior remains candidate scope; existing transport is not selected. |
| Exact AI/OAuth/profile/URL-classifier endpoints and SDK behavior | F-002, F-003, F-008 | The product needs capabilities, not the reference provider contract. |
| Specific analytics, error, trace, and RUM providers | F-021 / cross-cutting | Telemetry vendors are implementation dependencies; event purpose/privacy must be defined first. |
| Exact request-header modifications and client identification | Cross-cutting reference architecture | No independent user-observable requirement supports it. |
| Exact local/session/managed storage keys, database names, cache sizes, and timers | Cross-cutting reference architecture | These are persistence choices; clean-room requirements use semantic data classes and unresolved measurable targets. |
| Automatic task tab grouping, indicator colors/pill layout, fixed scheduled windows, and fixed timing values | F-001, F-007, F-011 | The product requires context association, visibility, and reliable scheduling—not the same UI/mechanism. |
| Internal debug flags, trace pills, test messages, and remote feature-switch internals | F-021 | They are not confirmed user goals and may expose implementation details. |
| Specific onboarding websites, task IDs, short-link routes, and starter prompt text | F-020 | PR-018 requires only a trusted, validated handoff contract. |
| Proprietary icons, fonts, sounds, illustrations, watermark, or generated visual assets | F-013, F-019 | Product outcome can be achieved with independently designed assets. |

## 21. Open Questions

### Q-001

**Related feature:** F-001, F-009–F-021 / PR-001, PR-009–PR-019

**Question**

Which candidate features and activation/onboarding entry points are included in the first product release, and do the separate desktop/CLI companion or remote-orchestrator ecosystems in F-016/F-017 belong to the new product at all?

**Why it matters**

It changes scope, UX, manifest permissions, external dependencies, test surface, release sequence, and the classification of all SHOULD/COULD/NEEDS-CLARIFICATION requirements.

**Current evidence**

The Reference Extension exposes toolbar and keyboard activation plus onboarding, settings, scheduling, hosted, connector, and remote entry paths. Presence does not establish new-product priority.

**Current status**

<code>UNRESOLVED</code>

### Q-002

**Related feature:** F-002, F-003 / PR-002, PR-003

**Question**

Which AI inference, conversation, and browser-tool orchestration service will the new product use, and which responsibilities belong to the Extension versus the server?

**Why it matters**

It affects API contracts, authentication, streaming/progress behavior, tool schemas, data transmission, retries, conversation persistence, and architecture.

**Current evidence**

The reference uses a specific remote AI provider for conversation and tool selection. Server-side behavior beyond the observed requests is not confirmed and is not inherited.

**Current status**

<code>UNRESOLVED</code>

### Q-003

**Related feature:** F-002 / PR-002

**Question**

Does the product support account-based authorization, direct API credentials, a product-owned backend session, or a defined subset?

**Why it matters**

It affects onboarding, identity-provider dependency, credential handling, distribution risk, logout, account switching, privacy notice, and acceptance criteria.

**Current evidence**

The reference supports account OAuth and an API-key mode. Static evidence does not establish that both are required for the new product.

**Current status**

<code>UNRESOLVED</code>

### Q-004

**Related feature:** F-002, F-003, F-005, F-006, F-009, F-010–F-015 / PR-002–PR-006, PR-009–PR-015

**Question**

Which conversation, page, screenshot/file, action, schedule, workflow, connector, and account-bound data is stored locally or remotely, for how long, and what is deleted on logout, account switch, task deletion, or user request?

**Why it matters**

It affects privacy, storage design, account isolation, deletion UX, server contracts, export, incident impact, and testability.

**Current evidence**

The reference uses transient memory, browser storage, an allowlisted query cache, and remote services. Full server persistence and complete logout cleanup are not confirmed.

**Current status**

<code>UNRESOLVED</code>

### Q-005

**Related feature:** F-006 / PR-006

**Question**

Are page JavaScript execution, console observation, and network observation part of the target product, and if so are they three separately authorized capabilities?

**Why it matters**

It affects product persona, critical browser permissions, sensitive-data exposure, consent UX, prompt-injection risk, and security testing.

**Current evidence**

The reference implements all three with high-risk browser diagnostics and site permission checks. Product importance is not established.

**Current status**

<code>UNRESOLVED</code>

### Q-006

**Related feature:** F-004, F-007, F-008, F-009 / PR-005, PR-007, PR-008, PR-009

**Question**

What is the initial browser-action set, how are batch/multi-tab actions scoped, which actions require one-time versus persistent consent, is plan approval required, and is any expert bypass mode permitted?

**Why it matters**

It defines the core product contract, permission model, stop semantics, UX friction, security posture, and acceptance-test matrix.

**Current evidence**

The reference supports broad page and tab actions, multiple permission modes, plan approval, and a skip-all option. These are observed behaviors, not approved new-product policy.

**Current status**

<code>UNRESOLVED</code>

### Q-007

**Related feature:** F-005, F-008 / PR-004, PR-008

**Question**

How will the product decide that a URL or cross-site action is safe, and will any full URL, path, or query be sent to a remote classification service?

**Why it matters**

It affects privacy, service dependency, fail-closed behavior, latency, policy precedence, and URL handling tests.

**Current evidence**

The reference combines administrator rules with a remote category service and may transmit normalized path/query data. The new mechanism is not selected.

**Current status**

<code>UNRESOLVED</code>

### Q-008

**Related feature:** F-001, F-004, F-005, F-009 / PR-001, PR-004, PR-005, PR-009

**Question**

What Chrome versions, page types, frame types, browser-internal pages, local pages, restricted sites, and complex DOM cases are supported?

**Why it matters**

It affects technical constraints, manifest design, user-facing unsupported states, browser capability tests, and accessibility-tree/context expectations.

**Current evidence**

The reference declares a minimum browser version, runs page scripts broadly, and has bounded frame/page reading, but no dynamic compatibility matrix was produced.

**Current status**

<code>UNRESOLVED</code>

### Q-009

**Related feature:** F-011, F-019 / PR-011, PR-017

**Question**

For scheduled tasks, what happens when the browser is closed, the device sleeps, the due time is missed, authentication expires, consent is unavailable, the target page is not ready, or a retry could duplicate effects?

**Why it matters**

It affects unattended authority, scheduling semantics, idempotency, retry policy, notification UX, task history, and security.

**Current evidence**

The reference supports once and recurring schedules, creates a task context, waits for a page, records failures, and has limited retries. Catch-up and complete unattended-consent semantics are not confirmed.

**Current status**

<code>UNRESOLVED</code>

### Q-010

**Related feature:** F-012 / PR-012

**Question**

What workflow steps are captured, how are screenshots/element context and optional voice processed, where is the workflow transformed, what can the user edit, and what is saved or transmitted?

**Why it matters**

It affects scope, microphone/page permissions, data schema, privacy, server dependency, recoverability, reuse, and acceptance criteria.

**Current evidence**

The reference visibly supports start/stop recording, action/visual capture, optional voice narration, review, and saving. Feature-flag combinations, remote transformation, and final schema are not confirmed.

**Current status**

<code>UNRESOLVED</code>

### Q-011

**Related feature:** F-014 / PR-014

**Question**

Does the new product need a second hosted assistant experience, and if so who owns its UI, session, conversation, origin, capability contract, persistence, and fallback?

**Why it matters**

It affects product scope, authentication, cross-origin security, server dependency, duplicated UX, message validation, and end-to-end test ownership.

**Current evidence**

The reference host can load and relay tools for a hosted experience, but the iframe’s internals and server-side orchestration are outside the static evidence.

**Current status**

<code>UNRESOLVED</code>

### Q-012

**Related feature:** F-015 / PR-015

**Question**

Which external services, tool capabilities, authorization scopes, revocation paths, data flows, error contracts, and transport/server-mediation models are in product scope?

**Why it matters**

It affects launch scope, dependencies, privacy disclosures, connector UX, security boundaries, API contracts, and testing.

**Current evidence**

The reference can discover service/tool metadata and request remote-tool permission. Connector-specific transport and server responsibility are only partially identified.

**Current status**

<code>UNRESOLVED</code>

### Q-013

**Related feature:** F-018 / PR-016

**Question**

Is enterprise-managed deployment a target, and what policy source, rule syntax, precedence, update behavior, invalid-policy behavior, account restrictions, audit needs, and user recovery are required?

**Why it matters**

It affects personas, distribution, browser management integration, authentication, site safety, support, and acceptance criteria.

**Current evidence**

The reference supports managed URL patterns and allowed organization identifiers, with policy blocks overriding ordinary use. Market scope and deployment contract are unknown.

**Current status**

<code>UNRESOLVED</code>

### Q-014

**Related feature:** F-011, F-019 / PR-011, PR-017

**Question**

Which events may notify, what is opt-in/default behavior, are sound and notification categories separate, are quiet hours needed, and what in-product fallback exists when browser notification permission is denied?

**Why it matters**

It affects user interruption, permission request timing, privacy on shared/locked screens, asynchronous task UX, and test cases.

**Current evidence**

The reference supports a notification preference, completion/failure/remote notifications, optional audio, and returning to related browser context. Denial fallback and category policy are not confirmed.

**Current status**

<code>UNRESOLVED</code>

### Q-015

**Related feature:** Cross-cutting / NFR-009

**Question**

What product analytics, error reporting, and performance diagnostics are necessary; what event fields, page/task data, redaction, consent, sampling, processors, and retention are allowed?

**Why it matters**

It affects privacy notice, compliance, external dependencies, CSP/network scope, incident response, and verification.

**Current evidence**

The reference contains several telemetry providers and instrumentation layers. Static analysis does not confirm complete payload schemas or dynamic redaction/sampling.

**Current status**

<code>UNRESOLVED</code>

### Q-016

**Related feature:** F-012, F-014, F-015, F-017, F-021 / PR-012, PR-014, PR-015, PR-019

**Question**

Will the new product use dynamic feature flags, which capabilities may be gated, who controls them, and can a flag change permission, data, or external-dependency behavior after release?

**Why it matters**

It affects scope visibility, reproducible acceptance tests, configuration security, rollout/rollback, support, and least privilege.

**Current evidence**

The reference fetches dynamic feature configuration and contains gated capabilities. Actual production combinations were not dynamically observed.

**Current status**

<code>UNRESOLVED</code>

### Q-017

**Related feature:** F-021 / PR-019, NFR-008

**Question**

Which locales are required at launch, what is the fallback locale, and which assistant, settings, consent, error, notification, and onboarding content must be localized?

**Why it matters**

It affects product scope, content operations, accessibility, layout testing, release criteria, and support.

**Current evidence**

The reference contains eleven locale resources and a locale preference/action. Their presence does not establish the new product’s launch locale set.

**Current status**

<code>UNRESOLVED</code>

### Q-018

**Related feature:** F-013 / PR-013

**Question**

Which export formats and content scopes are supported, and what redaction, selection, warning, branding, visual replay, deletion, and file-lifetime rules apply?

**Why it matters**

It affects privacy, download permission, format implementation, user expectations, durable data exposure, and acceptance criteria.

**Current evidence**

The reference can export structured conversation data and an animated action artifact with screenshots. New-product format and redaction policy are not defined.

**Current status**

<code>UNRESOLVED</code>

## 22. Assumptions

| ID | Assumption | Consequence if false |
| --- | --- | --- |
| A-001 | The two Reference Evidence documents are the complete evidence source for Phase 2. | A new evidence review and traceability revision are required. |
| A-002 | The new product remains a Chrome Extension whose core proposition is AI-assisted understanding and controlled interaction with the current webpage. | Product summary, personas, MUST classifications, and technical constraints require revision. |
| A-003 | At least one remote or product-owned AI inference capability is required for PR-003. | PR-002, external dependencies, and conversation/task behavior need a local-only redesign. |
| A-004 | User-observable reference behavior is usable as product evidence, while its internal implementation is not a design constraint. | The clean-room boundary and all derived PRs need legal/product re-review. |
| A-005 | The core product is user-initiated and interactive; unattended authority is not part of the baseline. | PR-011 and consent/security requirements need reprioritization. |
| A-006 | Candidate classifications are recommendations for review, not approved release commitments. | The totals and In Scope/Candidate Scope sections must be updated after approval. |
| A-007 | No dynamic feature flag is assumed enabled and no undocumented server/iframe behavior is treated as a requirement. | PR-012, PR-014, PR-015, PR-019 and related acceptance criteria require evidence updates. |
| A-008 | The new product has no preselected reference AI provider, connector provider, telemetry vendor, native companion, or remote orchestrator. | External Dependency Analysis and technical planning inputs must be updated explicitly. |
| A-009 | Least privilege and explicit user consent are product constraints, even where the reference supports a broader expert bypass. | PR-008 and security acceptance criteria require a documented risk exception. |
| A-010 | Numeric limits, timeouts, retries, storage quotas, and compatibility targets are planning/testing decisions unless the user later supplies them. | New measurable requirements must replace the corresponding TBD statements. |

## 23. Risks

| ID | Risk | Impact | Mitigation / linked decision |
| --- | --- | --- | --- |
| R-001 | Malicious page content or prompt injection influences a privileged browser action | Unauthorized reading, typing, navigation, upload, or disclosure | PR-008, PSR-001–PSR-005; define action/consent matrix in Q-006 |
| R-002 | Baseline manifest receives broad permissions for optional features | Excessive install-time trust and larger compromise impact | NFR-001, Section 11; exclude PR-006/F-016/F-017 permissions until adopted |
| R-003 | Page, screenshot, file, console, network, connector, or conversation data is sent or retained beyond user expectation | Privacy/compliance breach and credential exposure | DR rules, PSR-006/PSR-010, resolve Q-004/Q-007/Q-012/Q-015 |
| R-004 | Product requirements accidentally hard-code reference providers/protocols | Vendor lock-in, clean-room leakage, blocked redesign | Section 12/20; provider decisions only after Q-002/Q-003 |
| R-005 | Authentication material or account-bound cache survives logout/account switch incorrectly | Session compromise and cross-account data leakage | AR-005–AR-008, DR-R06/DR-R07, resolve Q-004 |
| R-006 | Scheduled work reuses overbroad or expired consent while unattended | Unreviewed side effects, duplicates, ambiguous responsibility | PR-011, PSR-015, resolve Q-009 before adoption |
| R-007 | Hosted, workflow, connector, or flag-dependent behavior remains underspecified | Untestable acceptance criteria and hidden dependencies | Keep PR-012/014/015/016 provisional; resolve Q-010–Q-016 |
| R-008 | Multiple external entry points share privileged tools without equivalent checks | One weak origin/account/transport bypasses core safety | NFR-013, PSR-009; F-016/F-017 remain reference-only |
| R-009 | Browser/Extension context restarts leave stale indicators or duplicate actions | Misleading UI, repeated form submissions, lost scheduled state | TC-004, PR-007, PR-011, NFR-005 |
| R-010 | Export or notification reveals sensitive task content outside the active browser session | Durable or lock-screen disclosure | PR-013/017, PSR-013/PSR-014, resolve Q-014/Q-018 |
| R-011 | Scope includes all reference features without product prioritization | Delayed MVP, incoherent UX, impossible least privilege | Classification matrix and Q-001 |
| R-012 | Page compatibility and restricted contexts are not defined | Inconsistent behavior and false success claims | PR-004/005 failure flows, NFR-010, resolve Q-008 |
| R-013 | Sensitive-field redaction is treated as complete protection | Screenshots, JavaScript, files, or network bodies can still expose user-selected website secrets even though product/AI-service authentication material is isolated | PR-004/005/006/009, layered consent and data minimization |
| R-014 | Telemetry is added before event-level privacy rules | Hidden external dependency and accidental content capture | NFR-009, Q-015; no reference vendor inherited |

## Appendix A — Requirement Quality Check

### Traceability

All F-001 through F-021 have a visible disposition in Section 7: 19 map to PR/FR requirements and two are REFERENCE-ONLY.

### Testability

Each PR-001 through PR-019 contains at least one Given/When/Then acceptance scenario. NEEDS-CLARIFICATION criteria are explicitly provisional and linked to an Open Question.

### Implementation leakage

Normative requirements avoid reference bundle/function/class/module names, internal identifiers, message constants, storage keys, provider endpoints, proprietary assets, and private architecture. Technical names appear only where documenting non-normative reference/dependency or potential permission implications.

### Assumption and inference handling

Unconfirmed server-side, iframe, connector, dynamic-flag, scheduling, persistence, notification, and enterprise behavior is labeled <code>Behavior not confirmed</code>, <code>Unknown</code>, <code>NEEDS-CLARIFICATION</code>, or with an unresolved open-question status; it is not presented as confirmed behavior.

### Phase boundary

This draft stops at Product Requirements Extraction. It does not run Spec-Kit, select architecture, create code, install dependencies, or modify the Reference Extension.
