# Feature Specification: Stop the Agent from the Page

**Feature Branch**: `spec-034-pill-stop` (from private main a71f19e)

**Feature Directory**: `specs/034-pill-stop`

**Created**: 2026-11-15

**Status**: Approved by the owner on 2026-11-15 (design answers D-034-1 to D-034-8, and D-034-9).

**Input**: Issue #64, "Stop the agent from the in-page pill". The owner can stop or end an agent only
from the side panel; on the page the agent is acting on there is no way to stop it. Observable
behaviour of other products was read, not copied (clean room, `docs/design-notes.md`); every phrase,
number and state below is Hallpass's own.

**Facts checked 2026-11-15** (this repository at private main a71f19e):

- Every tab a session holds shows the in-page pill (004 FR-062, R-117): the words "An agent is working
  in this tab" and one control, "back to the agent's tab". The control acts only on a press the
  browser marks as the user's own; a click the page makes up is ignored. The worker learns which tab
  pressed it from the browser's own sender record, never from the message body, and refuses a body that
  names another tab.
- The side-panel session card already has two ways to stop an outside agent:
  - **End session** (006 FR-087): the calls in flight answer `owner-stopped`, then the session is
    released. The agent has to start again.
  - **Interrupt this step** (014 FR-179, FR-180): the calls in flight answer `owner-interrupted`, a
    consent card that is up is withdrawn with no decision recorded, and nothing else changes. The
    agent's next call runs as usual.
- A side-panel conversation has its own **Stop**: the current turn ends and nothing more from it runs.
  The worker knows which sessions belong to a side-panel conversation.
- The stop reasons an agent receives are a closed list, `owner-stopped` and `owner-interrupted`; an
  agent branches on that short code.
- Session state the worker must keep across a worker restart lives in the browser's per-session
  extension storage, which survives the worker being stopped and restarted but not a browser restart
  (a browser restart ends every session anyway).
- A comparable browser-agent extension shows a Stop control on its in-page pill only for its own
  side-panel runs and hides it while an outside agent drives the browser, because its Stop reaches only
  its side panel. Hallpass already ends and interrupts outside sessions, so that reason does not apply
  here.

**Decisions (D-034-n)** (owner, 2026-11-15, one question at a time):

- **D-034-1 - what Stop means for an outside agent** (Q1 = A): Stop ends the step in flight the way
  Interrupt does, then holds the session: every later call of that session is refused until the owner
  resumes. The session and the pairing stay.
- **D-034-2 - where to resume** (Q2 = a): from either place. The pill turns into a stopped state with a
  Resume control, and the side-panel session card shows the same state with its own Resume.
- **D-034-3 - what is stopped** (Q3 = a): only the session that holds the tab the owner pressed Stop on.
  Other sessions keep running.
- **D-034-4 - reads are refused too** (Q4 = a): while held, every call of that session is refused,
  read-only ones included, all with the same answer.
- **D-034-5 - how long** (Q5 = a): a hold lasts until the owner resumes or the session ends. It has no
  timeout and it survives a worker restart; it never lifts by itself.
- **D-034-6 - side-panel conversations** (Q6 = a): for a side-panel conversation, Stop on the page is the
  conversation's own Stop. The turn ends; there is no held state and no Resume, because the owner's next
  message is what starts the agent again.
- **D-034-7 - when Stop does not land** (Q7 = a): if the page has no confirmation within about 2 s, the
  pill says Stop did not reach Hallpass and where else to stop, and the press is sent once more.
