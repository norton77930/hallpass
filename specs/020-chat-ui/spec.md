# Feature Specification: A Side-Panel Conversation That Reads Like an Agent

**Feature Branch**: `020-chat-ui` (git: `feature-020-chat-ui`, from `main` after 0.13.1)

**Feature Directory**: `specs/020-chat-ui`

**Created**: 2026-10-21

**Status**: Draft written under the owner's delegation of 2026-10-20 ("有問題妳可以先依照你建議的決策,
然後進入開發階段, 但明天早上要跟我說明"): every decision below is the recommendation the owner accepted in the
2026-10-20 grilling (G4–G19, G26); the palette is a provisional pick the owner confirms on the mockup.

**Input**: Owner, 2026-10-20, after the 0.13.0 release: the Conversation tab "完全沒設計過 讓人不想使用" and
should look like an agent; "要連上 Agent 的時候 為什麼還需要選擇是哪個 Agent?" — the owner wants to type
first, not pick an agent first. Target release 0.14.0 (G23).

**Owner decisions (2026-10-20 grilling, recorded here as D-020-n)**:

- **D-020-1 — composer first** (option ①): the Conversation tab opens on an empty conversation with the
  message box ready. Agent, folder and mode are chips under the message box. The agent chip defaults to
  the agent used last, else the only ready agent, else the first in the list (G18). The first-use card
  (019 Story 3) appears only when the owner sends to an agent whose connector is not yet fetched; after
  the one click the message is sent (G18, D-019-14).
- **D-020-2 — own look** (G4, G6, G12, G13): Hallpass gets its own design tokens for the whole panel
  (neutral greys plus one accent, light and dark, following the system setting). No colour, font,
  token name, asset or class list from any other product is used. The layout changes only in the
  Conversation tab; Connections & sites keeps its layout and takes the new tokens. Body text 14 px,
  compact spacing, roomier line height in replies. Accent: provisional indigo (mockup row A); the
  teal option (row B) stays available as a token swap until the owner chooses.
- **D-020-3 — replies are formatted** (G7, G19): the agent's replies are rendered as Markdown
  (headings, lists, emphasis, links, inline code, code blocks, tables). Raw HTML in a reply is shown as
  text, never interpreted. No syntax highlighting yet. Each finished reply offers Copy; nothing else
  (no regenerate, no edit).
- **D-020-4 — quiet action log** (G14): while a turn runs, one line shows what the agent is doing now.
  When the turn ends, its actions collapse into one line "N steps" that expands to the full list. A failed
  or refused action stays visible outside the collapsed group.
- **D-020-5 — permission card above the message box** (G15): a waiting permission card is pinned
  directly above the message box, not in the scrolling text. While it waits, the message box offers only
  Stop. Once answered, the card leaves and one line in the conversation records the answer.
