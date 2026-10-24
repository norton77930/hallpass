# Feature Specification: A Conversation in the Side Panel with the Owner's Own Coding Agent

**Feature Branch**: `019-side-panel-agent` (git: `worktree-feature-019-side-panel-agent`, from `main` at
36c9c39, release 0.12.5)

**Feature Directory**: `specs/019-side-panel-agent`

**Created**: 2026-10-18

**Status**: Approved by the owner 2026-10-18 ("照建議": the seven grilling decisions and the proposed
answer to each of the four spec-gate questions, D-019-8 – D-019-11); planning.

**Input**: Owner, 2026-10-18: after the 0.12.5 release, agreed to open a feature for a side-panel agent
driven through the Agent Client Protocol, reversing feature 006's decision that the side panel is
"status, consent and control, no chat" (`specs/006-side-panel/spec.md`). Evidence gathered the same
day: an ACP feasibility spike with Claude Code and Codex (both start, reuse the owner's login, answer,
reach Hallpass's browser tools and resume a conversation; Gemini's ACP mode hung at start), a second
spike proving the agents run on the owner's own installed command-line tools without a bundled copy,
and readings of the reference products' side panels and of open-source projects that run local agents
behind a UI (private evidence, not part of this repository).

**Owner decisions (2026-10-18)** — one question at a time, each with options and a recommendation:

- **D-019-1 — One folder per conversation** (Q1 = C). A new conversation works in a Hallpass-owned
  scratch folder unless the owner starts it in a project folder chosen from a list. A conversation's
  folder never changes; working in another folder means a new conversation. Every conversation shows
  its folder.
- **D-019-2 — Strict by default, the agent's own judgement on request, never full access**
  (Q2 = D). Every conversation starts in the agent's strictest asking mode. When the agent asks before
  editing a file or running a command that changes something, the conversation shows a permission card:
  allow once, reject, or allow for this conversation. Reading is not asked. The owner may switch one
  conversation to the agent's own automatic review, where only the actions the agent's reviewer blocks
  come to the owner. The mode is always visible; a new conversation starts strict again. A mode that
  approves everything without asking is never offered. Every action the agent reports is listed in
  the conversation.
- **D-019-3 — Two tabs, external consent always on top** (Q3 = A). The side panel gets a Conversation
  tab and a Connections & sites tab holding everything the panel shows today. Consent cards from
  external agents stay above both tabs.
- **D-019-4 — Agents live as long as the browser** (Q4 = A). Closing the side panel does not stop a
  running agent; reopening the panel shows the same conversation. Closing the browser ends every
  agent; the conversation can be continued later. An agent idle for 10 minutes is stopped and comes
  back on the next message. No agent process may outlive its owner.
- **D-019-5 — The owner's own agent, fetched on first use** (Q5 = B2). On first use of an agent, the
  panel asks before downloading the small connector Hallpass needs for it (about 60 MB for Claude Code,
  about 20 MB for Codex), at a version Hallpass has tested. The connector drives the agent the owner
  already installed and signed in to, so the panel agent has the same version, login, settings,
  instructions and tools as the owner's terminal.
- **D-019-6 — Hallpass keeps a list, not the content** (Q6 = A). Hallpass remembers which conversations
  exist (title, agent, folder, mode, last used); the content stays where the agent itself keeps it and
  is replayed from there.
- **D-019-7 — The panel agent uses the browser it lives in, under the same site rules** (Q7 = A with
  7-1a, keeping 7-1b open). The panel agent needs no pairing per conversation: one consent the first
  time the owner uses a panel agent. Site modes and site consent are the same as for external agents
  and shared with them. Each change of a site's mode records whether the panel or an external agent
  made it, so a later decision to let a panel "allow" apply to the panel only (as one reference product
  does) needs no change to what was stored.

Spec-gate answers (2026-10-18, as proposed):

- **D-019-8 — A scratch folder per conversation** (spec-gate Q1): each scratch conversation gets its own
  folder under Hallpass's data folder. Hallpass never deletes it on its own (it may hold files the agent
  made); the panel offers to open it.
