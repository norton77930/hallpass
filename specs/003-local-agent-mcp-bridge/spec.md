# Feature Specification: Local Agent MCP Bridge

**Feature Branch**: `003-local-agent-mcp-bridge` (logical feature identifier; this workspace has no Git metadata)

**Feature Directory**: `specs/003-local-agent-mcp-bridge`

**Created**: 2026-09-08

**Status**: Draft — owner decisions D-003-1 to D-003-4 recorded 2026-09-07; no open clarification; ready for planning

**Input**: User description: "Local agent MCP bridge (feature 003). Replace the remote-service trust model
with a trusted local coding agent: the extension pairs once with a local native-messaging host that exposes
an MCP server, so a coding agent (Claude Code first) can drive the user's real branded Chrome for automated
testing. Tool surface is the Claude in Chrome tool set from the reference analysis (kept in the private archive; its public summary is docs/design-notes.md) […]
Decisions already taken by the owner on 2026-09-07: (1) manifest gains host permission <all_urls> and the
permissions the tools need; (2) trust model is pair-once plus a per-site mode, the per-action consent card
becomes optional; (3) the existing remote task channel, per-action consent flow and plan binding are
archived, not extended; (4) only real branded Chrome is supported, verified through the packaged gate's
attach mode. Reuse: content runtime, contracts, locales, page fixtures, packaged gate. Non-goals: remote AI
service, per-action consent parity with 001, NVDA/accessibility sign-off, desktop/device tools, side-panel
workspace features. Success: a Claude Code session with the MCP server configured can open a fixture page,
read it, find an element by description, click/type/press keys, batch a login-form sequence, screenshot, and
manage tabs, on branded Chrome 152, with every tool covered by the packaged gate in attach mode."

**Authoritative Source Order**: Constitution → `docs/product-requirements-draft.md` → the reference
analysis (kept in the private archive; its public summary is `docs/design-notes.md`).

## Why this feature exists

001 and 002 built an assistant whose AI service is a remote, untrusted party: every browser effect is
gated by a per-action consent card, every task re-consents, one document is bound at a time, and the
extension holds no host permission. The product owner's primary goal is different: a **coding agent the
owner already trusts and runs locally** (Claude Code first) must be able to drive the owner's real Chrome
for automated testing, through the same kind of tool surface the reference extension exposes to its own
local agents. Under that trust model the per-action ceremony is friction rather than protection, and the
single-document model rules out navigation and multi-tab work outright. This feature therefore introduces a
second caller — a paired local agent — with its own consent model, and brings the reference tool surface
into scope for that caller. The remote-service path stays as it is (archived, not extended).

## Owner decisions recorded before specification

These were taken by the product owner on 2026-09-07 and are binding for this feature. Each is a product
decision the Constitution reserves for the owner (IV, V, VI); recording them here is what lets planning
proceed without a `BLOCKS-PLANNING` gate.

| ID | Decision | Constitution touchpoint |
| --- | --- | --- |
| D-003-1 | The manifest MAY declare broad host access and the permissions the approved tools require. Each permission still has to trace to a functional requirement and an acceptance scenario in this document (FR-031, FR-045). | V (least privilege — satisfied by tracing, not by breadth), TC-003 |
| D-003-2 | Trust model for the local-agent caller: **pair once**, then a **per-site mode** (`ask` / `follow-a-plan` / `skip-checks`). The per-action consent card of 001 is optional under `ask` and absent under the other two modes. | VI, PR-008 |
| D-003-3 | The remote task channel, per-action consent flow and plan binding of 001/002 are **archived**: not removed, not extended, and out of scope here. | I, III (destination recorded) |
| D-003-4 | Only real branded Chrome is a supported host; evidence comes from the packaged gate's attach mode. | TC-007 |

**Governance consequences**, applied by this specification:

- A new Product Requirement **PR-020 — Pair a Trusted Local Agent** is introduced (owner-approved 2026-09-07;
  its text is appended to `docs/product-requirements-draft.md` as part of this specification). It is the
  "later approved Product Requirement" the Constitution requires to move **F-016** (local bridge and
  native messaging) out of `REFERENCE-ONLY`. F-017 stays `REFERENCE-ONLY`.
