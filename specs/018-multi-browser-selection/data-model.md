# Data Model: Several Browsers, One Bridge (018)

All schemas are closed (`strictObject`) in `packages/contracts`; every addition to an existing frame is
optional (link protocol stays 2, R-267).

## Browser identity (extension, per profile)

`chrome.storage.local` key `agentBrowserIdentity`:

| Field | Type | Notes |
| --- | --- | --- |
| `browserId` | string, 8–64, `[A-Za-z0-9-]` | minted once (random UUID); re-minted only on `browser-identity-conflict` (R-276) |
| `name` | string 1–40, optional | owner-set; absent = default name (R-269) |

`kind` is computed at run time (not stored): `chrome` \| `edge` \| `brave` \| `chromium` \| `unknown`.

## Per-browser record (host file)

`%LOCALAPPDATA%\hallpass\browsers\<browserId>.json` — one writer: that browser's relay (R-266).

| Field | Type | Notes |
| --- | --- | --- |
| `browserId` | string | as above, or `run-<browserRunId>` / `pid-<pid>` for an extension older than 018 |
| `browserRunId` | string, optional | the run that owns this relay (R-276 replacement vs collision) |
| `kind` | enum as above | `unknown` for an old extension |
| `name` | string 1–40, optional | owner-set name |
| `legacy` | boolean | true when the worker sent no identity |
| `features` | string[] ≤ 16 | worker features; `browser-choice` means it can show the choice card |
| `relayPid`, `port`, `token`, `startedAt`, `protocol` | as in today's `bridge.json` record | `startedAt` = "connected since" |

`bridge.json` keeps its current schema and is written for servers older than 018 by the relay that
claims it (R-277).

## Remembered choice (host file)

`%LOCALAPPDATA%\hallpass\choices\<agentId>.json` — `{ "browserId": string, "chosenAt": ISO string }`,
written temp-then-rename; last writer wins (R-271, R-279). The agent id is the per-Windows-user agent
id (D-018-11).

## Server-side session state (memory, per mcp-server)

| Field | Meaning |
| --- | --- |
| `boundBrowserId?` | set by the first forwarded call or by `select_browser` / a confirmed choice (D-018-12) |
| per browser: link, pairing state, worker features, browser run | today's singletons, keyed by browser (R-272) |
| `issuedTabIds: Map<browserId, Set<number>>` | filled from `tabs_*` / `tabs_context` answers; a `tabId` issued only under another browser is refused (FR-276) |

## Resolution (pure function, R-270 / R-278)

Inputs: connected browsers (from the directory), the session's bound browser, the remembered browser,
whether the bound browser is within the attach grace. Outputs:

| Situation | Result |
| --- | --- |
| bound browser connected | use it |
| bound browser absent, within the attach bound | wait (then re-resolve) |
| bound browser absent beyond the bound | refuse `browser-disconnected` (any number of others) |
| not bound, remembered browser connected | use it |
| not bound, remembered browser offline | refuse `browser-not-chosen` (D-018-13), even with one other connected |
| not bound, no remembered, exactly one connected | use it (FR-271) |
| not bound, no remembered, several connected | refuse `browser-not-chosen` |
| none connected | today's `bridge-unavailable` answer |

## Browser choice request (server memory + worker cards)

`{ requestId, sessionId, agentName, startedAt, boundMs = 120000, browsers: browserId[] }`; ends
`chosen(browserId)` \| `declined` \| `timed-out`. Worker card: prompt kind `browser-choice`.
