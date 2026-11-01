# Feature Specification: Extra MCP Servers for Side-Panel Conversations

**Feature Branch**: `feature-027-panel-mcp-servers` (from main ac53ea9, 0.17.0, after 026)

**Feature Directory**: `specs/027-panel-mcp-servers`

**Created**: 2026-10-28

**Status**: Draft. D-027-1 and D-027-2 put to the owner on 2026-10-28 and accepted as recommended
("依照你建議"); the rest are the main session's defaults, listed under Assumptions.

**Input**: Issue #21, from the 2026-10-26 discussion after 0.16.1: side-panel conversations use the agent's
own MCP servers and skills, as in a terminal. The owner wants to add more for side-panel conversations
only, without touching the agent's own configuration. The 0.16.0 settings page kept this out of scope
(024 D-024-5).

**Facts checked 2026-10-28**:

- When Hallpass opens or continues a side-panel conversation's session it already hands the agent one MCP
  server, its own browser tools (019 R-322). The protocol lets it hand more in the same place, so the extra
  servers need no change to any agent's own files.
- Claude Code, Codex and Hermes accept servers handed this way; DeepSeek accepts none (023 R-365), so it
  gets no extra servers either.
- Hallpass never edits the owner's agent configuration (025 FR-402); terminal use is unaffected by
  anything here.

**Decisions (D-027-n, confirmed by the owner)**:

- **D-027-1 — one list, agents ticked per server** (Q1): the settings page has one list of extra servers;
  each server has a box per agent that accepts servers (Claude Code, Codex, Hermes), all ticked when it
  is added.
- **D-027-2 — a Check on the settings page** (Q2): each server has a Check that starts it once, lists the
  tools it offers and stops it. Nothing extra is shown in a conversation (most agents do not report a
  server they could not start).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Add a server once, have it in every new side-panel conversation (Priority: P1)

The owner opens the settings page, adds an MCP server by its command, arguments and the names of the
environment variables it needs, and starts a side-panel conversation. The agent has that server's tools
in addition to its own and Hallpass's.

**Why this priority**: this is the request of issue #21.

**Independent Test**: add a server whose tools have a recognisable name; start a Claude Code conversation
in the side panel and ask the agent to list its tools; the server's tools are listed. Start Claude Code in
a terminal in the same folder; they are not.

**Acceptance Scenarios**:

1. **Given** the settings page, **When** the owner adds a server with a name, a command, arguments and
   variable names, **Then** it appears in the list and is stored on this computer.
2. **Given** a stored server, **When** a side-panel conversation of an agent that accepts servers starts
   or continues, **Then** the agent is handed that server along with Hallpass's browser tools.
3. **Given** a stored server, **When** the owner runs the same agent in a terminal, **Then** nothing is
   different: no file of the agent was changed.
4. **Given** DeepSeek, **Then** the settings page says it does not take extra servers, and its
   conversations are started as before.

---

### User Story 2 - The owner sees that the program they add is theirs to trust (Priority: P1)

Adding a server means a program of the owner's choosing runs whenever a side-panel conversation starts.
The page says so before the first server is added, and the server's secrets are never stored by Hallpass.

**Why this priority**: an MCP server is arbitrary code with the agent's reach; the owner must add it
knowingly (constitution VI).

**Acceptance Scenarios**:

1. **Given** no server yet, **When** the owner opens the add form, **Then** the page says that the program
   runs on this computer with the owner's rights each time a side-panel conversation starts.
2. **Given** a server needs a key, **Then** the owner enters only the variable's name; the value is read
   from the environment when the conversation starts and is never written by Hallpass, shown on the page
   or put in a log.
3. **Given** a variable named but not set, **Then** the page says so next to the server, and the
   conversation starts without that variable's value.

---

### User Story 3 - Change or remove a server (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a stored server, **When** the owner edits or removes it, **Then** conversations started or
   continued afterwards get the new list; a running conversation keeps what it was started with until it
   continues again.
2. **Given** the owner removes every server, **Then** side-panel conversations are started exactly as before
   this feature.