- **D-019-9 — Project folders are picked in a folder dialog** (Q2): the owner adds a folder through the
  Windows folder picker opened from the panel, not by typing a path.
- **D-019-10 — At most three panel agents run at once** (Q3): starting a fourth stops the one idle
  longest, which continues on its next message as after the idle limit.
- **D-019-11 — The one-time consent is withdrawn with a switch** (Q4): "Side-panel agent may use this
  browser" in Connections & sites.
- **D-019-12 — Strict mode asks even where the owner's own agent settings allow** (T542, 2026-10-19):
  the T541 measurement found that Claude's `default` mode does not ask for tools the owner's own
  settings already allow (this machine allows file edits), while Codex `read-only` asked as specified.
  Decided: in strict mode Hallpass adds conversation-scoped "ask" rules for file edits and shell
  commands, so the card appears whatever the owner's allow list says; the owner's MCP servers, hooks and
  instructions still load. Switching a conversation to the agent-review mode reloads it without those
  rules, so the owner's own settings and the agent's classifier apply there; switching back reloads it
  with them. SC-135 stands as written.
- **D-019-13 — Codex strict asks before edits inside its folder too** (T573, 2026-10-19/20): Codex
  0.163.0 in `read-only` wrote inside the conversation's folder without a card (10/10), because the
  connector's strict mode lets the folder be written. The owner chose to fix rather than disclose:
  Hallpass starts Codex's app server through its own relay, which keeps every strict turn in a
  read-only sandbox, so each write asks (live 3/3 on branded Chrome 155, reject left no file). Codex's
  request for wider sandbox permissions is declined in strict mode with a notice, and Codex does not
  start when the installed connector's modes differ from the measured ones (R-317). Commands the
  owner's own Codex rules allow still run without asking, as for Claude's allow list outside the
  rules of D-019-12. FR-293 and Story 2 scenario 7 change accordingly.
- **D-019-14 — 0.13.1 follow-ups** (owner, 2026-10-20 grill, G2): the broker also watches the
  browser's main process: when the browser is gone every panel agent ends at once; when only the relay
  went (the worker or the host was recycled) it waits up to 35 s for a new relay (was 15 s for every
  case, T572). After a one-time install the conversation the owner asked for starts by itself instead
  of returning to the picker (Story 3 as written). A project folder given with or without a trailing
  separator is the same folder. Right after an extension reload a conversation is not shown as in use
  in another browser. Three hardening items from the T558 review: a consent withdrawal leaves no window
  in which a token is handed out after it was revoked, a token revoked for a broker is not held again
  when that broker greets anew, and the broker sidecar is created exclusively. FR-296 changes
  accordingly; no new requirement otherwise.

## Why this feature exists

Hallpass today lets a coding agent the owner runs in a terminal use the owner's browser, under
consent given in the side panel. The owner wants the reverse direction as well: to talk to the same
agent from the browser, about the page they are looking at, without switching to a terminal.

The reference products offer a chat in their side panels, but their conversations run in the vendor's
cloud and have no access to the owner's files or tools. Hallpass instead lets the owner talk to the
agent already installed on their computer, with its login, instructions and tools, so the side panel
becomes a second front door to the same agent. That agent can change files and run commands, so this
feature is as much about the owner staying in control as it is about chat.

Feature 006 decided the panel would be status, consent and control only. That decision stays right for
external agents; this feature adds a conversation next to it without hiding any of it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ask the agent about the page (Priority: P1)

The owner reads a report page, opens the Hallpass side panel, picks Claude Code and types "summarise
this table". The agent reads the page through Hallpass, under the site's mode, and answers in the
panel. The owner watches each action appear in the conversation.

**Why this priority**: it is the feature: a conversation with the owner's own agent, in the browser,
about the page in view.

**Independent Test**: a machine with Claude Code installed and signed in, the connector already
fetched, a fixture page: one prompt yields a streamed answer that quotes the page, each tool the agent
used is listed, and a site set to "ask" raised its consent card before the read.

**Acceptance Scenarios**:

1. **Given** the panel is open on a page and the agent is ready, **When** the owner sends a message,
   **Then** the agent's answer appears progressively in the Conversation tab and the conversation
   header shows the agent, the folder and the mode.
2. **Given** the agent uses a browser tool, **When** the call runs, **Then** the conversation lists it
   (what it was, on which page, done or failed) and the site's mode applies exactly as it would for an
   external agent.
3. **Given** the agent's first browser action in a conversation, **When** it starts, **Then** it acts
   on the tab the owner was viewing when sending the message, and tabs it opens go into its own tab
   group.
4. **Given** the owner presses Stop while the agent works, **When** the agent stops, **Then** the
   conversation says it was stopped and no further action from that turn runs.

---

### User Story 2 - The owner stays in control of files and commands (Priority: P1)

The owner asks the agent to save the table as a file. The agent wants to write it; the conversation
shows a permission card naming the file. The owner chooses "allow for this conversation"; later writes
in this conversation do not ask. In a new conversation they ask again.

**Why this priority**: the panel agent can change the owner's files; without this the feature is not
safe to ship.

**Independent Test**: strict mode, a prompt that writes a file: a card appears and nothing is written
before the answer; reject leaves no file; allow once writes it and the next write asks again; allow
for this conversation stops the asking for that conversation only.

**Acceptance Scenarios**:

1. **Given** a new conversation, **When** it starts, **Then** it is in strict mode, whatever mode the
   owner uses for that agent in their terminal.
2. **Given** strict mode, **When** the agent asks to edit a file or run a command that changes
   something, **Then** a permission card names the action and offers allow once, reject and allow for
   this conversation; the agent waits.
3. **Given** a card, **When** the owner rejects, **Then** the action does not happen and the agent is
   told it was refused.
4. **Given** the agent only reads, **When** it reads a file or runs a read-only command, **Then** no
   card is shown and the action is listed in the conversation.
5. **Given** the owner opens the mode switch, **When** they look at the choices, **Then** only strict
   and the agent's own automatic review are offered; there is no choice that approves everything.
6. **Given** the owner switches a conversation to the agent's own automatic review, **When** the agent
   acts, **Then** only actions its reviewer blocks raise a card, every action is still listed, and the
   header shows the mode.
7. **Given** a Codex conversation in strict mode, **When** the owner views the mode, **Then** the panel
   says that Codex works read-only and asks before changes, and that commands the owner's own Codex
   rules allow still run without asking (D-019-13).

---

### User Story 3 - First use: fetch the connector, give the one consent (Priority: P1)

The owner opens the Conversation tab for the first time and picks Codex. The panel explains that
Hallpass needs to download a small connector (about 20 MB) for the Codex they already have, and that
the panel agent will be able to use this browser under the usual site rules. The owner accepts; a
progress bar runs; the conversation starts.

**Why this priority**: without it there is no conversation; it is also the one consent that admits the
panel agent to the browser.

**Independent Test**: a clean profile and an empty connector folder: picking an agent shows the card
with the size; cancel downloads nothing; accept downloads the tested version once, and the second
conversation starts without the card.

**Acceptance Scenarios**:

1. **Given** an agent never used from the panel, **When** the owner picks it, **Then** a card states
   what will be downloaded, its approximate size and that the panel agent will use this browser under
   the site rules, with Download and Cancel.
2. **Given** the owner cancels, **When** the card closes, **Then** nothing is downloaded and the agent
   stays unavailable until asked again.
3. **Given** the owner has not installed that agent, **When** they pick it, **Then** the panel says so
   and shows how to install it; nothing is downloaded.
4. **Given** the installed agent's version does not work with the connector Hallpass tested, **When**
   the owner picks it, **Then** the panel says which versions differ and what to do, and no
   conversation starts.
5. **Given** the download fails (offline, interrupted), **When** it stops, **Then** the panel says why
   and offers retry; a partial download is never used.

---

### User Story 4 - Close the panel, come back later (Priority: P2)

The owner asks for a long task and closes the side panel. Ten minutes later they reopen it: the
conversation is there with everything the agent did meanwhile. The next day, after restarting the
browser, they pick the conversation from the list and continue it.