- **D-034-8 - scope** (Q8 = a): moving the pill and opening the side panel from it (#65) are a separate
  spec.
- **D-034-9 - a new stop reason**: a call refused because of a hold answers a new reason, `owner-held`.
  Neither existing reason is true of it: `owner-stopped` says the session ended, and
  `owner-interrupted` says only one step ended and the next call may run. This adds one value to the
  closed list agents read; no existing value or field changes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The owner stops an outside agent from the page (Priority: P1)

The owner watches Claude Code working in a tab, sees it going the wrong way, and presses Stop on the
pill. The step it was doing ends at once, nothing more happens in the browser, and the agent is told
the owner stopped it.

**Why this priority**: It is the issue. The page the agent is acting on is where the owner notices a
problem, and today the only way to stop is to open the side panel.

**Independent Test**: With an outside session working in a test tab, press Stop on the pill during a
step and then let the agent send three more calls (a click, a page read and a tab listing); confirm the
step in flight ended, the three calls were refused with `owner-held`, and nothing changed on the page.

**Acceptance Scenarios**:

1. **Given** an outside session is waiting on a consent card in this tab, **When** the owner presses
   Stop on the pill, **Then** the card is withdrawn with no decision recorded, the waiting call answers
   that the owner stopped it, and the site's mode is unchanged.
2. **Given** the session is held, **When** the agent sends any call (`click`, `read_page`,
   `screenshot`, `tabs_context`, `find`, …), **Then** it is refused at once with reason `owner-held`
   and a message telling the agent to stop and tell its user, and nothing reaches the page.
3. **Given** two sessions each hold their own tab, **When** the owner presses Stop on the first tab's
   pill, **Then** only the first session is held; the second session's calls run as before.
4. **Given** the session holds three tabs, **When** the owner presses Stop on one of them, **Then**
   every pill of that session shows the stopped state and calls on all three tabs are refused.
5. **Given** the page itself dispatches a click on the Stop control, **When** that click arrives,
   **Then** nothing happens.

---

### User Story 2 - The owner resumes, from the page or the side panel (Priority: P1)

After looking around or finishing something by hand, the owner presses Resume, either on the pill or
on the session card in the side panel, and the agent's next call works again.

**Why this priority**: A hold with no way out would be End session under another name; the owner chose
a hold precisely so the session can carry on.

**Independent Test**: Hold a session from the pill; resume from the pill and confirm the next call
runs; hold again; resume from the side-panel card and confirm the next call runs.

**Acceptance Scenarios**:

1. **Given** a held session, **When** the owner presses Resume on any of its pills, **Then** every pill
   of that session returns to its working state, the side-panel card leaves the stopped state, and the
   agent's next call runs normally.
2. **Given** a held session, **When** the owner presses Resume on its side-panel card, **Then** the
   same happens.
3. **Given** a held session, **When** the owner presses End session on its card, **Then** the session
   ends exactly as End session does today, held or not.
4. **Given** a held session, **When** the page itself dispatches a click on Resume, **Then** the
   session stays held.
5. **Given** a call was refused while held, **When** the owner resumes, **Then** that call is not run
   again by Hallpass; only calls the agent sends after the resume run.

---

### User Story 3 - The hold never lifts by itself (Priority: P1)

A held session stays held however long the owner leaves it, and a worker restart in between does not
quietly let the agent back in.

**Why this priority**: Stop is the owner's decision; anything that undoes it without the owner breaks
the one promise the control makes.

**Independent Test**: Hold a session, stop and restart the worker, then let the agent send a call;
confirm it is refused with `owner-held` and the pill and card still show the stopped state.

**Acceptance Scenarios**:

1. **Given** a held session, **When** 30 minutes pass with no action, **Then** it is still held.
2. **Given** a held session, **When** the worker is stopped and started again, **Then** the session is
   still held, its pills show the stopped state, and its card shows Resume.
3. **Given** a held session, **When** the session ends for any reason (End session, the agent
   disconnecting, the browser closing), **Then** the hold goes with it and nothing of it is left for a
   later session.
4. **Given** a held session, **When** a page in one of its tabs navigates or reloads, **Then** the new
   page's pill shows the stopped state.

---

### User Story 4 - Stop on the page in a side-panel conversation (Priority: P2)

While an agent in a side-panel conversation works in a tab, the owner presses Stop on the pill and the
conversation's turn ends, the same as pressing Stop in the conversation.

**Why this priority**: The control is the same on every pill; in a conversation the existing Stop
already means "nothing more until I say so", so the page only has to reach it.

**Independent Test**: In a side-panel conversation working on a test page, press Stop on the pill;
confirm the conversation shows its usual stopped line, no further step runs, there is no Resume, and
the owner's next message starts a new turn that can use the browser.

**Acceptance Scenarios**:

1. **Given** a conversation turn is working in this tab, **When** the owner presses Stop on the pill,
   **Then** the turn ends as if Stop had been pressed in the conversation, and the conversation shows its
   usual "Stopped" line.
2. **Given** the turn was stopped from the page, **When** the owner sends the next message, **Then**
   that turn can use the browser without any Resume.

---

### User Story 5 - The owner always learns whether Stop worked (Priority: P2)

If Stop cannot reach Hallpass (for example, the extension was just updated and the page still runs the
old script), the pill says so within a few seconds and tells the owner how else to stop.

**Why this priority**: Believing the agent stopped when it did not is the worst outcome of a Stop
control.

**Independent Test**: Make the worker unable to confirm (in a test build that drops the stop message)
and press Stop; confirm the press is sent twice and the pill shows the not-delivered message within
about 2 s.

**Acceptance Scenarios**:

1. **Given** the worker confirms the stop, **When** the owner presses Stop, **Then** the pill shows the
   stopped state within 1 s.
2. **Given** no confirmation arrives, **When** about 2 s have passed since the press, **Then** the press
   has been sent once more and the pill shows "Stop didn't reach Hallpass. Open the side panel (toolbar
   icon or Alt+A) and choose End session."