- **PR-006 — Provide Advanced Page Diagnostics** was `NEEDS-CLARIFICATION`. The owner's tool list includes
  console, network and script evaluation for the local-agent caller, so PR-006 is resolved **for that
  caller only** (User Story 6) and stays unresolved for the remote-service caller.
- **PR-015** (connected external service tools) is *not* what this feature is: here the agent calls the
  browser, not the other way round. PR-015 stays unresolved.

## Traceability

| This feature | Product requirement | Reference feature | Notes |
| --- | --- | --- | --- |
| US1, FR-031–FR-035 | **PR-020 (new)** | F-016 | Pairing, host discovery, unpairing, agent identity |
| US2, FR-036–FR-039 | PR-004 | F-005 | Page understanding for the local-agent caller |
| US3, FR-040–FR-043 | PR-005, PR-008 | F-004, F-008 | Actions gated by the per-site mode |
| US4, FR-044–FR-046 | PR-005, PR-007 | F-004, F-007 | Navigation, tabs, the session tab group, resize |
| US5, FR-047–FR-048 | PR-005 | F-004 | Batch and wait for automated test flows |
| US6, FR-049–FR-050 | **PR-006 (resolved for this caller)** | F-006 | Diagnostics behind an explicit per-site grant |
| US7, FR-051 | PR-009 | F-009 | File upload into a page |
| FR-052–FR-054 | PR-007, PR-008 | F-007, F-008 | Stop, visibility, and what does not change |

Reference features with no story here keep their 001 destination. F-017 remains `REFERENCE-ONLY`.

**Numbering**: functional requirements continue from 002 (FR-030) and success criteria from 002 (SC-019).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pair a coding agent with the browser once (Priority: P1)

The owner installs the local bridge, adds it to their coding agent's tool configuration, and starts a
session. The first time the agent connects, the extension shows who is asking to pair and the owner
confirms once. From then on the agent's tools are available in every session without further prompting,
until the owner unpairs from the extension.

**Why this priority**: nothing else in this feature is reachable without a paired agent; pairing is also
where the new trust boundary (owner ↔ local agent) is established and made visible.

**Independent Test**: install the bridge, configure the agent, run one trivial tool (list tabs) — the
pairing prompt appears once, the call succeeds, a second session needs no prompt, and unpairing makes the
next call fail with a clear "not paired" answer.

**Acceptance Scenarios**:

1. **Given** the bridge is installed and no agent is paired, **When** an agent connects for the first time,
   **Then** the extension shows a pairing request naming the agent and the owner can accept or decline; no
   tool runs before acceptance.
2. **Given** an agent was accepted earlier, **When** it connects again (new session, browser restart),
   **Then** its tools work without any prompt.
3. **Given** a paired agent, **When** the owner unpairs it from the extension, **Then** every open agent
   session loses its tools immediately and the next connection is treated as a first connection.
4. **Given** the bridge is not installed or not running, **When** the agent tries to connect, **Then** the
   agent receives an explicit "bridge unavailable" answer that names the missing piece; the extension stays
   usable for everything else.
5. **Given** a second, different agent connects while one is paired, **When** it asks to pair, **Then** the
   owner is asked again for that agent; acceptance of one never implies acceptance of another.

---

### User Story 2 - Let the agent read and understand the current page (Priority: P1)

A paired agent asks which tabs it owns, reads a page as text or as a structured tree of elements, finds an
element by describing it, and takes a screenshot to see what the owner sees.

**Why this priority**: reading is the half of every automated test that decides whether the action half
worked; with User Story 1 it already delivers value (page inspection from the agent).

**Independent Test**: open a fixture page in the agent's tab, call each read tool, and compare the answers
with the fixture's known content.

**Acceptance Scenarios**:

1. **Given** a paired agent and a tab it owns showing a page, **When** it asks for the page's text, **Then**
   it receives the readable text of the page, article content first, within a stated size bound.