**Why this priority**: long tasks and returning to work are the normal use, but a first release could
ship with conversations ending on close.

**Independent Test**: start a multi-step task, close the panel, wait, reopen: the turn completed (or
waits on a card) and the conversation shows it. Restart the browser: the list shows the conversation;
opening it replays the history and a new message continues it.

**Acceptance Scenarios**:

1. **Given** an agent working, **When** the owner closes the panel, **Then** the agent keeps working;
   reopening the panel shows the same conversation with the actions done meanwhile.
2. **Given** the agent asked for permission while the panel was closed, **When** the owner reopens the
   panel, **Then** the card is shown and the agent has done nothing past it.
3. **Given** a conversation idle for 10 minutes, **When** the owner sends a new message, **Then** the
   conversation continues with its history, after a short reconnecting notice.
4. **Given** the browser is closed, **When** it is reopened, **Then** no agent from before is running,
   and each earlier conversation can be opened from the list and continued.
5. **Given** the browser closes or crashes, **When** the owner checks the machine's processes, **Then**
   no agent process started for the panel is still running.

---

### User Story 5 - Choose a project folder (Priority: P2)

The owner wants the agent to work in a project, not in scratch. They start a new conversation, choose
the project from their folder list, and the conversation header shows it. To work in another project
they start another conversation.

**Why this priority**: scratch covers page work; projects make the panel useful for coding, which is
what these agents are for.

**Independent Test**: add a folder to the list, start a conversation there, ask the agent for its
working folder: it answers that folder; the header shows it; there is no way to change it inside the
conversation.

**Acceptance Scenarios**:

1. **Given** a new conversation and no choice made, **When** it starts, **Then** it works in a
   Hallpass scratch folder and the header says so.
2. **Given** the folder list, **When** the owner adds a folder, **Then** it is remembered for later
   conversations and can be removed from the list.
3. **Given** a conversation, **When** the owner wants another folder, **Then** the panel offers to start
   a new conversation there; the current one keeps its folder.
4. **Given** a listed folder that no longer exists, **When** the owner picks it, **Then** the panel says
   so and does not start the conversation.

---

### User Story 6 - The list of conversations (Priority: P3)

The owner opens the conversation list, sees recent conversations with agent, folder and when they were
last used, opens one, removes another from the list.

**Why this priority**: useful once there are several conversations; not needed for the first.

**Independent Test**: create three conversations, restart the browser: all three are listed; opening one
replays it; removing one takes it off the list and the agent's own record of it is still there.

**Acceptance Scenarios**:

1. **Given** earlier conversations, **When** the owner opens the list, **Then** each shows title, agent,
   folder and last use, newest first.
2. **Given** an entry, **When** the owner removes it, **Then** it leaves the list and nothing else is
   deleted.
3. **Given** an entry the agent itself no longer has, **When** the owner opens it, **Then** the panel
   says it can no longer be continued.
4. **Given** more than 50 conversations or entries unused for 30 days, **When** the list is shown,
   **Then** the oldest beyond those limits are no longer listed.

---

### User Story 7 - External agents are not disturbed (Priority: P1)

While the owner chats in the Conversation tab, a Claude Code session in their terminal asks to click a
button on a site set to "ask". The consent card appears above the tabs, not hidden in the other tab;
the owner answers it without leaving the conversation.

**Why this priority**: the existing product must not regress; a hidden consent card has caused
timeouts before.

**Independent Test**: the packaged gate's existing external-agent suites pass unchanged with the new
panel; with the Conversation tab active, an external consent request shows its card above the tabs.

**Acceptance Scenarios**:

1. **Given** the Conversation tab is shown, **When** an external agent needs consent, **Then** its card
   appears above both tabs and stays until answered or expired.
2. **Given** something in Connections & sites needs attention (a pairing request, a browser choice),
   **When** the Conversation tab is shown, **Then** the other tab shows a count.
3. **Given** the owner switches tabs, **When** they reopen the panel later, **Then** it opens on the tab
   they used last.
