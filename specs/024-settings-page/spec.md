# Feature Specification: Settings Page

**Feature Branch**: `024-settings-page` (git: written on `feature-022-composer-attachments` after 023; a
branch of its own is cut when implementation starts)

**Feature Directory**: `specs/024-settings-page`

**Created**: 2026-10-24

**Status**: Draft. Every decision below was put to the owner on 2026-10-23 as Q7–Q12 and **confirmed by
the owner** ("都照建議"). The layout was chosen from three clickable prototypes (A, left navigation), then
revised at the owner's request and approved ("照建議").

**Input**: Owner, 2026-10-23, after the Hermes trial (023): preparing an agent (download, install, its own
setup, key variables, the optional browser component) happens today inside a conversation, where the owner
waits without knowing why. Agents should be prepared, checked and chosen in one place before they are used.

**Design source**: prototype A, revised — `.scratch/024-prototypes/a.html` with the screenshots
`.scratch/024-prototypes/_shots/a2-light.png`, `a2-dark-en.png` and `a2-375.png` (private, not shipped).
The prototype uses made-up data; the states it shows are the ones listed under User Stories.

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
- **D-024-4 — the site list moves to the settings page** (Q10): the sites the agents may act on, each with
  its mode (Ask / Follow a plan / Skip checks) and Revoke, are managed on the settings page. Consent cards
  stay in the side panel.
- **D-024-5 — browser tools shown, not managed** (Q11): the first version shows which agents can use
  Hallpass's browser tools and why not; it adds no other tool servers, no skills management and no key
  entry (keys stay with each agent).
- **D-024-6 — order** (Q12): after 023 (0.15.2); prototypes first (done), then this spec.
- **D-024-7 — layout A, revised**: a top bar (title, theme, language), a left navigation with four
  sections (Agents, Sites & permissions, Browser tools, Diagnostics) and a short summary, and the chosen
  section on the right. Each agent is a card that is one row when collapsed and shows its details when
  opened; cards that need the owner's attention start open.
- **D-024-8 — the default is set on the card only**: "Make default" sits on each agent's card. For an agent
  that is not ready and enabled it is shown greyed with its reason, not hidden.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See at a glance which agents are ready (Priority: P1)

The owner opens the settings page. Each agent appears as one row with its name, its state (Ready, Ready with
warnings, Needs a download, Downloading, Off, Not installed), whether it is the default and an Enabled
switch. Agents that need attention are already opened. The navigation shows how many agents are ready.

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
   percent and time left, and the collapsed row shows a small progress bar.
2. **Given** a download in progress, **When** the owner presses Cancel, **Then** it stops and the card
   returns to "Needs a download".
3. **Given** a download finishes, **Then** the card shows Ready and the owner is told once.
4. **Given** Hermes, **When** its card is open, **Then** it shows the setup steps (Git, the hermes command,
   the optional browser component, the key variable and a full browser restart) each marked found or not
   done, and no download button.
5. **Given** the owner closes the settings page during a download, **When** it is opened again, **Then** the
   download is still shown with its current progress.

---

### User Story 3 - Check that an agent really works (Priority: P1)

From an agent's card the owner presses Test and learns whether the agent starts, whether its model answers,
and whether it has the browser tools.

**Why this priority**: replaces discovering a problem in the middle of a conversation.

**Independent Test**: Test a working agent (pass, with the time the model took), an agent whose model is
unreachable (failure naming the model server), and Hermes without its browser component (partial pass
naming the missing component).

**Acceptance Scenarios**:

1. **Given** a ready agent, **When** the owner presses Test, **Then** the button shows it is testing and
   then a result line with the outcome and when it ran.
2. **Given** the test fails, **Then** the result says what failed in the owner's words (model server,
   missing component, key variable the browser cannot see) and what to do.
3. **Given** a test is running, **When** the owner leaves the card, **Then** the test continues and its result
   is there when the card is opened again.
4. **Given** an agent that is not ready or not enabled, **Then** Test is unavailable.

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
3. **Given** the default agent, **When** the owner switches it off, **Then** the default moves to the next
   ready, enabled agent and the owner is told; if none is left, the owner is told there is no default.
