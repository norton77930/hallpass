# Feature Specification: Reference Parity for the Local Agent Bridge

**Feature Branch**: `004-reference-parity-bridge` (logical feature identifier; this workspace has no Git metadata)

**Feature Directory**: `specs/004-reference-parity-bridge`

**Created**: 2026-09-09

**Status**: Draft — owner decisions D-004-1 to D-004-6 recorded 2026-09-09; no open clarification; ready for planning

**Input**: User description: "Feature 004 — Reference parity for the local agent bridge. Close the behaviour
deltas between feature 003 (local agent MCP bridge) and the two reference extensions (Claude in Chrome
1.0.91, ChatGPT/Codex 1.26.901), driven by the first owner run on branded Chrome 152 on 2026-09-09. Scope,
in slice order: S0 acceptance probe […]; S1 multi-session bridge on the Codex model […]; S2 pairing timeout
that survives a 20 s human accept inside one call, and tab ownership […] plus the reference in-page
indicator banner with a user-triggered "back to main tab" button; S3 all-frames reading […]; S4 CDP input
[…]; S5 refs stable per element across reads […], read_page capacity and fields matching the reference
[…], and open shadow root traversal […]; S6 a coordinate-based computer tool […]. Out of scope: closed
shadow roots, cross-session coordination, CDP drag, find's matching mechanism, cloud bridge. Acceptance
standard (owner-approved 2026-09-09): every claim closes with the S0 probe on the owner's branded Chrome
152 against a named public page […], expected behaviour derived from reading the installed reference code
(never copied), nothing left for the owner to verify."

**Authoritative Source Order**: Constitution → `docs/product-requirements-draft.md` (PR-020 as amended
here) → the behaviour analysis (kept in the private archive; its public summary is
`docs/design-notes.md`), which records the 2026-09-09 reading of both installed reference extensions.

## Why this feature exists

Feature 003 was verified on a bundled browser against fixture pages. On 2026-09-09 the owner drove it for
the first time from a real coding-agent session on their own branded Chrome 152 against a real page, and
hit four failures inside one hour (recorded in `docs/design-notes.md`, evidence E1–E4):
a second agent session made the bridge unavailable to every session; the first call after the pairing
prompt timed out; the agent could not see the tab the owner had open; and a page whose content lives in an
embedded frame read as almost empty. Reading the installed code of the two reference extensions showed
that three of the four are exactly the places where 003's behaviour departs from theirs, and that the
remaining gaps the earlier coverage review had ranked on paper (hover, per-key typing, reference lifetime,
page capacity, coordinate actions) are departures too.

This feature therefore has one purpose: **make the local-agent caller behave, observably, the way the
reference extensions behave**, in the order the owner's real run exposed the gaps, and prove each item on
the owner's real browser against real pages before it is called done. Where the two references differ, the
evidence document says which one is followed and why. Where neither reference determines a behaviour, 003's
behaviour stays.

## Owner decisions recorded before specification

Taken by the product owner on 2026-09-09 during the scope review, binding for this feature.

| ID | Decision | Constitution touchpoint |
| --- | --- | --- |
| D-004-1 | This feature is framed as **closing the observable-behaviour deltas from the reference extensions**, not as the earlier coverage ranking. For each item the expected behaviour is the reference's, established by reading the installed reference code and confirmed by running the reference on the same page; it is described here in observable terms only. Both references count: Claude in Chrome for page tools and the agent indicator, the Codex extension for concurrent sessions and tab leases, and for open shadow roots. | I (the owner's confirmation is what makes these product requirements), II (behaviour, never code) |
| D-004-2 | **Several agent sessions may use one browser at the same time.** Each session has its own tab group; a tab belongs to at most one live session; a session asking for another session's tab is refused and told which session holds it. No coordination between sessions. This amends PR-020 (one session per device was an interim constraint of 003's planning, not a product decision). | PR-020 amendment, VI |
| D-004-3 | **The agent may see the owner's tabs and take over the one the owner is looking at.** Listing the owner's tabs is a read the owner accepts for a paired agent; reading or acting on a tab still requires the session to hold it. This narrows 003's SC-024 ("never list … outside its group") to "never read or act on a tab it does not hold". The reference's in-page indicator with a user-triggered "back to the agent's main tab" control is included for the owner's convenience. | PR-007, PR-020 amendment, VI |
| D-004-4 | **Inputs are delivered the way the references deliver them**: as browser-level pointer and keyboard input so that a page cannot tell them from a person's, with pointer movement before every click and hover, and one keystroke per character. The browser's own "this tab is being controlled" notice that accompanies this kind of input is accepted as visible, since the references show it too. The existing debugging permission of 003 is used for this; its diagnostics grant (PR-006) stays a separate consent and is not implied. | V (existing permission, new traced use), PR-005, PR-008 |
| D-004-5 | **Open shadow roots are read** (the Codex extension does; Claude in Chrome does not). Closed shadow roots are out of scope. | PR-004 |
| D-004-6 | **Acceptance standard**: every claim in this feature closes on the owner's own branded Chrome 152, against a named public page, with the coding agent itself as the caller (a scripted non-interactive agent session on the cheaper model tier), a baseline recorded for the same page (see "Acceptance standard" point 4, amended 2026-09-09), and a timestamped report. No verification cell is handed to the owner. | VII, TC-007 |

