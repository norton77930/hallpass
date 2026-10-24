# Feature Specification: Settings Page

**Feature Branch**: `024-settings-page` (git: first written on `feature-022-composer-attachments` after
023, 4c7d4e5; revised on `worktree-feature-024-settings-page` from main 68b78ec)

**Feature Directory**: `specs/024-settings-page`

**Created**: 2026-10-24

**Status**: Draft, revised 2026-10-24. D-024-1..8 were put to the owner on 2026-10-23 as Q7–Q12 and
**confirmed by the owner** ("都照建議"). The layout was chosen from three clickable prototypes (A, left
navigation), then revised at the owner's request and approved ("照建議"). A second grilling round on
2026-10-24 (Q1–Q10 of that day) settled D-024-9..18 and amended D-024-4 and D-024-5; the owner accepted
every recommendation ("全部照建議").

**Input**: Owner, 2026-10-23, after the Hermes trial (023): preparing an agent (download, install, its own
setup, key variables, the optional browser component) happens today inside a conversation, where the owner
waits without knowing why. Agents should be prepared, checked and chosen in one place before they are used.

**Design source**: prototype A, revised 2026-10-24 — `.scratch/024-prototypes-rev/a.html` (private, not
shipped; the 2026-10-23 version and its screenshots `a2-light.png`, `a2-dark-en.png`, `a2-375.png` stay in
the 023 worktree's `.scratch/024-prototypes/`). The side panel's before/after is drawn in the owner's
comparison page of 2026-10-24. The prototype uses made-up data; the states it shows are the ones listed
under User Stories.

**Decisions (D-024-n, confirmed by the owner)**:

- **D-024-1 — a settings page** (Q7): Hallpass gets its own settings page, part of the extension, that
  opens in a full browser tab and needs no network. It opens from the side-panel menu, from the agent
  picker in the side panel, and from the browser's own "extension options".
- **D-024-2 — who chooses the agent** (Q8): the settings page decides which agents are enabled and which
  one is the default. The side panel still lets the owner pick any enabled, ready agent for each
  conversation, with the default preselected. An agent that is not ready shows a one-line reason and a link
  to the settings page.
- **D-024-3 — preparing agents moves to the settings page** (Q9): downloads and installs (an agent's
  adapter or helper, DeepSeek's first install of about 5–6 minutes) run on the settings page with progress,
  time left and Cancel. When the side panel meets an agent that needs a download, it shows only a link to
  the settings page. Hermes stays owner-installed (D-021-3): its card shows its setup steps, marks each as
  found or not done, and offers "Check again"; Hallpass never downloads or updates Hermes.
- **D-024-4 — standing permissions move to the settings page** (Q10, amended 2026-10-24 by D-024-11):
  the sites the agents may act on, each with its mode (Ask / Follow a plan / Skip checks) and Revoke, the
  upload folders, and the paired outside agents with Unpair, are managed on the settings page. Consent
  cards and site-plan cards stay in the side panel.
- **D-024-5 — browser tools shown, not managed** (Q11, amended 2026-10-24 by D-024-13): the first version
  shows which agents can use Hallpass's browser tools and why not. Its one control is the switch that lets
  side-panel agents use the browser tools at all (moved from the side panel). It adds no other tool
  servers, no skills management and no key entry (keys stay with each agent).
- **D-024-6 — order** (Q12): after 023 (0.15.2); prototypes first (done), then this spec.
- **D-024-7 — layout A, revised**: a top bar (title, theme, language), a left navigation with four
  sections (Agents, Sites & permissions, Browser tools, Connection & diagnostics) and a short summary, and
  the chosen section on the right. Each agent is a card that is one row when collapsed and shows its details
  when opened; cards that need the owner's attention start open.
- **D-024-8 — the default is set on the card only**: "Make default" sits on each agent's card. For an agent
  that is not ready and enabled it is shown greyed with its reason, not hidden.
- **D-024-9 — a download outlives the page, not the browser** (2026-10-24 Q1): closing the settings page
  does not stop a download; reopening shows its progress. Closing the browser stops it; the card then says
  the last download was interrupted and offers to try again. While a download runs, the local helper
  program does not count as idle and does not shut itself down. A Hallpass that keeps running without the
  browser is rejected because it would undo 019 Q4 (the helper lives with the browser).
- **D-024-10 — Test asks the model, apart from conversations** (2026-10-24 Q2): Test starts a short-lived
  copy of the agent of its own, asks its model for a short answer, then stops it; conversations already
  running are not touched. The button says it makes one model call. A check-only Test is rejected because
  it misses an unreachable model server, the failure of the Hermes trial.
- **D-024-11 — the side panel keeps what happens now, the page keeps the rules** (2026-10-24 Q3a, Q4):
  the side panel's "Connections & sites" tab becomes "Sessions" and keeps only the connection state (with
  the not-connected view and Retry) and the session cards (Stop, Interrupt, Release tabs, Withdraw plan).
  The site list, the upload folders, the paired outside agents with Unpair, the browser's name with Rename,
  and the side-panel-agent switch move to the settings page. Removing the tab is rejected: a session's Stop
  must stay one press away during a run.
- **D-024-12 — a way from a session to its site** (2026-10-24 Q3b): a session card that is acting on a site
  carries "Manage this site's permissions ↗", which opens the settings page at Sites & permissions with that
  site marked. A per-site control in the side panel is rejected to keep the panel free of standing rules.
- **D-024-13 — the side-panel-agent switch lives under Browser tools** (2026-10-24 Q3c): the switch from
  019 FR-309 ("side-panel agents may use this browser") moves to the Browser tools section and is that
  section's only control.
- **D-024-14 — an agent's state says how ready it is** (2026-10-24 Q5): the states are Ready, Ready with
  warnings, Needs a download, Downloading, Not installed. Whether an agent is on is shown by its Enabled
  switch alone; a switched-off card is shown dimmed with its readiness state kept.
- **D-024-15 — the default falls back in a fixed order** (2026-10-24 Q6): when the default agent is
  switched off, the default moves to the first ready, enabled agent in the order Claude, Codex, Hermes,
  DeepSeek, and the owner is told which one.
- **D-024-16 — choices per browser, readiness per computer** (2026-10-24 Q7): each browser connected to
  the same computer keeps its own enabled agents and default. Readiness, downloads and test results come
  from the local helper program and are the same in every browser: an agent downloaded from one browser
  shows ready in the others.
- **D-024-17 — Connection & diagnostics** (2026-10-24 Q8, Q9): the fourth section shows whether the local
  helper program is connected, the extension's and the helper's versions and whether they match, the
  browsers connected to the same computer, this browser's name with Rename (the section's only control)
  and a Copy of these details; under them, each agent's last output (D-024-7). The paired outside agents
  open the Sites & permissions section as its first block, "Outside agents that may drive this browser",
  because pairing is a standing permission like a site's mode.
