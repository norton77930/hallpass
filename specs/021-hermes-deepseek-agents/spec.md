# Feature Specification: Hermes and DeepSeek in the Side-Panel Conversation

**Feature Branch**: `021-hermes-deepseek-agents` (git: written on `feature-022-composer-attachments`, which
ships with it as 0.15.0)

**Feature Directory**: `specs/021-hermes-deepseek-agents`

**Created**: 2026-10-21

**Status**: Draft. Every decision below was put to the owner in grill rounds G1–G31 (2026-10-20) and
Q32–Q42 (2026-10-21) and **confirmed by the owner** ("都照建議"). The consent behaviour was measured on
2026-10-21 against a scripted stand-in model; the run on the owner's own model (Q37) is still to come and
is a release condition (SC-157).

**Input**: Owner, 2026-10-20: after Claude Code and Codex, the first two further agents are Hermes Agent and
DeepSeek Harness ("我們比較常用"); the others (OpenCode, CodeBuddy, Cursor, Grok, Pi) come later, one at a
time. Hermes and DeepSeek are not tied: 0.15.0 ships whichever passes (G30).

**Decisions (D-021-n, confirmed by the owner)**:

- **D-021-1 — the asking bar** (G8): an agent is offered in the panel only if, in the panel's strict mode,
  it asks before every edit inside the conversation folder and every command, either by itself or because
  Hallpass starts it with settings that make it so. Measured per agent before release.
- **D-021-2 — Hermes runs natively** (G28, Q34): Hermes Agent 0.22.2 on Windows itself, never through WSL.
  Its command tool needs Git for Windows; missing Git is shown as setup guidance.
- **D-021-3 — the owner installs Hermes** (Q38): Hermes is a full program the owner sets up with its own
  model choice, so Hallpass does not install it. Hallpass finds an installed Hermes the way it finds the
  Claude CLI, checks its version, and otherwise shows how to install the tested version (the official
  installer, pinned to the tested release).
- **D-021-4 — Hermes strict = no commands** (Q33, Q39): Hermes by itself asks before edits but runs
  ordinary commands without asking. In strict, Hallpass starts Hermes with its command, code-running and
  helper-agent tools switched off, through a Hallpass-owned settings layer; edits still ask. The owner's
  own Hermes settings, model and keys are not changed.
- **D-021-5 — Hermes automatic mode** (Q39, D-019-2): the panel's automatic mode is Hermes' own
  "accept edits" mode with commands on; Hermes' own check of dangerous commands is its reviewer. Hermes'
  "never ask" mode is never offered. Note for the owner: unlike Codex, Hermes has no folder boundary for
  commands in automatic mode.
- **D-021-6 — saved logins stay out** (Q39): Hermes' tool for saved logins and payment cards is switched
  off in every mode when Hermes runs from the panel.
- **D-021-7 — the official DeepSeek Harness** (Q35, G29): the DeepSeek agent is DeepSeek's own Harness at
  the exact tested pre-release 0.2.1-rc.2, fetched by Hallpass on first use like the Claude and Codex
  helpers, with every package pinned. The community packages that wrap it are not used.
- **D-021-8 — DeepSeek's two modes are its sandbox** (Q35): DeepSeek has no modes of its own. Strict =
  read-only sandbox (it asks before every edit and command); automatic = the folder sandbox (in-folder
  edits and commands run, anything outside the folder asks). Full access is never used. Its default when
  nothing is said is the folder sandbox, so strict is always set explicitly.
- **D-021-9 — DeepSeek sends no usage data** (Q40): Hallpass starts DeepSeek with its usage reporting off.
- **D-021-10 — DeepSeek's consent cards** (Q42): DeepSeek's question names only an action id. The card shows
  the command and reason from the action the agent announced just before; when none matches, the card says
  the action is unknown and offers only Reject.
- **D-021-11 — DeepSeek's slow start** (Q41): a cold start can take several minutes. The panel shows that it
  is starting, that the first start can take a few minutes, and a Cancel button. Starting it ahead of time
  is a later step.