**Governance consequences**, applied by this specification:

- **PR-020 — Pair a Trusted Local Agent** is amended (text appended to `docs/product-requirements-draft.md`
  as "Amendment 2026-09-09"): "one or more sessions of one or more paired agents at the same time", and
  "the agent may list the owner's tabs and take a tab the owner offers". F-016 stays in scope as before.
- 003's **SC-024** is superseded for listing by D-004-3; its read/act half is restated as SC-032 here.
- 003's recorded limitation "a `find` or a `read_page` replaces the page's refs" (003 change log, M6) is
  removed by FR-066.
- The `debugger` permission traced by 003's FR-049 gains a second traced use (FR-064, FR-065, FR-069). No
  new permission is requested. The always-present page reader of FR-063 needs no permission beyond the host
  access 003 already declared (D-003-1); it reads nothing until a paired session asks.

## Traceability

| This feature | Product requirement | Reference feature | Evidence items |
| --- | --- | --- | --- |
| US1 (acceptance probe), SC-028 | TC-007, VII | — | acceptance standard, D-004-6 |
| US2, FR-055–FR-058 | **PR-020 (amended)** | F-016 | G1, G2, G11 |
| US3, FR-059–FR-062 | PR-020 (amended), PR-007 | F-016, F-001, F-007 | G3, G4 |
| US4, FR-063 | PR-004 | F-005 | G5 |
| US5, FR-064–FR-065 | PR-005, PR-008 | F-004 | G6, G7 |
| US6, FR-066–FR-068 | PR-004 | F-005 | G8, G9, N1 |
| US7, FR-069 | PR-005, PR-008 | F-004 | G10 |
| FR-070–FR-071 | PR-001, PR-008 | — | what does not change |

Items the evidence document lists as *not determinable* from the references (pairing time bound; how the
reference resolves a description to an element) keep 003's behaviour except where this document states a
bound (FR-059). Items where 003 already equals or exceeds the references (drag and drop) are untouched.

**Numbering**: functional requirements continue from 003 (FR-054) and success criteria from 003 (SC-027).

## Acceptance standard *(binding for every requirement below)*

Owner-approved 2026-09-09 (D-004-6). A requirement in this feature is met only when all of the following
hold, and the report of that run is attached to the feature's coverage record:

1. **Environment**: the owner's own branded Chrome 152, attached to by the packaged gate the way 003
   already supports; never only the bundled browser. The owner's only part is to have Chrome open.
2. **Targets**: real public pages, one named page per capability (table below). Fixture pages remain for
   unit-level checks and are not acceptance evidence.
3. **Caller**: the coding agent itself, driven non-interactively with fixed prompts and its answers
   checked; not a harness that talks to the bridge directly. The agent runs on the cheaper model tier.
4. **Baseline**, in two tiers (amended 2026-09-09 after the S0 run):
   - **Automated tier, in every run**: the browser's own accessibility tree for the same page, read
     through the debugging session the probe already holds. This is the machine-checkable expected
     value (node counts, presence of a frame's content, a menu's items after a hover).
   - **Reference tier, once per capability**: the reference extension's result on the same page,
     recorded by the owner's *interactive* agent session, which is where the reference's tools are
     reachable, and pasted into the scenario file as its recorded expectation.
   The two-tier form exists because the reference extension publishes no interface a non-interactive
   agent session can call: it was verified on 2026-09-09 that such a session sees no reference tool at
   all. The report always names which tier a scenario's baseline came from.
5. **Done**: every scenario green, report timestamped, zero cells "left for the owner".

| Capability | Named public page | What the baseline records |
| --- | --- | --- |
| Embedded frames (US4) | a claude.ai artifact page (content rendered in an embedded frame) | the browser's tree for that page, including the frame's content; reference tier recorded once |
| Hover (US5) | MDN or Bootstrap documentation navigation with a hover-opened menu | the menu items present in the browser's tree after hovering; reference tier recorded once |
| Per-key typing (US5) | Wikipedia search box | the suggestion list present after typing; reference tier recorded once |
| Page capacity and fields (US6) | a GitHub repository home page | the browser's node count and link targets; reference tier recorded once |
| Reference lifetime (US6) | same GitHub page | — (behavioural check) |
| Coordinate actions (US7) | excalidraw.com | before/after screenshots of the same toolbar click; reference tier recorded once |
| Concurrent sessions, pairing, owner's tab (US2, US3) | any of the above, opened by the owner | — (behavioural checks) |

If a public page changes so that a scenario can no longer be run, the report says so and names a
replacement page with the same property; the scenario is not marked passed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prove it on the owner's browser before calling it done (Priority: P1)

The owner keeps their own Chrome open. Everything else — starting agent sessions, opening the named public
pages, running the reference extension for the baseline, running each scenario, writing the report — is
done for them. When they come back they find a timestamped report that says, per scenario, what the
reference saw, what this feature saw, and pass or fail.