- **D-024-18 — the Sessions tab when nothing runs** (2026-10-24 Q10): with no session, the Sessions tab
  shows the connection state, one line saying no agent is acting on this browser, and a link to the
  settings page. The tab's waiting count is unchanged.
- **D-024-20 — one appearance choice for both pages** (2026-10-24, plan Q-A): the side panel has no theme
  or language choice today (it follows the system and the browser). The settings page's top bar gets one
  choice of theme (System / Light / Dark) and language (System / English / 繁體中文), default System, which
  the side panel follows too. Keeping no controls was rejected because the prototype's top bar and FR-389
  assumed a choice.
- **D-024-21 — upload folders: Remove only** (2026-10-24, plan Q-B): a folder still joins the list only when
  an agent asks to upload from it and the owner agrees (014). The page lists the folders with Remove and says
  so. An Add folder action was rejected: an extension page cannot learn a folder's path, so the helper would
  have to open a Windows folder dialog — a new way to widen what agents may upload.
- **D-024-19 — readiness is a local check; only Test costs a call** (2026-10-24, after reading how an
  open-source slide tool reports its Claude Code and Codex connection): an agent's state comes from checks
  on this computer only — whether its program and adapter are found and the version each reports, read
  with a short time limit and kept until something changes. Opening the page or a card never makes a model
  call; the model server is checked only by Test (D-024-10). A Windows command shim that cannot be started
  directly does not count as found.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See at a glance which agents are ready (Priority: P1)

The owner opens the settings page. Each agent appears as one row with its name, its state (Ready, Ready with
warnings, Needs a download, Downloading, Not installed), whether it is the default and an Enabled switch.
Agents that need attention are already opened. The navigation shows how many agents are ready.

**Why this priority**: the trial's main problem was not knowing whether an agent could work before using it.

**Independent Test**: with four agents in four different states, open the page; every state is readable
without opening a card, the cards needing attention are open, and the summary counts match.

