# Feature Specification: A Readable Panel — Sessions You Can Tell Apart, Words That Mean What They Say

**Feature Branch**: `016-readable-panel` (git: `feature-016-readable-panel`, from `main` at 5f8f27c =
0.8.0 as released)

**Feature Directory**: `specs/016-readable-panel`

**Created**: 2026-09-27

**Status**: Implemented 2026-09-27 (0.9.0; owner approval of screenshots and branded-Chrome run pending, see coverage.md)

**Input**: Owner review of the 0.8.0 side panel on 2026-09-27 ("I don't understand what this is
showing"), followed by a one-question-at-a-time decision session the same day and an approved
before/after mockup (private design canvas "Hallpass 面板改版示意"). The reference reading behind
the tab-group decision is the private evidence for 016.

**Owner decisions (2026-09-27)**:

- **D-016-1 — Next phase is readability.** UI first, with three small robustness follow-ups; macOS
  and Linux are a later, separate feature.
- **D-016-2 — Keep the panel's three parts** (connection → sessions → sites); remove repetition, fix
  wording, hide internal identifiers. No re-layout.
- **D-016-3 — Status row** says "connected · N sessions"; the duplicated in-panel title goes; the
  paired-agent list moves into the "more options" menu.
- **D-016-4 — A session is named by its project folder and start time**; the internal id moves into
  the technical details.
- **D-016-5 — Three session states**: working, waiting for you, idle (with "last action N minutes
  ago").
- **D-016-6 — Buttons say what they do and appear only when they can act**: end session (always),
  interrupt this step (while working), take back tabs (N) (while holding tabs).
- **D-016-7 — Site rows**: the permissive mode is marked on its control, not by a second label; the
  diagnostics grant says what is read; revoke does not repeat the address.
- **D-016-8 — Tab group**: titled "Hallpass" with an hourglass while working and a bell while
  waiting for the owner; each session its own colour, shown on its panel card too.
- **D-016-9 — Robustness**: a keystroke that opens a dialog is answered with the dialog; a hung
  press sends no release (pinned by a test); a pairing card gets the longer wait when the owner's
  focus leaves the panel's window after it was raised.
- **D-016-10 — Mockup first, then build; release only after the owner approves real screenshots.**

## Why this feature exists

The owner looked at the panel with two live sessions and could not read it. Measured against the
0.8.0 source:

- The panel shows its own name twice (browser chrome and an in-panel heading).
- The status row shows "connected · hallpass-verify-X": the display name of the **first paired
  agent**, which was a verification client, not either of the two sessions on screen.
- Each session card is titled with an eight-character hex id; two sessions of the same agent are
  indistinguishable.
- Every session that is not waiting on the owner reads "running", including sessions that are idle
  and hold no tab.
- Three buttons — stop, interrupt, give back tabs — are always shown; "stop" and "interrupt" read as
  synonyms; "give back tabs" appears on a card that holds none; "interrupt" is greyed.
- Each site row says the same thing twice (a warning label and the select both say "does not ask";
  the diagnostics checkbox and a line under it both say "allowed") and the revoke button repeats the
  address.
- In the tab strip every session's group is titled "Agent" in the same blue, so two sessions cannot be
  told apart there either.

None of this is wrong information; it is information the owner cannot use. This feature changes what
the panel and the tab strip say, not what the product does — except for the three robustness items,
which are small corrections to answers and waits.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The owner can tell at a glance whether the bridge is up and how many sessions use it (Priority: P1)

The owner opens the panel. The first line says the connection is up and how many agent sessions are
connected. Nothing on it names an agent that is not connected.

**Why this priority**: it is the first thing read, and today it names a stale, unrelated agent.

**Independent Test**: with two live sessions and three paired agents, the status row reads
"connected · 2 sessions"; the paired agents are listed inside "more options", each with its unpair
action.

**Acceptance Scenarios**:

1. **Given** the bridge is connected and two sessions are live, **When** the panel opens, **Then**
   the status row reads "connected · 2 sessions" and no agent display name appears in it.
2. **Given** one session, **Then** the row uses the singular form in each locale.
3. **Given** the bridge is connected and no session is live, **Then** the row reads "connected · no
   sessions" (or the locale's equivalent) rather than an empty count.
4. **Given** the owner opens "more options", **Then** every paired agent is listed by its display name
   with an unpair action for each, and unpairing one behaves exactly as unpair does today.
5. **Given** the panel is shown, **Then** the product name appears once (in the browser's panel
   header) and not again as an in-panel heading.

---

### User Story 2 - Each session card says which project it is, what it is doing, and offers only what applies (Priority: P1)

The owner has two Claude Code windows open on different projects. Each card names its project and
when it started, says whether it is working, waiting for the owner, or idle (and since when), and
shows only the buttons that can do something right now.

**Why this priority**: the core complaint; the owner must be able to stop or take back the right
session.

**Independent Test**: sessions started from folders "shop-frontend" and "hallpass"; one with a call
in flight holding two tabs, one idle for 12 minutes holding none. The first card reads "claude-code ·
shop-frontend", "14:02 started · holds 2 tabs: …", "working", with end / interrupt / take back (2);
the second "claude-code · hallpass", "idle · last action 12 min ago", with end only.

**Acceptance Scenarios**:

1. **Given** a session whose host reported its project folder, **Then** the card title is the agent
   name and the folder's last path segment, and the subtitle carries the session's start time (local,
   hours and minutes) and the tabs it holds.
2. **Given** a session whose host did not report a folder (an older host), **Then** the title is the
   agent name and the start time, and the card is otherwise the same.
3. **Given** the owner opens the card's technical details, **Then** the internal session id is there
   and nowhere else on the card.
4. **Given** a call of the session is in flight, **Then** the card says "working".
5. **Given** a question from the session is waiting on the owner, **Then** the card says "waiting for
   you" and is visually marked as needing attention.
6. **Given** neither, **Then** the card says "idle" followed by "last action N minutes ago" (or "just
   now" under a minute; hours past 60 minutes), and the figure advances while the panel stays open.
7. **Given** any state, **Then** "end session" is shown at the left and ends the session exactly as
   "stop" does today.
8. **Given** the session is working, **Then** "interrupt this step" is shown and behaves exactly as
   "interrupt" does today; **Given** it is not, **Then** the button is absent; **Given** the owner
   presses it in the moment the call ended, **Then** the existing "nothing to interrupt" line is
   shown instead of nothing.
9. **Given** the session holds N ≥ 1 tabs, **Then** "take back tabs (N)" is shown and releases them as
   "give back tabs" does today; **Given** it holds none, **Then** the button is absent.
10. **Given** buttons appear or disappear, **Then** "end session" does not move.

---

### User Story 3 - A site row is read once (Priority: P2)

Each site row names the site, shows its mode in one control (marked as a warning when the mode lets
the agent act without asking), one checkbox that says what the diagnostics grant reads, and a short
revoke button.

**Why this priority**: less urgent than the sessions, but every row today doubles its text.

**Independent Test**: a site in "act without asking" with diagnostics granted shows: the site, the
select with a warning border, "allow reading console and network logs" checked, "revoke"; no other
text.

**Acceptance Scenarios**:

1. **Given** a site in the permissive mode, **Then** the mode select carries the warning colour on its
   border and no separate warning label is shown; **Given** any other mode, **Then** the select looks
   ordinary.
2. **Given** the diagnostics grant, **Then** its checkbox reads "allow reading console and network
   logs" (and the English equivalent), and no line repeats its state.
3. **Given** the revoke button, **Then** its visible text is "revoke" alone and its accessible name
   still includes the site.
4. **Given** a screen reader, **Then** the select and the checkbox are still announced with the site
   they belong to.

---

### User Story 4 - The tab strip shows which session holds which tabs and which one needs the owner (Priority: P1)

A session's tabs sit in a group titled "Hallpass" in that session's colour; the same colour marks its
panel card. While the session works, the title starts with an hourglass; while it waits for the
owner, with a bell.

**Why this priority**: the owner looks at the tab strip more often than at the panel; this is where
"which one is waiting for me" is answered without opening anything.

**Independent Test**: two sessions each holding tabs get two different colours; the working one's
group reads "⌛ Hallpass", the waiting one's "🔔 Hallpass"; each card's stripe matches its group.

**Acceptance Scenarios**:

1. **Given** a session takes its first tab, **Then** its group is titled "Hallpass" in the next colour
   of a fixed rotation that excludes red and yellow, and its card shows that colour.
2. **Given** two live sessions hold tabs, **Then** their colours differ (until the rotation's length
   is exceeded).
3. **Given** a session's call starts, **Then** its group title gains the hourglass prefix; **Given**
   calls follow each other within about a second, **Then** the prefix stays rather than flickering;
   **Given** the session goes idle, **Then** the prefix is removed.
4. **Given** a question from the session waits on the owner, **Then** its group title carries the bell
   prefix (taking precedence over the hourglass) until the question is answered or withdrawn.
5. **Given** the session releases its tabs or ends, **Then** the group marking is withdrawn as today.
6. **Given** the browser restarted or the extension reloaded, **Then** groups left behind titled
   "Agent" (0.8.0 and earlier) or "Hallpass" with or without a prefix are recognised and cleaned up as
   the "Agent" groups are today.
7. **Given** the owner renamed a group by hand, **Then** the product does not fight the rename beyond
   the next state change it would have made anyway.

---

### User Story 5 - Three answers and waits that were slightly wrong are right (Priority: P2)

A keystroke whose page handler opens a dialog is answered with that dialog, as a click is. A press
whose "button down" never returned sends no "button up". A pairing card raised while the owner was in
the panel's window still gets the longer wait if the owner then leaves that window.

**Why this priority**: small, known, and in the path of the same owner-facing honesty.

**Independent Test**: unit tests for each; the dialog case also in a browser gate.

**Acceptance Scenarios**:

1. **Given** a `key`/`type` step whose keydown handler opens `alert`, **When** the call is answered,
   **Then** the answer carries the dialog as a click's answer does (not `page-not-responding`), and a
   retry is not needed.
2. **Given** a press whose "button down" dispatch did not return within the bound, **Then** no
   "button up" is ever sent for that gesture, even when the late response arrives.
3. **Given** a pairing card raised while the panel's window had focus (short wait), **When** focus
   leaves that window before the wait ends, **Then** the wait extends to the long wait, measured from
   when the card was raised, and the agent's hint is the one it gets today when the panel was not seen.

---

### User Story 6 - 0.9.0, verified, documented, and approved by the owner before release (Priority: P3)

**Acceptance Scenarios**:

1. **Given** the build, **Then** the version reads 0.9.0 wherever 0.8.0 is read today.
2. **Given** the full agent gate suite on the developer browser, **Then** it is green.
3. **Given** the panel, **Then** real screenshots in zh-TW and en-US, light and dark, are produced for
   the owner; release waits for the owner's approval of them and for the owner's branded-browser run.
4. **Given** the docs, **Then** README, README.zh-TW, the operations guide, the QA guide, the design
   notes and the package README describe the new panel and tab strip.

---

### Edge Cases

- A host that sends no project folder (0.8.0 and earlier): the title falls back to agent name + start
  time (US2-2). A 0.9.0 host with a 0.8.0 extension: the new frame is dropped as unknown; nothing else
  changes.
- A project folder name that is very long, empty, or the root of a drive: the card shows at most a
  bounded number of characters with an ellipsis; an empty or root folder is treated as "no folder".
- A folder name containing characters that look like markup: shown as inert text.
- Two sessions from the same folder: told apart by start time.
- More live sessions than colours in the rotation: colours repeat in rotation order; the card titles
  still differ.
- A session that holds no tab has no group; its card still shows its colour so the colour is stable
  when it later takes a tab.
- The session's first tab arrives while it is already waiting for the owner: the group is created
  with the bell prefix.
- Time on the card ("last action") when the worker restarted: it is computed from the recorded last
  activity, not from when the panel opened.
- Locales: the singular/plural forms and the "minutes ago" forms are per locale; the tab-group title
  "Hallpass" and its prefixes are not localised.
- Reduced motion: nothing in this feature animates; the hourglass/bell are static characters.
- The owner answers a pairing card in the very tick the wait was being extended (B5): the answer wins.

## Requirements *(mandatory)*

### Functional Requirements

**Status row (D-016-3)**

- **FR-223**: The status row MUST state the connection state and the number of live sessions, and
  MUST NOT show any agent's display name.
- **FR-224**: The panel MUST NOT repeat the product name as an in-panel heading.
- **FR-225**: The "more options" menu MUST list every paired agent by display name with its unpair
  action; unpair MUST behave as today.

**Session identity (D-016-4)**

- **FR-226**: The local host MUST report, once per session, the last path segment of its own working
  directory, at most 64 characters, as a session label, on a link frame type of its own (an old
  worker drops it as unknown; the link protocol stays 2). It MUST NOT send or log the full path.
- **FR-227**: The session card title MUST be the agent's display name and the reported folder; when
  none was reported, the agent's display name and the session's start time.
- **FR-228**: The card MUST show the session's start time (local, hours and minutes) and MUST move the
  internal session id into its technical details. The start time MUST appear once: in the subtitle
  when the title carries a folder, in the title alone when it does not (owner check, 2026-09-27).
- **FR-229**: Label text from the host MUST be rendered as inert text and truncated with an ellipsis
  beyond a fixed visible length.

**Session state (D-016-5)**

- **FR-230**: The card MUST show exactly one of: working (a call is in flight), waiting for you (a
  question from this session waits on the owner; takes precedence), idle.
- **FR-231**: An idle card MUST show the time since the session's last action, in whole minutes
  ("just now" under one minute; hours and minutes from 60 minutes), refreshed at least once a minute
  while the panel is open.

**Session actions (D-016-6)**

- **FR-232**: "End session" MUST always be shown, at a fixed position, and MUST do what "stop" does
  today.
- **FR-233**: "Interrupt this step" MUST be shown only while the card is working and MUST do what
  "interrupt" does today, including the "nothing to interrupt" line when pressed after the call ended.
  Owner confirmed 2026-09-27: it is not offered while the card waits for you; the owner answers the
  question card (or ends the session) instead, and 014's interrupt-a-waiting-call path is withdrawn
  from the panel.
- **FR-234**: "Take back tabs (N)" MUST be shown only while the session holds N ≥ 1 tabs and MUST do
  what "give back tabs" does today.

**Site rows (D-016-7)**

- **FR-235**: The permissive mode MUST be marked by the mode control's appearance (warning border)
  and not by a separate label.
- **FR-236**: The diagnostics grant control MUST name what it allows ("reading console and network
  logs"); no separate line may repeat its state.
- **FR-237**: The revoke control's visible text MUST NOT repeat the site; its accessible name MUST
  include it.
- **FR-248** (owner check, 2026-09-27): The allowed-upload-directories section MUST say what the list
  governs, MUST say when it is empty and how a directory gets onto it, and MUST show the list file's
  path as its last, quiet line.

**Tab strip (D-016-8)**

- **FR-238**: A session's tab group MUST be titled "Hallpass", prefixed with "⌛ " while the session is
  working and "🔔 " while a question from it waits on the owner (bell takes precedence), unprefixed
  otherwise.
- **FR-239**: The working prefix MUST NOT be removed until the session has had no call in flight for
  about one second, so consecutive calls do not flicker the title.
- **FR-240**: Each session MUST be assigned a colour from a fixed rotation excluding red and yellow,
  kept for the session's life, used for its tab group and shown on its panel card.
- **FR-241**: Stale-group cleanup MUST recognise groups titled "Agent", "Hallpass", "⌛ Hallpass" and
  "🔔 Hallpass".

**Robustness (D-016-9)**

- **FR-242**: A keyboard dispatch that opens a JS dialog MUST be answered with the dialog, as a click
  that opens one is.
- **FR-243**: A pointer gesture whose "button down" exceeded the dispatch bound MUST NOT send its
  "button up", even after the late response; a test MUST pin this.
- **FR-244**: A pairing question raised with the short wait MUST extend to the long wait (measured
  from when it was raised) when the owner's focus leaves the panel's window before the short wait
  ends; the agent is then told what it is told today when the panel was not seen.

**Close-out (D-016-10)**

- **FR-245**: Version 0.9.0 at every single source that carries the version today.
- **FR-246**: Docs listed in US6-4 updated; zh-TW and en-US strings complete; public docs carry no
  reference identifiers.
- **FR-247**: Real panel screenshots (zh-TW, en-US; light, dark) produced for the owner; no public
  release before the owner approves them.

### Key Entities

- **Session label**: per session; the host's working-directory last segment (optional), reported
  once; shown on the card and never logged.
- **Session colour**: per session; one of the rotation; assigned when the session is first seen by
  the worker; shown on the card and the group.
- **Session presentation state**: working / waiting / idle, plus last-activity time; derived from the
  worker's existing counts and records.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-116**: With two live sessions from different folders, a person who did not build the product
  can say which card belongs to which project and which one needs them, from the panel alone, in under
  10 seconds (checked by the owner on the screenshots).
- **SC-117**: In the panel with two sessions and two sites, no fact is stated twice (0 repeated
  statements, counted on the screenshots), and no internal identifier is visible outside the
  technical details.
- **SC-118**: In the tab strip, two sessions' groups differ in colour, and the one waiting for the
  owner carries the bell, in 10 of 10 gate runs.
- **SC-119**: A keystroke that opens a dialog is answered with the dialog on the first call in 10 of
  10 runs.
- **SC-120**: Every agent gate is green on the developer browser; the owner's branded-browser run and
  screenshot approval precede release.

## Assumptions

- The session's start time is the time the worker first saw the session's greeting; a worker restart
  keeps it from the session record.
- "Working" means at least one call of the session is in flight in the worker's count (the same count
  the interrupt control uses today).
- The colour rotation order is cyan, green, purple, pink, orange, grey, blue, assigned in order of
  sessions first seen in this browser run.
- The visible length for a folder label is about 24 characters on the card; the group title never
  carries the folder.
- The long and short pairing waits are today's (2 minutes / 45 seconds).
- Emoji in the group title render as the platform's glyphs; no fallback text is needed.

## Out of Scope

A favicon badge on held tabs; a spring-physics cursor; making the dispatch bound per call instead of
per dispatch; the old pairing timer left by a session reopen; tick "panel connected" flags after the
panel returns; macOS and Linux support; any change to what the buttons, modes or grants do.

## Traceability

| Decision | Requirements | Success criteria |
| --- | --- | --- |
| D-016-3 status row | FR-223 – FR-225 | SC-116, SC-117 |
| D-016-4 session identity | FR-226 – FR-229 | SC-116 |
| D-016-5 session state | FR-230 – FR-231 | SC-116 |
| D-016-6 session actions | FR-232 – FR-234 | SC-117 |
| D-016-7 site rows | FR-235 – FR-237 | SC-117 |
| D-016-8 tab strip | FR-238 – FR-241 | SC-118 |
| D-016-9 robustness | FR-242 – FR-244 | SC-119 |
| D-016-10 close-out | FR-245 – FR-247 | SC-120 |