**Why this priority**: it is the owner's condition for every other story. Without it, verification cells
are handed back to the owner, which is what this feature exists to end.

**Independent Test**: with only 003 installed, the probe runs and produces a report in which the four
2026-09-09 failures reproduce as failed scenarios with the same answers the owner saw.

**Acceptance Scenarios**:

1. **Given** the owner's Chrome 152 is open and the bridge installed, **When** the probe is started with no
   other input, **Then** it attaches to that browser, runs every scenario of this feature through a real
   agent session, and writes a report with a timestamp, the browser version, and per-scenario baseline,
   observed and verdict.
2. **Given** the reference extension is installed in the same browser, **When** a scenario has a baseline
   column, **Then** the report shows the reference's result on the same page recorded in the same run.
3. **Given** a scenario fails, **When** the report is written, **Then** the failing scenario carries the
   agent's raw answer, and the run's overall verdict is "not done".
4. **Given** a named public page is unreachable or changed, **When** the probe reaches that scenario,
   **Then** the scenario is reported "not run: page changed" and is not counted as passed.

---

### User Story 2 - Several agent sessions share one browser (Priority: P1)

The owner has two coding-agent sessions open — perhaps two projects — and both use the browser. Each
gets its own tab group; neither notices the other except when it asks for a tab the other holds, in which
case it is told which session has it. If the link between the browser and the agents drops, it comes back
within seconds and both sessions carry on. When a session ends, its group marking and any diagnostics it
held are released.

**Why this priority**: on 2026-09-09 a second session made the bridge unavailable to *every* session
(E1). The coding agent starts one bridge process per session as a matter of course, including sessions of
other projects, so this is the first wall any real use hits.

**Independent Test**: start two agent sessions; run "list tabs" in both; open a page in each; from the
second, try to read the first's tab; end the first; observe the second unaffected and the first's marking
gone.

**Acceptance Scenarios**:

1. **Given** one paired agent session is working, **When** a second session (same agent, another
   project) starts and runs its first tool, **Then** it succeeds within the same bound as a first session
   would alone, with its own tab group; the first session's next call also succeeds.
2. **Given** two live sessions, **When** the second asks to read or act on a tab the first holds, **Then**
   the answer is a refusal that names the holding session; nothing runs on that tab.
3. **Given** two live sessions, **When** the link between the browser and the agents drops (the
   browser-side piece exits, the extension reloads), **Then** within 10 seconds both sessions' next calls
   succeed again and both keep their tabs and group markings.
4. **Given** a live session, **When** its agent process ends without an explicit stop, **Then** within 15
   seconds its tab group marking is cleared, its diagnostics attachments are released, and its tabs stay
   open as ordinary tabs.
5. **Given** three sessions started within a minute of each other, **When** each runs "list tabs",
   **Then** all three succeed and none receives "bridge unavailable".

---

### User Story 3 - Pair without racing the clock, then work on the tab the owner is looking at (Priority: P1)

The first time an agent connects, the owner sees the pairing request, reads it, and accepts twenty seconds
later; the call that triggered the request succeeds instead of timing out. The owner then opens a site by
hand, logs in, and tells the agent "look at the page I have open": the agent lists the owner's tabs,
takes that one into its group, and reads it. On the page a small indicator shows an agent is active; from
any other tab the owner can jump back to the agent's main tab with one control on that indicator.

**Why this priority**: E2 and E3 of the owner's run are the agent's first call and first tab — its first
impression — and both failed.

**Independent Test**: unpair, reconnect, accept after 20 s, see the same call succeed; then open a page by
hand and have the agent read it without the agent opening anything.

**Acceptance Scenarios**:

1. **Given** an agent not yet paired, **When** its first call raises the pairing request and the owner
   accepts 20 seconds later, **Then** that same call succeeds; no retry is needed.
2. **Given** the pairing request is showing, **When** the owner does not answer within the stated bound,
   **Then** the call answers "not paired: no answer" and the request is dismissed; the next call raises it
   again.
3. **Given** the owner has tabs open that no session holds, **When** a paired session lists tabs, **Then**
   it sees them (title, address, which one is active, which window) alongside its own, each marked as
   "yours" or "the owner's" or "held by session X".
4. **Given** an owner's tab that no session holds, **When** the session takes it, **Then** the tab joins
   the session's group with the group's marking, and the session's reads and effects on it work; the
   owner's other tabs stay untouched.
5. **Given** a tab another live session holds, **When** this session tries to take it, **Then** it is
   refused with that session named (US2 scenario 2).
6. **Given** a session with a main tab, **When** the owner is on any other tab in that browser and uses
   the indicator's "back to the agent's tab" control, **Then** the agent's main tab becomes the active tab
   and its window comes to the front within 1 second; nothing else changes.
7. **Given** a session ends or releases a tab, **When** the owner looks at that tab, **Then** the indicator,
   the light around the page and the cursor marker are gone and the tab is an ordinary tab again.

---

### User Story 4 - See and act inside embedded frames (Priority: P1)

