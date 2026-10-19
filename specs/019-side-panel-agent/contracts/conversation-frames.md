# Contract: conversation frames, panel commands and hello additions (019)

Closed schemas in `packages/contracts/src/agent-tools.ts` (or a sibling `conversation.ts` re-exported
from it). Link protocol stays 2 (R-323): everything below is a new frame type or an optional field.

## `hello` additions (link)

- `role?: "broker"` + `brokerSecret?: string 43–128` — the broker's link (R-312). The relay admits
  `role` only together with the secret it gave its spawned broker (or whose hash its sidecar holds, for an
  adopted broker), strips `brokerSecret` before forwarding (as it strips `token`), and refuses `role` on
  any other greeting (log code `broker-role-refused`). The worker accepts one broker session per relay
  run, treats it as no agent (no card, no tab group), and accepts `conversation-*` frames only from it.
- `panelToken?: string 32–128` — an mcp-server started for a panel conversation (R-321), with agent id
  `panel:<conversationId>`. A token the worker does not know → refused as `not-admitted` (never
  downgraded to an external pairing under the panel agent id). Never stored or logged.

## Relay ↔ broker (link)

`relay-gone` (relay → broker, on stdin end): the broker redials for ≤ 15 s and keeps running only if a
relay of the same `browserRunId` admits it (R-312).

## Worker ↔ broker (link, all carry the broker `sessionId`)

| Frame | Direction | Payload |
| --- | --- | --- |
| `conversation-command` | worker → broker | `{ commandId, command }` — command is one of the panel commands below, already validated |
| `conversation-result` | broker → worker | `{ commandId, ok: true, value? }` \| `{ commandId, ok: false, error: ConversationError }` |
| `conversation-event` | broker → worker | `{ conversationId, seq, event }` — `seq` increases per conversation; a gap → the worker asks for pages from the last seq it forwarded |
| `conversation-overview` | broker → worker | `{ conversations: ConversationView[] (index fields + state, no content), agents: AgentAvailability[], folders }` |
| `conversation-page` | broker → worker | `{ conversationId, fromSeq, events, more }` — one page ≤ 256 KB of a running conversation's log (R-318); every frame stays under the 1 MB link cap |
| `conversation-browser-token` | broker → worker | `{ conversationId, token, startTabId? }` / `{ conversationId, token: null }` to revoke |