4. **Given** the side panel is open, **When** the owner changes agents on the settings page, **Then** the
   panel's picker reflects it for new conversations without a reload; conversations already open keep
   their agent.
5. **Given** an agent that is enabled but not ready, **When** the owner looks at the side panel's picker,
   **Then** it shows one line saying why and a link that opens the settings page at that agent.

---

### User Story 5 - Manage the sites agents may act on (Priority: P2)

The owner sees every site with its mode, changes a mode, and revokes a site, with a confirmation and the
chance to undo.

**Why this priority**: the list exists today in the side panel; moving it frees the panel for conversations.

**Independent Test**: change one site's mode, revoke another, undo the revoke; the side panel's consent
behaviour follows each change.

**Acceptance Scenarios**:

1. **Given** sites with modes, **When** the owner opens Sites & permissions, **Then** each site shows its
   mode and a one-line meaning of that mode.
2. **Given** a site, **When** the owner picks another mode, **Then** it applies at once and the owner is told.
3. **Given** a site, **When** the owner presses Revoke, **Then** a confirmation explains that agents will
   have to ask again; on confirming, the site is removed and an Undo is offered for a few seconds.
4. **Given** no sites, **Then** the section explains that agents ask in the side panel the first time.
5. **Given** an agent asks for a site, **Then** the consent card still appears in the side panel, not here.

---

### User Story 6 - See which agents can use the browser tools (Priority: P2)

The owner reads, for each agent, whether it can use Hallpass's browser tools and, if not, why.

**Independent Test**: the section lists the four agents with their status and reason, and offers no control.

**Acceptance Scenarios**:

1. **Given** the four agents, **Then** Claude shows available, Codex available (or "after the helper
   download"), Hermes "needs its browser component" until it has it, DeepSeek "not supported".
2. **Given** the section, **Then** it states it is read-only in this version.

---

### User Story 7 - Read what an agent last said about itself (Priority: P3)

When something goes wrong, the owner opens an agent's last output from its card or from Diagnostics, reads
it, and can copy it for someone helping.

**Independent Test**: show, hide and copy an agent's last lines; keys, tokens and user paths never appear.

**Acceptance Scenarios**:

1. **Given** an agent, **When** the owner presses "Show last lines", **Then** the lines are read at that
   moment and shown with the time they were read; nothing is read before the owner asks.
2. **Given** the lines, **Then** no key value, token or user path appears in them.
3. **Given** the owner presses Copy, **Then** the shown lines are copied and the owner is told.
4. **Given** the agent has printed nothing, **Then** the section says so.

### Edge Cases

- The local helper program is not installed or not reachable: the page opens, says what is missing and how
  to fix it, and shows what it can (sites, browser tool status) without the agent checks.
- The page is opened twice: both stay in step; a download started in one shows in the other.
- An agent is switched off while downloading: the download keeps its result, the agent stays off.
- A download fails (network, disk): the card says so in the owner's words and offers to try again.
- The owner changes the default while a conversation is running: that conversation keeps its agent.
- A narrow window (375 px wide): every section is usable without sideways scrolling; the navigation becomes
  a row across the top.
- Language or theme changed: the page follows at once; the choice is the same one the side panel uses.
- Test result for an agent whose state changed since: the result line stays, marked with its time.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-375**: Hallpass MUST provide a settings page that opens in a full browser tab, works without network,
  and is reachable from the side-panel menu, from the side panel's agent picker and from the browser's
  extension options (D-024-1).
- **FR-376**: The page MUST have four sections — Agents, Sites & permissions, Browser tools, Diagnostics —
  with a navigation that shows the ready-agent count, the site count and a mark when an agent has a
  warning, plus a summary of ready, downloading, needing attention and warned agents (D-024-7).
- **FR-377**: Each agent MUST appear as a card that is one row when collapsed (name, state, default mark or
  "Make default", Enabled switch, and while relevant a small progress bar or a warning count) and shows its
  details when opened; cards needing a download or with warnings MUST start open (D-024-7).
- **FR-378**: An opened card MUST show the agent's version (and that Hermes is installed by the owner), its
  checks — prerequisites, model server, browser tools, accepted attachments (images, tab, files) — its
  notes and warnings in the owner's words, its main action and Test (D-024-3, D-024-7).
- **FR-379**: Downloads and installs Hallpass performs for an agent MUST run from its card with progress,
  percent, time left and Cancel; they MUST continue if the page is closed and show their current state when
  it is reopened; the owner MUST be told once when one finishes or fails (D-024-3).
- **FR-380**: Hermes' card MUST show its setup steps, each marked found or not done from a check of the
  owner's machine, and "Check again"; Hallpass MUST NOT download, install or update Hermes (D-024-3,
  D-021-3).