3. **Given** a Resume press gets no confirmation, **When** about 2 s have passed, **Then** the pill keeps
   the stopped state and says Resume didn't reach Hallpass, with the same pointer to the side panel.

---

### Edge Cases

- **Nothing in flight**: Stop with no step running still holds the session; the first refused call is
  the agent's next one.
- **A batch**: a `browser_batch` in flight ends at the current step; the steps after it are not run.
- **Stop pressed twice**, or on two tabs of the same session: the session is held once; the second
  press is confirmed and changes nothing.
- **Resume on a session that is not held**, e.g. two Resume presses: nothing happens beyond the
  confirmation.
- **Stop on a tab that is no longer held**, e.g. the session released it a moment before the press: the
  press holds nothing and the pill disappears as it does today when a tab leaves a session.
- **A frame**: the pill is drawn in the tab's top document only, so a press always comes from the top
  document; the worker decides the tab from the browser's sender record, as the existing control's does.
- **A page that copies the pill**: a page can draw a look-alike control, but a press on it never reaches
  the worker as a Stop or Resume. A page that hides or covers the real pill cannot stop the owner from
  using the side panel.
- **Consent card at the moment of Stop**: it is withdrawn with no decision recorded, as Interrupt does
  (014 FR-179); the site keeps its mode.
- **Pairing**: a hold does not touch the pairing or the site modes; after Resume nothing has to be asked
  again that was not already going to be asked.
- **A hold and a reconnect**: if the agent's link drops and the same session comes back, it is still
  held; if a new session starts, it is not.
- **The pointer and glow**: they stay on the page while held, so the owner can still see which tabs the
  agent holds; the pointer's caption (033) shows "Stopped".
- **Two windows of the side panel**: every open side-panel document shows the stopped state and Resume
  for that session.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-512 - Stop on the pill**: every pill of a tab held by an outside session or a side-panel
  conversation shows a Stop control next to the existing "back to the agent's tab" control, in the
  owner's locale.
- **FR-513 - only the owner's press, only for the tab's own session**: Stop and Resume act only on a press
  the browser marks as the user's own. The worker decides which session a press is about from the
  browser's sender record of the tab, never from anything the page sends, and refuses a press from a tab
  no session holds.
- **FR-514 - Stop holds an outside session**: for an outside session, Stop ends every call of that
  session in flight the way Interrupt does (014 FR-179, FR-180), including withdrawing a consent card
  with no decision recorded, and then marks the session held. Nothing else changes: the session, its
  tabs, its tab group, its debugger attachment, its recording, its pairing and the site modes stay as
  they are.
