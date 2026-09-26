# Data Model: Honest Answers (015)

## Press observation (extended, `agentEffectObservationSchema`)

Existing required fields unchanged: `effect`, `documentChanged`, `verified`, `verdict`. New, all
optional (additive; the schema stays strict):

| Field | Type | Present when | Source |
| --- | --- | --- | --- |
| `url` | string | `documentChanged` and the tab's URL at the end of the settle wait is known | `chrome.tabs.get(tabId).url` after the settle |
| `newTabs` | `{ tabId: number; url: string; held: false }[]` (1..10) | a tab with `openerTabId === tabId` was created between dispatch and the end of the settle | `chrome.tabs.onCreated`, listener armed for the call |
| `downloads` | `{ id: number; filename: string; url: string; state: string }[]` (1..10) | the session's download observer recorded a creation in the same interval | observer `createdSince(sessionId, t0)` |
| `observedForMs` | number | none of `documentChanged`, `newTabs`, `downloads` | the settle wait actually spent |

Answer-level `hint` (existing optional field on the response) is set when the press target was a
link with an address and `observedForMs` is present, and when `newTabs` is present (names
`tabs_claim`).

Validation: `newTabs[].held` is always `false` in 015 (ownership unchanged). Arrays are capped at 10
entries; more are summarised by the hint.

## Binding failure reason

| Condition | Outcome | Reason | Hint |
| --- | --- | --- | --- |
| Tab does not exist | `stale` | `tab-gone` | — (existing) |
| Page the extension may not act on | `not-actionable` | existing reasons | — |
| Probe did not answer within the content deadline (10 s) | `failed` | `page-not-responding` | "The page did not answer for 10 s; it is still open. Retry the call, or take a screenshot to see its state." |
| A press or keystroke whose input dispatch was not answered within 10 s (T402) | `failed` | `page-not-responding` | "The input reached the page, which then did not answer for 10 s; it is still open and the input may have taken effect. Take a screenshot or read the page before sending it again." |
| Reference minted on a replaced document | `stale` | `stale-reference` | existing |

## Download ring (per session, `storage.session["agentDownloads"][sessionId]`)

| Field | Type | Notes |
| --- | --- | --- |
| `items` | `AgentDownloadRecord[]` | unchanged, newest-first by creation, ≤ 20 |
| `answered` | `number[]` | download ids already answered to this session by `wait`; pruned to ids still in `items` |
| `waitWatermark` | number (legacy) | read once for migration, then dropped |

Selection: among `items` with a terminal `state`, an `endedAt`, and an id not in `answered`, the
smallest `endedAt` (tie: smaller id). Answering appends the id to `answered`.

Migration on read: if `answered` is absent, `answered = items.filter(terminal && endedAt ≤
waitWatermark).map(id)`.

## Upload step (host, transient)

| Stage | Data |
| --- | --- |
| Agent-shaped step | `{ tool: "file_upload", args: { ref, paths } }` or `{ tool: "upload_image", args: { imageId, ref | coordinate } }` |
| After `prepareUpload` | `{ tool: "file_upload", args: { ref, files: [{ name, type, bytesBase64 }] } }` or `{ tool: "upload_image", args: { target, file } }` — exactly the standalone rewrite |
| Refusal | the standalone response, reason prefixed `step <n>: `, for the whole batch |

Aggregate: sum of `bytesBase64` lengths across all rewritten steps ≤ `AGENT_UPLOAD_MAX_BASE64_CHARS`.

## Pairing exchange

| Frame | New field | Meaning |
| --- | --- | --- |
| `pair-request` (host → worker) | `requestId?: string` | host-minted per exchange |
| `pair-result` (worker → host) | `requestId?: string` | echoes the request it answers |
| `pair-withdraw` (host → worker, new) | `{ agentId, sessionId, requestId? }` | the host stopped waiting for that session |

State (worker): each waiting session on a card keeps its `requestId`. On `pair-withdraw` the worker
runs `expireWaiting(agentId, sessionId)`: the session leaves the waiting list; the card goes when
none is left.

State (host): an exchange is `open` → `answered` | `withdrawn`. A `pair-result` naming a withdrawn
`requestId` is logged and ignored; one without `requestId` is handled as before.