**Acceptance Scenarios**:

1. **Given** Claude ready, Codex needing its helper, Hermes ready with two warnings and DeepSeek
   downloading, **When** the owner opens the page, **Then** each row shows its state; Codex and Hermes are
   open; DeepSeek's collapsed row shows its progress; Hermes' row shows "2 warnings".
2. **Given** the same state, **Then** the navigation says "1 of 4 agents ready" (plus downloading, needing
   attention and warning counts) and the Agents entry shows a warning mark.
3. **Given** a collapsed card, **When** the owner activates the agent's name, **Then** the card opens and
   shows version, checks, notes, actions and the last output control; activating it again closes it.
4. **Given** an agent the owner switched off, **Then** its row keeps its readiness state, is shown dimmed,
   and its Enabled switch is off (D-024-14).

---

### User Story 2 - Prepare an agent before using it (Priority: P1)

The owner downloads what an agent needs from its card and watches it finish there; Hermes' card guides
the owner through its own setup.

**Why this priority**: moves the long waits out of conversations (D-024-3).

**Independent Test**: start a download from a card, see progress and time left, cancel it, start it again
and let it finish; the agent becomes Ready. On Hermes' card, each setup step shows found or not done and
"Check again" refreshes them.

**Acceptance Scenarios**:

1. **Given** an agent that needs a download, **When** the owner starts it, **Then** the card shows progress,
   percent and time left, a line saying closing the page does not stop it and closing the browser does, and
   the collapsed row shows a small progress bar.
2. **Given** a download in progress, **When** the owner presses Cancel, **Then** it stops and the card
   returns to "Needs a download".
3. **Given** a download finishes, **Then** the card shows Ready and the owner is told once.
4. **Given** Hermes, **When** its card is open, **Then** it shows the setup steps (Git, the hermes command,
   the optional browser component, the key variable and a full browser restart) each marked found or not
   done, and no download button.
5. **Given** the owner closes the settings page during a download, **When** it is opened again, **Then** the
   download is still shown with its current progress.
6. **Given** the owner closes the browser during a download, **When** the browser and the page are opened
   again, **Then** the card says the last download was interrupted and offers to try again (D-024-9).
7. **Given** a download runs for longer than the helper's idle time, **Then** the helper keeps running
   until the download ends (D-024-9).

---

### User Story 3 - Check that an agent really works (Priority: P1)

From an agent's card the owner presses Test and learns whether the agent starts, whether its model answers,
and whether it has the browser tools.

**Why this priority**: replaces discovering a problem in the middle of a conversation.

**Independent Test**: Test a working agent (pass, with the time the model took), an agent whose model is
unreachable (failure naming the model server), and Hermes without its browser component (partial pass
naming the missing component).

**Acceptance Scenarios**:

1. **Given** a ready agent, **Then** its Test button says it makes one model call; **When** the owner
   presses it, **Then** the button shows it is testing and then a result line with the outcome and when it
   ran.
2. **Given** the test fails, **Then** the result says what failed in the owner's words (model server,
   missing component, key variable the browser cannot see) and what to do.
3. **Given** a test is running, **When** the owner leaves the card, **Then** the test continues and its result
   is there when the card is opened again.
4. **Given** an agent that is not ready or not enabled, **Then** Test is unavailable.
5. **Given** a conversation with the same agent is running in the side panel, **When** the owner presses
   Test, **Then** the test runs on a copy of its own and the conversation's process, turn and history are
   unchanged; the test's copy is gone when the result shows (D-024-10).

---

### User Story 4 - Choose which agents the side panel offers and the default (Priority: P1)

The owner switches agents on or off and makes one the default. The side panel offers only enabled, ready
agents, with the default preselected.

**Why this priority**: the owner's first message should go to a working agent without choosing.

**Independent Test**: disable DeepSeek and make Hermes the default; the side panel's picker lists only the
enabled, ready agents with Hermes preselected in a new conversation.

**Acceptance Scenarios**:

1. **Given** a ready, enabled agent, **When** the owner presses "Make default" on its card, **Then** it
   becomes the default, its card shows "Default", and the previous default's card shows "Make default".
2. **Given** an agent that is not ready or not enabled, **Then** "Make default" is greyed and says why.
3. **Given** Claude is the default and Codex is not ready, **When** the owner switches Claude off, **Then**
   the default moves to Hermes if it is ready and enabled (order Claude, Codex, Hermes, DeepSeek) and the
   owner is told "Default agent is now Hermes"; if none is left, the owner is told there is no default
   (D-024-15).
