# Feature Specification: Consent Follow-ups After the Terminal Trial

**Feature Branch**: not created yet (spec written on `031-outside-agent-experience`, private main 37037d9)

**Feature Directory**: `specs/032-consent-followups`

**Created**: 2026-11-09

**Status**: Draft. The owner chose D-032-1..3 on 2026-11-09; the spec itself awaits the owner's approval.

**Input**: The owner's live run of spec 031 on 2026-11-09 (branded Chrome, Claude Code), and public
follow-up issues #58, #59, #60 (two of its five items) and #61.

1. The agent pressed Enter in a search box and its tab moved from `www.wikipedia.org` to
   `zh.wikipedia.org`. The next call asked the owner "continue / always / decline", but only as a
   side-panel card. Chrome was covered by the terminal, nothing appeared in the terminal, and the call
   failed after 120 seconds.
2. Revoking a site in settings does not end the "this session" answers given in the agent's client, so
   that session can keep acting on the site until it ends (#58).
3. The session's activity does not say where or how a consent question was answered (#59).
4. Two lifecycle gaps in spec 031's debugger handling (#60): the idle release does not survive a
   service-worker restart, and a screenshot that misses its bound leaves the attachment to chance.

**Facts checked 2026-11-09** (this repository at private main 37037d9):

- Only plain page actions, page dialog OK, a forced leave and diagnostics questions are asked in the
  agent's client (031 D-031-2). The site-transition question, the site-plan question (`propose_sites`),
  the plan card (follow-a-plan batch) and the upload-directory card are side-panel only.
- The transition card's *Continue* already records an allowance for that one from-to pair for the
  session only; *Always* records it persistently; *Decline* records nothing and asks again on the next
  call (up to three asks per call). The site-plan approval is also session-scoped.
- Each card waits 120 seconds from when it is raised. The host keeps a call alive for at most 130
  seconds from when the call was admitted, unless the question was raised to the client; so a
  side-panel-only question raised late in a call (for example a second transition ask) is cut before its
  120 seconds.
- Revoking a site (settings page, *Revoke*) clears the site's mode and its diagnostics checkbox and
  detaches diagnostics on that site's tabs. It does not touch spec 031 session grants (page actions,
  diagnostics), session site-plan approvals or session transition allowances.
- The activity list (latest 20 entries per session) records dialogs, uploads, restores, viewport
  changes, interrupts and site plans. A consent answer adds nothing.
- The 20-second idle release is a timer in the extension's background worker memory. Chrome keeps the
  debugger attachment when that worker is stopped, so the timer is lost and the "being debugged" bar
  stays. At worker start only diagnostics attachments it does not know are detached.
- A surface screenshot that misses its 5-second bound is answered by a fallback, but the browser-side
  capture request is never cancelled and nothing makes sure the attachment is let go.

**Decisions (D-032-n)**:

- **D-032-1 - more questions where the owner is** (owner, 2026-11-09): the site-transition question and
  the site-plan question are asked in the agent's client too. The client may answer only *continue for
  this session* / *allow these sites for this session* or *deny*. *Always* stays Chrome-only, as in
  D-031-2. The plan card and the upload-directory card stay Chrome-only.
- **D-032-2 - a revoke ends every session admission for the site** (owner, 2026-11-09): revoking a site
  removes, for every live agent session, the page-action and diagnostics session grants for it, its
  session site-plan approval, and session transition allowances that lead to it. Persistent transition
  pairs keep their own clear control.
- **D-032-3 - activity records answers and timeouts** (owner, 2026-11-09): every settled consent question
  adds one activity line with the site, where it was answered and the result, including *timed out*.
- **D-032-4 - every question gets its full wait**: a question gets 120 seconds from when it is shown,
  whether or not it was raised to the client.
- **D-032-5 - no attachment outlives a worker restart indefinitely**: an attachment nothing claims after a
  worker restart is released after the same idle period; a screenshot that misses its bound lets go of
  its hold like any other ending.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A site change is asked in the terminal (Priority: P1)

The agent's action moves its tab to a site the owner has not decided about. On the agent's next call the
question appears in the terminal as well as in the side panel. The owner chooses *continue for this
session* in the terminal and the agent carries on.

**Why this priority**: it is the failure the owner hit in the first live run; any cross-site move with
Chrome covered stalls the agent for two minutes.

**Independent Test**: with a client that supports asking, have the agent move a tab to an undecided
site, then call again on that tab. Confirm the question appears in the client, answer there, and confirm
the call runs and the card is withdrawn.

**Acceptance Scenarios**:

1. **Given** a tab that moved to an undecided site in `ask` mode, **When** the agent calls on that tab,
   **Then** the question is shown in the agent's client and as a side-panel card at the same time, and
   both name the site it came from and the site it went to.
2. **Given** that question, **When** the owner chooses *continue for this session* in the client, **Then**
   the call goes on, the card is withdrawn, and the same move is not asked about again in this session.
3. **Given** that question, **When** the owner chooses *deny* in the client, **Then** the call is refused
   as declined and nothing is recorded.
