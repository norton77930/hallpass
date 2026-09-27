# Data Model: A Readable Panel (016)

## Session record (worker, `storage.session`, tab manager) — extended

| Field | Type | Rule |
| --- | --- | --- |
| `firstSeenAt` | ISO string | NEW. Written once, on the first greeting of the session id; never overwritten by a re-greeting. |
| `colourIndex` | integer ≥ 0 | NEW. Assigned once from the counter below; colour = `SESSION_COLOURS[colourIndex % 7]`. |
| `label` | string ≤ 64, optional | NEW. Last value from a `session-label` frame; absent until one arrives. |
| (existing) `lastHelloAt`, `agentId`, tabs, group id … | | unchanged |

Records written by 0.8.0 lack the new fields: on first read they are filled (`firstSeenAt` = the
record's `lastHelloAt`, a fresh `colourIndex`), no label.

## Colour counter (worker, `storage.session["agentSessionColourNext"]`)

Integer, incremented on each new session; starts at 0 in a browser run.

## Session view (projection → panel) — extended, all optional

| Field | Type | Source |
| --- | --- | --- |
| `label` | string | session record |
| `startedAt` | ISO string | `firstSeenAt` |
| `colour` | `"cyan" \| "green" \| "purple" \| "pink" \| "orange" \| "grey" \| "blue"` | session record |
| `state` | `"working" \| "waiting" \| "idle"` | CHANGED: `waiting` if a prompt of the session waits; `working` if in-flight > 0; else `idle` |

`AGENT_SESSION_STATES` gains `"idle"`. A 0.8.0 panel never receives `idle` from a 0.8.0 worker; a
0.9.0 panel reading a 0.8.0 projection treats a missing state as today.

## Panel status (projection) — extended

| Field | Type | Rule |
| --- | --- | --- |
| `liveSessions` | integer | derived by the panel from `sessions.length` (no new field) |
| `paired[]` | existing | shown in the menu, each with its own unpair |

## Group presentation (worker, in memory)

Per session with a group: `lastTitle` written, `idleTimer` (1 s). Wanted title:
`🔔 Hallpass` (waiting) › `⌛ Hallpass` (in-flight > 0, or within 1 s of the last call ending) ›
`Hallpass`. Recognised stale titles: `Agent`, `Hallpass`, `⌛ Hallpass`, `🔔 Hallpass`.