4. **Given** the side panel is open, **When** the owner changes agents on the settings page, **Then** the
   panel's picker reflects it for new conversations without a reload; conversations already open keep
   their agent.
5. **Given** an agent that is enabled but not ready, **When** the owner looks at the side panel's picker,
   **Then** it shows one line saying why and a link that opens the settings page at that agent.
6. **Given** two browsers on the same computer, **When** the owner makes Hermes the default in one,
   **Then** the other browser's default is unchanged; **When** DeepSeek finishes downloading in one,
   **Then** it shows Ready in both (D-024-16).

---

### User Story 5 - Manage what agents may do in this browser (Priority: P2)

On Sites & permissions the owner sees the paired outside agents, every site with its mode, and the upload
folders; changes a mode; revokes a site with a confirmation and the chance to undo; unpairs an outside
agent; and edits the upload folders.

**Why this priority**: these lists exist today in the side panel; moving them frees the panel for what is
happening now (D-024-11).

**Independent Test**: change one site's mode, revoke another, undo the revoke, unpair one outside agent and
remove one upload folder; the side panel's consent behaviour follows each change.

**Acceptance Scenarios**:

1. **Given** paired outside agents, **When** the owner opens Sites & permissions, **Then** its first block
   lists them with where they connected from and when, each with Unpair; unpairing one means it asks again
   next time.
2. **Given** sites with modes, **Then** each site shows its mode and a one-line meaning of that mode.
3. **Given** a site, **When** the owner picks another mode, **Then** it applies at once and the owner is told.
4. **Given** a site, **When** the owner presses Revoke, **Then** a confirmation explains that agents will
   have to ask again; on confirming, the site is removed and an Undo is offered for a few seconds.
5. **Given** no sites, **Then** the section explains that agents ask in the side panel the first time.
6. **Given** upload folders, **Then** they are listed with Remove, with the same effect as today's
   side-panel row (014), and a line saying a folder is added when an agent asks to upload from it
   (D-024-21).
7. **Given** an agent asks for a site, **Then** the consent card still appears in the side panel, not here.
8. **Given** a session card in the side panel acting on a site, **When** the owner presses "Manage this
   site's permissions ↗", **Then** the settings page opens at Sites & permissions with that site marked
   (D-024-12).

---

### User Story 6 - See which agents can use the browser tools (Priority: P2)

The owner reads, for each agent, whether it can use Hallpass's browser tools and, if not, why; and decides
whether side-panel agents may use the browser tools at all.

**Independent Test**: the section lists the four agents with their status and reason; the side-panel-agent
switch is its only control and has the same effect as today's switch in the side panel.

**Acceptance Scenarios**:

