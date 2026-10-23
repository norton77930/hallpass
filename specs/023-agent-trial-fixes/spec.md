# Feature Specification: Fixes from the Owner's First Hermes Trial

**Feature Branch**: `023-agent-trial-fixes` (git: written on `feature-022-composer-attachments`, which
ships it as 0.15.2)

**Feature Directory**: `specs/023-agent-trial-fixes`

**Created**: 2026-10-23

**Status**: Draft. Every decision below was put to the owner on 2026-10-23 as Q1–Q6 and **confirmed by the
owner** ("都照建議"). The findings behind them were measured that day on the owner's own machine and model.

**Input**: Owner, 2026-10-23, after using Hermes from the side panel on 0.15.1: the panel showed nothing for
minutes, the agent could not see the page, and the experience "沒有很好". Diagnosis found eight problems
(below); six are fixed here. A settings page (agents prepared before use) is decided separately as
feature 024.

**What the trial found** (all on 0.15.1, 2026-10-23):

1. With the model server unreachable, the panel showed nothing while the agent waited about six minutes.
2. The agent's key variable had been set after the browser started, so the agent never received it; the
   only message was the agent's own advice to re-run its setup, which was wrong for this case.
3. Every new conversation waits roughly 35 seconds for its agent to start, with no word from the panel.
4. Hermes never received the browser tools: its installation lacked an optional component, and it skips
   the browser connection without a word. DeepSeek has no way to take them at all.
5. "+ current tab" is unavailable for Hermes and DeepSeek, because neither takes page context.
6. **Hermes' saved-logins tool was still offered to the agent** in both modes, although 021 (D-021-6,
   FR-348) requires it off: the switch Hallpass sets names a tool group that does not exist in Hermes.
7. The owner expected the agent to see the screen by itself; only agents with the browser tools can.
8. Nothing an agent printed about its own failures was kept, so diagnosis meant reading the agent's files.

**Decisions (D-023-n, confirmed by the owner)**:

- **D-023-1 — saved logins really off, first** (Q1; amends the verification of D-021-6/FR-348): the
  saved-logins tool must be absent from everything the agent can call or look up, in every mode, checked
  against the real Hermes 0.22.2 and not only against the settings Hallpass writes. It is fixed first and
  may ship alone if the rest is not ready.
- **D-023-2 — say when the browser tools did not arrive** (Q2-B): after an agent starts, Hallpass knows
  whether the agent actually took its browser tools. When it did not, the panel says so once per
  conversation and says what to do: for Hermes, the missing component and how to add it; for DeepSeek,
  that it cannot use them and that a screenshot or the tab can be attached instead.
- **D-023-3 — the tab as a file** (Q2-C; amends D-022-6, FR-356 and D-021-13): for an agent that does not
  take page context, "+ current tab" is offered again and the tab's title and text reach the agent as a
  text file in the conversation folder, named the same way as an attached file. Agents that take page
  context keep receiving it as before.
- **D-023-4 — the owner's Hermes gets the missing component** (Q2-A, operational): during the live check
  the component is added to the owner's own Hermes installation, after a dry run that shows every change.
  Hallpass itself still never installs or changes Hermes (D-021-3).
- **D-023-5 — say what is being waited for** (Q3): for every agent, the panel shows that the agent is
  starting (and that the first start can take 30–60 seconds), then, once a message is sent and nothing has
  come back, how long it has waited for the model; after 30 seconds without any output it adds a hint to
  check the model server or the network/VPN.
- **D-023-6 — a key the browser cannot see** (Q4, option B only): when an agent fails to start or fails its
  first message, and the variable its own settings name as its key source exists in the owner's user
  settings but not in what the agent was started with, the panel says so and tells the owner to quit the
  browser completely (including when it keeps running in the background) and open it again. Hallpass
  checks the variable's name only: it never reads, shows, logs or passes on its value, and how keys reach
  agents does not change.
- **D-023-7 — one agent process per conversation stays** (Q5): no starting ahead of time and no sharing;
  D-023-5 is the answer to the wait for now.
- **D-023-8 — keep what the agent said about itself** (Q6): the last 50 lines an agent run printed about
  itself are kept in memory, with the value of every environment variable removed, shown on request in the
  conversation's details, and dropped with the conversation. They are never written to disk or to
  Hallpass's own log.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Saved logins and cards are never offered to an agent (Priority: P1)

The owner talks to Hermes from the side panel in either mode. Whatever the agent is asked, it cannot list,
look up or use the owner's saved logins, passwords or payment cards through Hermes' own tool for them.

**Why this priority**: a security promise of 021 that is not kept today; it outranks every convenience.

**Independent Test**: start a Hermes conversation in strict and in automatic mode with the real Hermes and
record everything the agent is offered, including tools it can look up on demand; the saved-logins tool
appears in neither.