- **D-020-6 — mode chip** (G16): the mode is a chip next to the agent and folder chips. Its menu explains
  each mode (strict, the agent's own review) and holds the Codex note of FR-293. The agent's-own-review
  chip uses the warning colour.
- **D-020-7 — conversation list as a drawer** (G17): the header has a list button on the left and
  "new conversation" on the right. The list opens as a drawer over the conversation, grouped Today, Last
  7 days, Earlier, with a title search. Each row shows the agent, the title, the folder and the time.
- **D-020-8 — agent menu shows every supported agent** (G18): each with its state: ready, needs a
  one-time download, not installed (with install guidance), or version not supported (with the versions).
- **D-020-9 — languages and access** (G26): en-US and zh-TW for every new string; keyboard and screen
  reader use at the 006 bar.
- **D-020-10 — new dependency** (G7): a Markdown renderer for React and its table extension, owner
  approved. Nothing else new.

## Why this feature exists

019 proved the plumbing: a real agent, its permission questions, its history, inside the browser. The
screen around it was built to prove behaviour, not to be used: the owner picks an agent before saying
anything, every tool call is a row of equal weight, replies are plain text, and the list of
conversations is a separate view. The owner's verdict is that nobody would want to use it. This
feature makes the same behaviour readable and quick, without changing what the agent may do.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Type first, the agent is already chosen (Priority: P1)

The owner opens the Conversation tab and types a question. The agent chip already shows the agent used
last; the folder chip shows the scratch folder; the mode chip shows strict. Sending starts the
conversation. If the owner wants another agent, folder or mode, one chip changes it before sending.

**Why this priority**: it is the owner's main complaint ("為什麼還需要選擇").

**Independent Test**: with Claude Code ready and used last, open the tab, type, press Enter: the reply
streams with no picker step.

**Acceptance Scenarios**:

1. **Given** the agent used last is ready, **When** the owner opens the Conversation tab, **Then** the
   message box has focus and the agent chip shows that agent.
2. **Given** no agent was used before and exactly one is ready, **When** the tab opens, **Then** that agent
   is chosen.
3. **Given** the chosen agent needs its connector, **When** the owner sends, **Then** the first-use card
   appears above the message box with the message held; one click fetches the connector and sends the
   held message; Cancel keeps the text in the box.
4. **Given** the agent chip is opened, **When** the menu shows, **Then** every supported agent is listed
   with its state, and a not-installed agent links to install guidance.
5. **Given** a conversation has started, **When** the owner looks at the chips, **Then** agent and folder
   are fixed for this conversation (choosing another starts a new one, as in FR-303) and mode can still
   change.

### User Story 2 - Replies are easy to read (Priority: P1)

The agent's reply shows headings, lists, tables and code as formatted text, with Copy on each finished
reply.

**Why this priority**: most replies are Markdown; plain text is hard to read.

**Independent Test**: ask for a table and a code block: both render; Copy puts the reply's Markdown on
the clipboard; a reply containing `<img onerror=…>` shows the text, runs nothing.

**Acceptance Scenarios**:

1. **Given** a reply with a table, **When** it renders, **Then** it is a table that scrolls sideways
   inside the reply when wider than the panel.
2. **Given** a reply with raw HTML, **When** it renders, **Then** the HTML is shown as text.
3. **Given** a reply with a link, **When** the owner clicks it, **Then** it opens in a new tab, never in
   the panel.
4. **Given** a finished reply, **When** the owner presses Copy, **Then** the reply's source text is on the
   clipboard and the button confirms.

### User Story 3 - The action log stays out of the way (Priority: P2)

While the agent works, one line says what it is doing now. After the turn, the steps collapse into
"N steps", which expands on demand. A failed or refused step stays visible.

**Why this priority**: a turn often has 10–30 tool calls; listed in full they bury the answer.

**Independent Test**: a turn with five reads and one failing command: during the turn one live line;
after it "5 steps" collapsed plus the failed command visible.

**Acceptance Scenarios**:

1. **Given** a running turn, **When** the agent reports a new action, **Then** the live line shows it and
   screen readers hear it politely, at most once per action.
2. **Given** the turn ended, **When** the owner expands "N steps", **Then** every action is listed with
   name, input summary and status, as FR-287 requires.
3. **Given** an action failed or was refused, **When** the turn ends, **Then** that action is shown
   outside the collapsed group.

### User Story 4 - Permission questions are impossible to miss (Priority: P1)

A permission card sits directly above the message box. While it waits, the message box offers Stop only.
After the answer, one line in the conversation records it.

**Why this priority**: permission is the safety boundary of 019; a card scrolled out of view leaves the
agent waiting with the owner unaware.

**Independent Test**: strict mode, ask for a file write: the card appears above the box with the file
and a change summary; while it waits Enter does not send; answering removes it and leaves one line.

**Acceptance Scenarios**:

1. **Given** a waiting card, **When** the owner scrolls the conversation, **Then** the card stays in view.
2. **Given** a waiting card, **When** the owner presses Enter in the box, **Then** nothing is sent.
3. **Given** the mode chip, **When** the owner opens it, **Then** both modes are explained, the Codex note
   is shown for Codex, and the agent's-own-review mode is marked with the warning colour when active.

### User Story 5 - Switch between conversations from the header (Priority: P2)

The list button opens a drawer of conversations grouped by time, searchable by title.

**Why this priority**: useful once there are several conversations.

**Independent Test**: three conversations from today and one from last week: the drawer shows two groups;
typing part of a title filters; choosing one opens it with its history.

**Acceptance Scenarios**:

1. **Given** the drawer is open, **When** the owner presses Escape or chooses a row, **Then** it closes and
   focus returns to the list button or the message box.
2. **Given** a conversation cannot be continued, **When** it is listed, **Then** its row says so (FR-304).
3. **Given** a conversation is in use in another browser, **When** it is listed, **Then** its row says so.

### User Story 6 - One look across the panel, light and dark (Priority: P2)

Both tabs use the same tokens; the panel follows the system's light or dark setting; text contrast meets
4.5:1.

**Independent Test**: switch the system to dark: both tabs change; an automated contrast check on every
token pair used for text passes.

### User Story 7 - Nothing else changes (Priority: P1)

External-agent pairing, consent, site modes and the packaged-gate suites behave as in 0.13.1.

### Edge Cases

- The last-used agent was uninstalled since: the chip shows it as not installed; sending shows the
  guidance instead of trying.
- No agent is ready and none was used: the chip shows the first agent with its state; sending shows its
  card or guidance.
- A very long reply or a code block wider than the panel: horizontal scroll inside the block only.
- A reply still streaming when Markdown is incomplete (an open code fence): shown as best effort and
  re-rendered when complete; nothing jumps above the reading position.
- A permission card and a first-use card cannot both be pending: the first-use card belongs to a
  conversation that has not started.
- Panel narrower than 320 px: chips wrap to a second row; the message box keeps at least two lines.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-312**: The Conversation tab MUST open on the current conversation or, when none is open, on an
  empty one with the message box focused. No step before typing MUST be required.
- **FR-313**: The agent chip MUST default to the agent used last, else the only ready agent, else the
  first supported agent. Its menu MUST list every supported agent with one of: ready, needs a one-time
  download, not installed (with install guidance), version not supported (with the versions).
- **FR-314**: Sending to an agent whose connector is missing MUST show the first-use card (FR-299) above
  the message box holding the message; consenting MUST fetch the connector and send the held message
  without another action; cancelling MUST keep the text in the box.
- **FR-315**: Agent and folder MUST be fixed once a conversation has started; changing either MUST start a
  new conversation (FR-303). Mode MUST remain switchable (FR-292).
- **FR-316**: Replies MUST be rendered as Markdown including tables. Raw HTML MUST be shown as text and
  never interpreted; links MUST open in a new browser tab; images MUST NOT be loaded from replies (shown
  as their link).
- **FR-317**: Every finished reply MUST offer Copy of its source text. No other per-reply action MUST be
  added.
- **FR-318**: While a turn runs, the conversation MUST show one live line naming the current action. After
  the turn, its actions MUST collapse into one expandable line with their count; failed and refused
  actions MUST also be shown outside the collapsed line. FR-287's detail MUST stay reachable.
- **FR-319**: A waiting permission card MUST be shown directly above the message box and stay in view
  while the conversation scrolls. While it waits, the box MUST NOT send and MUST offer Stop. The answer
  MUST be recorded as one line in the conversation.
- **FR-320**: The mode MUST be shown as a chip next to the agent and folder chips; its menu MUST explain
  each mode and carry the FR-293 note for Codex; the agent's-own-review mode MUST use the warning colour.
- **FR-321**: The header MUST hold a list button and a new-conversation button. The list MUST open as a
  drawer grouped Today, Last 7 days and Earlier, with a title search, each row showing agent, title,
  folder and last use, plus the not-resumable and in-use states.
- **FR-322**: The whole panel MUST use one set of Hallpass design tokens with a light and a dark theme that
  follow the system setting. No colour, font, token name or asset of another product MUST be used.
- **FR-323**: Every new string MUST exist in en-US and zh-TW. Every new control MUST be reachable and
  operable by keyboard, have an accessible name, and announce state changes as the 006 bar requires;
  text MUST meet 4.5:1 contrast in both themes.
- **FR-324**: Pairing, consent, site modes, tab groups, session cards and the 019 conversation behaviour
  (FR-282–FR-311) MUST be unchanged except where this list amends their presentation.

### Key Entities

- **Composer defaults**: the agent used last (per browser profile) and the default folder (scratch);
  stored with the panel's existing preferences.
- **Design tokens**: named colours, type sizes, spacing and radii for light and dark.

## Success Criteria *(mandatory)*

- **SC-141**: With an agent ready and used before, the owner sends a first message within 5 seconds of
  opening the tab, with no click before typing.
- **SC-142**: A reply with a table, a list and a code block renders formatted; 0 of a fixed set of 10
  hostile Markdown/HTML samples runs script, loads a remote resource or changes the panel's layout.
- **SC-143**: In a turn of 20 actions the reply text starts within the first screen height of the turn's
  start once the turn ends.
- **SC-144**: In 10 strict-mode permission requests, the card is visible without scrolling every time and
  nothing is sent from the box while it waits.
- **SC-145**: Every text/background token pair used in both themes meets 4.5:1 (automated check).
- **SC-146**: Every 0.13.1 packaged-gate suite and the 019 conversation suites pass with only selector
  updates for moved controls, no changed assertions on behaviour.
- **SC-147**: The owner approves the look on the branded Chrome screenshots before release.

## Assumptions

- The mockup canvas (artifact, two rows A/B) is the visual reference; the palette is confirmed by the
  owner, indigo until then.
- "Agent used last" is per browser profile, kept with the panel's existing local preferences.
- 021's new agents will appear in the agent menu through the same state list; 020 ships Claude Code and
  Codex only.

## Out of Scope

- New agents and adapter bumps (021). Syntax highlighting. Regenerate or edit a message. Attachments.
  Voice. Per-project permission levels. Any change to what an agent may do.