4. **Given** the panel agent and an external agent are both working, **When** each acts, **Then** each
   keeps its own tab group and its own session card.

---

### Edge Cases

- The owner's agent is signed out: the agent's own sign-in message is shown in the conversation and no
  credential is asked for or handled by Hallpass.
- The owner's own settings start extra tools or instructions inside the panel agent (their own MCP
  servers, hooks, instructions file): they apply as in the terminal; the panel says on first use that
  the panel agent runs with the owner's own settings.
- The owner's own settings already include Hallpass: the panel agent must not end up with two sets of
  browser tools that pair separately; it uses the connection Hallpass supplies (FR-305).
- Two side-panel documents are open (two windows): both show the same conversations; a card answered in
  one disappears from the other.
- The agent crashes or exits mid-turn: the conversation says the agent stopped unexpectedly and offers
  to continue; nothing is retried on its own.
- A permission card waits while the browser closes: the agent ends; the action never ran.
- The browser has several Hallpass profiles or browsers (018): each browser's panel runs its own
  conversations; a panel agent uses only the browser it lives in.
- The owner revokes the first-use consent: running panel agents lose browser access at once; new
  conversations ask again.
- A site the owner set to "skip checks" from the panel also skips checks for external agents (7-1a);
  the site list says who changed the mode last.
- The machine has no network when the connector is first needed: the download fails with a clear
  message; agents already fetched still work.
- A conversation's scratch folder is deleted by the owner: the conversation can no longer continue and
  says why.

## Requirements *(mandatory)*

### Functional Requirements

**Conversation and layout (D-019-3)**

- **FR-282**: The side panel MUST offer two tabs, Conversation and Connections & sites. Connections &
  sites MUST hold every element the panel shows before this feature, with unchanged behaviour.
- **FR-283**: Consent cards from external agents MUST be shown above both tabs whichever tab is active,
  until answered or expired.
- **FR-284**: When Connections & sites holds something awaiting the owner, its tab MUST show a count
  while the other tab is active. The panel MUST reopen on the tab used last.
- **FR-285**: The Conversation tab MUST let the owner choose an agent (Claude Code or Codex), send a
  message, see the agent's answer as it arrives, and stop the current turn.
- **FR-286**: The conversation header MUST show the agent, the folder and the current mode at all
  times.
- **FR-287**: Every action the agent reports MUST be listed in the conversation with what it is, a short
  description of its input, and whether it is running, done, failed or refused.
- **FR-288**: Every open side-panel document MUST show the same conversation state; a card answered in
  one MUST leave all of them.

**Permissions and modes (D-019-2)**

- **FR-289**: Every new or resumed conversation MUST be put into the agent's strict asking mode
  (Claude Code: ask before changes; Codex: ask for approval) before the owner's first message is sent,
  regardless of the owner's own default for that agent.
- **FR-290**: When the agent asks permission for an action, the conversation MUST show a card naming the
  action (file and change summary, or the command) with allow once, reject and allow for this
  conversation. The agent's action MUST NOT run before the owner answers.
- **FR-291**: "Allow for this conversation" MUST apply only to that conversation and only to the kind of
  action the agent asked about, and MUST end when the conversation ends.
- **FR-292**: The owner MUST be able to switch a conversation between strict mode and the agent's own
  automatic review. No other mode MUST be offered, and a mode that approves every action without asking
  MUST NOT be reachable from the panel in any way.
- **FR-293**: For Codex in strict mode the panel MUST state that Codex works read-only and asks before
  changes, and that commands the owner's own Codex rules allow still run without asking (D-019-13).
- **FR-294**: A permission card left unanswered MUST keep the agent waiting; it MUST NOT expire into an
  approval.

**Lifecycle (D-019-4)**

- **FR-295**: Closing every side-panel document MUST NOT stop a running agent. Reopening the panel MUST
  show the conversation with all output and actions produced meanwhile.
- **FR-296**: Closing the browser MUST end every panel agent; no agent process started for the panel
  MUST remain afterwards, including after a browser crash.
  Since 0.13.1 (D-019-14) the agents end as soon as the browser's main process is gone; when only the
  relay went, the broker waits up to 35 s for a new one before ending them.