1. **Given** the four agents, **Then** Claude shows available, Codex available (or "after the helper
   download"), Hermes "needs its browser component" until it has it, DeepSeek "not supported".
2. **Given** the section, **Then** it shows the switch "Let side-panel agents use the browser tools" above
   the list and states that the list is read-only in this version (D-024-13).
3. **Given** the owner turns the switch off, **Then** side-panel conversations can only chat and outside
   agents are not affected, as with 019 FR-309.

---

### User Story 7 - See the connection and what an agent last said (Priority: P3)

When something goes wrong, the owner opens Connection & diagnostics: whether the helper is connected, the
versions, the browsers on this computer and this browser's name; and each agent's last output, which can be
copied for someone helping.

**Independent Test**: read the connection block, rename this browser, show, hide and copy an agent's last
lines; keys, tokens and user paths never appear.

**Acceptance Scenarios**:

1. **Given** the section, **Then** it shows the helper's connection, the extension's and the helper's
   versions and whether they match, and the browsers connected to this computer with this one marked.
2. **Given** this browser's name, **When** the owner renames it, **Then** the new name is what agents see
   when choosing between browsers (018) and the owner is told.
3. **Given** Copy connection details, **Then** the connection block is copied without user paths.
4. **Given** an agent, **When** the owner presses "Show last lines", **Then** the lines are read at that
   moment and shown with the time they were read; nothing is read before the owner asks.
5. **Given** the lines, **Then** no key value, token or user path appears in them.
6. **Given** the owner presses Copy, **Then** the shown lines are copied and the owner is told.
7. **Given** the agent has printed nothing, **Then** the section says so.

---

### User Story 8 - The side panel shows what is happening now (Priority: P2)

The side panel has two tabs, Conversation and Sessions. Sessions shows the connection state and the session
cards; the standing permissions are on the settings page.

**Why this priority**: the panel is where the owner watches and stops a run; it should carry nothing else
(D-024-11).

**Independent Test**: with one outside session acting on a site, the Sessions tab shows the connection and
that session with Stop and the permissions link, and no site list, upload folders, browser name or
side-panel-agent switch; with no session it shows the empty line and the settings link.

**Acceptance Scenarios**:

1. **Given** the side panel, **Then** its tabs are Conversation and Sessions; Sessions holds the connection
   state, the not-connected view with Retry, and the session cards with Stop, Interrupt, Release tabs and
   Withdraw plan, unchanged in behaviour.
2. **Given** a session acting on a site, **Then** its card shows "Manage this site's permissions ↗".
3. **Given** no session, **Then** Sessions shows the connection state, "No agent is acting on this browser"
   and a link to the settings page (D-024-18).
4. **Given** something waiting for the owner, **Then** the Sessions tab shows its count while the other tab
   is shown, as before (019 FR-284).
5. **Given** consent and site-plan cards, **Then** they still show above both tabs (019 FR-283).

### Edge Cases

- The local helper program is not installed or not reachable: the page opens, says what is missing and how
  to fix it, and shows what it can (the browser's own settings, browser tool status) without the agent
  checks; standing permissions kept by the helper (upload folders) say they cannot be shown until it is.
- The page is opened twice: both stay in step; a download started in one shows in the other.
- An agent is switched off while downloading: the download keeps its result, the agent stays off.
- A download fails (network, disk): the card says so in the owner's words and offers to try again.
- The browser is closed during a download: the card says the download was interrupted (D-024-9).
- The owner changes the default while a conversation is running: that conversation keeps its agent.
- Test is pressed while a conversation of that agent runs: the conversation is untouched (D-024-10).
- Two browsers on the same computer: each keeps its own enabled agents and default; readiness, downloads and
  test results are shared (D-024-16).
- The site named by a session card's link was revoked meanwhile: the page opens at Sites & permissions and
  says the site is no longer in the list.
- A narrow window (375 px wide): every section is usable without sideways scrolling; the navigation becomes
  a row across the top.
- Language or theme changed: the page follows at once; the choice is the same one the side panel uses.
- Test result for an agent whose state changed since: the result line stays, marked with its time.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-375**: Hallpass MUST provide a settings page that opens in a full browser tab, works without network,
  and is reachable from the side-panel menu, from the side panel's agent picker and from the browser's
  extension options (D-024-1).
- **FR-376**: The page MUST have four sections — Agents, Sites & permissions, Browser tools, Connection &
  diagnostics — with a navigation that shows the ready-agent count, the site count and a mark when an agent
  has a warning, plus a summary of ready, downloading, needing attention and warned agents (D-024-7,
  D-024-17).
- **FR-377**: Each agent MUST appear as a card that is one row when collapsed (name, state, default mark or
  "Make default", Enabled switch, and while relevant a small progress bar or a warning count) and shows its
  details when opened; cards needing a download or with warnings MUST start open. The state MUST be one of
  Ready, Ready with warnings, Needs a download, Downloading, Not installed; a switched-off agent keeps its
  state and is shown dimmed (D-024-7, D-024-14).
- **FR-378**: An opened card MUST show the agent's version (and that Hermes is installed by the owner), its
  checks — prerequisites, model server, browser tools, accepted attachments (images, tab, files) — its
  notes and warnings in the owner's words, its main action and Test (D-024-3, D-024-7).
- **FR-379**: Downloads and installs Hallpass performs for an agent MUST run from its card with progress,
  percent, time left and Cancel; they MUST continue if the page is closed and show their current state when
  it is reopened; the owner MUST be told once when one finishes or fails. Closing the browser MUST stop a
  download, and the card MUST then say it was interrupted and offer to try again; while a download runs the
  local helper program MUST NOT end itself for being idle (D-024-3, D-024-9).
- **FR-380**: Hermes' card MUST show its setup steps, each marked found or not done from a check of the
  owner's machine, and "Check again"; Hallpass MUST NOT download, install or update Hermes (D-024-3,
  D-021-3).
- **FR-381**: Test MUST say beside its button that it makes one model call; it MUST start a short-lived copy
  of the agent of its own, ask its model for a short answer, stop that copy, and report, in the owner's
  words, whether it passed, how long the model took, and what failed (model server, browser tools, key
  variable the browser cannot see) with what to do. It MUST NOT change any running conversation (D-024-10;
  builds on 023).
- **FR-382**: The Enabled switch and "Make default" MUST decide which agents the side panel offers and which
  is preselected; only a ready, enabled agent may be the default; for other agents "Make default" MUST be
  shown greyed with its reason (D-024-2, D-024-8).
- **FR-383**: Switching off the default agent MUST move the default to the first ready, enabled agent in the
  order Claude, Codex, Hermes, DeepSeek and tell the owner which one, or tell the owner that no agent can be
  the default (D-024-2, D-024-15).
- **FR-384**: The side panel's agent picker MUST list enabled agents, preselect the default for a new
  conversation, follow settings changes without a reload, and for an enabled agent that is not ready show
  one line saying why with a link that opens the settings page at that agent; it MUST NOT start downloads
  itself (D-024-2, D-024-3).
- **FR-385**: Sites & permissions MUST show, in this order, the paired outside agents with where and when
  they last connected and Unpair; every site with its mode and the mode's meaning, applying a mode change at
  once and revoking only after confirmation with an Undo offered afterwards; and the upload folders with
  Remove and a line saying folders are added when an agent asks (D-024-21). Each MUST behave as its side-panel counterpart did before this feature (004, 006,
  014, 016) (D-024-4, D-024-11, D-024-17).
- **FR-386**: Browser tools MUST show, read-only, for each agent whether it can use Hallpass's browser
  tools and the reason when not, and MUST carry the switch that lets side-panel agents use the browser
  tools, with the effect of 019 FR-309 (D-024-5, D-024-13).
- **FR-387**: An agent's last output MUST be read only when the owner asks, shown with the time it was read,
  copyable, and free of key values, tokens and user paths (D-024-7; builds on 023's kept lines).
- **FR-388**: The page MUST NOT ask for, show or store any API key or key value; key variables are named
  only, as in 023 (D-024-5, D-023-6).
- **FR-389**: All new text MUST exist in English and zh-TW; the page's top bar MUST carry one appearance
  choice — theme (System / Light / Dark) and language (System / English / 繁體中文), System by default —
  that the page and the side panel both follow at once (D-024-20); the page MUST meet the 006/020 keyboard and screen-reader bar, with visible focus
  and every control reachable by keyboard.
- **FR-390**: At a width of 375 px every section MUST be usable without sideways scrolling.
- **FR-391**: Conversations already open, and conversations with every agent in general, MUST behave as
  before apart from where their agent list and default now come from (FR-384).
- **FR-392**: The side panel's tabs MUST be Conversation and Sessions. Sessions MUST hold the connection
  state, the not-connected view with Retry, and the session cards with their actions, unchanged in
  behaviour; it MUST NOT hold the site list, the upload folders, the paired-agent list with Unpair, the
  browser's name or the side-panel-agent switch. Consent and site-plan cards stay above both tabs (D-024-11;
  supersedes the second sentence of 019 FR-282).
- **FR-393**: A session card acting on a site MUST offer "Manage this site's permissions ↗", opening the
  settings page at Sites & permissions with that site marked, or saying it is no longer listed (D-024-12).
- **FR-394**: With no session, the Sessions tab MUST show the connection state, one line saying no agent is
  acting on this browser, and a link to the settings page (D-024-18).
- **FR-395**: Connection & diagnostics MUST show whether the local helper program is connected, the
  extension's and helper's versions and whether they match, the browsers connected to this computer with
  this one marked, and this browser's name with Rename (with the effect of 018's rename); it MUST offer to
  copy these details without user paths (D-024-17).
