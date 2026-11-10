# Feature Specification: Outside-Agent Consent and Capture Experience

**Feature Branch**: not created yet (spec written on `release-0.20.1`, private main 0535499)

**Feature Directory**: `specs/031-outside-agent-experience`

**Created**: 2026-11-08

**Status**: Approved. The owner approved the principle behind D-031-1..3 on 2026-11-08, and accepted every
recommendation D-031-4..13 the same day.

**Input**: Owner trial, 2026-11-08. A coding agent running in a terminal drives the owner's Chrome
through Hallpass. Three things made it feel much worse than the reference products:

1. The agent asks for consent, but the owner is looking at the terminal and never sees the question. The
   question exists only as a card in the side panel. When a side panel is open anywhere in the focused
   window, the toolbar mark is not shown, and the question expires after 25 seconds. The owner learns
   about it only from the refusal the agent reports.
2. The diagnostics tools (`read_console`, `read_network`, `evaluate`) are refused outright on a site
   whose diagnostics checkbox is off. Nobody is asked. The owner has to find the checkbox in the side
   panel or settings, tick it, and have the agent retry.
3. When the browser window is minimized or covered by another window, screenshots fail or return an
   old picture, and an agent tab is brought to the front to be photographed. Once the agent has acted on
   a tab, the browser stays in its "being debugged" state until the session ends.

**Facts checked 2026-11-08** (this repository's own code at private main 0535499; client behaviour
measured on this machine without any model call):

- An unanswered question is held for 25 seconds when a side panel is visible in the focused browser
  window, and for 120 seconds otherwise. The toolbar mark is shown only when a question is pending and
  no side panel is visible in the focused window. The browser cannot tell that the owner is looking at a
  terminal rather than at the browser.
- While a question waits, the host sends progress notifications to the agent every 5 seconds. The
  terminal client does not show them to the owner in a noticeable way.
- The diagnostics tools are refused with `diagnostics-not-granted` before anything attaches, unless the
  site's diagnostics grant is on. That grant can be changed only in the side panel's site list or the
  settings page.
- A session-scoped site plan already exists (spec 017, `propose_sites`). It is approved in the side
  panel and admits only the page actions spec 017 lists. Page JavaScript, uploads and a forced leave
  never read it.
- A whole-viewport screenshot is taken by photographing what the window currently shows. The tab is
  made active first. An emulated viewport and GIF frames already use the debugger-based capture.
- Once an agent action needs the debugger on a tab, the attachment is held until the tab is released,
  closed or the session ends.
- The MCP clients the owner uses advertise MCP form elicitation when they connect. Codex CLI 0.166.0 was
  captured advertising `elicitation: {form, url}`. Claude Code 2.1.319 advertises it according to its
  own shipped code, but this was not captured live. **Behaviour not confirmed**: that the question is
  actually shown to the person, and what each client does under auto-approval modes or with hooks that
  answer automatically.

**Reference behaviour** (observed, not copied; the evidence is kept privately, never in this spec): both reference products ask the person inside the agent's own host when the
host can ask. They fall back to a browser-side prompt only when it cannot. Both photograph tabs without
bringing them to the front. One of them reports a minimized window rather than photographing it, and
releases the debugger after a short idle period.

**Decisions (D-031-n)**:

- **D-031-1 - ask where the owner is** (owner-approved principle): when the agent's client can ask the
  person a question, Hallpass asks through the client as well as through the side panel.
- **D-031-2 - the terminal grants only short-lived consent** (owner-approved principle): a question
  answered in the agent's client offers exactly three answers: *allow this once*, *allow this site for
  this agent session*, and *deny*. Long-lived decisions can be given only in the browser: always allow
  a site, skip-checks, follow-a-plan, and diagnostics always on. The agent's client is the party being
  gated, and it can be configured to answer by itself, so it must not be able to leave consent behind
  that outlives the session.
- **D-031-3 - session grants end with the session** (owner-approved principle): *allow this site for this
  agent session* covers one agent session and one site (full origin, as in D-030-2). It is never carried
  to another session, and it ends when the session ends.
- **D-031-4 - one question, two places, one answer** (recommended): the question is shown at the same time
  in the agent's client and as the side-panel card. The first answer given in either place decides it.
  The other place is withdrawn. A late answer from the withdrawn place admits nothing.
