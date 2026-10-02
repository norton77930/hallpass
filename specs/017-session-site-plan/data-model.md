# Data Model: Session Site Plan (017)

## Site plan proposal (in memory, worker prompt controller)

| Field | Type | Rule |
| --- | --- | --- |
| proposalId | string | worker-minted, unguessable |
| sessionId | string | the proposing session |
| callId / hostCallId | string | the waiting tool call |
| origins | string[1..10] | exact http(s) origins, unique (FR-250) |
| purpose | string (1..200) | required |
| steps | string[0..10], each ≤ 120 | optional |
| alreadyApproved | string[] | origins of the session's active plan, for marking (FR-260) |
| raisedAt | ISO time | |

States: `pending` → `approved(origins ⊆ proposal)` | `declined` | `withdrawn` (call ended / session
ended / interrupt of that call) | `busy` (another question on top, as `askPlan`).

## Session site plan (chrome.storage.session, key `agentSessionSitePlans`)

`Record<sessionId, { origins: string[]; approvedAt: string }>`

- Created/replaced by an approved proposal (FR-260: replace, never merge).
- Read by every gate decision of that session (R-245).
- Deleted by: releaseSession (all session-end paths), unpair (every session of the agent), owner
  withdraw (R-252). Browser restart empties session storage.
- Never copied into `agentSiteModes` (storage.local).

## Panel state additions (strict)

- `sitePlan?: { proposalId, sessionId, origins, purpose, steps?, alreadyApproved?, raisedAt }` — the
  pending question.
- `sessions[].sitePlan?: { origins: string[] }` — the active approval.

## Panel commands additions (strict)

- `ui.agent.site-plan-decide { proposalId, approve: boolean, origins: string[] }` — `origins` must be a
  non-empty subset of the proposal when `approve`; ignored when declining.
- `ui.agent.site-plan-withdraw { sessionId }`.

## Tool answer (to the agent)

- `{ outcome: "ok", result: { approved: string[], leftOut: string[] } }`
- `{ outcome: "declined" }`
- `{ outcome: "failed", reason: "invalid-arguments", hint: "<entry>: <rule>" }`
- `{ outcome: "unavailable", reason: "extension-too-old", hint: "reload the extension" }`
- ordinary `timed-out` / `owner-interrupted` / `not-paired` outcomes unchanged.