- **FR-297**: An agent with no turn running and no card waiting for 10 minutes MUST be stopped; the next
  message to its conversation MUST continue it with its history.
- **FR-311**: At most three panel agents MUST run at the same time. Starting a fourth MUST stop the
  agent idle longest (never one with a running turn or a waiting card); its conversation MUST continue
  on its next message as in FR-297. When all three are busy, the panel MUST say so instead of starting
  the fourth.
- **FR-298**: When an agent ends unexpectedly, the conversation MUST say so and offer to continue; the
  interrupted turn MUST NOT be retried on its own.

**Agent setup (D-019-5)**

- **FR-299**: Before the first use of an agent, the panel MUST ask the owner before downloading its
  connector, stating what it is, its approximate size, and that the panel agent will use this browser
  under the site rules (the one-time consent of D-019-7). Nothing MUST be downloaded without that
  answer.
- **FR-300**: The connector version MUST be the one Hallpass was tested with; it MUST NOT update itself.
  A partial or failed download MUST NOT be used.
- **FR-301**: The panel agent MUST run the owner's installed agent. When it is not installed, the panel
  MUST say so with install guidance; when its version does not work with the tested connector, the panel
  MUST say which versions differ.
- **FR-302**: Hallpass MUST NOT ask for, store or transmit the owner's agent credentials; sign-in stays
  the agent's own.

**Folder and history (D-019-1, D-019-6)**

- **FR-303**: A new conversation MUST work in its own Hallpass scratch folder unless the owner chooses a
  folder from their list. Hallpass MUST NOT delete a scratch folder on its own, and the panel MUST offer
  to open a conversation's folder. The owner MUST be able to add folders to the list through a folder
  picker opened from the panel, and remove them from the list. A conversation's folder MUST NOT change;
  choosing another folder MUST start a new conversation.
- **FR-304**: Hallpass MUST keep a list of conversations (title, agent, folder, mode, last use) and MUST
  NOT keep a copy of their content. Opening an entry MUST replay the conversation from the agent's own
  record. The list MUST keep at most 50 entries and drop entries unused for 30 days. Removing an entry
  MUST NOT delete anything else. An entry the agent can no longer continue MUST say so.

**Browser access (D-019-7)**

- **FR-305**: The panel agent MUST reach this browser through a connection Hallpass supplies to that
  conversation, admitted by the one-time consent (FR-299) without a pairing card per conversation. If the
  owner's own agent settings also connect Hallpass, the panel agent MUST NOT end up with a second,
  separately paired set of browser tools: the second set is withheld where possible, otherwise the agent
  is told which set to use and the other set's pairing request is ignored.
- **FR-306**: The panel agent's first browser action of a turn MUST target the tab the owner was viewing
  when sending the message; tabs it opens MUST go into its own tab group; any other tab MUST be claimed
  through the existing claim flow.
- **FR-307**: Site modes, site consent cards and site plans MUST apply to the panel agent exactly as to
  external agents and MUST be shared with them.
- **FR-308**: Every change of a site's mode MUST record whether the panel agent or an external agent
  made it. The site list MUST show who changed a mode last.
- **FR-309**: The owner MUST be able to withdraw the one-time consent with the switch "Side-panel agent
  may use this browser" in Connections & sites; withdrawing
  MUST end every panel agent's browser access at once, and the next panel conversation MUST ask again.

**Non-regression**

- **FR-310**: Pairing, consent, site modes, tab groups and session cards for external agents MUST behave
  as in 0.12.5; the existing packaged-gate suites MUST pass without changes to their assertions.

### Key Entities

- **Conversation**: one exchange with one agent in one folder; has a title, agent, folder, mode, last
  use, and a reference to the agent's own record of it. Content is never stored by Hallpass.
- **Panel agent**: the owner's installed Claude Code or Codex, running for one conversation, alive
  while the browser runs and the conversation is active or recently used.