- **D-031-5 - a dismissed terminal question is not a refusal** (recommended): if the client dismisses the
  question without the owner choosing an answer (the client declines, cancels, fails, or does not
  support asking), the side-panel card keeps waiting. Only an explicit *deny* refuses. A client that
  auto-dismisses therefore cannot refuse on the owner's behalf. It also cannot approve, because
  dismissing is never read as approval.
- **D-031-6 - one bound, always visible** (recommended): an unanswered question waits 120 seconds whether
  or not a side panel is visible. The toolbar mark is shown whenever a question is pending. The timeout
  message the agent receives tells it to ask the owner to answer in Chrome and then retry.
- **D-031-7 - where a grant came from is recorded** (recommended): every consent records whether it was
  given in the agent's client or in the browser. The side panel shows this for session grants and in the
  session's activity.
- **D-031-8 - the session grant covers page actions only** (recommended): a session grant given from
  either place admits the same page actions a spec 017 session site plan admits, which includes pressing
  OK on a page dialog. Page JavaScript (`evaluate`), file and image uploads, a forced leave and closing a
  tab are still asked each time. In the agent's client those questions offer only *allow this once* and
  *deny*. (Amended 2026-11-08, R-457: the first wording also excluded dialog OK, which contradicted
  "the same as spec 017". The owner chose to follow spec 017.)
- **D-031-9 - diagnostics are asked, not refused** (recommended): a diagnostics tool on a site without the
  diagnostics grant raises a question instead of a refusal. It uses the same two places. In the agent's
  client the answers are *allow this once*, *allow diagnostics on this site for this session*, and
  *deny*. The side-panel card also offers *always*, which is the existing checkbox. `evaluate` must still
  pass the site's effect gate afterwards, as it does today.
- **D-031-10 - photograph without fronting** (recommended): screenshots of an agent tab are taken through
  the browser's debugging access. This works for a tab that is in the background or covered by another
  window, and the tab is not brought to the front. The current method stays only as a fallback when
  debugging access is unavailable. The picture contract of spec 012 does not change: the CSS-pixel
  frame, the density handling and the size budget.
- **D-031-11 - a minimized window is photographed, not restored** (amended 2026-11-08 by the owner after
  the T938 measurement, see research.md change log): a screenshot of the active tab in a minimized window
  is taken through debugging access without restoring the window. Only when that capture fails or does
  not return in time does the agent get a clear "the window is minimized" answer. Hallpass never restores
  the window by itself. (Was: always answer "the window is minimized".) To be confirmed on branded Chrome.
- **D-031-12 - focus while attached** (recommended): while debugging access is held on an agent tab, the
  page is told it has focus. This keeps pages that pause in the background working.