---

### User Story 4 - Know when a server does not work (Priority: P2)

The owner presses Check next to a server and learns, within seconds, whether it starts and which tools it
offers, before relying on it in a conversation (D-027-2).

**Acceptance Scenarios**:

1. **Given** a working server, **When** the owner presses Check, **Then** the row shows "Works" and the
   names of its tools, and the program is stopped again.
2. **Given** a command that does not exist, fails to start, or does not answer in time, **Then** the row
   shows "Did not start" with the reason, without any variable's value in it.
3. **Given** a check running, **Then** Check is disabled for that row until it ends.

---

### Edge Cases

- A server whose name starts with `hallpass`, or two servers with one name: refused when added.
- A command that does not exist on this computer: the settings page says so; the conversation still
  starts (the agent decides what to do with a server it cannot start).
- A server list file that cannot be read: the page says so; conversations start without extra servers and
  with Hallpass's browser tools as before.
- The owner's Codex already has a server of the same name: the extra server is handed under its own name
  only if that does not clash; a clash is shown on the page (as 019 R-322 does for `hallpass`).
- More than a handful of servers: the list is capped (Assumptions).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-425**: The settings page MUST let the owner add, edit and remove MCP servers for side-panel
  conversations, each with a name, a command, arguments and the names of environment variables.
- **FR-426**: Hallpass MUST hand the stored servers, besides its own browser tools, to every side-panel
  conversation it starts or continues of an agent that accepts servers and is ticked for that server
  (D-027-1).
- **FR-427**: Hallpass MUST NOT write to any agent's own configuration for this feature, and terminal
  use of the agents MUST be unchanged.
- **FR-428**: Hallpass MUST store variable names only; values are read from the environment when a
  conversation starts and MUST NOT be written to disk, shown on the page, sent to the extension or logged.
- **FR-429**: Before the first server is added, the page MUST say that the program runs on this computer
  with the owner's rights whenever a side-panel conversation starts.
- **FR-430**: For each agent, the page MUST say whether it takes extra servers.
- **FR-431**: A server whose name starts with `hallpass` (Hallpass's own entries), a duplicate name, or an
  empty command MUST be refused with the reason.
- **FR-432 (D-027-2)**: Each server MUST have a Check that starts it once with the same command,
  arguments and variables a conversation would use, lists its tools or the reason it failed, and stops
  it; a check MUST end within a bound and MUST NOT leave the program running.

### Key Entities

- **Extra server**: name, command, arguments, variable names, and the agents it applies to (per FR-426).
- **Server list**: the owner's list on this computer, shared by every browser's Hallpass.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-189**: An added server's tools are available in 100% of side-panel conversations of agents that
  accept servers, started or continued after it was added.
- **SC-190**: No agent configuration file changes when servers are added, edited or removed (compared
  byte for byte before and after).
- **SC-191**: No value of a named variable appears in any Hallpass file, page, frame or log (checked by
  searching for a known test value).
- **SC-192**: Adding a server takes one form on the settings page and no restart of the browser.

## Assumptions

- **Local programs only** (stdio servers: a command the agent starts). Remote servers by URL are a later
  feature.
- **Up to 10 servers**, enough for the use case and small enough to show on one page.
- **Stored per computer** next to Hallpass's other shared files, so every browser's Hallpass on this
  computer uses the same list.
- **No switch per conversation**: the list applies to every new or continued side-panel conversation; to
  leave a server out, the owner removes it. A per-conversation switch is a later feature.
- **Part A of the issue (a read-only view of each agent's own servers and skills) is a later feature**: it
  needs each agent's own file format read and kept current, and is independent of part B.
- **Skills are not handed to side-panel conversations**: the protocol has no standard way to (issue #21).

## Change log

| Date | Change | Source |
| --- | --- | --- |
| 2026-10-28 | Created from issue #21; FR-426 and User Story 4 open for the owner | Issue #21, main session |
| 2026-10-28 | D-027-1 (one list, agents ticked) and D-027-2 (Check on the settings page) decided | Owner |
