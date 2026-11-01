# Feature Specification: A Hallpass Skill for Outside Coding Agents

**Feature Branch**: `feature-026-agent-skill` (from main ac53ea9, 0.17.0)

**Feature Directory**: `specs/026-agent-skill`

**Created**: 2026-10-28

**Status**: Draft. D-026-1 and D-026-2 put to the owner on 2026-10-28 and accepted as recommended
("依照你建議"); the rest are the main session's defaults, listed under Assumptions.

**Input**: Issue #16, a follow-up from the 024 settings-page discussion: outside coding agents (Claude
Code, Codex and others the owner connects to Hallpass) learn how to use the browser only from the tool
descriptions. A small skill shipped with Hallpass should tell them how the tools fit together, how
consent works, and what to do when an action is declined or a card times out.

**Facts checked 2026-10-28**:

- An ordinary agent session that connects to Hallpass is given no server instructions at all; only a
  conversation started from the side panel is given one line ("You were started from the Hallpass side
  panel; …", 019 R-322). So a skill repeats nothing the agent is already told.
- What an agent learns today is each tool's own description. Nothing tells it that the first call asks
  the owner to pair, that a page-changing action waits for a consent card, that a declined or timed-out
  card is the owner's answer, or that reads never ask.
- An agent that does not know a declined card is final may try the same action again, which shows the
  owner the same card again.

**Decisions (D-026-n, confirmed by the owner)**:

- **D-026-1 — both user-level skill folders** (Q1): the skill is installed into the owner's user-level
  skills folder of Claude Code and into the user-level shared agents' skills folder that Codex and other
  agents read. Nothing is installed into a repository: a project-level copy could be committed into the
  owner's project by accident.
- **D-026-2 — the settings page** (Q2): the state of each folder and the Install / Update actions are a
  section of the settings page. The installer does not install the skill; an update after an upgrade is
  seen the next time the settings page is opened.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The agent knows how Hallpass works before its first call (Priority: P1)

The owner installs the Hallpass skill for their coding agent. In a new session the owner asks the agent
to do something in the browser. The agent uses the browser tools in a sensible order (look at the tabs,
read the page, then act), tells the owner that a pairing card or a consent card is waiting for them in
the side panel, and does not treat waiting for the owner as an error.

**Why this priority**: this is the point of issue #16; every other story depends on the skill existing
and being found by the agent.

**Independent Test**: install the skill, start a fresh agent session against an unpaired browser, ask for
a task on a page; the agent's first reply mentions the pairing card, and after pairing its calls read the
page before acting on it.

**Acceptance Scenarios**:

1. **Given** the skill is installed for an agent, **When** the owner starts a new session of that agent,
   **Then** the agent can list the Hallpass skill among its skills without the owner naming it.
2. **Given** an unpaired browser, **When** the agent's first browser call waits for pairing, **Then** the
   agent tells the owner a pairing card is waiting in the Hallpass side panel.
3. **Given** a site in mode `ask`, **When** the agent performs a page-changing action, **Then** it says
   that the owner is asked to approve it in the side panel, rather than reporting a failure.
4. **Given** a multi-step task on one site, **Then** the skill tells the agent that a batch of steps can
   be approved once as a plan when the owner has chosen `follow-a-plan` for that site, and that several
   sites can be proposed once with a site plan.

---

### User Story 2 - A declined or timed-out action is reported, not retried (Priority: P1)

The owner declines a consent card, or does not answer it in time. The agent tells the owner what was not
done and why, and asks how to continue. It does not send the same action again on its own.

**Why this priority**: an agent that retries a declined action shows the owner the same card again and
again; this is the behaviour the issue names as the one to prevent.

**Independent Test**: with the skill installed, decline one card; the agent's next message reports the
decline and asks the owner, and no second card for the same action appears.

**Acceptance Scenarios**:

1. **Given** the owner declines a consent card, **Then** the agent reports which action was declined and
   asks the owner what to do next; it does not repeat the action.
2. **Given** a card that timed out unanswered, **Then** the agent reports it the same way and does not
   repeat the action unless the owner asks it to.
3. **Given** the owner ends the session or takes back the tabs, **Then** the agent stops its browser work
   and says so.
4. **Given** a site the owner has not decided about is reached by a navigation, **Then** the agent knows
   the owner is asked at its next call on that tab, and reports the owner's answer.

---

### User Story 3 - The owner installs and updates the skill from Hallpass (Priority: P2)

The owner sees, for each place an agent reads skills from, whether the Hallpass skill is installed, up to
date, out of date or changed by the owner, and can install or update it with one action. Hallpass never
installs it without the owner's action and never overwrites a copy the owner edited without saying so.

**Why this priority**: the skill only helps once it is in the agent's skill folder; installing it by hand
means finding the right folder for each agent.

**Independent Test**: on a computer without the skill, install it from Hallpass; the agent's skill folder
holds a copy whose content matches the shipped one. Change one line of the copy; Hallpass shows it as
changed by the owner. Upgrade Hallpass to a version with a new skill text; Hallpass offers the update.

**Acceptance Scenarios**:

1. **Given** no Hallpass skill in an agent's skill folder, **Then** Hallpass shows "Not installed" for it
   with an Install action.
2. **Given** the owner presses Install, **Then** the skill is copied (a real copy, never a link) into
   that folder and the state reads "Installed".
3. **Given** an installed copy identical to the skill this Hallpass ships, **Then** the state reads
   "Up to date" and no action is offered.
4. **Given** a newer Hallpass ships a different skill text and the installed copy is the older shipped
   text, **Then** the state reads "Update available" with an Update action.
5. **Given** the installed copy differs from every skill text Hallpass has shipped (the owner edited it),
   **Then** the state reads "Changed by you"; Update is offered with a warning that it replaces the
   owner's changes, and nothing is replaced without that action.
6. **Given** the skill folder cannot be written (read-only, missing permission), **Then** Install fails
   with the reason and nothing is half-written.

---

### User Story 4 - Uninstalling Hallpass removes only what it installed (Priority: P3)

When the owner uninstalls Hallpass, a skill copy that is still exactly what Hallpass installed is
removed; a copy the owner changed is left in place and the uninstall says where it is.

**Why this priority**: leaving files behind in another program's folders is untidy, but deleting the
owner's edited copy would be worse.

**Independent Test**: install the skill, uninstall Hallpass; the copy is gone. Install again, edit it,
uninstall; the copy stays and its path is printed.

**Acceptance Scenarios**:

1. **Given** an unchanged installed copy, **When** Hallpass is uninstalled, **Then** the copy is removed.
2. **Given** a changed copy, **When** Hallpass is uninstalled, **Then** the copy stays and the uninstall
   output names its folder.

---

### Edge Cases

- The agent's skill folder does not exist yet (the agent was installed but never used skills): Install
  creates it.
- A folder of the same name holds something that is not a Hallpass skill (the owner's own skill with the
  same name): Hallpass shows it as "Changed by you" and never replaces it without the warning.
- The skill file is present but unreadable: shown as "Cannot read" with the reason; no action replaces it
  silently.
- Two browsers with Hallpass on the same computer: both show the same state, because the skill folder is
  per computer, not per browser.
- A side-panel conversation of the same agent reads the same skill: its text must hold there too (the
  side-panel agent is already paired through the panel and its browser is fixed).
- The owner's agent is not one Hallpass knows: the skill is plain text the owner can copy by hand from the
  public repository (`skills/hallpass/SKILL.md`) or from an installed copy.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-413**: Hallpass MUST ship one skill, in its release package and its public repository, that
  describes for an outside coding agent: how the browser tools fit together (tabs, reading, acting,
  screenshots, batches, site plans, diagnostics and uploads at the level of what each is for); the
  consent model (pairing on first use, the three site modes, reads never ask, a site plan for a
  multi-site task, an undecided site asked at the next call); and what to do when the owner declines, a
  card times out, the session is ended or the tabs are taken back.
- **FR-414**: The skill MUST tell the agent that a declined or timed-out card is the owner's answer: the
  agent reports what was not done and asks the owner; it MUST NOT repeat the same action on its own.
- **FR-415**: The skill MUST NOT ask the agent to bypass, avoid or shorten any consent step, and MUST NOT
  suggest changing a site's mode; changing a mode is the owner's action in the side panel.
- **FR-416**: The skill's text MUST hold for both an outside agent session and a side-panel conversation
  of the same agent.
- **FR-417**: Hallpass MUST install the skill only on an explicit owner action, as a copy of the shipped
  files. It MUST NOT install it by a link of any kind.
- **FR-418**: For each skill location Hallpass supports, Hallpass MUST show one of: Not installed,
  Up to date, Update available, Changed by you, Cannot read, decided by comparing the installed copy's
  content with the content of every skill text Hallpass has shipped.
- **FR-419**: An Update MUST replace the installed copy only on the owner's action; for a copy shown as
  Changed by you, the action MUST first warn that the owner's changes are replaced.
- **FR-420**: An install or update that cannot complete MUST leave the previous copy (or no copy) in
  place, never a partial one, and MUST say why.
- **FR-421**: Uninstalling Hallpass MUST remove an installed copy whose content is exactly a shipped
  skill text, and MUST leave any other copy in place and name its folder in the uninstall output.
- **FR-422 (D-026-1)**: The skill locations Hallpass supports MUST be exactly two, both in the owner's
  home: Claude Code's user-level skills folder and the user-level shared agents' skills folder. Hallpass
  MUST NOT install the skill into any repository or project folder.
- **FR-423 (D-026-2)**: The state of each location and its Install / Update action MUST be shown in a
  section of the settings page. The installer MUST NOT install the skill.
- **FR-424**: The skill MUST be written in English only, and MUST contain no path of the owner's computer
  and no account name (it is public, and the snapshot check applies to it).

### Key Entities

- **Skill**: a folder with one main instruction file (name, one-line description of when to use it,
  the instructions) and nothing executable. Shipped with each Hallpass version.
- **Shipped skill texts**: the content fingerprints of every skill text any Hallpass release shipped, so
  an installed copy can be told apart as current, older-shipped or changed by the owner.
- **Skill location**: one folder an agent reads skills from, with its state (FR-418).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-184**: In a scripted check with the skill installed, after the owner declines one card, the agent
  sends no second request for the same action in that session (0 repeats in 5 runs).
- **SC-185**: With the skill installed, a fresh agent session against an unpaired browser mentions the
  pairing card in its first reply that follows the waiting call, in 5 of 5 runs.
- **SC-186**: Installing from Hallpass takes one action per location, and the state reads "Up to date"
  right after, for every supported location.
- **SC-187**: An owner-edited copy is never replaced without the warning: 0 replacements in a test that
  edits the copy and presses every offered action except the confirmed Update.
- **SC-188**: Uninstall removes 100% of unchanged copies and 0% of changed ones.

## Assumptions

- **Content first, placement second**: the skill text itself is written in the project's own words from
  Hallpass's own behaviour (README "The consent model" and "Tools"), with no wording taken from another
  product's skills (Clean room, constitution II).
- **Short**: the skill is a page or two; it points to the tool descriptions for detail instead of
  repeating them.
- **No new permission, no network**: installing writes files into a folder on the owner's computer and
  nothing else; no browser permission changes (constitution V).
- **An agent's own configuration is not edited**: 025 FR-402 forbids Hallpass writing an agent's own
  configuration. A skill folder is read by the agent but the file Hallpass writes is its own, installed
  only on the owner's action and removable; this spec treats that as allowed and says so explicitly.
- **SC-184 and SC-185 run against a real agent** in the acceptance probe (they cost model calls); the
  install states are checked by ordinary tests.
- **Version**: shipped with the next minor release; the host and extension upgrade together if the
  settings page shows the states.

## Change log

| Date | Change | Source |
| --- | --- | --- |
| 2026-10-28 | Created from issue #16; FR-422 and FR-423 open for the owner | Issue #16, main session |
| 2026-10-28 | D-026-1 (both user-level folders) and D-026-2 (settings page) decided; FR-422, FR-423 closed | Owner |