- **Connector**: the per-agent component Hallpass downloads on first use, at a tested version.
- **Permission card**: a pending question from the agent about one action, with its three answers.
- **Folder list**: folders the owner added for conversations; plus the scratch folder.
- **Panel consent**: the one-time admission of panel agents to this browser; can be withdrawn.
- **Site grant change** (extends existing site modes): who changed a site's mode (panel or external)
  and when.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-134**: With the connector fetched, the owner gets the first words of an answer within 10 seconds
  of sending a message, on the reference machine.
- **SC-135**: In 20 attempts across both agents, no file edit or changing command runs in strict mode
  without the owner's answer on a card.
- **SC-136**: After closing the browser (normally and by ending its process), zero processes started for
  panel agents remain, in 10 out of 10 trials.
- **SC-137**: A conversation closed by idling, panel close or browser restart is continued with its
  history in 10 out of 10 trials, while the agent still has its record.
- **SC-138**: Every external-agent packaged-gate suite of 0.12.5 passes unchanged on branded Chrome.
- **SC-139**: A first-time user goes from opening the Conversation tab to a first answer in under 3
  minutes on a normal connection, with no terminal command.
- **SC-140**: No panel mode, setting or message lets an action run without the agent's own asking or
  reviewer; an inspection of every mode offered finds none that approves everything.

## Assumptions

- The owner has Claude Code and/or Codex installed and signed in on the same Windows user; Hallpass does
  not install or sign them in.
- The tested versions are Claude Code 2.1.302 and Codex 0.163.0 with connectors measured on 2026-10-18 (Codex
  re-measured on 2026-10-19);
  later versions are accepted while they work with the pinned connector.
- The owner's own settings for the agent (instructions file, extra tools, hooks) apply inside panel
  conversations, as in their terminal; Hallpass does not edit them.
- Codex's own strict mode lets it write inside the working folder without asking; Hallpass keeps
  strict turns read-only so it asks (D-019-13).
- Conversations run on this machine; messages go from the agent to its own vendor service exactly as
  in the terminal. Hallpass adds no transmission of its own.
- The 10-minute idle limit, 50 entries and 30 days are owner-approved defaults (D-019-4, D-019-6).
- Release 0.13.0. The feature touches authorization (a new kind of agent admitted to the browser,
  permission handling for file and command actions) and adds a runtime dependency, so it follows the
  owner's R2 path: architecture and code review before release.

## Out of Scope

- Gemini and other agents (Gemini's ACP mode hung at start in the 2026-10-18 spike); agents that are not
  installed locally.
- Per-project permission levels (Q2 option B; possible later without changing this design).
- An action classifier built by Hallpass (Q2 option E).
- Agents that keep running after the browser closes (Q4 option C).
- Storing conversation content in Hallpass (Q6 option B).
- Per-surface site grants (7-1b): designed for by FR-308 but not offered in this feature.
- Changing the owner's own agent settings, or a mode that approves every action.
- macOS and Linux (issue #1).

## Questions for the owner (spec gate) — answered 2026-10-18 as proposed (D-019-8 – D-019-11)

1. **Scratch folder**: one scratch folder per conversation under Hallpass's own data folder (proposed),
   or one shared scratch folder for all conversations? Proposed: per conversation, never deleted
   automatically (it may hold files the agent made); the panel offers "open folder".
2. **Adding a project folder**: the owner picks it in a Windows folder dialog opened from the panel
   (proposed), or types a path?
3. **How many agents at once**: at most 3 panel agents running at the same time (proposed; starting a
   fourth stops the one idle longest, which resumes on its next message), or no limit?
4. **Where the one-time consent is withdrawn**: a switch "Side-panel agent may use this browser" in
   Connections & sites (proposed, FR-309).

## Change log

- **2026-10-24 — FR-282 (second sentence) and FR-309's placement superseded by 024** (D-024-11, D-024-13,
  FR-392): the Connections & sites tab becomes "Sessions" and keeps only the connection state and the
  session cards; the site list, upload folders, paired agents, browser name and the side-panel-agent switch
  move to the settings page. FR-283 and FR-284 are unchanged.
