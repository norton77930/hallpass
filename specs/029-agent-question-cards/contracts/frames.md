# Frames: Agent Questions as Side-Panel Cards

Additions only; host and extension upgrade together (strict schemas refuse an unknown field or event).

## Broker ↔ agent (ACP)

- `initialize.clientCapabilities.elicitation = { form: {} }` (R-429). No `url`.
- The broker answers `elicitation/create`:
  - `{ action: "accept", content }` after Send, `{ action: "decline" }` after Skip;
  - `{ action: "cancel" }` for a question it does not show (R-431) and on Stop, turn end, drift or exit
    (R-435).
- An incoming `$/cancel_request` for an open question closes its card `withdrawn`.

## Conversation events (broker → extension → panel)

- `question` and `question-closed` join `conversationEventSchema` (data-model). Both are forwarded and paged
  like every other event.

## Commands (panel → broker)

- `ui.conversation.question-reply { conversationId, requestId, reply }` (data-model "Reply"). Outcomes:
  - ok;
  - `not-found`: no such conversation or question, or it was already answered (another panel document
    answered first);
  - `question-invalid`: the values do not fit the question, and the card stays (R-434).