- **FR-396**: Enabled agents and the default MUST be kept per browser; readiness, download progress and test
  results MUST come from the local helper program and be the same in every browser on the computer
  (D-024-16).
- **FR-397**: An agent's state and versions MUST come from local checks only (program and adapter found,
  version each reports) with a time limit of at most 5 s per check and the result kept until the owner
  presses Check again, a download or install finishes, or the page reopens; opening the page or a card
  MUST NOT call any model (D-024-19).

### Key Entities

- **Agent settings**: per browser — which agents are enabled, and which one is the default. Kept with the
  extension in that browser and shared by its settings page and side panel.
- **Agent readiness**: per agent on the computer — state (ready, ready with warnings, needs a download,
  downloading, not installed), version, check results, warnings, download progress, last interrupted
  download. Known to the local helper program and shown by every browser's pages.
- **Test result**: per agent on the computer — outcome, model answer time, what failed, when it ran.
- **Site entry**: a site with its mode (unchanged from today; only where it is managed moves).
- **Paired outside agent**, **upload folder**, **browser name**, **side-panel-agent consent**: unchanged
  from 004/014/018/019; only where they are managed moves.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-169**: With the owner's four agents in mixed states, the owner can tell which are ready, which need
  something and what, within 10 seconds of opening the page, without opening any card.
