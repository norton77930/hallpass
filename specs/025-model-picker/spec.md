# Feature Specification: Side-Panel Model Picker

**Feature Branch**: `feature-025-model-picker` (from main 5a394e6, 0.16.1)

**Feature Directory**: `specs/025-model-picker`

**Created**: 2026-10-26

**Status**: Draft. D-025-1..12 were put to the owner on 2026-10-26 as grill Q1–Q10 and accepted as
recommended ("全部照建議", "A，Q9 Q10 照建議"); the owner confirmed the summary ("確認，建分支開始寫
spec"). D-025-11 and D-025-12 were stated in that summary as the main session's own choices.

**Input**: Owner, 2026-10-26 ("現在側邊攔可以選模型嗎? 我怎麼沒看到"), issue #15: the side panel has no
model picker; every side-panel conversation uses the model set in the agent's own configuration.

**Facts measured 2026-10-26** (each agent started and asked to open a session, no message sent, so no model
call): every agent reports the models it can use when a session opens. Claude Code (connector 0.81.2) and
Codex (connector 1.13.1) report their models and their reasoning-effort levels as the protocol's session
options; DeepSeek (0.2.1-rc.2) reports its models that way, without effort; Hermes (0.22.2) reports its
models through the protocol's older, still-unstable model list, without effort. The lists contain the
owner's own provider and model names; they are the owner's data.

**Design source**: prototype variant A — `.scratch/025-prototypes/index.html` (private, not shipped;
published for the owner as an artifact on 2026-10-26). It uses made-up model names; its six states are the
ones listed under User Stories.

**Decisions (D-025-n, confirmed by the owner)**:

- **D-025-1 — all four agents** (Q1): Claude Code, Codex, DeepSeek and Hermes get the picker. Hermes is
  switched through the older model list; the tested-version pin of 021 keeps a Hermes that changes it from
  being used unknowingly.
- **D-025-2 — model and reasoning effort only** (Q2): the picker offers the model and, where the agent
  reports it, the reasoning effort. The agent's own modes, fast mode and collaboration mode are not
  offered: the mode chip (019 FR-292, 020 FR-320) stays the only control over what the agent may do.
- **D-025-3 — a remembered list before the first message** (Q3): the list arrives only when a session
  opens, which happens with the first message. Hallpass remembers each agent's last reported list on this
  computer and offers it before the first message; the choice is applied after the session opens and
  before the first message reaches the agent. A remembered choice the agent no longer offers falls back to
  the agent's own default, and the owner is told.
- **D-025-4 — the default is the last choice; the agent's settings are never written** (Q4): a new
  conversation with an agent starts with the model and effort last chosen for that agent; with nothing
  chosen yet, with the agent's own default. Hallpass never changes the agent's own configuration files.
- **D-025-5 — change between turns, leave a line** (Q5): the model and effort can be changed in a running
  conversation while no turn runs; each change that takes effect leaves one line in the conversation.
- **D-025-6 — re-applied when a conversation continues** (Q6): a conversation continued after an idle stop,
  an unexpected end or from the conversation list is put back on its own model and effort before the
  owner's next message is sent.
- **D-025-7 — a refused change keeps the current model** (Q7): when the agent refuses a change, the
  conversation keeps the model it had, shows the agent's own error text, and does not retry. Hallpass never
  sends a typed command to the agent as a substitute.
- **D-025-8 — where it lives and what it is called** (Q8): the picker is a chip in the composer's chip row;
  models are shown by the names the agent reports. Version 0.17.0; the extension and the local helper
  program upgrade together.
- **D-025-9 — layout A** (prototype pick): one chip after the mode chip, reading the model and, when not
  the default, the effort ("Opus 5.5 · High"). Its popup lists the models, then the effort levels as a row
  of choices below a divider; picking keeps the popup open so both can be changed in one visit.
- **D-025-10 — the settings page is unchanged** (Q9): no default model or effort is set on the settings
  page; the picker is the only place.
- **D-025-11 — the session options win** (main session): when an agent reports both its session options
  and the older model list, the session options are used. The remembered list is replaced every time a
  session of that agent opens.
- **D-025-12 — an effort the new model does not offer** (main session): when a change of model leaves the
  chosen effort unoffered, the conversation shows the effort the agent now reports, and the change's line
  says so.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pick a model before the first message (Priority: P1)

In a new conversation the owner opens the model chip, sees the models the agent offered last time, picks
one and, for Claude Code or Codex, a reasoning effort, and sends the first message. The agent answers on
that model.

**Why this priority**: this is the request of issue #15; the first message is where the owner decides
cost and quality.

**Independent Test**: with a remembered list for Claude Code, pick a non-default model and an effort, send
a message, and observe that the session was switched to both before the message reached the agent; with no
remembered list, the chip offers only the agent's default and says why.

**Acceptance Scenarios**:

1. **Given** Claude Code with a remembered list, **When** the owner opens the model chip in a new
   conversation, **Then** the popup lists the remembered models with the agent's default first and marked
   recommended, the current choice checked, and below a divider the effort levels the agent reported.
2. **Given** the owner picks a model and then an effort, **Then** the popup stays open, the chip reads
   "<model> · <effort>", and nothing is sent to the agent yet.
3. **Given** the owner sends the first message, **Then** the session is switched to the chosen model and
   effort before the message is passed to the agent, and the conversation shows no change line for it.
4. **Given** an agent with no remembered list (first use on this computer), **When** the owner opens the
   chip, **Then** it offers only "Default" with the line "The list of models appears once the conversation
   starts."; after the first message the chip shows what the agent reports.
5. **Given** Hermes or DeepSeek, **Then** the popup lists models only and the chip shows the model only.
6. **Given** the owner switches the new conversation to another agent before sending, **Then** the chip
   shows that agent's last choice or its default.

---

### User Story 2 - Change the model during a conversation (Priority: P1)

Between two turns the owner changes the model or effort; the next message goes to the new model, and the
conversation shows a line recording the change. When the agent refuses, the owner sees why and the
conversation carries on with the old model.

**Why this priority**: switching to a cheaper or stronger model mid-task is the second half of the request.

**Independent Test**: in a running Codex conversation change the model and the effort; two lines appear
and the next turn runs on the new values. Make the agent refuse a switch; a notice shows its error, the
chip still shows the old model, and no retry happens.

**Acceptance Scenarios**:

1. **Given** a conversation with no turn running, **When** the owner picks another model, **Then** the
   agent is switched, the chip shows the new model, and one line "Model changed to <model>" appears.
2. **Given** the owner picks another effort, **Then** one line "Reasoning effort changed to <effort>"
   appears.
3. **Given** a turn is running or a permission card waits, **Then** the chip is shown but cannot be opened
   and says the model can be changed once the answer is finished; pressing Stop makes it available.
4. **Given** the agent refuses the change, **Then** a notice says "<agent> did not switch to <model> and
   keeps using <current>" with the agent's own error text, the chip shows the current model, and Hallpass
   neither retries nor sends any typed command instead.
5. **Given** a model change after which the chosen effort is not offered, **Then** the chip shows the
   effort the agent now reports and the change line names it (D-025-12).
6. **Given** a conversation started before this feature's upgrade, **When** the owner opens it, **Then**
   the chip shows what the agent reports for it once it is running.

---

### User Story 3 - A continued conversation keeps its model (Priority: P2)

A conversation stopped for being idle, ended unexpectedly, or reopened from the conversation list continues
on the model and effort it had.

**Why this priority**: without it a long task silently falls back to the agent's default after ten idle
minutes.

**Independent Test**: choose a non-default model, let the agent be stopped as idle, send the next message;
the agent is put back on the model before that message reaches it. Reopen the conversation from the list
after a browser restart; the same holds.

**Acceptance Scenarios**:

1. **Given** a conversation on a chosen model whose agent was stopped as idle (019 FR-297), **When** the
   owner sends the next message, **Then** the agent is put back on that model and effort before the message
   is passed on, and no change line is added.
2. **Given** the conversation list entry of that conversation, **When** it is opened and continued,
   **Then** the same happens; the list keeps each conversation's model and effort.
3. **Given** the model is no longer offered when the conversation continues, **Then** the conversation uses
   the agent's default and shows a notice "<agent> no longer offers <model>; using its default model."
4. **Given** the agent refuses to be put back on the model, **Then** the notice of User Story 2 scenario 4
   appears and the message is still sent, on the model the agent has.

---

### User Story 4 - The remembered list follows the agent (Priority: P3)

When an agent's offer changes (a new model, a removed one, another account), the picker follows it the
next time a session of that agent opens.

**Independent Test**: start a session with a fake agent that reports list X, then one that reports list Y;
the next new conversation offers Y. With a remembered choice that is not in Y, the new conversation starts
on the agent's default with the notice.

**Acceptance Scenarios**:

1. **Given** a session of an agent opens, **Then** that agent's remembered list is replaced by what it
   reported.
2. **Given** the remembered choice is missing from the new list, **When** the next conversation starts,
   **Then** it uses the agent's default and shows the no-longer-offered notice once.
3. **Given** an agent that reports no models at all, **Then** no model chip is shown for it and nothing is
   remembered.

### Edge Cases

- An agent reports the older model list and the session options: the session options are used (D-025-11).
- An agent reports a list but rejects the switch at the start of a conversation: the first message is still
  sent, on the agent's model, after the refusal notice.
- A long list (Hermes reports 18 entries): the popup scrolls; a long name is shortened with an ellipsis and
  the full name is available to the pointer and to screen readers.
- The agent changes its model on its own and reports it: the chip shows what the agent reports; no change
  line is added for a change the owner did not make.
- A DeepSeek conversation's mode is fixed once started (021 FR-360): its model can still be changed.
- Two browsers on the same computer: both offer the same remembered lists and last choices, as the list is
  kept by the local helper program.
- The helper program is older than the extension: the existing version pairing refuses the pair, as
  today; no partial picker is shown.
- The agent ends unexpectedly while a switch is in progress: the conversation says the agent ended (019
  FR-298); continuing it applies the chosen model as in User Story 3.
- A narrow panel (320 px): the chip row wraps; the model chip and Send stay usable without sideways
  scrolling.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-398**: For every side-panel agent that reports selectable models, the composer MUST show one model
  chip after the mode chip, reading the current model and, when it is not the default, the reasoning
  effort. Its popup MUST list the models by the names the agent reports, the agent's default first and
  marked recommended where the agent has one, the current one checked, and, where the agent reports
  effort levels, those levels below a divider; picking MUST keep the popup open (D-025-8, D-025-9).
- **FR-399**: The picker MUST offer only the model and the reasoning effort. The agent's own modes, fast
  mode, collaboration mode and any other session option MUST NOT be offered or changed by it (D-025-2).
- **FR-400**: Hallpass MUST remember, on this computer, each agent's last reported list of models and
  efforts and the model and effort last chosen for it, replacing the list each time a session of that agent
  opens, and MUST offer them before the first message; with no list, the chip MUST offer only "Default"
  and say the list appears once the conversation starts (D-025-3, D-025-11).
- **FR-401**: A new conversation MUST start with the model and effort last chosen for its agent, or the
  agent's own default when none was chosen; the choice MUST be applied after the session opens and before
  the first message is passed to the agent, and MUST NOT add a change line (D-025-3, D-025-4).
- **FR-402**: Hallpass MUST NOT write to any agent's own configuration to change its model or effort
  (D-025-4; 021 FR-349 unchanged).
- **FR-403**: In a running conversation, the model and effort MUST be changeable only while no turn runs
  and no permission card waits; otherwise the chip MUST be shown, not open, reachable by keyboard and screen
  reader, and say when it can be changed (D-025-5).
- **FR-404**: Each change the agent accepts during a conversation MUST add one line naming the new model
  or effort; when a model change leaves the chosen effort unoffered, the line MUST also name the effort the
  agent now reports (D-025-5, D-025-12).
- **FR-405**: When the agent refuses a change, the conversation MUST keep its model, show a notice naming
  the refused and the kept model with the agent's own error text, and MUST NOT retry or send any typed
  command instead (D-025-7).
- **FR-406**: A conversation continued after an idle stop, an unexpected end or from the conversation list
  MUST be put back on its model and effort before the next message is passed to the agent; the
  conversation list MUST keep each conversation's model and effort with its other details (019 FR-304)
  (D-025-6).
- **FR-407**: A remembered or kept model the agent no longer offers MUST be replaced by the agent's default,
  with one notice saying so (D-025-3).
- **FR-408**: When an agent reports both its session options and the older model list, the session options
  MUST be used; Hermes, which reports only the older list, MUST be switched through it (D-025-1, D-025-11).
- **FR-409**: The chip MUST show what the agent reports after each change, including a change the agent
  makes itself, which adds no line.
- **FR-410**: The remembered lists and choices MUST stay on this computer, MUST NOT appear in anything
  Hallpass publishes, and MUST NOT be sent anywhere but to the agent they came from.
- **FR-411**: All new text MUST exist in English and zh-TW; the chip and popup MUST meet the 006/020
  keyboard, screen-reader and contrast bar (020 FR-323); at a panel width of 320 px the chip row MUST
  stay usable without sideways scrolling.
- **FR-412**: The settings page MUST NOT gain any model or effort setting (D-025-10). Conversations,
  modes, permission cards, attachments and external agents MUST behave as in 0.16.1 apart from the model
  and effort the agent uses.

### Key Entities

- **Agent model offer**: per agent on this computer — the models the agent last reported (its id, name,
  optional description, whether it is the default), the effort levels it reported (if any), the means by
  which it reports them (session options or older model list), and when it was reported.
- **Agent model choice**: per agent on this computer — the model and effort last chosen.
- **Conversation model**: per conversation — the model and effort the conversation uses; kept in the
  conversation list entry with title, agent, folder and mode (019 FR-304).
- **Model change line** and **model notice**: entries in a conversation's view — a change taken (model or
  effort, new value), a refusal (asked, kept, agent's text), or a no-longer-offered replacement.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-178**: The owner can choose the model, and for Claude Code and Codex the effort, of a new
  conversation before sending the first message, with at most three presses after opening the chip.
- **SC-179**: In 100% of new and continued conversations with a chosen model, the agent is on that model
  before the first or next message reaches it (checked with a stand-in agent that records the order).
- **SC-180**: Every accepted change in a conversation leaves exactly one line; a refused change leaves the
  model unchanged and shows the agent's text, with no retry.
- **SC-181**: No agent's own configuration file is changed by any picker action (checked by comparing the
  files before and after the tests).