As implemented in `packages/contracts/src/conversation.ts` (S1): events are discriminated by `type`
(the `tool` and `permission` events carry the tool's `kind` as a field); `conversation-page.events` is
`[{ seq, event }]` because coalescing leaves gaps in `seq`; a page is ≤ 256 KB of JSON and ≤ 4096
entries; `AgentAvailability` is `{ agent, availability: missing|needs-install|ready|version-problem,
version?, detail? }`; `ConversationView` is the index entry without `agentSessionId` and `lease`, plus
`state` and `inUseElsewhere?`; the panel answers only `allow-once | reject | allow-conversation` — the
other `permission-closed` answers are the broker's.

`event` types: `text` `{ role: "agent"|"owner", text ≤ 16 KB }` (coalesced, R-318); `tool` `{ toolCallId,
kind, title ≤ 200, inputSummary ≤ 400, status: "pending"|"running"|"done"|"failed"|"refused",
byRule?: true }`; `permission` `{ requestId, toolCallId, kind, title, detail ≤ 2 KB }`;
`permission-closed` `{ requestId, answer: "allow-once"|"reject"|"allow-conversation"|"by-rule"|"cancelled"|"agent-exited" }`; `mode` `{ mode, note? }`; `state` `{ state }` (data-model);
`notice` `{ code, text }`.

`ConversationError` codes: `agent-missing`, `agent-version`, `install-needed`, `install-failed`,
`folder-missing`, `cannot-resume`, `too-many-running`, `consent-needed`, `broker-unavailable`,
`agent-exited`, `in-use-elsewhere` (R-319 lease). Each carries a `detail` already redacted (R-326).

## Panel → worker (panel port, `ui.conversation.*`)

`start { agent, folder }`, `send { conversationId, text ≤ 32 KB, activeTabId? }`, `stop
{ conversationId }`, `answer { conversationId, requestId, answer: "allow-once"|"reject"|"allow-conversation" }`,
`set-mode { conversationId, mode: "strict"|"agent-review" }`, `open { conversationId }`, `remove
{ conversationId }`, `add-folder {}`, `remove-folder { path }`, `open-folder { conversationId }`,
`install { agent }` (only after the consent card's Download, FR-299), `consent { granted }`.

`set-mode` refuses any other value at the schema; there is no field through which a full-access mode
can be named (FR-292, SC-140).

## Worker → panel

`agentPanelStateSchema` gains `conversation?: { available: boolean, reason?, consent: "unknown"|"granted"|"withdrawn", conversations, active?, agents, folders }`; events are forwarded as
`conversation-event` panel messages to every panel document.

## Agent-facing text

The mcp-server started for a panel conversation adds one line to its server instructions: "You were
started from the Hallpass side panel; the user's current tab is in your tab group." No tool list
change: `AGENT_TOOL_NAMES` stays as in 0.12.5. Under the Codex fallback name `hallpass_panel`
(R-322, set through `HALLPASS_PANEL_SERVER_NAME`) a second line follows: "Use only the browser tools
of the "hallpass_panel" server. A server named "hallpass" from your own settings is a separate
connection to this browser: do not use it."

## Additions for the worker forwarding (T547)

All optional fields, new frame/message/command types or new enum members (R-323, protocol stays 2).

- **Panel commands carry a `commandId?`** (1–128) beside `type` and `payload`. The worker forwards
  `{ type, payload }` as the frame's `command` under that id (or one it mints); the frame's `command`
  never carries `commandId` itself. `ui.agent.*` commands do not take one.
- **`conversation-result` panel message** `{ commandId, ok: true, value? } | { commandId, ok: false,
  error }`, to every panel document. The worker answers `broker-unavailable` itself when no broker is
  attached, and for commands in flight when the broker leaves or a new relay starts. The shell shows
  a refusal only for a commandId it minted, and clears it on its next success.
- **`ConversationError` codes** gain `not-found` (no such conversation in the index; was
  `cannot-resume`) and `busy` (a message while the turn is running; was `broker-unavailable`).
- **`AgentAvailability.installing?`** `preparing | downloading | finishing`: present while the broker
  downloads that agent's connector; the broker sends an overview on each phase change.
- **`conversation-overview.consent?`** `unknown | granted | withdrawn`: the broker's consent record, so
  a worker that restarted shows the owner's answer.
- **`worker.conversation.page { conversationId, fromSeq }`**: a `command` only the worker sends in a
  `conversation-command` frame (not accepted at the panel port). The broker answers with a result
  (`not-found` for an unknown conversation) and then the pages from `fromSeq`. The worker sends it for
  a panel's resync, for a jump in a conversation's live seqs, and for each conversation it forwarded
  events of when a broker greets again.
- **`ui.conversation.resync { conversationId, fromSeq }`** (panel → worker, never forwarded as itself):
  a panel document, on each new connection and when the conversation part becomes available again,
  names the conversation it shows and the seq after the last event it kept (0 if none). The panel
  inserts paged events by `seq` and drops a seq it already has.
- **Unavailable reasons**: `broker-unavailable` while the link is down, before a relay, or after the
  broker left; `host-outdated` when a relay run has had no broker greeting for 15 s.

## Additions for the folder chooser and the list (T563)

- **`ui.conversation.add-folder { path? }`** (1–1024): no path opens the folder dialog; a path is the
  owner's typed answer, checked by the broker exactly like a chosen folder.
- **`ConversationError` code `path-entry`**: the dialog cannot open on this desktop; the panel then
  offers a typed path (14 codes).
- **`notice?: "index-unreadable"`** on `conversation-overview` and on the panel's `conversation`
  state: the broker could not read its conversation list and kept the file aside. A code only; the
  panel says it in the owner's language, so neither broker text nor the kept file's path reaches it.

## Addition for the broker epoch (T572)

- **`epoch?`** (1–128) on the panel's `conversation` state: the session id of the broker whose events
  the panel shows. A replacement broker restarts every conversation's seq at 0; the worker clears its
  forwarded seqs when a broker with another session id greets (an adopted broker keeps its id and its seqs), and a panel that sees the epoch change drops its
  logs and pages again from 0.