- **FR-515 - a held session's calls are refused**: while a session is held, every call it sends that
  reaches the worker is refused before anything reaches a page or a browser API, read-only calls
  included, with reason `owner-held` and the message in FR-521. A refused call is never run later on its
  own. The calls the host answers by itself, and the other limits, are listed in
  [contracts/agent-stop-reason.md](contracts/agent-stop-reason.md).
- **FR-516 - only that session**: a hold applies to the one session that holds the pressed tab; every
  other session is unaffected.
- **FR-517 - Resume**: a held session is resumed by a press on Resume on any of its pills or on its
  side-panel card. After a resume the session's next call runs as if the hold had not happened.
- **FR-518 - the hold lasts until the owner lifts it**: a hold has no timeout. It is kept where it
  survives a worker restart, and a restarted worker refuses the session's calls and shows the stopped
  state before it answers any of them. A hold ends only with Resume or with the session itself, and
  nothing of it outlives the session.
- **FR-519 - side-panel conversations**: for a session that belongs to a side-panel conversation, Stop
  on the pill does what the conversation's own Stop does (the turn ends) and holds nothing; the pill
  shows no Resume for it.
- **FR-520 - the stopped state is shown everywhere**: while a session is held, each of its pills shows
  the words "Stopped" and a Resume control in place of Stop; the session card in every open side-panel
  document shows "Stopped from the page" and a Resume control; the card's activity list notes the stop
  and the resume with their times.
- **FR-521 - what the agent is told**: a call refused because of a hold answers reason `owner-held` and
  a message that the owner pressed Stop, nothing was done, the agent should stop and tell its user, and
  the owner can resume from the page or the side panel. The message does not invite a retry.
- **FR-522 - confirmation and the not-delivered message**: the worker confirms every accepted Stop and
  Resume press to the page that sent it. If the page has no confirmation about 1 s after the press, it
  sends the press once more; if it still has none about 2 s after the press, the pill shows the
  not-delivered message (FR-523) and keeps its previous state.
- **FR-523 - copy**: the words are the worker's, in the owner's locale, sent to the page as text:

  | Where | en-US | zh-TW |
  |---|---|---|
  | Pill control | Stop | 停止 |
  | Pill, held | Stopped | 已停止 |
  | Pill control, held | Resume | 繼續 |
  | Pill, Stop not delivered | Stop didn't reach Hallpass. Open the side panel (toolbar icon or Alt+A) and choose End session. | 停止沒有送達。請打開側邊欄（工具列圖示或 Alt+A），按「結束工作階段」。 |
  | Pill, Resume not delivered | Resume didn't reach Hallpass. Use Resume on the side panel. | 繼續沒有送達。請在側邊欄按「繼續」。 |
  | Card state | Stopped from the page | 已從頁面停止 |
  | Card control | Resume | 繼續 |
  | Pointer caption (033) | Stopped | 已停止 |
  | Agent message (`owner-held`) | The owner pressed Stop on the page, so nothing was done. Stop and tell your user; the owner can resume from the page or the side panel. | (agents read English) |

- **FR-524 - one internal message shape each way**: the page sends the worker a Stop or Resume press as an
  internal message of a fixed, closed shape that names no session or tab; the worker sends the page the
  pill's state (working, held, conversation) and its words the same way. The page script never chooses
  words and puts them on screen as text, never as markup.
- **FR-525 - the agent-facing protocol**: the only change agents see is the new reason `owner-held` in
  the closed list of stop reasons (D-034-9). No tool, field or existing reason changes, and the host and
  extension versions stay pinned to each other as today.

### Key Entities

- **Hold**: a per-session mark that the owner stopped the session from a page; it has the time it was
  set and the tab it was set from, and nothing else. It exists only while its session does.
