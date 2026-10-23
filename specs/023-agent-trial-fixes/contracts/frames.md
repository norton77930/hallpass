# Contract additions (023)

All additions are `z.strictObject`, additive, and pinned by contract tests; panel and host versions stay
paired (unknown frames are refused at the boundary).

## Worker → broker

`conversation-browser-attached` — `{ type, sessionId, conversationId }` (`sessionId` routes the link frame, R-323). Sent once per conversation run when the
service worker accepts a `hallpass` server greeting carrying that conversation's panel token.

## Broker → panel: notice codes (existing notice event, new codes)

- `browser-tools-missing` — `{ code, agent }`. Panel text by agent: Hermes → its optional MCP component is
  missing and how to add it; DeepSeek → it cannot use the browser, attach a screenshot or the tab.
- `key-env-not-in-browser` — `{ code, agent, variable }`. `variable` is a name matching
  `^[A-Za-z_][A-Za-z0-9_]{0,127}$`; never a value.

## Panel → broker → panel: diagnostics

- Request `ui.conversation.diagnostics` — `{ type, conversationId }`.
- Reply `conversation-diagnostics` — `{ type, conversationId, lines: string[] }`, `lines.length ≤ 50`,
  each `≤ 500` chars, already scrubbed by the broker. Unknown or removed conversation → empty `lines`.

## Changed behaviour of existing frames

- Prompt with a tab for an agent without page context: no longer refused with `attachment-not-accepted`;
  the image refusal is unchanged.