**Acceptance Scenarios**:

1. **Given** a Hermes conversation in strict mode, **When** the agent's offered tools (direct and
   look-up-on-demand) are listed, **Then** the saved-logins tool is not among them.
2. **Given** the same conversation switched to automatic mode, **When** the tools are listed again, **Then**
   the saved-logins tool is still absent.
3. **Given** a resumed Hermes conversation, **When** it starts, **Then** the saved-logins tool is absent.

---

### User Story 2 - The owner knows what the panel is waiting for (Priority: P1)

The owner sends a first message to a new conversation. The panel shows the agent starting, then a running
count while it waits for the model, and after 30 seconds of silence a hint to check the model server or
VPN — instead of an empty panel for minutes.

**Why this priority**: the trial's first impression was "完全沒反應"; this applies to all four agents.

**Independent Test**: with a stand-in agent that starts slowly and a model that never answers, the panel
shows the starting state, the counting state and, after 30 seconds, the hint; with a model that answers,
the hint never appears.

**Acceptance Scenarios**:

1. **Given** a new conversation, **When** its agent is starting, **Then** the panel says the agent is
   starting and that the first start can take 30–60 seconds.
2. **Given** a sent message and no output yet, **When** time passes, **Then** the panel shows how many
   seconds it has waited.
3. **Given** 30 seconds without any output, **When** the owner looks, **Then** a hint asks to check the model
   server or the network/VPN; the owner can still stop the message.
4. **Given** output arrives at any moment, **When** it does, **Then** the waiting indicator and hint go away.

---

### User Story 3 - The agent can see the current tab (Priority: P2)

The owner asks Hermes or DeepSeek about the page they are on. They can attach the current tab with "+", and
the agent reads its text. If Hermes did not take the browser tools, the panel says why and how to fix it.

**Why this priority**: "summarise this page" is the main reason to talk to an agent from the browser.

**Independent Test**: attach the current tab to a Hermes and a DeepSeek conversation; each agent receives a
file holding the tab's title and text, and answers from it. Start Hermes without the optional component:
the panel names it and how to add it.

**Acceptance Scenarios**:

1. **Given** Hermes or DeepSeek, **When** the owner opens "+", **Then** "current tab" is available.
2. **Given** the tab is attached and the message sent, **Then** the agent receives a text file in the
   conversation folder with the tab's title and text, listed like an attached file.
3. **Given** Claude or Codex, **When** the tab is attached, **Then** it reaches the agent exactly as before.
4. **Given** an agent that did not take the browser tools, **When** its conversation starts, **Then** the
   panel says once that this agent cannot use the browser by itself and what to do (Hermes: the missing
   component; DeepSeek: attach a screenshot or the tab).

---

### User Story 4 - A key the browser cannot see is explained (Priority: P2)

The owner set the variable holding Hermes' key after the browser was started. The first message fails. The
panel says the key variable exists in the owner's settings but the browser started before it, and to quit
the browser completely and reopen it.

**Why this priority**: cost the owner several rounds today; the agent's own message pointed the wrong way.

**Independent Test**: start Hermes with its key variable present in the owner's user settings but absent
from the environment the agent receives; the failure notice names the variable (name only) and the restart.

**Acceptance Scenarios**:

1. **Given** the variable named by the agent's settings exists in the owner's user settings but not in the
   agent's environment, **When** the start or first message fails, **Then** the panel explains this and
   tells the owner to fully quit and reopen the browser.
2. **Given** the variable is present in the agent's environment, **When** a failure happens, **Then** this
   explanation is not shown.
3. **Given** any case, **Then** no part of the variable's value appears in the panel, the logs or anything
   kept.

---

### User Story 5 - What the agent said about its failure can be seen (Priority: P3)

When something goes wrong, the owner (or whoever helps them) opens the conversation's details and sees the
last lines the agent printed about itself, with no secret values in them.

**Why this priority**: makes every other problem quicker to explain; no direct user value on its own.

**Independent Test**: a stand-in agent prints 80 lines including an environment value; the details show the
last 50 with the value removed; nothing is written to disk.

**Acceptance Scenarios**:

1. **Given** an agent printed more than 50 lines, **When** the owner opens the details, **Then** the last 50
   are shown, oldest first.
2. **Given** a printed line contains the value of any environment variable the agent ran with, **Then** that
   value is removed before the line is kept.
3. **Given** the conversation is removed or the browser closes, **Then** the lines are gone.

### Edge Cases

- The agent starts but never answers its first setup step: the starting state stays with the existing
  Cancel; after 30 seconds the hint also shows.
