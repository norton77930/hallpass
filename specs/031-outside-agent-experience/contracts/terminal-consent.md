# Contract: Terminal Consent Frames and Form (031)

All frames are `strictObject` in `packages/contracts`, like every other link frame. The relay forwards
them unchanged. The worker advertises `terminal-consent` in `pair-result.features` (R-459).

## Worker -> host: `prompt-raised`

Sent once, when a question is raised for a call that came from this host.

| Field | Type | Notes |
|---|---|---|
| `type` | `"prompt-raised"` | |
| `sessionId` | string | |
| `callId` | string | the call the question holds |
| `promptId` | string (1-128) | this question; browser_batch steps share one `callId`, so answers are matched by `promptId` (T929 review) |
| `kind` | `"effect" \| "diagnostics"` | |
| `site` | string | full origin, as shown on the card |
| `action` | string | short, human-readable summary of the action (≤ 200 chars) |
| `choices` | array of `"once" \| "session" \| "deny"` | at least `once` and `deny` |
| `boundMs` | number | 120 000 |

## Host -> worker: `prompt-answer`

Sent only when the owner chose an option in the client (`accept` with a valid `choice`).

| Field | Type | Notes |
|---|---|---|
| `type` | `"prompt-answer"` | |
| `sessionId` | string | must match the link's session (relay-mux rule) |
| `callId` | string | |
| `promptId` | string | echoed from `prompt-raised`; an answer naming a question that is not the open one is logged as late and settles nothing |
| `choice` | `"once" \| "session" \| "deny"` | must be one of the raised `choices`, otherwise ignored and logged |

The worker settles with `decideByCall`. If the question has already been settled, the answer is logged
as late and changes nothing.

## Worker -> host: `prompt-settled`

Sent when the question leaves `pending` for any reason. The host aborts its open elicitation for that
question.

| Field | Type | Notes |
|---|---|---|
| `type` | `"prompt-settled"` | |
| `sessionId` | string | |
| `callId` | string | |
| `promptId` | string | the host aborts the elicitation of this question only |
| `answeredFrom` | `"client" \| "browser" \| "none"` | `none` for timeouts, stops and releases |

## Elicitation form (host -> MCP client, `elicitation/create`, form mode)

- `message`: "Hallpass: allow <agent label> to <action> on <site>?" (wording finalised in implementation,
  English, following the MCP client's own language handling).
- `requestedSchema`: one required property `choice`, a string `enum` of the raised `choices` with titles
  *Allow once*, *Allow on this site for this session*, *Deny*.
- Result handling (R-452): `accept` + valid `choice` -> send `prompt-answer`. Anything else -> no frame.
  The card keeps waiting.
- Timeout: just under `boundMs`. The request is aborted on `prompt-settled` or when the tool call ends.

## Unchanged

`prompt-waiting` ticks keep their schema. They now start at every raise (R-453), and their timeout
sentence changes (R-455). `ui.agent.effect-decide` gains `session: true` (session grant) and
`grantDiagnostics: true` (diagnostics question only, R-461).
