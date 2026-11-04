# Research: Agent Questions as Side-Panel Cards

Sources: the ACP SDK Hallpass pins (`@agentclientprotocol/sdk` 1.9.0), and the published packages of the
tested agents read for their observable protocol behaviour only (Claude Code adapter 0.81.2, Codex adapter
1.13.1, DeepSeek `dsh` 0.2.1-rc.2 with its ACP server, Hermes 0.19.0 from the package index). Nothing of
them is copied; this file says what they do on the wire, in our words (constitution II).

## R-428 — Hermes 0.22.2 (open)

**Finding**: in Hermes 0.19.0 the clarify tool is not connected to the protocol; called from an ACP session
it reports that it is not available here, so Hermes asks in plain text. 0.22.2, the version Hallpass tests,
is not on the package index and was not read.

**Next**: `npm run probe:017 -- --agent hermes` on the Windows machine (the 0.18.0 probe already advertises
forms and records how the agent asks). FR-448 keeps Hermes unchanged either way; if 0.22.2 asks by form,
FR-440 shows it without further change (User Story 4, scenario 2). The same run with `--agent claude-code
--agent codex` confirms R-429 against the real programs.

## R-429 — What Hallpass advertises, and what each agent then does (FR-439, D-029-1)

**Decision**: at `initialize`, `clientCapabilities.elicitation = { form: {} }`; no `url` (D-029-1).

What that changes, per tested agent:

- **Claude Code**: its question tool, switched off today, is offered to the model again; a call becomes one
  form question (one field per question, each followed by an optional free-text field), tied to the tool
  call. Form questions of the MCP servers the agent uses are passed on, tied to no tool call. Its
  fallback-model consent (D-029-3) arrives as a single-choice form; Skip keeps the refusal. Without `url`,
  it starts no MCP sign-in.
- **Codex**: its user-input request becomes one form question tied to the request's own tool call, with a
  fixed message ("needs your input") and each question as a field title, every question required, with an
  "Other" choice and a note field when the agent offers one. It may carry its own waiting time
  (`_meta.codex.autoResolutionMs`), after which Codex withdraws it (R-435); the card may say how long.
  An MCP server's form with fields is passed on, tied to the MCP tool call when there is one. **A form with
  no fields** (how MCP tool approvals arrive) **still comes as a permission request**, so the existing
  permission cards and their rules are unchanged. Without `url`, its device-code sign-in and MCP re-sign-in
  stay off, as today.
- **DeepSeek**: offers no questions (its ACP server says so); unchanged.
- **Hermes**: see R-428.

**Alternatives**: advertising `url` too - every link question the adapters ask is a sign-in (MCP OAuth,
Codex device code), which the side panel has no reason to run today (D-029-1).

## R-430 — Who asks (FR-443, D-029-2)

**Finding**: neither adapter says which MCP server asked. Claude Code ties its own question tool to its tool
call and an MCP server's question to none. Codex ties both its own user-input request and an MCP server's
question to the tool call they belong to, when there is one.

**Decision**: the card always names the agent. When the question names a tool call this broker announced in
the current turn, the card adds that call's title as the agent announced it (an MCP tool's title carries
its server and tool, e.g. `mcp__github__create_issue`). With no tool call, the card says only that the
agent asks. Hallpass never infers a server from text.

**Consequence for D-029-2**: "labelled with the server" holds wherever the question carries its tool call;
a question that carries none (Claude Code's pass-through of an MCP server's form) is labelled as the agent's.
The card's fixed text says the answer may go on to a tool, so the owner is not told a server cannot see it.

## R-431 — Which questions get a card

**Decision**: a card is shown only for a `form` question scoped to this conversation's session during a live
turn that was not cancelled. Anything else is answered `cancel` with no card: a question outside a turn, for
another session, scoped to a JSON-RPC request (before a session exists), or of a mode other than `form`.
`cancel` is the protocol's "not answered by the user"; `decline` stays the owner's own Skip (FR-441).

**Rationale**: the same rule as permission requests (`onPermission`: outside a live turn, cancelled), so the
turn's end, Stop and the idle stop treat both alike.

## R-432 — Fields (FR-440, FR-446)

The protocol's form fields map to controls:

| Field | Control | Value sent |
| --- | --- | --- |
| string with `oneOf` (titled) or `enum` | one choice (radio list) | the option's `const` / the enum value |
| array with `items.anyOf` / `items.enum` | several choices (checkboxes), `minItems` / `maxItems` enforced | the chosen values, in offered order |
| string (with `format` email / uri / date / date-time, `minLength`, `maxLength`, `pattern`) | text line (date: date input) | the text |
| number / integer (`minimum`, `maximum`) | number input; integer rejects fractions | the number |
| boolean | checkbox | true / false |