- Output arrives exactly at 30 seconds: the hint does not flash in.
- The tab has no readable text (blank page, browser page): the attach is refused as today for that page.
- The tab text is very large: the existing tab-text limit of 022 applies; the file holds what the tab
  attachment would have held.
- The conversation folder is the owner's own project folder: the tab file goes into the same place
  attached files go, and is cleaned up the same way.
- An agent's settings name no key variable, or it cannot be found: no key explanation is shown.
- The browser-tools check cannot tell (agent gave no signal): no notice is shown, rather than a wrong one.
- Agent output contains very long lines: each kept line is bounded in length.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-362**: Hermes started from the panel MUST NOT be able to call or look up its saved-logins tool in
  any mode (strict, automatic, after a restart or resume) (D-023-1).
- **FR-363**: The check for FR-362 MUST be made against the real Hermes 0.22.2's offered tools, including
  tools offered for look-up on demand; a test of the settings text alone does not satisfy it (D-023-1).
- **FR-364**: After an agent run starts, Hallpass MUST determine whether the agent took Hallpass's browser
  tools and, when it did not, show one notice per conversation naming what is missing and what to do,
  specific to the agent (D-023-2).
- **FR-365**: For an agent that does not take page context, the "+" menu MUST offer "current tab", and the
  tab's title and text MUST reach the agent as a text file in the conversation folder, named in the
  message like an attached file (D-023-3).
- **FR-366**: For an agent that takes page context, the tab MUST reach it exactly as in 022 (D-023-3).
- **FR-367**: The panel MUST show a starting state with the expected first-start time while an agent
  starts, for every agent (D-023-5).
- **FR-368**: While a sent message has produced no output, the panel MUST show the seconds waited, and
  after 30 seconds without output a hint to check the model server or network/VPN; both disappear as soon
  as any output arrives (D-023-5).
- **FR-369**: When an agent's start or first message fails and the variable its own settings name as its
  key source exists in the owner's user settings but not in the agent's environment, the panel MUST say so
  and tell the owner to fully quit and reopen the browser (D-023-6).
- **FR-370**: Hallpass MUST NOT read, show, log, keep or pass on the value of any key variable for
  FR-369; only the variable's name and its presence are used (D-023-6).
- **FR-371**: Each agent run MUST keep, in memory only, at most the last 50 lines the agent printed about
  itself, each with every environment value it ran with removed and each bounded in length (D-023-8).
- **FR-372**: The conversation's details MUST show those lines on request, and they MUST be dropped with
  the conversation or when the browser closes (D-023-8).
- **FR-373**: Every new text in the panel MUST exist in English and zh-TW and meet the 006/020 keyboard and
  screen-reader bar (D-021-15).
- **FR-374**: Claude and Codex conversations MUST behave as before apart from FR-367, FR-368 and
  FR-371/372 (D-023-7).

### Key Entities

- **Agent run report**: per agent run — whether the browser tools were taken, the last printed lines
  (scrubbed), and, after a failure, whether a key variable was found only in the owner's user settings.
- **Tab file**: a text file in the conversation folder holding one attached tab's title and text, created
  for agents that do not take page context and cleaned up like an attached file.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-163**: In 100% of Hermes runs from the panel (strict, automatic, resumed), the saved-logins tool is
  absent from the agent's offered tools, measured on the real Hermes.
- **SC-164**: With an unreachable model, the owner sees a waiting indicator within 2 seconds of sending and
  the server/VPN hint at 30 seconds, instead of an empty panel.
- **SC-165**: A Hermes or DeepSeek conversation can answer "summarise this page" from an attached tab on the
  first try.
- **SC-166**: When Hermes lacks its browser component, the owner learns the cause from the panel without
  any other tool.
- **SC-167**: With the key variable set after the browser started, the owner is told the right fix
  (restart the browser completely) on the first failure.
- **SC-168**: No key value appears in anything Hallpass shows, keeps or logs (checked by searching for the
  value after the tests).

## Assumptions

- Hermes 0.22.2 remains the tested version. Research (R-363) found it can switch off the saved-logins tool
  only together with its whole own-browser tool group, so from the panel Hermes also loses its own browser
  tools (which drive a browser Hermes starts itself); the owner's browser is reached through Hallpass's tools.
- "The agent took the browser tools" can be determined from the agent's own behaviour or messages without
  calling the model; if it cannot for some agent, that agent shows no notice (no false alarm).
- The owner's user settings for variables are those of the signed-in Windows user; only presence by name is
  checked.
- The tab file uses the tab text 022 already collects; nothing new is read from the page.
- Feature 024 (settings page) will later move setup and checks out of the conversation; 023's notices stay
  useful in the panel.
- Out of scope: settings page, custom MCP servers, skills, starting agents ahead of time, storing keys,
  browser tools for DeepSeek.