- **D-021-12 — keys and models stay with the agents** (G31, Q32): Hallpass has no key field and never reads,
  shows or stores a key. Hermes uses its own settings; DeepSeek uses its own settings and the owner's
  environment. Either may point at a local model. DeepSeek has no account login, so the DeepSeek web chat
  cannot be used. When an agent cannot reach its model or has no key, the panel says so and where to set it.
- **D-021-13 — what each agent accepts** (D-022-6): Hermes accepts images but not page context; DeepSeek
  accepts images but not page context with the owner's model (R-355; it depends on the configured model).
  The "+" menu follows what each agent says when it starts; files work for both.
- **D-021-14 — old conversations** (D-019-6): Hermes replays an old conversation; DeepSeek cannot, so
  opening an old DeepSeek conversation says the earlier messages cannot be shown and continues it.
- **D-021-15 — scope** (G3, G26): English and zh-TW; keyboard and screen-reader access at the 006/020 bar.
  The Claude/Codex helper upgrades (G3) are not part of 021; they follow as their own change because the
  Codex strict shim has to be measured again.
- **D-021-16 — DeepSeek's mode is fixed once its conversation has started** (owner, 2026-10-22; R-359):
  DeepSeek keeps the permission mode its session was created with, and a continued session ignores the
  mode Hallpass starts it with, so switching by restarting it (R-351) would leave the panel showing a mode
  DeepSeek does not run in. Before the first message the owner picks the mode and the first start uses it;
  afterwards the mode chip shows the mode but offers no switch and says that another mode needs a new
  conversation, and the broker refuses a switch (`mode-fixed`) without restarting anything. Claude Code,
  Codex and Hermes still switch during a conversation.

## Why this feature exists

The owner and the QA team use Hermes and DeepSeek more than the two agents the panel offers today. 019
built the panel conversation around agents that speak the Agent Client Protocol; 020 made the agent a
choice in the composer; 022 added attachments. 021 adds the two agents without lowering the panel's
promise: in strict mode nothing in the owner's folder changes without asking.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Work with Hermes in strict mode (Priority: P1)

The owner picks Hermes in the composer, types a request and works with it like with Claude Code: replies
stream, actions are listed, and every edit asks first. Hermes cannot run commands in strict mode.

**Why this priority**: Hermes is one of the two agents asked for; strict is the default mode.

**Independent Test**: with Hermes installed, ask it to edit a file and to run a command in the
conversation folder; the edit shows a permission card and the command is not run.

**Acceptance Scenarios**:

1. **Given** Hermes 0.22.2 is installed and set up, **When** the owner sends a message with Hermes picked,
   **Then** the reply streams in and every action Hermes reports is listed.
2. **Given** strict mode, **When** Hermes wants to edit a file in the folder, **Then** a permission card asks
   first and rejecting leaves the file unchanged.
3. **Given** strict mode, **When** the owner asks Hermes to run a command, **Then** no command runs and Hermes
   says it cannot.
4. **Given** any mode, **When** Hermes runs from the panel, **Then** its saved-logins tool is not available.
5. **Given** the owner's own Hermes settings, **When** Hermes runs from the panel and afterwards from its own
   terminal, **Then** the owner's settings, model and keys are unchanged.

---

### User Story 2 - Work with DeepSeek in strict mode (Priority: P1)

The owner picks DeepSeek. On first use Hallpass fetches it (first-use card, as for Claude and Codex). The
first start takes a while and the panel says so. In strict mode DeepSeek asks before every edit and command.

**Why this priority**: DeepSeek is the other agent asked for.

**Independent Test**: on a machine without the DeepSeek helper, pick DeepSeek, agree on the first-use card,
wait for the start, ask for an edit and a command; both ask first.

**Acceptance Scenarios**:

1. **Given** DeepSeek was never used, **When** the owner sends a message with DeepSeek picked, **Then** the
   first-use card names what will be fetched; agreeing fetches it and sends the held message.
2. **Given** DeepSeek is starting, **Then** the panel shows that it is starting, that the first start can take
   a few minutes, and a Cancel button that stops the start.
3. **Given** strict mode, **When** DeepSeek wants to edit, create, delete or run a command, **Then** a
   permission card asks first, showing the command or file and the reason DeepSeek gave.