`title` is the label (else the field key), `description` the hint, `default` the initial value, `required`
(on the schema) marks a field Send waits for. An option's `description` is shown under it; anything under
`_meta` is ignored except R-433.

**Bounds** (the event; text beyond is clipped for display with "show all", never sent clipped): message 4000
chars, at most 20 fields, 100 options per field, titles 200, descriptions 1000. A question over a bound, with
no field Hallpass can show, or with a required field of a kind it cannot show, is shown with its message and
Skip only (FR-446); a field it cannot show that is not required is listed as "can't be answered here" and
left out of the reply.

## R-433 — Secret fields (FR-449)

**Finding**: Codex marks a user-input question that asks for a secret with `_meta.codex.isSecret: true` on
the field. The protocol has no general marker.

**Decision**: a field with that marker uses a hidden-text input; the answered line says the field was
answered without its value; the value leaves the panel only in the reply command. No other field is
guessed to be secret.

## R-434 — The reply (FR-441, FR-444, FR-445)

**Decision**: one command, `ui.conversation.question-reply { conversationId, requestId, reply }`, with
`reply` either `{ action: "accept", values }` or `{ action: "decline" }` (the owner cannot send `cancel`;
Stop does). The broker checks `values` against the question it holds - only its keys, each of its kind and
within its limits, every required field present - and answers the agent only then; a reply that does not
fit is refused `question-invalid` and the card stays. The first reply wins; a later one (another panel
document) gets `not-found`, as `ui.conversation.answer` does.

## R-435 — How a card ends

| End | Reply to the agent | `question-closed.ending` |
| --- | --- | --- |
| Send | `accept` with the values | `answered` |
| Skip | `decline` | `skipped` |
| Stop, turn end, mode drift (`cancelTurn` / `endTurn`) | `cancel` | `cancelled` |
| The agent withdrew it (its request cancelled, e.g. Codex's own waiting time) | none (already withdrawn) | `withdrawn` |
| The agent exited / the conversation closed | `cancel` (if the connection is open) | `agent-exited` |

The broker learns of a withdrawal from the request's abort signal, which the SDK raises on the agent's
`$/cancel_request`.

## R-436 — The answered line, and what is kept

**Decision**: `question-closed` carries, for `answered`, a summary built by the broker: each field's label
and value (choices by their titles, several joined with commas, a secret as "hidden", booleans as yes / no),
clipped to 400 chars. Events stay in memory only, in the broker's outbox and the panel document (D-019-6);
the summary is not written to disk, and no value is written to the broker's logs or the diagnostics lines
(which hold the agent's own output). A replayed session (`session/load`) shows what the agent replays; the
broker does not replay cards.

## R-437 — Waiting, and what else waits (FR-442)

**Decision**: questions are held beside permission cards; every check that today reads "a card waits"
(the idle stop, mode change, restart, model change, the `waiting-for-owner` state) counts both. Hallpass
sets no expiry (FR-294 applies alike).

## Amendments (implementation, 2026-11-04)

- **R-436**: the answered line is built once by the broker and shown as is in either language, so it
  uses language-neutral marks: ✓ / ✗ for yes / no and •••••• for a secret.
- **R-434**: a `question-invalid` refusal is shown as the conversation's refusal notice (as every other
  command refusal is), with the card left open. The card itself keeps Send unavailable while a value is
  missing or outside its limits, so the broker's check refuses only what the panel could not know.
- **R-435**: a closing connection aborts every open request's signal too; only the agent's own
  `$/cancel_request` (-32800) is a withdrawal, so an exit still ends the card `agent-exited`.

## R-438 — Showing a question the way the agent means it (owner review, 2026-11-04)

**Finding**: the tested adapters say more than the form's types. Claude Code's question tool titles each
question with its short tag and puts its words in the description (one question: its words are the
message); each option may carry a preview under `_meta["_claude/askUserQuestionOption"]`; and each
question has its own free-text answer field, marked `_meta._askUserQuestionCustomAnswer.questionId` (a
marker the adapter names as meant for any client and any bridge). Codex's user-input request puts the
words in the title and the tag in the description, under `_meta.codex`, offers "None of the above", and
adds a note field marked `_meta.codex.role: "user_note"` with its `questionId`. The first card drew all
of these as plain separate fields: the tag as the heading, the words as a grey hint, each Other box as a
field of its own.

**Decision**: the broker maps the hints (`chip` for the tag, the words as the label, `preview` on an
option, `otherFor` on a free-text field that belongs to a choice field of the same form) and nothing is
inferred from text. The card draws the tag as a small chip over the question's words, the options as rows
to pick (the picked one in the accent's soft fill) with their description and preview under them, and a
question's own answer box or note inside that question after its options, with the agent's hint said in
full above it. A field's label may now be 1000 characters (it holds the question's words); an option's
stays 200, a preview 4000.