- **SC-170**: The owner can prepare an agent that needs a download and confirm it works with Test without
  starting a conversation.
- **SC-171**: A first message in a new conversation goes to the default agent with no agent choice needed,
  in 100% of cases where a default exists.
- **SC-172**: No conversation starts a download or install; the side panel only links to the settings page.
- **SC-173**: Every control on the page can be reached and used with the keyboard alone, in both languages
  and both themes, and at 375 px width.
- **SC-174**: No key value appears in anything the page shows, copies or keeps (checked by searching for the
  value after the tests).
- **SC-175**: From a running session's card, the owner reaches that site's row on the settings page in one
  press, and stops the session in one press without leaving the side panel.
- **SC-176**: A Test pressed during a conversation with the same agent leaves that conversation's
  messages and turn unchanged in 100% of runs.
- **SC-177**: Opening the settings page and every card makes zero model calls; each agent's state shows
  within 5 s of opening even when one agent's program does not answer.

## Assumptions

- The local helper program (broker/host) is the one that already downloads adapters and runs agents; the
  settings page asks it for readiness, downloads and tests. When it is not reachable the page says so.
- Enabled/default choices are stored with the extension, so they survive browser restarts.
- Test uses the agent's own model and therefore costs one short model call; it runs only when pressed and
  the button says so (D-024-10).
- The prototype's numbers (≈40 MB helper, ≈5–6 min DeepSeek install) are today's figures, shown as estimates.
- The side panel's site list, upload folders, paired-agent list, browser name, side-panel-agent switch and
  download prompts are removed once the page has them (FR-384, FR-385, FR-392); 023's notices in
  conversations stay.
- Out of scope: custom tool servers, skills management, API keys, accounts, shortcuts and schedules,
  per-conversation choices (model and permission mode stay in the side panel), starting agents ahead of
  time, Hermes installation, a Hallpass helper that runs without the browser.

## Change log

- **2026-10-24 — second grilling round** (Q1–Q10 of 2026-10-24, owner "全部照建議"): added D-024-9..18,
  FR-392..396, SC-175..176 and User Story 8; amended D-024-4 (all standing permissions move, not only
  sites), D-024-5 (the side-panel-agent switch is the one control under Browser tools), D-024-7 (fourth
  section renamed Connection & diagnostics), FR-376, FR-377 (no Off state), FR-379, FR-381, FR-383, FR-385,
  FR-386, FR-391 (wording: every agent, not only Claude and Codex). Supersedes the second sentence of
  019 FR-282 (see 019's change log).
- **2026-10-24 — readiness check** (owner agreed to point 1 of the open-slide comparison): added D-024-19,
  FR-397 and SC-177; Test (D-024-10) stays the only check that calls a model.
- **2026-10-24 — plan questions** (owner: Q-B "A", the rest as recommended): added D-024-20 (one
  appearance choice) and D-024-21 (upload folders Remove only); amended FR-385, FR-389 and User Story 5
  scenario 6.
- **2026-10-24 — e2e gate findings** (FR-385 "as its side-panel counterpart did", FR-393): the settings
  page's site rows carry the diagnostics grant (004 FR-049; `ui.agent.set-diagnostics` joins the settings
  command union, and Undo after a revoke restores the grant if it was on) and who changed the site last
  (019 FR-308); the upload folders show the list file's path (014 FR-191); the worker's session cards
  carry `site`, the main tab's canonical origin. frames.md and data-model.md amended.
- **2026-10-25 — slow `--version`** (T794: the real Hermes answers in 6-11 s): a found program whose
  `--version` timed out at 5 s shows Not installed with the timed-out reason first. It is then retried
  once in the background at the launch bound (15 s), and an answer updates the settings page and side
  panel. SC-177 is unchanged. See R-374's amendment.