- **FR-381**: Test MUST start the agent, ask its model for a short answer and report, in the owner's words,
  whether it passed, how long the model took, and what failed (model server, browser tools, key variable
  the browser cannot see) with what to do (D-024-3; builds on 023).
- **FR-382**: The Enabled switch and "Make default" MUST decide which agents the side panel offers and which
  is preselected; only a ready, enabled agent may be the default; for other agents "Make default" MUST be
  shown greyed with its reason (D-024-2, D-024-8).
- **FR-383**: Switching off the default agent MUST move the default to the next ready, enabled agent and
  tell the owner, or tell the owner that no agent can be the default (D-024-2).
- **FR-384**: The side panel's agent picker MUST list enabled agents, preselect the default for a new
  conversation, follow settings changes without a reload, and for an enabled agent that is not ready show
  one line saying why with a link that opens the settings page at that agent; it MUST NOT start downloads
  itself (D-024-2, D-024-3).
- **FR-385**: Sites & permissions MUST list every site with its mode and the mode's meaning, apply a mode
  change at once, and revoke only after confirmation with an Undo offered afterwards; the side panel MUST
  keep its consent cards and no longer carry the site list (D-024-4).
- **FR-386**: Browser tools MUST show, read-only, for each agent whether it can use Hallpass's browser
  tools and the reason when not (D-024-5).
- **FR-387**: An agent's last output MUST be read only when the owner asks, shown with the time it was read,
  copyable, and free of key values, tokens and user paths (D-024-7; builds on 023's kept lines).
- **FR-388**: The page MUST NOT ask for, show or store any API key or key value; key variables are named
  only, as in 023 (D-024-5, D-023-6).
- **FR-389**: All new text MUST exist in English and zh-TW; the page MUST follow the side panel's language
  and theme (System / Light / Dark) and meet the 006/020 keyboard and screen-reader bar, with visible focus
  and every control reachable by keyboard.
- **FR-390**: At a width of 375 px every section MUST be usable without sideways scrolling.
- **FR-391**: Conversations already open, and Claude and Codex conversations in general, MUST behave as
  before apart from where their agent list and default now come from (FR-384).

### Key Entities

- **Agent settings**: per agent — enabled or not; plus which agent is the default. Kept with the extension
  and shared by the settings page and the side panel.
- **Agent readiness**: per agent — state (ready, ready with warnings, needs a download, downloading, off,
  not installed), version, check results, warnings, download progress. Known to the local helper program
  and shown by both pages.
- **Test result**: per agent — outcome, model answer time, what failed, when it ran.
- **Site entry**: a site with its mode (unchanged from today; only where it is managed moves).

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

## Assumptions

- The local helper program (broker/host) is the one that already downloads adapters and runs agents; the
  settings page asks it for readiness, downloads and tests. When it is not reachable the page says so.
- Enabled/default choices are stored with the extension, so they survive browser restarts.
- Test uses the agent's own model and therefore costs one short model call; it runs only when pressed.
- The prototype's numbers (≈40 MB helper, ≈5–6 min DeepSeek install) are today's figures, shown as estimates.
- The side panel's existing site list and download prompts are removed once the page has them (FR-384,
  FR-385); 023's notices in conversations stay.
- Out of scope: custom tool servers, skills management, API keys, accounts, shortcuts and schedules,
  per-conversation choices (model and permission mode stay in the side panel), starting agents ahead of
  time, Hermes installation.