4. **Given** a DeepSeek question that matches no announced action, **Then** the card says the action is
   unknown and offers only Reject.
5. **Given** DeepSeek runs from the panel, **Then** it sends no usage data.

---

### User Story 3 - Automatic mode per conversation (Priority: P2)

The owner switches one conversation to automatic. Hermes then edits without asking and runs commands
unless its own check finds them dangerous; DeepSeek edits and runs commands inside the folder and asks for
anything outside it.

**Independent Test**: switch each agent to automatic and repeat the edit, command and outside-the-folder
requests; compare with the table in D-021-5 and D-021-8.

**Acceptance Scenarios**:

1. **Given** automatic mode with Hermes, **When** it edits in the folder, **Then** no card is shown and the
   action is listed.
2. **Given** automatic mode with DeepSeek, **When** it writes outside the conversation folder, **Then** a card
   asks first.
3. **Given** any agent, **Then** a mode that approves everything is never offered, and a new conversation
   starts strict unless the owner chose automatic before its first message (FR-361).
4. **Given** a DeepSeek conversation that has started, **When** the owner looks at its mode, **Then** the mode
   is shown, cannot be switched, and the panel says another mode needs a new conversation (D-021-16).

---

### User Story 4 - Setup that explains itself (Priority: P1)

The agent list shows each agent's state. Whatever is missing is named with what to do, in the panel's
language.

**Independent Test**: on a machine with neither agent set up, open the agent list; then install Hermes
without Git, then with another version; each state reads correctly.

**Acceptance Scenarios**:

1. **Given** Hermes is not installed, **Then** the list shows "not installed" with how to install the tested
   version.
2. **Given** a different Hermes version, **Then** the list shows "version mismatch" with the installed and
   the tested version, and Hermes cannot be picked.
3. **Given** Git for Windows is missing, **Then** Hermes shows that Git is needed for it to work.
4. **Given** DeepSeek not yet fetched, **Then** the list shows "needs download".
5. **Given** an agent that cannot reach its model or has no key, **When** a message is sent, **Then** the
   conversation says the model could not be reached or the key is missing, and where that is set; no key is
   asked for or shown.

---

### User Story 5 - Attachments and old conversations (Priority: P2)

Attachments follow what each agent accepts; old conversations open as far as each agent allows.

**Acceptance Scenarios**:

1. **Given** Hermes, **Then** images and files can be attached and "Attach this tab" is disabled with the
   reason (a PDF tab still works as a file).
2. **Given** DeepSeek, **Then** only files can be attached; the image and tab entries are disabled with the
   reason.
3. **Given** an old Hermes conversation, **When** opened, **Then** its messages are replayed.
4. **Given** an old DeepSeek conversation, **When** opened, **Then** the panel says the earlier messages cannot
   be shown, and a new message continues the conversation.

---

### User Story 6 - Nothing else changes (Priority: P1)

Claude Code, Codex, external agents over the bridge and every 0.14.0 and 022 behaviour work as before.

### Edge Cases

- Hermes is installed twice (two copies on the path): the first one found is used and its version checked.
- The owner's own Hermes settings already switch some tools off: the panel's strict list still applies.
- DeepSeek's start is cancelled, or the panel is closed during the start: no DeepSeek process is left behind.
- The DeepSeek fetch fails half-way: the next attempt starts clean and the agent shows "needs download".
- A DeepSeek pre-release update is published: Hallpass keeps the tested version until a new release of
  Hallpass moves it.
- The model behind an agent rejects a request mid-conversation (quota, network): the conversation shows the
  agent's error and stays usable.
- The owner switches a running conversation's mode: the change takes effect as for Claude and Codex (the
  agent is restarted with the other settings when it cannot switch while running).
- An agent asks for permission while the panel is closed: the card waits, as in 019.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-343**: The agent list MUST offer Hermes and DeepSeek beside Claude Code and Codex, each with its state
  (ready, needs download, not installed, version mismatch, setup needed) and the action that fixes it.
- **FR-344**: Hallpass MUST find an installed Hermes the way it finds the Claude CLI and MUST treat any version
  other than the tested one as "version mismatch" that cannot be picked, showing both versions.