- **D-031-13 - let go when idle** (recommended): debugging access on a tab is released after 20 seconds
  with no call in progress. It is kept while a GIF recording, an emulated viewport or a diagnostics
  buffer (console or network history kept for the agent) needs it. (Amended 2026-11-08, R-466:
  diagnostics added by the owner, because the history lives on the debugging access and would be lost.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The owner answers in the terminal (Priority: P1)

The owner works in a terminal with a coding agent. The agent wants to click on a site the owner has not
decided about. The question appears in the terminal, where the owner is looking. The owner chooses
*allow this site for this agent session*, and the agent carries on without being asked again on that
site until the session ends.

**Why this priority**: this is the biggest gap from the owner's trial. Every other improvement matters
less while the owner cannot see the question.

**Independent Test**: with a client that supports asking, pair an outside agent and act on an undecided
site. Answer in the client. Confirm the action runs and that the next action on the same site is not
asked about. Confirm that a second agent session on the same site is asked again.

**Acceptance Scenarios**:

1. **Given** an outside agent whose client supports asking and a site in `ask` mode, **When** the agent
   clicks on that site, **Then** the question is shown in the agent's client and as a side-panel card at
   the same time, and both name the site and the action.
2. **Given** that question, **When** the owner chooses *allow this once* in the client, **Then** that one
   action runs, the card is withdrawn, and the next action on the site is asked about again.
3. **Given** that question, **When** the owner chooses *allow this site for this agent session*,
   **Then** the action runs, later page actions of this session on this site are not asked about, and
   the side panel shows the session grant marked as given in the terminal.
4. **Given** a session grant on a site, **When** a different agent session acts on the same site,
   **Then** it is asked about.
5. **Given** a session grant on a site, **When** the session ends, **Then** the grant is gone, and a new
   session on that site is asked about.
6. **Given** the question in the client, **When** the owner chooses *deny*, **Then** the action is
   refused with the existing refusal, and the card is withdrawn.
7. **Given** the question in both places, **When** the owner answers the card in the browser first,
   **Then** the client's question is withdrawn, and an answer arriving later from the client changes
   nothing.
8. **Given** a question about page JavaScript, an upload, a forced leave or closing a tab, **When** it is
   shown in the client, **Then** it offers only *allow this once* and *deny*.

---

### User Story 2 - A question nobody can see does not expire silently (Priority: P1)

The owner's client cannot ask, or it dismisses the question by itself. The question still waits for the
owner in Chrome. The toolbar mark shows it, and it waits long enough to be found. If time runs out, the
agent tells the owner what to do.

**Why this priority**: the fallback has to hold for every client. A client that auto-dismisses must not
be able to refuse or approve for the owner.

**Independent Test**: use a client that does not support asking, and then a client stubbed to dismiss
every question. In both cases confirm that the card waits up to 120 seconds with the toolbar mark shown,
including while a side panel is open, and that an expired question tells the agent to have the owner
answer in Chrome.

**Acceptance Scenarios**:

1. **Given** a client that does not support asking, **When** the agent needs consent, **Then** only the
   side-panel card is raised, the toolbar mark is shown, and the question waits up to 120 seconds.
2. **Given** a client that dismisses the question without an answer, **When** it does so, **Then** the
   card keeps waiting, and nothing is admitted or refused.
3. **Given** a side panel open in the focused window, **When** a question is pending, **Then** the
   toolbar mark is shown, and the question still waits up to 120 seconds.
4. **Given** a question nobody answers, **When** 120 seconds pass, **Then** the agent receives the
   timeout, with text telling it to ask the owner to answer in Chrome and retry, and the question is
   withdrawn in both places.

---

### User Story 3 - Diagnostics are asked about, not refused (Priority: P2)

The agent wants to read the console on a site whose diagnostics grant is off. Instead of a refusal, the
owner is asked, in the terminal and in Chrome. The owner can allow it once or for this session from
either place, or always from Chrome.

**Why this priority**: today this needs a manual trip to a checkbox. It becomes much smoother once Story
1's channel exists.

**Independent Test**: with diagnostics off on a site, call `read_console`. Confirm that a question is
raised rather than a refusal, that each answer behaves as specified, and that *always* is offered only in
Chrome.

**Acceptance Scenarios**:

1. **Given** a site without the diagnostics grant, **When** the agent calls a diagnostics tool, **Then** a
   question is raised in the client (if it supports asking) and as a card, and nothing attaches before an
   answer.
2. **Given** that question, **When** the owner chooses *allow this once*, **Then** that call runs and the
   next diagnostics call on the site is asked about.
3. **Given** that question, **When** the owner chooses the session answer, **Then** diagnostics calls of
   this session on this site run without asking until the session ends, and the site's checkbox stays
   off.
4. **Given** the card in Chrome, **When** the owner chooses *always*, **Then** the site's diagnostics
   checkbox is turned on, as if ticked by hand.
5. **Given** `evaluate` is allowed by a diagnostics answer, **When** it runs, **Then** it still passes the
   site's effect gate, so a site in `ask` mode asks about the script itself.
6. **Given** the owner denies, **When** the agent receives the answer, **Then** it gets the existing
   `diagnostics-not-granted` refusal.

---

### User Story 4 - Screenshots work behind other windows (Priority: P2)

The owner keeps the terminal in front, with Chrome covered or in the background. The agent's screenshots
still show the agent's tab as it is now. The owner's current tab is never switched away to take them. If
Chrome is minimized, the agent is told so plainly.

**Why this priority**: the owner works with Chrome behind the terminal, so the current behaviour fails in
the normal case.

**Independent Test**: cover the Chrome window completely with another window, have the agent change the
page and take a screenshot. Confirm the picture shows the change and the owner's active tab did not
change. Minimize Chrome and confirm the screenshot answer says the window is minimized.

**Acceptance Scenarios**:

1. **Given** the Chrome window fully covered by another window, **When** the agent takes a screenshot
   after changing the page, **Then** the picture shows the page after the change.
2. **Given** an agent tab that is not the active tab of its window, **When** the agent takes a screenshot,
   **Then** the picture is of the agent tab. Because T938 measured that a background tab's capture can
   hang without activation (R-462 outcome rule), such a tab is still briefly brought to the front and the
   owner's active tab restored afterwards, as today.
3. **Given** the window is minimized, **When** the agent takes a screenshot, **Then** it receives the
   picture of the tab and the window stays minimized; if the capture fails or times out, it receives a
   "window minimized" answer that tells it to ask the owner to restore the window (D-031-11 as amended).
4. **Given** the screenshot of Story 4.1, **When** the agent clicks a point read off it, **Then** the
   click lands where it would have under the spec 012 contract (same frame size and density handling).
5. **Given** debugging access cannot be obtained for the tab, **When** the agent takes a screenshot,
   **Then** the previous method is used, and the answer behaves as it does today.

---

### User Story 5 - The "being debugged" state does not linger (Priority: P3)

After the agent stops acting on a tab for a while, the browser leaves its debugging state. It returns
when the agent acts again.

**Why this priority**: it is an annoyance, not a blocker, and it has costs (see Edge Cases).

**Independent Test**: have the agent act on a tab, then wait. Confirm the debugging state ends about 20
seconds after the last call. Confirm it stays while a GIF is recording or an emulated viewport is set, and
that the next action works normally.

**Acceptance Scenarios**:

1. **Given** the agent acted on a tab, **When** 20 seconds pass with no call in progress on it, **Then**
   debugging access on that tab is released.
2. **Given** a GIF recording or an emulated viewport on the tab, **When** 20 seconds pass, **Then**
   access is kept until those end.
3. **Given** access was released, **When** the agent acts again, **Then** the action works, and the page
   is again told it has focus.

### Edge Cases

- The owner answers in both places at nearly the same moment: the first answer to arrive decides, and
  the second is reported to the person who gave it as "already answered".
- The agent session ends or the agent disconnects while a question is pending: the question is withdrawn
  in both places, and nothing is admitted.
- The client advertises asking but never shows or answers the question: the card still decides, within
  the 120-second bound.
- The page navigates to another site while the question waits: the existing re-check before acting
  applies, so an answer for the old site does not admit an action on the new one (as in D-030-11).
- An action targets another site's frame (spec 030): the question and any session grant are for the
  frame's site.
- A second question arrives in the same session while one is pending: the existing one-at-a-time rule
  (`busy`) applies unchanged.
- A side-panel conversation agent (spec 019): its questions already appear in the panel. This feature
  changes only how outside agents are asked.
- A page dialog raised while debugging access is released is not seen until the next attach. This is an
  accepted cost of D-031-13.
- The browser's debugging notice still appears whenever access is held, including briefly during a
  screenshot. This cannot be suppressed and is an accepted cost.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-467**: When an outside agent's action needs consent and the agent's client advertises form
  elicitation, the system MUST ask through the client and raise the side-panel card at the same time
  (D-031-1, D-031-4).
- **FR-468**: A question asked through the client MUST offer only *allow this once*, *allow this site for
  this agent session* (where D-031-8 permits it) and *deny*. It MUST NOT offer any answer that persists
  beyond the session (D-031-2).
- **FR-469**: A session grant MUST cover one agent session and one site (full origin). It MUST NOT
  admit any other session's actions, and it MUST end when the session ends (D-031-3).
- **FR-470**: A session grant MUST admit only the page actions a spec 017 session site plan admits.
  This includes page dialog OK. Page JavaScript, uploads, a forced leave and closing a tab MUST still be
  asked each time (D-031-8).
- **FR-471**: The first answer given in either place MUST decide the question and withdraw it in the
  other place. A later answer MUST admit nothing (D-031-4).
- **FR-472**: A client that dismisses, declines, cancels or fails the question without the owner's
  explicit choice MUST NOT refuse or admit. The side-panel card MUST keep waiting (D-031-5).
- **FR-473**: An unanswered question MUST wait 120 seconds regardless of side-panel visibility. The
  toolbar mark MUST be shown whenever a question is pending (D-031-6). "Question" here means a consent
  question (an effect or diagnostics card); the pairing request card keeps its own bound and mark, because
  pairing happens once per agent, right after the owner has started it (owner-approved 2026-11-09).
- **FR-474**: The timeout the agent receives MUST tell it to ask the owner to answer in Chrome and then
  retry (D-031-6).
- **FR-475**: Each grant MUST record whether it was given in the agent's client or in the browser, and the
  side panel MUST show this for session grants and in the session's activity (D-031-7).
- **FR-476**: A diagnostics tool on a site without the diagnostics grant MUST raise a question instead of
  being refused. The client offers *once*, *this session on this site* and *deny*. The card also offers
  *always*, which sets the existing grant (D-031-9).
- **FR-477**: A diagnostics answer MUST NOT bypass the effect gate for `evaluate` (D-031-9).
- **FR-478**: A screenshot of an agent tab MUST be taken without making it the active tab and MUST
  reflect the page's current state while the window is covered. The previous method MUST remain only as
  a fallback when debugging access is unavailable (D-031-10).
- **FR-479**: A screenshot MUST keep the spec 012 picture contract: CSS-pixel frame, density handling and
  size budget (D-031-10).
- **FR-480**: A screenshot of a tab in a minimized window MUST be attempted through debugging access
  without restoring the window; if that capture fails or does not return within its bound, it MUST
  return a distinct "window minimized" answer telling the agent to have the owner restore the window. The
  window MUST NOT be restored automatically (D-031-11, amended 2026-11-08).
- **FR-481**: While debugging access is held on an agent tab, the page MUST be told it has focus
  (D-031-12).
- **FR-482**: Debugging access on a tab MUST be released after 20 seconds with no call in progress,
  unless a GIF recording, an emulated viewport or a diagnostics buffer still needs it. Released access
  MUST be re-acquired transparently on the next call (D-031-13).
- **FR-483**: The behaviour of actions other than screenshots in a minimized window MUST be measured
  before planning settles it. Measured 2026-11-08 (T938, Playwright Chromium): clicks and typing land in
  a minimized window, so effects get no minimized refusal. Branded-Chrome confirmation pending.

### Key Entities

- **Question**: one pending consent decision for one session, site and action. It is shown in up to two
  places and has exactly one answer.
- **Session grant**: an agent session, a site, a kind (page actions or diagnostics), and where it was
  given (client or browser). It lives only as long as the session.
- **Debugging hold**: on a tab, who needs debugging access (an action in progress, a recording, an
  emulated viewport) and when it was last used.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-208**: With a client that supports asking, the owner can grant consent for a new site without
  leaving the terminal, in one answer.
- **SC-209**: In a session that works on one site, the owner answers at most one question for that
  site's page actions after choosing the session answer.
- **SC-210**: No question expires in less than 120 seconds, and no pending question goes without the
  toolbar mark.
- **SC-211**: No consent answered in the agent's client is still in force after its session ends.
- **SC-212**: Screenshots taken while Chrome is fully covered show the page's current state in 100 % of
  the gate's runs, with no change to the owner's active tab.
- **SC-213**: The browser leaves its debugging state within 30 seconds of the agent's last call on a tab,
  unless a recording or an emulated viewport is active.

## Assumptions

- The question shown in the client is a form with one choice field. Its wording is decided during
  planning.
- If a client advertises asking but its dialog does not appear in practice, the card fallback (FR-472,
  FR-473) still serves the owner. The live check of each client is a plan task, not a precondition of
  this spec.
- The 120-second bound and the 20-second idle release are product defaults. They are not configurable in
  this feature.
- Session grants are held in memory for the session's lifetime and are never written to storage that
  outlives the browser.
- The site list, modes and the diagnostics checkbox keep their current meaning. Nothing in this feature
  changes the default mode.

## Non-goals

- Reusing an answer for N minutes, or any time-based cache.
- Any global "allow every site" from the agent's client.
- Restoring a minimized window automatically.
- Changing the default site mode.
- Any private protocol between a specific client and its own browser extension.