2. **Given** the same tab, **When** it asks for the page's structure, **Then** it receives a tree of
   elements with roles, names and stable references, optionally filtered to interactive elements or limited
   in depth, within a stated size bound, with a note when the tree was cut.
3. **Given** the same tab, **When** it describes an element ("the search box", "the Save button"), **Then**
   it receives up to a bounded number of matching elements, each with a reference usable by the action
   tools; a description matching nothing says so; a description matching more than the bound says so
   rather than guessing.
4. **Given** the same tab, **When** it asks for a screenshot or a zoomed region, **Then** it receives an
   image of the visible viewport (or region) of that tab.
5. **Given** a tab showing a page the browser does not let extensions read (browser-internal pages, the
   extension's own pages, local files without permission, a PDF viewer), **When** any read tool is called,
   **Then** the answer is an explicit "page not readable" with the reason, never partial or fabricated data.
6. **Given** the site mode for the page's site is `ask`, **When** a read tool is called, **Then** reading
   proceeds without a prompt — reading is never gated by the per-site mode (only effects are).

---

### User Story 3 - Let the agent act on the page under a per-site mode (Priority: P1)

A paired agent clicks, double- and triple-clicks, right-clicks, hovers, drags, types, presses keys with
modifiers, scrolls, and sets form values on the page. What the agent may do without asking is decided per
site by the owner: `ask` (every effect needs the owner's yes), `follow-a-plan` (the owner approves a stated
plan once, then its steps run unprompted), or `skip-checks` (effects run unprompted on that site).

**Why this priority**: acting is what makes automated testing possible; the per-site mode is the whole
consent model of this feature and must ship with the first action.

**Independent Test**: on a fixture page, set the site to `skip-checks`, run each action, and verify the
page changed as the fixture defines; set the site to `ask`, run one action, and verify the prompt appears
and nothing happens until it is answered.

**Acceptance Scenarios**:

1. **Given** a paired agent and a site in `skip-checks` mode, **When** it clicks a button by reference,
   **Then** the page's own click handling runs and the answer reports what the page did (observable
   change or none).
2. **Given** the same site, **When** it types text into a focused field, presses a key (with or without
   a modifier, repeated N times), scrolls, hovers, double-clicks, triple-clicks, right-clicks, or drags
   from one point to another, **Then** each is delivered to the page as the corresponding user input and
   the answer reports the observed outcome.
3. **Given** the same site, **When** it sets a form control by reference (text, checkbox, select option),
   **Then** the control holds the requested value afterwards and the page's own change handling ran.
4. **Given** a site in `ask` mode, **When** any effect is requested, **Then** the owner sees what is about
   to happen (site, target, action) and the effect runs only after the owner's yes; a no answers the agent
   with an explicit denial and nothing happened on the page.
5. **Given** a site in `follow-a-plan` mode, **When** the agent states a plan and the owner approves it,
   **Then** the plan's steps run without further prompts; a step outside the approved plan is treated as
   under `ask`.
6. **Given** a site the owner has never set, **When** an effect is requested, **Then** the site is treated
   as `ask` and the owner can set the site's mode from that prompt.
7. **Given** the owner presses Stop in the extension while an agent action is in flight, **When** the
   action has not yet reached the page, **Then** it does not run; when it has, the answer reports the
   action as done or uncertain, never as stopped-before-it-happened.
8. **Given** a target reference from an earlier read that no longer exists on the page, **When** an action
   names it, **Then** the answer is an explicit "stale reference"; nothing else on the page is acted on.

---

### User Story 4 - Let the agent navigate and manage its own tabs (Priority: P2)

A paired agent opens tabs, closes them, navigates to a URL, goes back and forward, resizes the window, and
always knows which tabs are its own. Its tabs are grouped and visibly marked so the owner can tell them
apart from their own browsing.

**Why this priority**: automated tests start from a URL and usually span more than one page; without this
story the agent can only act on whatever the owner opened for it.

**Independent Test**: from the agent, create a tab, navigate it to a fixture, navigate to a second fixture,
go back, list tabs, close the tab — each answer matches the browser's state.