- **FR-345**: Hallpass MUST NOT install Hermes or Git; it MUST show how to install the tested Hermes release
  and that Git for Windows is needed when Git is missing.
- **FR-346**: In strict mode Hermes MUST be started with its command, code-running and helper-agent tools off;
  edits MUST ask first through a permission card.
- **FR-347**: In automatic mode Hermes MUST run in its "accept edits" mode with commands on; its "never ask"
  mode MUST never be used.
- **FR-348**: Hermes' saved-logins tool MUST be off in every mode when started from the panel.
- **FR-349**: Starting Hermes from the panel MUST NOT change the owner's Hermes settings, model or keys; the
  settings Hallpass adds MUST live in a folder Hallpass owns.
- **FR-350**: DeepSeek MUST be fetched on first use, after the first-use card, at the exact tested version with
  every package pinned and no install scripts run.
- **FR-351**: DeepSeek MUST be started read-only in strict mode and with the folder sandbox in automatic mode;
  full access MUST never be used; the sandbox MUST always be set explicitly.
- **FR-352**: DeepSeek MUST be started with its usage reporting off.
- **FR-353**: A DeepSeek permission card MUST show the command or file and the reason taken from the action
  DeepSeek announced with the same id; with no match it MUST say the action is unknown and offer only Reject.
- **FR-354**: While an agent starts, the conversation MUST show that it is starting; for DeepSeek it MUST add
  that the first start can take a few minutes; a Cancel button MUST stop the start and leave no process.
- **FR-355**: Hallpass MUST NOT ask for, read, show, log or store any key; when an agent reports a missing key
  or an unreachable model, the conversation MUST say so and name where the agent's own setting lives.
- **FR-356**: The "+" menu MUST follow what each agent says it accepts (D-022-6): Hermes images and files,
  DeepSeek images and files as measured with the owner's model (R-355); neither takes page context.
- **FR-357**: Opening an old Hermes conversation MUST replay it; opening an old DeepSeek conversation MUST say
  the earlier messages cannot be shown and let the owner continue it.
- **FR-358**: Every new text MUST exist in English and zh-TW; the new list entries, states, cards and buttons
  MUST be reachable by keyboard and named for screen readers.
- **FR-359**: Claude Code, Codex, external-agent and 022 attachment behaviour MUST stay as in the 022 build.
- **FR-360** (D-021-16): Once a DeepSeek conversation has started, its mode MUST NOT change: the panel's mode
  chip MUST show the mode, offer no switch, stay reachable by keyboard and screen reader (`aria-disabled`)
  and say, in English and zh-TW, that another mode needs a new conversation; the broker MUST refuse a
  switch with `mode-fixed` and MUST NOT restart DeepSeek for it; a continued DeepSeek conversation MUST keep
  the mode it started with (an exception to "every resume starts strict").
- **FR-361** (D-021-16, R-360): For every agent, the mode chosen on the empty conversation's chip before the
  first message MUST be the mode the first start uses and the started conversation shows; the panel MUST
  send it with `ui.conversation.start` and MUST NOT switch the mode beside the first message.

### Key Entities

- **Agent description**: name, how it is found or fetched, the tested version, how strict and automatic map
  onto its own settings, what it accepts, whether it replays old conversations, setup hints.
- **Agent state**: ready, needs download, not installed, version mismatch, setup needed (with the reason).
- **Hallpass settings layer for Hermes**: the tools switched off per mode, in a Hallpass-owned folder.
- **Announced action**: an agent's reported action with its id, command or file and reason, used to fill a
  permission card.

## Success Criteria *(mandatory)*

- **SC-155**: In strict mode, 0 of the measured edit, create, delete and command requests take effect without a
  permission card, for each new agent, on the scripted stand-in model.
- **SC-156**: In strict mode Hermes runs 0 commands, even when its model asks for the command tools by name.
- **SC-157**: SC-155 and SC-156 also hold on the owner's own model before release (Q37).
- **SC-158**: The owner's Hermes settings files are byte-identical before and after a panel session.
- **SC-159**: A DeepSeek start can be cancelled at any moment and leaves no DeepSeek process within 5 seconds.
- **SC-160**: Every setup state in FR-343 is shown correctly on a machine prepared for it, in English and zh-TW,
  light and dark, and reviewed one screenshot at a time.