4. **Given** that question in the client, **Then** no answer offered there records the move as allowed
   beyond the session.
5. **Given** that question, **When** the owner answers on the card instead, **Then** the client's question
   is withdrawn and the card's answer decides, including *always*.

---

### User Story 2 - A multi-site plan is asked in the terminal (Priority: P2)

The agent proposes the sites for a task (`propose_sites`). The owner approves the plan in the terminal for
this session.

**Why this priority**: an agent working across sites asks this first; with Chrome covered it stalls just
like Story 1, but it is asked once per task rather than on every move.

**Independent Test**: with a client that supports asking, call `propose_sites` and answer in the client.
Confirm the sites are approved for the session and the card is withdrawn.

**Acceptance Scenarios**:

1. **Given** a site-plan proposal, **When** it is raised, **Then** it is shown in the client and as a card,
   and the client's question lists the proposed sites.
2. **Given** that question, **When** the owner allows it in the client, **Then** the sites are approved for
   this session only, exactly as approving the card would do.
3. **Given** that question, **When** the owner denies it in the client, **Then** nothing is approved and
   the agent is told it was declined.

---

### User Story 3 - Every question gets its full two minutes (Priority: P1)

A question that is shown only in Chrome (a plan card, an upload directory, or any question when the
client cannot ask) gets its whole 120 seconds, even when it is raised late in a long call.

**Why this priority**: a question that is cut early looks to the owner like the agent gave up while they
were reaching for it.

**Independent Test**: in one call, answer a first question after about 100 seconds so that a second
question is raised; leave the second unanswered and measure that it waits 120 seconds from when it was
shown before the call reports no answer.

**Acceptance Scenarios**:

1. **Given** a question raised late in a call, **When** nobody answers, **Then** it is withdrawn 120
   seconds after it was shown, not earlier.
2. **Given** any pending question, **Then** the toolbar mark is shown.

---

### User Story 4 - Revoking a site really revokes it (Priority: P1)

The owner gave an agent session "this session" access to a site in the terminal, then changes their mind
and revokes the site on the settings page. The agent's next page action on that site is asked about
again.

**Why this priority**: a revoke that does not take effect breaks the owner's trust in every other
control.

**Independent Test**: grant a site for the session in the client (page actions and diagnostics), approve
a site plan that includes it, and allow a move into it; revoke the site in settings; confirm each of the
next page action, diagnostics call, and move into the site is asked about again.

**Acceptance Scenarios**:

1. **Given** a session grant for page actions on a site, **When** the owner revokes the site, **Then** the
   session's next page action there is asked about.
2. **Given** a session diagnostics grant on a site, **When** the owner revokes the site, **Then** the next
   diagnostics call there is asked about, and diagnostics on its tabs stop.
3. **Given** a session site plan that includes the site, **When** the owner revokes the site, **Then** the
   plan no longer admits page actions there; the plan's other sites are unaffected.
4. **Given** a session allowance for a move into the site, **When** the owner revokes the site, **Then**
   the next move into it is asked about again.
5. **Given** a persistent *always* allowance for a move into the site, **When** the owner revokes the site,
   **Then** that allowance stays until the owner clears it with its own control.
6. **Given** several live sessions with grants on the site, **When** the owner revokes it, **Then** every
   session loses them; grants on other sites are untouched.

---

### User Story 5 - The activity says how each question was answered (Priority: P3)

The owner opens a session card and sees, for each consent question, where it was answered and what was
chosen, or that nobody answered.

**Why this priority**: it helps the owner understand a refusal afterwards; nothing is blocked without it.

**Independent Test**: answer one question in the client, one on the card, and leave one unanswered;
confirm three activity lines naming the site, the place and the result.

**Acceptance Scenarios**:

1. **Given** a question answered in the client, **Then** the activity names the site, says it was answered
   in the agent's client, and gives the answer (once, this session, deny).
2. **Given** a question answered on the card, **Then** the activity says it was answered in Chrome and
   gives the answer, including *always*.
3. **Given** a question nobody answered, **Then** the activity says it timed out.
4. **Given** more than 20 activity entries, **Then** only the latest 20 are kept, as today.

---

### User Story 6 - The debugging bar goes away after a worker restart (Priority: P3)

The agent acted on a tab, then the extension's background worker was stopped by Chrome. Within about 20
seconds of the worker starting again, the "being debugged" bar is gone unless something still needs the
attachment.

**Why this priority**: an annoyance with no consent impact, but it undercuts spec 031's promise that the
bar does not linger.

**Independent Test**: act on a tab, stop the background worker, start it again, and confirm the
attachment is released within the idle period; repeat with a recording running and confirm it stays.

**Acceptance Scenarios**:

1. **Given** an attachment from before a worker restart that nothing claims, **When** the worker starts,
   **Then** the attachment is released within the idle period.
2. **Given** a recording, an emulated viewport, a diagnostics grant or an open page dialog on a tab while
   the worker runs, **Then** the attachment is kept (FR-497 as amended).
