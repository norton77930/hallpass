# Feature Specification: Agent Questions as Side-Panel Cards

**Feature Branch**: `claude/charming-goldberg-a09vjh` (from main fcdef46, 0.18.2)

**Feature Directory**: `specs/029-agent-question-cards`

**Created**: 2026-11-04

**Status**: Draft. D-029-1..3 put to the owner on 2026-11-04 and accepted as recommended; the rest are
the main session's defaults, listed under Assumptions.

**Input**: Issue #17, a follow-up from the 024 settings-page discussion: when a side-panel agent wants to
ask the owner a question (choices, a clarification), the answer should come from a card in the side
panel, not from free text the owner has to notice. A dismissed card tells the agent the owner did not
answer.

**Facts checked 2026-11-04** (each agent's published package at the version Hallpass tests, read for its
observable protocol behaviour only):

- The agent protocol Hallpass speaks has a standard way for an agent to ask the user a structured
  question: a form with typed fields (one choice, several choices, free text, a number, yes/no) or a link
  to open. The user's reply is one of three: answered (with the values), declined, or cancelled. An agent
  sends such a question only to a client that said, when the connection opened, that it can show one.
- Hallpass does not say so today, and handles no such question.
- **Claude Code** (adapter 0.81.2): its built-in question tool becomes such a form, one field per
  question with an optional free-text answer beside each; with a client that cannot show forms, the
  adapter switches the question tool off, so today Claude Code can only ask in plain text.
- **Codex** (adapter 1.13.1): its user-input request becomes such a form; with a client that cannot show
  forms, the adapter answers the request with no answers. **Today Codex is told the owner gave no answer
  to a question the owner never saw.** A request may carry its own time after which Codex stops waiting.
- **Hermes**: its clarify tool (up to four choices plus "other") is not wired to the protocol in 0.19.0,
  the newest version published on the package index; the tool reports that it is not available. The
  version Hallpass tests (0.22.2) could not be inspected (open item R-428).
- **DeepSeek** (0.2.1-rc.2): its protocol server says it deliberately offers no such questions.
- Both the Claude Code and Codex adapters also pass on such questions from the MCP servers the agent
  uses, which include Hallpass's own browser tools and the owner's extra servers (027), marked as coming
  from a tool call. Claude Code also uses a form to ask whether a refused request may be retried on a
  fallback model.
- A permission card in a side-panel conversation never expires while it waits (FR-294); the conversation
  shows it is waiting for the owner, and the idle stop does not run (FR-297).

**Decisions (D-029-n)**:

- **D-029-1 — forms only, no links** (confirmed): Hallpass says it can show
  forms, not links. An agent or server that wants the owner to open a link is told the client cannot, as
  today. Every link question the tested adapters ask is a sign-in: an MCP server's sign-in (both), and
  Codex's account sign-in by device code. In Hallpass the agents are signed in from their own terminal,
  and the extra servers of 027 are local programs, so these do not arise; showing links would make the
  side panel run sign-ins, a later feature with remote servers. *Alternative*: also show links, opened
  only on the owner's click, with the full address shown.
- **D-029-2 — questions from MCP servers are shown, labelled with the server** (confirmed): a question
  that comes from a tool call names the server that asks, and Hallpass's own browser tools never ask
  through this path. *Alternative*: only the agent's own questions are shown; a server's question is
  declined by Hallpass and a notice says so.
- **D-029-3 — Claude Code's fallback-model question is shown as a card** (confirmed): it is the agent
  asking the owner, and declining keeps today's behaviour (the refusal stands). *Alternative*: Hallpass
  declines it itself, as today.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Answer an agent's question from a card (Priority: P1)

In a side-panel conversation, Claude Code or Codex asks the owner to pick between options before it goes
on. The side panel shows a card with the question and its options; the owner picks one (or types their
own answer) and presses Send. The agent continues with that answer.

**Why this priority**: this is the point of issue #17, and it fixes Codex being told "no answer" to
questions the owner never saw.

**Independent Test**: with an agent stand-in that asks one single-choice and one free-text question, start
a side-panel conversation and send a message; a card appears with both fields; pick an option, type a
line, press Send; the stand-in receives exactly those two values and the conversation goes on.

**Acceptance Scenarios**:

1. **Given** a running turn, **When** the agent asks a question, **Then** the side panel shows a card with
   the agent's message and one control per field, the conversation shows it is waiting for the owner, and
   the agent waits.