**Acceptance Scenarios**:

1. **Given** a paired agent, **When** it asks for its tab context, **Then** it receives the identifiers
   and current URLs of the tabs in its own group, and nothing about the owner's other tabs.
2. **Given** a paired agent, **When** it creates a tab, **Then** the tab is added to the agent's group,
   visibly marked as agent-controlled, and reported back with its identifier.
3. **Given** an agent tab, **When** it navigates to a URL, back, or forward, **Then** the tab shows the
   requested page and the answer reports the final URL, or an explicit failure when the browser refused
   or the page did not load.
4. **Given** an agent tab whose site mode is `ask`, **When** the agent navigates it to another site,
   **Then** the new site's own mode applies from then on; a navigation itself is not an effect on the
   page and needs no prompt.
5. **Given** the owner closes an agent tab by hand, **When** the agent next refers to it, **Then** the
   answer is an explicit "tab gone"; the agent's other tabs are unaffected.
6. **Given** a paired agent, **When** it resizes the window, **Then** the window holding its tab group
   takes the requested size where the platform allows it and the answer reports the resulting size. A
   window that is maximized or full-screen is returned to a normal window first, because that is the only
   state in which a size can be honoured; the answer is still the size the window actually got.

---

### User Story 5 - Run a sequence in one call and wait for the page (Priority: P2)

A paired agent submits an ordered list of tool calls to run as one round trip — for example click the
username field, type, click the password field, type, press Enter — and can wait either a fixed time or
until a page condition holds before the next step.

**Why this priority**: a login form is five round trips today; automated tests are made of such sequences,
and a per-step round trip makes them slow and flaky. It builds on User Story 3 and is independently
demonstrable on the login-form fixture.

**Independent Test**: on the login-form fixture in `skip-checks` mode, submit the five-step sequence as one
batch and verify the form was submitted; then submit a batch whose third step names a missing element and
verify steps four and five did not run.

**Acceptance Scenarios**:

1. **Given** a site in `skip-checks` mode, **When** the agent submits a batch of effects, **Then** they run
   in order, each answer is returned in order, and the batch stops at the first failure with the remaining
   steps reported as not run.
2. **Given** a site in `ask` mode, **When** the agent submits a batch, **Then** each effect in the batch is
   subject to the owner's yes exactly as if it had been sent alone; a batch never bypasses the site mode.
3. **Given** a batch that navigates to a site in a different mode midway, **When** the next step is an
   effect, **Then** that step is governed by the new site's mode.
4. **Given** a page that will change after an action, **When** the agent waits for a condition (an element
   appears or disappears, becomes enabled, or visible text changes) with a stated maximum, **Then** the
   wait ends as soon as the condition holds, or at the maximum with an explicit "condition not met".
5. **Given** any wait, **When** the owner presses Stop, **Then** the wait ends at once with an explicit
   "stopped" answer and no dependent step runs.

---

### User Story 6 - Give the agent page diagnostics behind an explicit grant (Priority: P3)

A paired agent reads the page's console messages and network requests, and evaluates a script in the page,
so a test can assert on what the page logged, requested, or holds in memory. Because these reach past what
a user can see, they require a separate per-site diagnostics grant from the owner.

**Why this priority**: valuable for testing, but the first automated tests do not need it, and it is the
only story that changes what the browser shows the owner (a diagnostics banner).

**Independent Test**: grant diagnostics for the fixture site, log a message from the page, and read it
back; request a network read on a site without the grant and verify the explicit refusal.

**Acceptance Scenarios**:

1. **Given** a site with the diagnostics grant, **When** the agent reads console messages with a filter,
   **Then** it receives the matching messages of that tab's current page only.
2. **Given** the same site, **When** it reads network requests with a filter, **Then** it receives the
   matching requests made by that tab since the page loaded; requests are cleared when the tab leaves the
   site.