A page keeps its real content in an embedded frame — an artifact viewer, a login widget, a payment form,
an embedded editor. The agent's page tree includes that content as part of the one page; elements inside
the frame have references the agent can click and type into; text extraction includes the frame's text.

**Why this priority**: E4 — on the owner's first real page the agent saw four buttons and none of the
content. This is the largest capability gap the run exposed.

**Independent Test**: open the named claude.ai artifact page; read it; compare with the reference's read of
the same page; click a control inside the frame.

**Acceptance Scenarios**:

1. **Given** a page whose content lives in an embedded frame, **When** the agent reads the page tree,
   **Then** the frame's elements appear in the tree with their roles and names, each marked with the frame
   it belongs to, and the tree is not reported as truncated when it is not.
2. **Given** such a page, **When** the agent extracts the page text, **Then** the frame's text is included.
3. **Given** a reference obtained from inside a frame, **When** the agent clicks it or types into it,
   **Then** the effect lands on that element and the answer reports it as it would for a top-level element.
4. **Given** a frame that the browser forbids the extension to read (a browser-internal or another
   extension's frame), **When** the agent reads the page, **Then** the tree lists the frame as "not
   readable" and the rest of the page is still returned.
5. **Given** a frame that navigates while the agent holds a reference into it, **When** the agent uses the
   reference, **Then** the answer is "stale reference" (US6 scenario 3), never an effect on the wrong
   element.

---

### User Story 5 - Inputs the page cannot tell from a person's (Priority: P2)

The agent hovers over a navigation item and the menu the site opens on hover opens; the agent then clicks
an item in it. The agent types into a search box and the site's suggestions appear as they would for a
person typing. A visible cursor marker on the page shows where the agent is pointing.

**Why this priority**: the coverage review had ranked hover and per-key typing in its first tier; the
references deliver both through browser-level input. Real sites depend on both for menus, comboboxes and
validation.

**Independent Test**: on the MDN/Bootstrap navigation page hover and read; on the Wikipedia search box type
a word and read; compare both with the reference.

**Acceptance Scenarios**:

1. **Given** a menu that opens only on pointer hover, **When** the agent hovers its trigger, **Then** the
   next read lists the menu's items and the agent can click one.
2. **Given** any click, **When** it is delivered, **Then** the pointer first moves to the element, so the
   page's hover state is true at the moment of the click, and a cursor marker is visible on the page at
   that point.
3. **Given** a text box with per-keystroke behaviour (suggestions, formatting, validation), **When** the
   agent types a string, **Then** the box receives one keystroke per character in order and the page's
   per-keystroke behaviour fires as for a person; the final value equals the string.
4. **Given** a character with no keyboard key (an emoji, a character outside the layout), **When** it is
   part of the typed string, **Then** it is still inserted at the caret and the rest of the string is
   typed per key.
5. **Given** the browser refuses this kind of input on a tab (developer tools already attached to it, a
   restricted page), **When** the agent acts, **Then** the answer says so explicitly ("input unavailable:
   reason") and no substitute input is attempted silently.
6. **Given** a site in `ask` mode, **When** the agent hovers, clicks or types, **Then** the site-mode gate
   of 003 applies exactly as before; the delivery mechanism changes nothing about consent.

---

### User Story 6 - Read once, use many times; read the whole page (Priority: P2)

The agent reads a page, finds an element, reads again to check, and clicks the element it found first —
the reference is still good. A long page comes back with as much as the reference extension would give:
deep enough, thousands of elements, links with their targets, controls with their type and placeholder,
selects with their options; when the agent wants only what is on screen, it gets that. Elements inside
open shadow roots are included.

**Why this priority**: today every read invalidates the previous read's references and the page is
capped far below the reference; the agent spends calls re-reading. Not blocking, but it multiplies the
cost of every task.

**Independent Test**: on the GitHub repository page read three times and act with a first-read reference;
compare node count and link targets with the reference; on a page using open shadow roots read and find a
control inside one.

**Acceptance Scenarios**:

1. **Given** a reference from an earlier read, **When** the agent reads or finds again on the same tab and
   then uses the earlier reference, **Then** it still resolves to the same element.
2. **Given** an element that has been removed from the page, **When** its reference is used, **Then** the
   answer is "stale reference"; a reference is never silently reassigned to another element.
3. **Given** a page moved on by navigation, **When** an old reference is used, **Then** the answer is
   "stale reference".
4. **Given** the GitHub repository page, **When** the agent reads it with default settings, **Then** the
   number of elements returned is within 10% of the reference's on the same page, links carry their target
   address, inputs their type and placeholder, and selects list their options.
5. **Given** a page larger than the stated capacity, **When** it is read, **Then** the answer says it was
   truncated and by which limit, and the agent can raise the text limit within the stated ceiling.
6. **Given** the interactive-elements read, **When** part of the page is scrolled out of view, **Then**
   only elements in the current viewport are listed; the full read still lists all.
7. **Given** a control inside an open shadow root, **When** the agent reads, finds or extracts text,
   **Then** the control is listed with a usable reference and its text is included.

---

### User Story 7 - Act by position on pages that have no elements (Priority: P3)

A drawing board, a map, a game canvas: nothing to reference. The agent takes a screenshot, decides where
to act, and clicks, double-clicks, right-clicks, types, presses keys, scrolls or waits at a position,
then screenshots again to confirm.

**Why this priority**: it is the references' only way to work canvas pages; once browser-level input
exists (US5) it is a small addition.

**Independent Test**: on excalidraw.com screenshot, click a toolbar tool by position, screenshot again,
observe the tool state changed as in the reference's run.

**Acceptance Scenarios**:

1. **Given** a session tab, **When** the agent performs a position-based click, **Then** the pointer moves
   to that position and clicks there, the cursor marker shows it, and the answer reports the position and
   the observed outcome.
2. **Given** the same, **When** the agent performs right, double or triple click, types, presses a key,
   scrolls by an amount, or waits, all by position, **Then** each behaves as its element-based counterpart
   does, minus the element.
3. **Given** a position outside the tab's viewport, **When** the agent acts there, **Then** the answer is a
   refusal naming the viewport size; nothing is clicked.
4. **Given** a site in `ask` mode, **When** a position-based effect is requested, **Then** the prompt shows
   the screenshot region around the position, and the gate applies as for any effect.

---

### Edge Cases

- **The browser-side piece is killed mid-call**: the call answers "bridge lost" within the call's bound;
  the session survives; the link is back within 10 seconds (US2 scenario 3).
- **Owner closes a tab a session holds**: the session's next call on it answers "tab gone"; the session
  keeps its other tabs.
- **Owner switches away from the agent's active tab while it acts**: the effect still lands on the agent's
  tab; the agent never acts on the tab the owner switched to unless it holds that tab.
- **Two sessions try to take the same owner's tab at once**: exactly one succeeds; the other is refused
  with the winner named.
- **A session's agent process ends while the link is down**: the session is released when the link is back
  and the process is found gone; the release bound counts from then.
- **Developer tools are open on the session's tab**: browser-level input is unavailable there; effects
  answer "input unavailable: developer tools attached"; reads still work.
- **A frame is cross-site and sandboxed**: it is read if the browser allows the extension in; otherwise it
  is listed as "not readable" (US4 scenario 4).
- **A control lives in a closed shadow root**: it is not listed; the position-based tool (US7) can still
  reach it by screenshot.
- **The page's text exceeds the raised text ceiling**: truncated with the limit named; never silently cut.
- **The indicator's control is triggered by a script rather than a person**: ignored; only a person's
  action on the indicator switches tabs.
- **Extension reloads while sessions are open**: pairings, sessions and tab holdings survive; the next call
  of each session succeeds within 10 seconds.
- **Restricted pages** (browser-internal, the extension's own, another extension's): unchanged from 003 —
  reads and effects answer "page not readable"/"page not actionable".

## Requirements *(mandatory)*

### Functional Requirements

**Concurrent sessions and the bridge (US2)**

- **FR-055 (PR-020 — MUST)**: Any number of sessions of paired agents MUST be able to use the browser at the
  same time. Each session has its own tab group and identity; a session's first call MUST succeed within
  the same bound whether or not other sessions are live. No session ever receives "bridge unavailable"
  because another session exists.
- **FR-056 (PR-020 — MUST)**: A tab MUST belong to at most one live session at a time. A session asking to
  list, read or act on a tab another live session holds MUST be refused with the holding session named.
  Listing is the exception defined by FR-060.
- **FR-057 (PR-020 — MUST)**: When the link between the browser and the agents is lost for any reason
  (the browser-side piece exits, the extension reloads), it MUST be restored within 10 seconds without
  the owner's intervention, and every live session MUST keep its identity, tabs and group marking across
  the loss. A call in flight during the loss answers "bridge lost".
- **FR-058 (PR-020 — MUST)**: A session MUST end when its agent process ends or when the agent stops it.
  Within 15 seconds of ending, the session's group marking, indicator and diagnostics attachments MUST be
  released; its tabs stay open as the owner's tabs. The 15-second bound applies when the end is observed
  directly (the agent's connection closing). When the release depends instead on a periodic wake — the
  case where the browser-side link itself restarted and sessions must re-announce — the bound is the
  browser's own minimum wake interval, 30 seconds, because a browser clamps shorter periods for an
  installed extension; the acceptance run states which bound each scenario measured.

**Pairing and the owner's tabs (US3)**

- **FR-059 (PR-020 — MUST)**: The call that raises a pairing request MUST wait for the owner's answer for
  at least 30 seconds and succeed if the owner accepts within that time, in the same call. If the bound
  passes without an answer the call MUST answer "not paired: no answer" and the request is withdrawn.
- **FR-059a (PR-020 — MUST, amendment 2026-09-24, owner decision)**: Only a tool call MAY raise a pairing
  request. An agent connecting - its client starting, the MCP handshake, the link to the browser being
  (re)established, the extension being reloaded - MUST NOT put a pairing card in front of the owner.
  Origin: with several coding-agent windows open, every connect and every extension reload raised a card
  the owner had not asked for (observed 2026-09-24). The earlier raise-on-connect was an implementation
  choice (T100) made while a call could wait at most ~60 s; since 011 a call waits up to 2 minutes with
  a where-to-click notice, so nothing is lost by asking at the first call. Whatever the host learned from
  the answer on connect (browser run, worker features, 013/R-184, 014/R-187) MUST still be known before
  the first call that needs it.
- **FR-060 (PR-020, PR-007 — MUST)**: A paired session MUST be able to list every tab in the browser with
  its title, address, active state and window, each marked as held by this session, by another named
  session, or by no session (the owner's). Listing MUST NOT read page content.
- **FR-061 (PR-020, PR-007 — MUST)**: A paired session MUST be able to take a tab no session holds into its
  own group, after which reads and effects on it are admitted as for a tab the session created, and the
  site-mode gate of 003 applies. A tab another live session holds MUST be refused (FR-056). Reads and
  effects on a tab the session does not hold MUST be refused as "not yours".
- **FR-062 (PR-007 — MUST)**: Every tab a session holds MUST show an in-page indicator that an agent is
  active, with a control the owner can use to bring the session's main tab to the front (active tab, window
  focused) within 1 second. The control MUST respond only to the owner's own action, never to page scripts.
  The indicator marks the page as a whole as well as carrying the control: the edges of the page are lit
  while the tab is held (breathing gently; still when the owner asks the system for reduced motion), in
  the top document only, so "this page is being driven" reads at a glance on any site. The indicator,
  its light and the cursor marker of FR-064 MUST all disappear when the tab is released.

**Embedded frames (US4)**

- **FR-063 (PR-004 — MUST)**: Page reads (tree, text extraction, description-to-element) MUST cover the
  content of embedded frames the browser lets the extension read, at any nesting depth, as part of one
  page: every element carries the frame it belongs to, references into frames are actionable, and frames
  the browser forbids are listed as "not readable" without failing the read.

**Browser-level input (US5)**

- **FR-064 (PR-005 — MUST)**: Pointer effects (hover, click of every kind, scroll, drag start and end)
  MUST be delivered as browser-level pointer input such that the page's hover state is true at the target
  before and during a click, and hover-opened interfaces open. A visible cursor marker MUST show the
  pointer's position on the page while a session acts: it MUST move to the target and arrive there before
  the pointer input for that target is delivered (a short glide; the wait for it is bounded and never
  fails the input), and it MUST stay on the page between gestures for as long as the tab is held, leaving
  with the indicator (FR-062). When browser-level input is unavailable on a tab, the answer MUST say so
  with the reason; no silent fallback.
- **FR-065 (PR-005 — MUST)**: Typing MUST be delivered one keystroke per character in order, so a page's
  per-keystroke behaviour fires as for a person; characters with no keyboard key MUST still be inserted at
  the caret. The control's final value MUST equal the requested string.

**References and page capacity (US6)**

- **FR-066 (PR-004 — MUST)**: An element reference MUST stay valid for as long as its element is part of
  the page, across any number of later reads and finds on that tab. A reference MUST answer "stale" once
  the element is gone or the page has navigated, and MUST never be reassigned to another element.
- **FR-067 (PR-004 — MUST)**: A page-tree read MUST offer at least the reference's capacity: a default
  depth of 15, up to 10,000 elements and 50,000 characters of text in one answer, with a caller-adjustable
  text limit up to that ceiling; elements MUST carry link target, control type, placeholder and, for
  selects, their options; the interactive-elements read MUST list only elements in the current viewport
  while the full read lists all; truncation MUST be reported with the limit that applied.
- **FR-068 (PR-004 — MUST)**: Reads, finds and text extraction MUST include elements inside open shadow
  roots, with usable references. Closed shadow roots are out of scope.

**Position-based actions (US7)**

- **FR-069 (PR-005, PR-008 — MUST)**: A paired session MUST be able to act by position on a tab it holds:
  screenshot, left/right/double/triple click, type, key press, scroll by amount, and wait. Each MUST use
  the same delivery as its element-based counterpart (FR-064, FR-065), MUST refuse positions outside the
  viewport naming the viewport size, and MUST pass the site-mode gate as an effect whose prompt shows the
  region around the position.

**What does not change**

- **FR-070 (PR-001 — MUST)**: The remote-service build and the 001/002 behaviour MUST stay byte-for-byte
  what they were: the narrow manifest unchanged, the archived suites passing. Nothing in this feature is
  reachable before an agent is paired.
- **FR-071 (PR-008, PR-006 — MUST)**: The per-site mode gate, Stop, the activity record and the diagnostics
  grant of 003 MUST govern every new capability here exactly as they govern existing ones. Using the
  browser's debugging facility to deliver input MUST NOT grant diagnostics, and MUST NOT expose page
  content, console or network to the agent beyond what the site's diagnostics grant allows.

### Key Entities

- **Agent session**: one running instance of a paired agent; has an identity, a tab group, a set of held
  tabs, and a lifetime bounded by its process. Several may be live at once.
- **Tab holding (lease)**: the exclusive relation between one live session and one tab; created by the
  session creating the tab or taking an owner's tab; released by the session, by the tab closing, or by
  the session ending.
- **Bridge link**: the connection between the browser and the agents' side; shared by all sessions;
  restored automatically after loss.
- **Frame**: a document embedded in a page; part of the page's one tree; readable or "not readable".
- **Element reference**: a handle bound to one element for the element's lifetime; carries its frame.
- **Position action**: an effect addressed by viewport coordinates instead of a reference.
- **Acceptance run**: one execution of the probe on the owner's browser; produces the timestamped report
  with baseline, observed and verdict per scenario.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-028**: Every functional requirement of this feature is closed by at least one scenario in an
  acceptance run on the owner's branded Chrome 152, with the coding agent as caller, against the named
  public page, with the reference baseline recorded in the same run; the run's report is timestamped and
  no scenario is "left for the owner". A feature with any such cell is not done.

  **Amendment 2 (2026-09-10, main session) — SC-036's controls half was measured against the wrong
  baseline, and that is my error, not a product shortfall.** The judge compares the **default** read's
  controls against the **browser's whole accessibility tree**. But the default read is deliberately
  viewport-gated (FR-067 drops offscreen nodes, copied from the reference), while the browser's tree
  carries every control on the page regardless of where it is. On a long page most controls are below the
  fold, so that comparison can only ever fail — 6 of 15 on a GitHub repo page is exactly what the gating
  guarantees, not evidence of a gap.

  The criterion is therefore: the **full** read is what must contain the browser tree's headings, links
  **and controls** — the full read is the one that claims completeness. The default read's job is
  different: it is the working list of what can be acted on **now**, and measuring it against an ungated
  baseline measures the gating, not the reading.

  This corrects the measurement, not the claim. Any shortfall the **full** read shows remains a real
  finding and is not excused by this amendment.

  **Amendment (2026-09-10, owner decision).** The acceptance run is made in **one** locale — **zh-TW**,
  the owner's own browser's UI language — not in both. The paid probe measures the agent-facing tools,
  which carry no localised text; what *is* localised is the side panel, and that is already proven in
  **both** locales by the free release matrix (`tests/release/release-environment.js` runs en-US and
  zh-TW across two Chrome channels, and T145 runs it). A second full probe pass in en-US would spend
  roughly thirty paid agent calls to re-measure a dimension a free gate already covers. Verified before
  the amendment was written rather than asserted: the matrix's locale profiles were read, not assumed.
- **SC-029**: With three agent sessions started within one minute, 100% of first calls succeed within the
  single-session bound and 0 answer "bridge unavailable"; 100% of cross-session tab accesses are refused
  with the holder named (10 attempts).
- **SC-030**: After the browser-side piece is killed or the extension reloaded, both live sessions' next
  calls succeed within 10 seconds, 0 sessions lose tabs or markings (5 runs).
- **SC-031**: With the owner accepting 20 seconds after the pairing request appears, the triggering call
  succeeds in 5 of 5 runs; with no answer, it reports "not paired: no answer" within the stated bound.
- **SC-032**: An owner-opened tab is listed by the agent in its first call, taken in one call, and read
  successfully; a tab the session does not hold is refused as "not yours" in 100% of attempts; the
  indicator's control brings the main tab to the front within 1 second in 5 of 5 tries.
- **SC-033**: On the named artifact page the agent's tree contains at least 90% of the elements the
  baseline lists on the same page, including those inside the embedded frame, and one click inside the
  frame produces the same observed outcome as the reference's.
- **SC-034**: On the named hover-navigation page the agent lists and clicks a menu item the baseline shows
  after the same hover; on the Wikipedia search box the suggestion list the baseline shows appears after
  the agent types the same word (each 5 of 5 runs).
- **SC-035**: Across three consecutive reads on the same page, 100% of first-read references still act;
  after removing an element, 100% of its references answer "stale" and 0 land elsewhere.
- **SC-036**: On the named repository page, the agent's **full** read (the one that asks for everything)
  carries every heading and every link the page's own accessibility tree names, and its **default** read
  carries every control that tree names; every link element carries a target address. The two reads are
  measured separately because they answer different questions: the default read is a working list of
  what can be acted on, and comparing it to a tree of the whole page would be comparing unlike things.
  Containment is the test rather than a node-count ratio, because a browser's own tree carries generic
  containers an agent cannot use, which makes it the wrong denominator.
- **SC-037**: On the drawing-board page a position-based click on a toolbar tool changes the tool state
  visibly in the after-screenshot, matching the recorded reference after-screenshot for the same click.
- **SC-038**: The narrow build's manifest is byte-identical to its pre-004 copy and the archived 001/002
  suites pass unchanged in the same run.

## Assumptions

- The references read on 2026-09-09 are Claude in Chrome 1.0.91 and the ChatGPT/Codex extension
  1.26.901 as installed in the owner's Chrome profile; their observable behaviour on the named pages that
  day is the baseline. A later reference version does not move the target unless the owner says so.
- Where the two references differ, the evidence document records which is followed: Codex for concurrent
  sessions, tab leases and open shadow roots; Claude in Chrome for page tree shape, references, input
  delivery, the indicator and position actions.
- The browser shows its own notice that a tab is being controlled while browser-level input is in use;
  the owner accepts this as the references show the same notice (D-004-4).
- A tab on which the owner has developer tools open cannot receive browser-level input; that is reported,
  not worked around.
- The agent-as-caller acceptance runs consume the owner's agent quota; they run on the cheaper model tier
  and only on delivery of a slice, not in inner development loops.
- Public pages change; the baseline is re-recorded in every run so that a page change never silently
  turns into a pass or a fail.
- 003's assumptions stand: single owner, bearer agent identity, branded Chrome only, "site" = scheme + host.
- A control inside a **closed** shadow root is absent from a read and indistinguishable from one that
  does not exist. Telling the agent "something is here you cannot reach" would require detecting the
  closed root, and the only interface that does so is the one D-004-5 chose not to use. The reference
  followed for page reading enters no shadow root at all, so reading open roots already exceeds it.
- Reading the installed reference code to establish observable behaviour is the same activity that
  produced `docs/reference-*.md`; no reference code, asset or private identifier enters this project's
  source or this specification (II).

## Out of scope

- Closed shadow roots.
- Coordination between sessions (handing a tab over, shared plans, queues).
- Delivering drag and drop as browser-level input (the references do not; 003's delivery stands).
- Changing how a description is resolved to an element (not determinable from the references; 003's
  stands).
- The references' cloud bridge, desktop/device tools, side-panel workspace, scheduling, sharing, export.
- The agent moving the owner's window focus on its own; only the owner's action on the indicator does.
- Enterprise policy for the local-agent caller.

## Change Log

| Date | Change | Origin |
| --- | --- | --- |
| 2026-09-16 | FR-064 amended: the cursor marker glides to the target and arrives before the pointer input is delivered (bounded wait), and stays on the page between gestures while the tab is held, instead of appearing at the instant of the input and being removed after each gesture. Cause: the owner reported the interaction still "felt" unlike the references after the marker was made visible; both references interpolate the motion, wait (bounded) for arrival before the move, and keep the pointer for the whole turn | Owner report 2026-09-16, design-notes §1 |
| 2026-09-16 | FR-062 amended and US3 scenario 7 restated: the indicator also lights the page's edges while the tab is held (top document only, reduced-motion honoured), and the light and the cursor marker leave with it. Cause: owner's choice after a side-by-side preview of the references' "agent is driving this page" signals (one lights the page edges, the other badges the tab's favicon); the pill and the tab-group colour stay | Owner decision 2026-09-16, design-notes §7 |
| 2026-09-10 | G5 corrected: a ref-based click in the compared assistant acts in the top frame only and confirms nothing afterwards; our frame-aware routing and post-click confirmation are therefore our own design, not parity | design-notes §1 |
| 2026-09-10 | New reading: the Codex extension performs no click logic of its own — pointer input is decided outside the extension and relayed; the glide-then-click behaviour we match is the assistant's, not Codex's | design-notes §1 |
| 2026-09-10 | Cross-site OOPIF platform question settled by measurement (B73), from the extension's own service worker against a genuine OOPIF fixture: `Target.setAutoAttach {flatten:true}` yields a per-frame `sessionId`, and `sendCommand({tabId, sessionId}, ...)` delivers `Input.dispatchMouseEvent`/`Runtime.evaluate` into that frame's own coordinate space with no composition or frame-owner walk needed. This is what let FR-063/SC-033's act half be built for genuinely cross-origin (not just same-site) frames | S4 input work, 2026-09-10, our own measurement (B73) and `tasks.md` B73-B75 |
| 2026-09-10 | SC-036 restated: containment of the page's headings, links and controls rather than a node-count ratio, and measured against the read that actually claims to return the whole page instead of the deliberately narrower default. Cause: the original wording compared the working-list read against a tree of the entire page, which are unlike things, and used a denominator carrying generic containers an agent cannot act on | S5 measurement, 2026-09-10 |
| 2026-09-09 | FR-058 split into two bounds: 15 s when a session's end is observed directly, the browser's 30 s minimum wake interval when the release depends on a periodic wake. Cause: the S1 architecture review established that a browser clamps sub-30 s periodic wakes for an installed extension, so the single 15 s number was only ever true for the development load | S1 architecture review |
| 2026-09-09 | Acceptance standard point 4 amended to a two-tier baseline: the browser's own accessibility tree in every automated run, plus a once-per-capability recorded observation from the reference through an interactive session. Cause: the S0 run established that a non-interactive agent session cannot reach the reference extension's tools at all (it publishes no callable interface), so the original "run the reference in the same run" form was not executable | S0 probe run, `probe-004/reports/004-2026-09-09T05-49-56Z.md` |
| 2026-09-09 | Initial specification; PR-020 amended (concurrent sessions, owner's tabs); 003's SC-024 narrowed by D-004-3; 003's M6 ref-lifetime limitation removed by FR-066 | `/speckit-specify`, owner decisions D-004-1–6 of 2026-09-09, evidence E1–E4 and G1–G12/N1–N2 in `docs/design-notes.md` |