- **SC-161**: No key value appears in any panel text, log or file Hallpass writes (checked by searching the logs
  and Hallpass folders for the test key after a session).
- **SC-162**: Every existing test and the packaged conversation gate pass; Claude Code and Codex conversations
  behave as in the 022 build.

## Assumptions

- Hermes 0.22.2 and DeepSeek Harness 0.2.1-rc.2 behave on the owner's machine as measured on 2026-10-21.
- The owner's Hermes and DeepSeek are already set up with a model (local or cloud) by the owner.
- Only the tested Hermes version is allowed, because the asking bar was measured on it.
- A Hermes start takes about half a minute; its first conversation can take a few minutes.
- The DeepSeek pre-release may change incompatibly; moving to a new version is a new Hallpass release with the
  asking bar measured again.

## Out of Scope

Pi, OpenCode, CodeBuddy, Cursor, Grok and Gemini; WSL; installing Hermes or Git; storing or entering keys;
starting DeepSeek ahead of time; the Claude/Codex helper upgrades (G3, a separate change); the first message
lost when switching panel tabs (a separate fix).

## Change log

- **2026-10-22 — D-021-16, FR-360, FR-361** (R-359, R-360; T695–T700): DeepSeek's mode is fixed once its
  conversation has started (replaces the DeepSeek half of R-351 and T663); a new conversation of any agent
  starts in the mode chosen before its first message, carried by `ui.conversation.start` (`mode`, optional),
  instead of a switch sent beside the first message. Contract: `CONVERSATION_MODE_FIXED_AGENTS`, error code
  `mode-fixed`.
- **2026-10-22 — FR-361 fix** (T701): the mode chosen for one new conversation no longer carries to the next
  new conversation in the same panel; each starts in Ask first unless the owner picks automatic for it.
- **2026-10-22 — live verification** (dev host on the owner's machine; T683–T689, T692, T693): Hermes strict asks
  before an edit (Reject leaves `a.txt` absent) and has no command tool; switching to Agent review restarts
  Hermes, keeps the conversation and gives it the command tools (shown by the request dump); the owner's Hermes
  settings (`config.yaml`, `auth.json`, `SOUL.md`) are byte-identical, only Hermes' own runtime state
  (`provider_models_cache.json`, `state.db`) changes. DeepSeek: the first download measured 32.6 min, over the
  30 min target; about 39 min of earlier downloads was spent in "Checking the download and putting it in
  place" - follow-up, cause not measured, possibly antivirus scanning. Cancel during start leaves no process
  within 5 s; strict shows the card and Reject keeps the file absent; the mode is fixed after the start
  (D-021-16) and a mode chosen before the start applies (FR-361); a new conversation is back on Ask first
  (T701, confirmed live). The reject-only card never arose on the real DeepSeek (every real card matched an
  announced `tool_call`); it is covered by the test-mode fake DeepSeek scenario only. See R-361 for a known
  Hermes limitation after a mode change.
- **2026-10-23 — FR-360 follow-up** (review LOW items): the conversation itself refuses a DeepSeek mode change
  `mode-fixed` once it has a session or is starting, not only the pool, so no caller can restart it in another
  mode; a switch during the first start is refused and starts no second run, and a set to the mode that start
  carries is answered ok (it was refused `mode-fixed` before the agent was spawned).
- **2026-10-23 — FR-356 / D-021-13 text** (owner): DeepSeek accepts images, as R-355 measured and the code
  already does; the earlier "files only" text predated that measurement. No behaviour change.
- **2026-10-23 — install no longer renames the installed tree** (owner; R-362): the 2026-10-22 "putting it in
  place" time was measured: under a real-time file scanner the rename of DeepSeek's `npm ci` tree into
  `agents\<agent>\<version>` took 41.2 min of a 49.7 min install. Every fetched package (both adapters and
  DeepSeek) now stays in the folder `npm ci` ran in, and a small pointer file names it once it is verified;
  installs made by 0.15.0 and earlier keep working without a download.