3. **Given** the same site, **When** it evaluates a script in the page, **Then** the script's result is
   returned and the site mode's rules for effects still apply to anything the script changes visibly
   (a script under `ask` is itself an effect that needs the owner's yes).
4. **Given** a site without the diagnostics grant, **When** any diagnostics tool is called, **Then** the
   answer is an explicit "diagnostics not granted for this site"; the owner can grant it from the
   extension.
5. **Given** the browser shows its own warning while diagnostics are attached, **When** the owner reads
   it, **Then** it names this extension, and detaching (revoking the grant) removes the warning.

---

### User Story 7 - Let the agent put a file into a page (Priority: P3)

A paired agent uploads one or more files from the owner's disk into a page's file input, so a test can
exercise upload flows without a native file dialog.

**Why this priority**: needed for a class of tests, not for the first ones; isolated and bounded.

**Independent Test**: on the upload fixture, upload a small file by reference and verify the page reports
the file's name and size.

**Acceptance Scenarios**:

1. **Given** a site in `skip-checks` mode and a file input reference, **When** the agent uploads files
   under the size bound, **Then** the input holds those files and the page's change handling ran.
2. **Given** a path outside what the owner allowed for uploads or a file over the bound, **When** the
   agent uploads, **Then** the answer is an explicit refusal naming the rule; nothing is read from disk.

---

### Edge Cases

- **Agent disconnects mid-action**: the in-flight action completes or fails on its own; its answer is
  discarded; the owner sees the effect's outcome in the extension's activity record; no later action runs.
- **Extension reloads while an agent session is open**: the agent's next call receives "reconnect
  required" and the pairing survives; tabs the agent owned stay open and marked.
- **Owner navigates an agent tab by hand**: the tab stays the agent's; its next read sees the new page;
  stale references fail as in US3 scenario 8.
- **Two calls in flight on the same tab**: the second is refused as "busy" rather than interleaved.
- **A prompt under `ask` is left unanswered**: the call times out with "no answer" after a stated bound;
  nothing ran.
- **The page opens a modal dialog (alert/confirm/prompt)**: the answer reports the dialog and the agent can
  accept or dismiss it through a tool; no other action runs until it is handled.
- **The site mode changes while a batch is running**: the change applies from the next step.
- **Restricted pages** (browser-internal, the extension's own pages, another extension's pages): reads and
  effects answer "page not readable"/"page not actionable"; tab management still works.

## Requirements *(mandatory)*

### Functional Requirements

**Pairing and identity (PR-020)**

- **FR-031 (PR-020 — MUST)**: The product MUST let one or more local agents pair with the extension
  through a locally installed bridge; the first connection of each agent MUST be shown to the owner with
  the agent's stated name and origin and MUST NOT expose any tool until the owner accepts. Acceptance
  MUST persist across browser and agent restarts until the owner unpairs. The permissions this needs
  (local bridge messaging) MUST be declared and MUST NOT be requested for any other purpose.
- **FR-032 (PR-020 — MUST)**: The owner MUST be able to see the paired agents and unpair any of them from
  the extension; unpairing MUST take effect on open sessions immediately.
- **FR-033 (PR-020 — MUST)**: An agent that is not paired, or whose bridge is unavailable, MUST receive an
  explicit answer naming the cause; the extension MUST remain fully usable without the bridge.
- **FR-034 (PR-020 — MUST)**: Every tool answer MUST identify the tab it concerns; an agent MUST NOT be
  able to name a tab outside its own group.
- **FR-035 (PR-020 — MUST)**: Page content, screenshots, diagnostics and files MUST flow only between the
  browser and the paired local agent on the same device. The extension MUST NOT transmit them anywhere
  else. The specification records that the agent itself may forward them to its own model; that is the
  agent's disclosure, and the pairing prompt MUST say so in one sentence.

**Reading (PR-004)**

- **FR-036 (PR-004 — MUST)**: A paired agent MUST be able to obtain the readable text of a tab's current
  page, article content first, within a stated size bound, without any per-site prompt.
- **FR-037 (PR-004 — MUST)**: A paired agent MUST be able to obtain the page's element tree with roles,
  names and stable references, optionally filtered to interactive elements, limited by depth, or rooted at
  a reference, within a stated size bound, with truncation reported.
- **FR-038 (PR-004 — MUST)**: A paired agent MUST be able to resolve a natural-language description to a
  bounded number of element references; no match and too many matches MUST be distinct explicit answers.
- **FR-039 (PR-004 — MUST)**: A paired agent MUST be able to obtain an image of a tab's visible viewport or
  a rectangular region of it. Pages the browser does not let extensions read MUST answer "page not
  readable" for every read tool.

**Effects and the per-site mode (PR-005, PR-008)**

- **FR-040 (PR-005 — MUST)**: A paired agent MUST be able to deliver these inputs to a page: left, right,
  double and triple click at coordinates or on a reference; hover; drag between two points; type text;
  press a named key with optional modifiers and a repeat count; scroll in a direction at a point; scroll a
  reference into view; set a form control's value (text, checkbox, select option). Each answer MUST report
  the observed outcome and MUST NOT claim an effect that was not observed.
- **FR-041 (PR-008 — MUST)**: Every effect MUST be governed by the mode of the site of the tab's current
  page at the moment the effect is requested: `ask` requires the owner's yes per effect; `follow-a-plan`
  requires the owner's yes once per stated plan and then admits only that plan's steps unprompted;
  `skip-checks` admits effects unprompted. A site never set MUST behave as `ask`. Reads and tab
  management are never gated by the mode.
- **FR-042 (PR-008 — MUST)**: The owner MUST be able to view and change every site's mode and the
  diagnostics grant from the extension, and MUST be able to set the mode from within an `ask` prompt.
- **FR-043 (PR-005 — MUST)**: A reference that no longer resolves on the current page MUST be refused as
  stale; a second call on a tab with a call in flight MUST be refused as busy; an `ask` prompt left
  unanswered MUST time out with nothing run.

**Navigation and tabs (PR-005, PR-007)**

- **FR-044 (PR-007 — MUST)**: Every tab an agent creates or is given MUST belong to that agent's own
  group, be visibly marked as agent-controlled while so, and be listed by the tab-context tool; the
  owner's other tabs MUST NOT be visible to the agent.
- **FR-045 (PR-005 — MUST)**: A paired agent MUST be able to create and close its own tabs, navigate them
  to a URL or through history, and resize their window (a maximized or full-screen window is returned to
  a normal window first; the answer is the size the window actually got, never the size asked for).
  Navigation is not an effect on a page and MUST NOT prompt; the destination site's mode applies afterwards. This is the requirement the broad host
  permission of D-003-1 traces to: without it a tab cannot be read or acted on after navigation.
- **FR-046 (PR-007 — MUST)**: Stop in the extension MUST end the current call and every queued step of a
  batch; an effect already delivered MUST be reported as done or uncertain, never as prevented.

**Batch and wait (PR-005)**

- **FR-047 (PR-005 — MUST)**: A paired agent MUST be able to submit an ordered batch of calls that runs
  sequentially in one round trip, stops at the first failure, reports every step's answer in order, and
  applies the per-site mode to each effect exactly as if sent alone.
- **FR-048 (PR-005 — MUST)**: A paired agent MUST be able to wait a fixed time (bounded) or until an
  element is present, absent or enabled or the visible text changed (bounded); reaching the bound MUST be
  an explicit answer; Stop MUST end a wait immediately.

**Diagnostics (PR-006, resolved for this caller)**

- **FR-049 (PR-006 — MUST)**: Console messages, network requests and script evaluation MUST be available
  only for sites the owner has granted diagnostics, revocable at any time; the browser's own attached-
  debugger indication MUST name this extension.
- **FR-050 (PR-006 — MUST)**: Console and network answers MUST be limited to the tab's current page/site
  and support a filter; a script evaluation's visible effects MUST be governed by the site mode.

**File upload (PR-009)**

- **FR-051 (PR-009 — SHOULD)**: A paired agent SHOULD be able to place files from owner-allowed
  locations, under a size bound, into a page's file input by reference, without a native dialog.

**What does not change**

- **FR-052 (PR-007 — MUST)**: The extension MUST show that an agent is active, on which tabs, and offer
  one Stop, as 001/FR-007 already requires.
- **FR-053 (PR-008 — MUST)**: The remote-service caller of 001/002 keeps its consent model unchanged; the
  per-site mode applies to the local-agent caller only (D-003-3).
- **FR-054 (PR-001 — MUST)**: Installing this feature MUST NOT change what the extension does before an
  agent is paired: no page is read, no action runs, no diagnostics attach.

### Key Entities

- **Paired agent**: a local agent identity the owner accepted; has a name, an origin (the bridge it came
  through), an acceptance time, and zero or more open sessions.
- **Agent session**: one connection of a paired agent; owns a tab group; ends with the connection.
- **Site mode**: per site (scheme + host), one of `ask`, `follow-a-plan`, `skip-checks`, plus a
  diagnostics grant flag; set by the owner; default `ask`.
- **Stated plan**: under `follow-a-plan`, the ordered list of effects the agent declared and the owner
  approved for one site and session.
- **Tool call**: one request from an agent naming a tab, a tool and its arguments; answered exactly once
  with an outcome (done, denied, stale, busy, not readable, stopped, timed out, failed).
- **Element reference**: a stable handle to one element of one page as of one read; invalid once the
  element or page is gone.
- **Agent tab group**: the tabs one session owns; visibly marked; the only tabs the session can name.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-020**: An owner with the bridge installed pairs a coding agent and runs its first successful tool
  call in under 2 minutes, answering exactly one prompt.
- **SC-021**: From a paired coding agent, the login-form fixture is completed as one batch (focus, type,
  focus, type, submit) in under 10 seconds end to end on branded Chrome 152, with the submission observed
  by the page.
- **SC-022**: Every tool in this feature's surface is exercised by at least one packaged journey that
  runs against a browser the owner loaded the extension into (attach mode), in both supported locales.
- **SC-023**: In `ask` mode, 100% of effects are preceded by a prompt and 0% run on a "no" or on no
  answer, across the packaged journeys.
- **SC-024**: An agent can never list, read, or act on a tab outside its group: every such attempt in the
  packaged journeys is refused.
- **SC-025**: No page content, screenshot, diagnostics or file leaves the device through the extension:
  the redacting test proxy that fronts the remote service sees none of it during the local-agent
  journeys.
- **SC-026**: Unpairing an agent stops its next call within 1 second; reinstalling the bridge does not
  restore a removed pairing.
- **SC-027**: Every read tool answers "page not readable" on each restricted-page kind in the fixture set
  (browser-internal, extension page, local file, PDF), never partial content.

## Assumptions

- The owner is the only user of the local-agent caller; multi-user or enterprise policy for it is out of
  scope (PR-016 unchanged).
- The coding agent speaks the same tool protocol the reference's local agents use, so the agent side needs
  configuration, not code; the exact protocol and bridge packaging are planning decisions (IX, X).
- Effects on a page are delivered the way 002 already delivers them (as inputs to the page's own
  handling, with observed outcomes), so the 002 constraints that were about *risk classification* for an
  untrusted caller do not apply under `skip-checks`; the observation and reporting rules do.
- Screenshots and viewport images are of the agent's tab only; the owner's screen outside the tab is never
  captured.
- "Site" means scheme plus host; a port is part of the host for the fixture origins.
- The reference's desktop/device tools, side-panel workspace features, scheduling, sharing and export are
  not part of this feature and keep their existing destinations.
- Accessibility sign-off (T093 of 001) is not required for this feature's first release.
- The agent's identity is a bearer value: any process running as the same user can read the machine-local
  `agent-id` file and present it, so pairing identifies an installation rather than authenticating a
  caller — accepted under R-102's single-user model, where such a process could already drive the browser.

## Out of scope

- The remote AI service and everything specific to it: the task channel, per-action consent cards for that
  caller, plan binding, effect markers as a consent mechanism (D-003-3; archived).
- Any agent that is not local to the device.
- Desktop application control, clipboard, local shell or file editing on behalf of the agent.
- Enterprise policy for the local-agent caller.

## Change Log

| Date | Change | Origin |
| --- | --- | --- |
| 2026-09-16 | FR-045 and US4 scenario 6 clarified: a maximized or full-screen window is returned to a normal window before the requested size is applied, and the answer is always the size actually obtained. Cause: on a maximized window the browser silently ignores a size and the tool answered the unchanged screen size for two different requests; the owner chose to honour the request (with the visible un-maximize) over refusing. Neither reference settles this — one has the same blind spot and reports the requested size as success, the other has no resize at all. Restoring the window's state when the tab is released is a recorded follow-up, not part of this requirement | Owner decision 2026-09-16, `docs/design-notes.md` §5 |
| 2026-09-08 | Initial specification; PR-020 introduced; F-016 brought into scope; PR-006 resolved for the local-agent caller | `/speckit-specify`, owner decisions D-003-1–4 of 2026-09-07 |
| 2026-09-08 | Reading recorded, no FR text changed: under `follow-a-plan` a "stated plan" is a `browser_batch` the owner approved once as a whole, admitted step by step; the gate and its bookkeeping ship in M3, the batch that states one in M5 (T048) | M3 design decision 5 |
| 2026-09-08 | Same reading, now delivered (no FR text changed): a `browser_batch` on a `follow-a-plan` site raises one plan prompt carrying every step in words; the owner approves it whole or strikes out steps, and the approved list is the session's StatedPlan the gate admits step by step. A struck-out step is answered `denied`/`excluded`, an unapproved effect on that site is still `ask` | M5 (T048), US3 scenario 5 |
| 2026-09-08 | Reading recorded, no FR text changed: FR-040's "every control" is delivered as a caller-stated *minting policy* on a page collection - the archived 001/002 walk is unchanged, and the local agent's names every control it sees, links, submit controls and the owner's own sensitive fields included, so a ref exists for anything the site's mode may then allow | M6 (B1), review of M3+M4 |
| 2026-09-08 | Reading recorded, no FR text changed: `evaluate` (US6) and `file_upload` (US7) pass the same per-site gate an effect does, because a script and a file put into a form both change the page; the diagnostics grant and the site mode are two separate consents and neither implies the other | M6 (T057, T063), US6 scenario 3 |
| 2026-09-08 | Recorded limitation, no FR text changed: a `find` or a `read_page` replaces the page's refs, so refs from an earlier read on the same tab are stale; both tool descriptions say so, and a per-read snapshot generation is a follow-up rather than part of this feature | M6 (B8/L4) |
| 2026-09-08 | Reading recorded, no FR text changed: FR-049's "the debugger goes away with the grant" covers a navigation nobody asked this feature about - a clicked link, a redirect, a form submit, the owner's own url entry - so the diagnostics runner watches `chrome.tabs.onUpdated` for the tabs it is attached to, and reconciles Chrome's own `getTargets()` at worker start so an attachment that outlived an evicted worker is let go | M7 (C1), review of M6 |
| 2026-09-08 | Reading recorded, no FR text changed: a control nobody can see is named but is not part of the working read - `read_page filter=all` lists it and keeps its ref (a `wait { condition: "present" }` has to be able to name an element that has not appeared yet, FR-048), `filter=interactive` omits it, and the executor refuses an effect on it. `input[type=hidden]` is not a control at all and is not listed; `input[type=file]` has its own role word `file` | M7 (C2), review of M6 |
| 2026-09-08 | Reading recorded, no FR text changed: a `pattern` on `read_console`/`read_network` is agent-supplied and matched against page-supplied text, so a nested-quantifier pattern is refused as `failed`/`invalid-pattern` and every match runs against a bounded prefix of a line - the cost of filtering cannot be made a function of what a page chose to log | M7 (C3), review of M6 |
| 2026-09-08 | Reading recorded, no FR text changed: FR-035's "in the owner's own language" covers what a prompt says the call *is*, so the panel names the tool through reviewed per-tool copy (`agent.summary.<tool>`, both locales) instead of rendering the worker's English summary; the worker's summary stays in the projection as its own record | M7 (T068) |