- **SC-182**: The picker adds no model call: opening the chip and choosing a model or effort make no request
  to any model before the owner sends a message.
- **SC-183**: Every control of the picker can be reached and used by keyboard alone, in both languages and
  both themes, at 320 px and 380 px panel width.

## Assumptions

- Switching a model at the start of a conversation is done inside the session the first message opens;
  the first message waits for it. The switch is local to the agent's process and makes no model call.
- An agent's default entry is the one it marks as its default; an agent without one (Codex, Hermes) has
  its current model preselected and no "Default" entry.
- The extension and the local helper program are released together as 0.17.0; the conversation frames
  gain the model and effort, which is a contract change of both.
- Released with 0.17.0, as their own small slices and outside this spec's requirements (fixes, change logs
  of 024 where needed): #18 (DeepSeek's download size on its settings card; sized 2026-10-26: the size is
  already known, a text change), #19 (settings-page polish points) and #20 (timing of the packaged gate's
  cold-broker case).
- Out of scope: the agent's own modes, fast mode and collaboration mode; a model default on the settings
  page; a custom agent; editing an agent's skills or tool servers (#21); typed slash commands.

## Change log

- **2026-10-26 — written** from grill Q1–Q10 and prototype pick A (owner); D-025-11 and D-025-12 stated in
  the confirmed summary.