- **Pill state**: what the worker tells each pill of a held tab — *working* (Stop shown), *held*
  ("Stopped" and Resume shown), or *conversation* (Stop shown, no Resume ever) — with the words for it.
- **Stop reason `owner-held`**: the code a refused call carries while its session is held.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-225**: From the owner's press on Stop, the pill shows the stopped state within 1 s in 10 of 10
  presses, and no page change from that session happens after the press.
- **SC-226**: While a session is held, 100 % of its calls that reach the worker are refused, across at
  least one call of each tool family (input, navigation, reading, screenshot, tab listing), and 0 of them
  reach a page (host-answered calls: see the contract's known limits).
- **SC-227**: A second session working at the same time completes its task with no refused call while
  the first session is held.
- **SC-228**: After a worker restart, a held session is still held in 5 of 5 tries.
- **SC-229**: 0 of 20 page-made clicks on Stop or Resume change any session's state.
- **SC-230**: When Stop cannot be delivered, the not-delivered message is on the pill within 3 s of the
  press in 5 of 5 tries.
- **SC-231**: In the owner's live run, the owner stops Claude Code from the page, does something by hand
  on the same page, resumes, and the agent carries on, without opening the side panel.

## Assumptions

- The pill's words follow the locale it already uses; locales other than `en-US` and `zh-TW` fall back to
  `en-US`.
- The pill is drawn where it is drawn today, in the top document of each held tab; Stop sits on it.
- The card's activity lines live in worker memory, like every other activity line, so the stop and
  resume lines are lost on a worker restart; the hold itself is not.
- Side-panel conversations remain Windows-only, as elsewhere; on other systems only outside agents get
  the pill.
- A page can cover or imitate the pill, as it can today; the protection is that only the owner's press on
  the real control counts, and that the side panel always offers End session.
- Live verification uses the attached-browser setup the packaged gate already uses; no new tooling.

## Non-goals

- Moving the pill or opening the side panel from it (#65).
- A "stop every session" control.
- Ending idle or long-held sessions automatically.
- Holding a session from the side panel (the card keeps End session and Interrupt as they are).
- Queuing calls during a hold to run them after Resume.

## Change log

- **2026-11-15**: first draft from the owner's answers to Q1-Q8.
- **2026-11-15 (plan)**: the pill is drawn in the top document only (the indicator is sent to frame 0),
  so the frame edge case and the pill assumption are corrected; the activity lines' restart limit is
  stated (research R-518, R-521). Calls in flight at the moment of Stop answer `owner-interrupted` and
  later ones `owner-held` (R-515), which is how US1.1's "answers that the owner stopped it" is met.
- **2026-11-15 (review round 1)**: the upload-directory question asked before an upload is refused with
  `owner-held` too, through a new `held` decision on the host link (owner's choice; the plan's "no host
  change" no longer holds - contracts/agent-stop-reason.md). A session that greets as a side-panel
  conversation is never held, also when the press came before it greeted a restarted worker (FR-519).
  A failed read of the holds is retried before the next call is decided. A step whose session is
  stopped while it waits to start is not started (SC-225). Known limits recorded in
  contracts/agent-stop-reason.md (host-answered tools, browser switch) and R-514 (unpair after a restart).
- **2026-11-15 (review round 2)**: FR-515 and SC-226 say "calls that reach the worker" and point at the
  contract's known limits. The upload-directory question checks the hold again right before the card is
  raised. A side-panel greeting drops a hold only for a session this worker does not know yet or knows as
  a conversation (R-514); a known outside session keeps it. A hold found by a late successful read redraws
  the session's pills as well as the card.
- **2026-11-15 (review round 3, owner's OK)**: the side-panel greeting rule reads the kind the session
  had when the worker first registered it, so repeating a token greeting cannot lift an outside
  session's hold (R-514).
- **2026-11-15 (review round 4, owner's choice)**: the rule is decided from the press, not from
  greetings: a hold records whether the worker knew the session when Stop was handled, and only a hold
  set while it did not is settled by the session's first greeting (R-514, data model).