2. **Given** a single-choice field, **Then** the owner can pick one option; **given** a several-choice
   field, any number within the limits the question sets; **given** a free-text field, a line of text;
   **given** a yes/no or number field, a value of that kind.
3. **Given** the owner fills the card and presses Send, **Then** the agent receives the answered reply
   with the values exactly as entered, and the card is replaced by a short line saying what was answered.
4. **Given** a field the question marks as required and left empty, **Then** Send is unavailable and the
   field says what is missing.
5. **Given** several side-panel documents open on the conversation, **Then** each shows the card; the
   first answer is the one sent, and the others close.

---

### User Story 2 - Decline or skip a question (Priority: P1)

The owner does not want to answer. They press Skip, and the agent is told the owner chose not to answer,
so it can go on without guessing that the owner agreed.

**Why this priority**: a dismissed card that silently answered would be worse than no card (issue #17).

**Acceptance Scenarios**:

1. **Given** a question card, **When** the owner presses Skip, **Then** the agent receives the declined
   reply and the card is replaced by a line saying the question was skipped.
2. **Given** a question card, **When** the owner stops the turn, **Then** the agent receives the
   cancelled reply, and nothing is answered on the owner's behalf.
3. **Given** a question card, **When** the agent exits or the conversation ends, **Then** the card closes
   and says the question is no longer waiting.
4. **Given** a question that carries its own waiting time, **When** that time passes unanswered, **Then**
   the agent stops waiting by its own rule and the card closes with a line saying so; Hallpass sets no
   other expiry.

---

### User Story 3 - Know who is asking (Priority: P1)

A question can come from the agent itself or from one of the MCP servers it uses. The card says which, so
the owner does not type something meant for the agent into a server they added, or the other way round.

**Why this priority**: an MCP server is a program the owner chose (027) and may be one they trust less
than the agent; constitution VI asks that what leaves where is clear to the owner.

**Acceptance Scenarios**:

1. **Given** any question, **Then** the card names the agent that sent it (Claude Code, Codex).
2. **Given** a question tied to a tool call the agent announced in this turn (D-029-2, R-430), **Then** the
   card also names that tool call as the agent announced it (for an MCP server's tool, its server and
   tool name), and says the answer may go on to that tool.
3. **Given** a question tied to no tool call, **Then** the card says only that the agent asks: it never
   claims who inside the agent asks, since neither tested adapter says whether an MCP server asked (R-430).
4. **Given** any question, **Then** the card says the answer is sent to the agent, and from there to its
   model provider like any message.

---

### User Story 4 - Agents that cannot ask with a card (Priority: P3)

Hermes and DeepSeek cannot ask with a card yet. Their conversations work as today: a question arrives as
text in the reply, and the owner answers with the next message.

**Acceptance Scenarios**:

1. **Given** Hermes or DeepSeek, **Then** nothing about their conversations changes with this feature.
2. **Given** a later Hermes version that asks through the protocol, **Then** its questions are shown as
   for Claude Code and Codex, with no further change (R-428).

---

### Edge Cases

- A question with no fields, or only fields Hallpass cannot show (a field kind added to the protocol
  later): the card shows the message and offers Skip only; the agent receives the declined reply when the
  owner presses it.
- A very long message, many options or many fields: the card scrolls inside itself; the text is clipped
  at a bound with a way to see all of it; no option is dropped.
- A question arriving outside a running turn, for another session, or tied to a request rather than a
  session: it is answered cancelled without a card, as a permission request outside a turn is (R-431).
- A question asking for a secret (Codex marks such a question): the field hides what is typed, and the
  answered line does not show it (FR-449).
- A permission card and a question card at once: both are shown, each answered on its own.
- A link question (D-029-1, forms only): the agent is told the client cannot open links, as today; no
  card is shown.
- The side panel is closed when a question arrives: the question waits like a permission card; opening
  the panel shows it.
- A conversation continued later: a question that was waiting when the agent exited is not shown again.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-439**: When a side-panel conversation's agent opens, Hallpass MUST tell it that it can show form
  questions, and (D-029-1) MUST NOT tell it that it can open links.
- **FR-440**: Hallpass MUST show each form question of a side-panel conversation as a card with the
  question's message and one control per field, for the field kinds the protocol defines: one choice,
  several choices, free text, number and yes/no, with the labels, descriptions, defaults and limits the
  question gives.
- **FR-441**: The card MUST offer Send (the answered reply with the values entered) and Skip (the declined
  reply). Stopping the turn MUST send the cancelled reply. Nothing MUST be sent as answered unless the
  owner pressed Send.
- **FR-442**: While a question card waits, the conversation MUST show that it is waiting for the owner,
  and the idle stop MUST NOT run, as for a permission card (FR-294, FR-297). Hallpass MUST NOT set an
  expiry of its own; a question's own waiting time is the agent's.
- **FR-443**: The card MUST name the agent that asks and, when the question is tied to a tool call the
  agent announced in this turn (D-029-2), that tool call as announced; it MUST NOT name a source the
  question does not carry (R-430). It MUST say that the answer goes to the agent and its model provider.
- **FR-444**: An answered or skipped card MUST be replaced in the conversation by one line saying what the
  owner answered or that they skipped; the values MUST NOT be written to Hallpass's logs or diagnostics.
- **FR-445**: Every open side-panel document MUST show the card; the first answer MUST be the one sent
  and MUST close the card in the others.
- **FR-446**: A question with no field Hallpass can show MUST be shown with its message and Skip only.
- **FR-447 (D-029-3)**: Claude Code's question whether a refused request may be retried on a fallback
  model MUST be shown as a card like any other; Skip MUST keep the refusal.
- **FR-448**: Agents that cannot ask with a card (Hermes, DeepSeek at their tested versions) MUST behave
  exactly as before this feature.
- **FR-449**: A field the question marks as secret MUST hide what is typed, and its value MUST NOT appear in
  the answered line or anywhere in the panel after Send.

### Key Entities

- **Question**: the conversation it belongs to, who asks (the agent, or a server and tool), the message,
  its fields, and its own waiting time if any.
- **Field**: a kind (one choice, several choices, free text, number, yes/no), a label, an optional
  description, whether it is required, a default and limits, and for choices the options with their labels.
- **Reply**: answered with a value per field, declined, or cancelled.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-196**: Every form question a Claude Code or Codex side-panel conversation asks reaches the owner as
  a card; no question is answered without the owner pressing Send (checked with an agent stand-in that
  asks and records the reply).
- **SC-197**: The values the agent receives equal what the owner entered, for each field kind (checked per
  kind).
- **SC-198**: A skipped card reaches the agent as declined, a stopped turn as cancelled, in 100% of runs.
- **SC-199**: No answered value appears in any Hallpass log or diagnostics file (checked by searching for
  a known test value).
- **SC-200**: Answering a single-choice question takes one pick and one press.
- **SC-201**: Hermes and DeepSeek side-panel conversations are unchanged (their existing tests pass
  unchanged).

## Assumptions

- **Side-panel conversations only.** Outside coding agents that use Hallpass's browser tools are not
  affected; they ask their own user in their own terminal.
- **No expiry by Hallpass** (FR-442): as with permission cards, a waiting question waits until the owner
  answers, skips or stops the turn, or the agent stops waiting by its own rule.
- **The tagged-block fallback in issue #17** (an agreed block in the reply that the panel turns into a
  card, for agents that cannot ask through the protocol) **is a later feature**: it needs each agent to be
  taught a format and its reliability measured; the protocol path covers Claude Code and Codex now.
- **Hallpass's own browser tools do not ask through this path**: their consent stays on the existing
  consent cards.
- **The answer is shown as a summary line**, not as an editable form, once sent.
- **Windows only**, like side-panel conversations (028).

## Open items

- **R-428**: whether Hermes 0.22.2 asks through the protocol; to be checked on the Windows machine with
  the tested version before planning.

## Change log

| Date | Change | Source |
| --- | --- | --- |
| 2026-11-04 | Created from issue #17; D-029-1..3 open for the owner | Issue #17, main session |
| 2026-11-04 | D-029-2 (server questions shown, labelled) and D-029-3 (fallback-model card) decided; D-029-1's link uses recorded | Owner, main session |
| 2026-11-04 | D-029-1 (forms only, no links) decided | Owner ("同意") |
| 2026-11-04 | Planning: FR-443 and User Story 3 say what the card can know (neither adapter names an asking server, R-430); a question outside a turn is cancelled (R-431); FR-449 secret fields | Main session, plan |
| 2026-11-04 | Implemented T864-T883 (Linux cloud session); T884 (probe:017 and the quickstart on Windows) owed | Main session |