- **2026-10-26 — review round 1** (code review of the combined diff): the index entry also follows the
  agent's own model change, so a resume ends on what the agent last reported (R-404, R-406); the start may
  carry a reasoning effort alone when no model is known (contracts/frames.md START). The per-agent store's
  choice stays the owner's last choice.
- **2026-10-26 — gate L7/L8** (packaged gate, en/zh): a model and then an effort picked right away between
  turns lost the effort, because the second change was refused while the first was in flight. A change
  that arrives during another now waits behind it (at most four wait) and is applied in order; a change
  cut short by the agent's exit says the agent stopped, not that it refused (contracts/frames.md,
  data-model.md).
- **2026-10-26 — real-agent probe (T825, owner decision)**: Claude Code and Codex accept a model and an
  effort change; DeepSeek offers one model and no effort. Hermes offers its models from two providers
  and refuses a model of the other provider (an internal error, after 114 s); the conversation keeps its
  model and shows the refusal, as FR-405 says. The owner accepts this as Hermes's own limitation: SC-181
  and the offer hold for all four, the accepted switch for three. The README says so.
- **2026-10-26 — a bound on a change (owner decision)**: from the same probe, a model change the agent
  takes minutes to answer kept the conversation from taking a message the whole time, and held the first
  message of a start behind it. Every model or effort change the agent has not answered within 30 s now
  ends as a refusal naming the wait (FR-405): the model stays, queued changes and messages go on, and a
  late switch the agent reports afterwards is followed (contracts/frames.md, data-model.md).