3. **Given** a screenshot whose capture misses its bound, **When** the call answers, **Then** the call no
   longer holds the attachment, and the idle release applies as after any other call.

### Edge Cases

- A move answered *continue for this session* in the client covers that one from-to pair only, as the
  card's *Continue* does today.
- A call that asks about a move up to three times may raise up to three client questions in a row; each
  has its own question identity and its own 120 seconds.
- A client that cannot ask, or that dismisses the question, leaves the card in force (031 FR-472).
- A revoke while a question about that site is pending does not answer the question; the owner's answer
  to it then decides as usual.
- A revoke of a site the session never touched changes nothing for that session.
- Activity lines for questions in a `browser_batch` name each step's question separately.
- After a worker restart no holder is restored (FR-497 as amended), so the start-up reconciliation has no
  holder to race.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-484**: The site-transition question MUST be asked through the agent's client, when it can ask, at
  the same time as its card (D-032-1).
- **FR-485**: A transition question in the client MUST offer only *continue for this session* and *deny*.
  *Continue for this session* MUST record exactly what the card's *Continue* records today (D-032-1).
- **FR-486**: The site-plan question MUST be asked through the agent's client, when it can ask, at the
  same time as its card, offering only *allow for this session* and *deny*; allowing MUST record exactly
  what approving the card records (D-032-1).
- **FR-487**: The plan card and the upload-directory card MUST NOT be asked through the client (D-032-1).
- **FR-488**: Every question MUST stay answerable for 120 seconds from when it is shown, whether or not it
  is raised to the client, and the toolbar mark MUST be shown while any question is pending (D-032-4).
- **FR-489**: The one-answer rules of spec 031 (FR-471, the per-question identity) MUST hold for every
  question this feature raises to the client.
- **FR-490**: Revoking a site MUST remove, for every live agent session, the page-action and diagnostics
  session grants for that site (D-032-2).
- **FR-491**: Revoking a site MUST remove that site from every live session site plan, leaving the plans'
  other sites in force (D-032-2).
- **FR-492**: Revoking a site MUST remove every session transition allowance whose destination is that
  site; persistent transition allowances MUST NOT be changed by a revoke (D-032-2).
- **FR-493**: After a revoke, the next page action, diagnostics call or move into that site MUST be asked
  about as for an undecided site.
- **FR-494**: Every settled consent question MUST add one activity line naming the site, where it was
  answered (agent's client or Chrome) and the result (once, this session, always, deny, timed out)
  (D-032-3).
- **FR-495**: The activity MUST keep its existing limit of the latest 20 entries per session.
- **FR-496**: After a background-worker restart, a debugger attachment that no current holder claims MUST
  be released within the idle period (20 seconds) (D-032-5). Found already met during implementation
  (2026-11-09): the worker's start-up reconciliation (`diagnostics.start`, the 031 C1 path) detaches every
  attachment this worker has no record of at once, so the release is immediate; R-489 pins it.
- **FR-497**: A recording, an emulated viewport, a diagnostics grant or an open page dialog MUST still
  keep the attachment while the worker that holds it runs. None of them survives a worker restart (the
  emulation, the dialog and the recording end with the worker; a diagnostics grant re-attaches on its next
  call), so there is nothing to keep across one.
- **FR-498**: A screenshot whose capture misses its bound MUST end the call's hold on the attachment,
  exactly as a completed capture does (D-032-5).

### Key Entities

- **Owner question**: a consent question with its own identity, the site(s) it concerns, the channel(s)
  it is shown in, the moment it was shown, and its outcome.
- **Session admission**: anything that lets a live session act on a site without asking: a page-action
  or diagnostics session grant, a session site-plan approval, a session transition allowance.
- **Activity line**: time, site, kind of question, channel, result.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-214**: With a client that supports asking, a cross-site move and a site plan can each be answered
  without leaving the terminal, in one answer.
- **SC-215**: No question is withdrawn less than 120 seconds after it is shown.
- **SC-216**: After a revoke, 100 % of the next page actions, diagnostics calls and moves into that site
  are asked about, in every live session.
- **SC-217**: Every consent question a session settles appears in its activity with the channel and
  result.
- **SC-218**: The browser leaves its debugging state within 30 seconds of a worker restart when nothing
  needs the attachment.

## Assumptions

- The wording of the client questions is decided during planning, in the same style as spec 031.
- The revoke control stays on the settings page; no new revoke control is added in the side panel.
- Session site plans and transition allowances keep their current storage and lifetime; only the revoke
  path learns to remove entries.
- A worker restart is rare in practice; restoring the exact remaining idle time is not required, only
  that the attachment is released within one idle period after the restart.

## Non-goals

- Any client answer that persists beyond the session (always, skip-checks, diagnostics checkbox).
- Asking the plan card or the upload-directory card in the client.
- The other three #60 items: overlapping allow-once diagnostics calls on one tab, closing a tab after an
  idle release, and the debugging bar during `navigate`.
- Changing pairing (031 FR-473 scope stays).
- A revoke control in the side panel.
