# Contract: browser tools, refusals and link frames (018)

Closed schemas in `packages/contracts/src/agent-tools.ts`. Link protocol stays 2; every change to an
existing frame is an optional field; new frame types are sent only to a peer known to read them.

## Agent tools (host-answered, R-273)

Always offered; need no pairing; exempt from the "several browsers, none chosen" refusal; not batch
steps.

### `list_browsers` — args `{}` (strict)

Answer (JSON text): `{ "browsers": [ { "browserId", "name", "kind", "connectedSince", "current" } ] }`
— `name` is the owner's name or the default name (R-269); `current` is true for the session's bound
or resolved browser. Nothing else about the browser or its tabs.

Description (agent-facing, en-US): "List the browsers running Hallpass on this computer. When several
are connected and none is chosen, ask the user which one to use and call select_browser with its
browserId; never pick one yourself. Refer to browsers by browserId, not by name."

### `select_browser` — args `{ "browserId": string 1–64 }` (strict)

Selects a connected browser for this session and remembers it for the agent (D-018-5, D-018-11). The
agent must be paired in that browser to act there (the next call asks for pairing as usual,
D-018-14). Answer: `{ "browserId", "name", "kind" }`. Not connected → refusal `browser-not-chosen`
with the connected list.

### `request_browser_choice` — args `{}` (strict)

Shows "Use this browser for <agent>?" in every connected browser that can show it; the first confirm
selects that browser (as `select_browser` does). Answer after confirm: `{ "browserId", "name",
"kind" }`; after decline everywhere or 120 s: `{ "chosen": false }` and the earlier choice is
unchanged. Browsers that cannot show the card (older extension) are skipped; if none can, the answer
says so immediately.

## Refusals (union `agentRefusalSchema`)

- `{ reason: "browser-not-chosen", browsers: BrowserSummary[] }` — several connected and no choice, or
  the remembered browser is offline (D-018-13), or `select_browser` named a browser that is not
  connected.
- `{ reason: "browser-disconnected", browser: BrowserSummary, browsers: BrowserSummary[] }` — the
  session's bound browser is gone beyond the attach bound.

`BrowserSummary = { browserId, name, kind }` (≤ 16 entries). Hint sentences (en-US + zh-TW constants
beside the existing attention sentences):

- not chosen: "Several browsers are running Hallpass. Ask the user which one to use, then call
  select_browser with its browserId (or request_browser_choice to let them pick it in the browser)."
- disconnected: "The browser this session was using (<name>) is no longer connected. Ask the user
  whether to wait for it or to use another browser."

## Link frames

| Frame | Direction | Fields | Notes |
| --- | --- | --- | --- |
| `relay-ack` (existing) | worker → relay | + optional `browserId`, `browserKind`, `browserName`, `features[]` | an old relay reads only `type`/`relayPid`/`browserRunId` (lenient read) |
| `browser-name` | worker → relay | `name` 1–40 | relay rewrites its record |
| `browser-peers` | relay → worker | `others: number`, `defaultName: string` | from the relay's 1 s poll; for the panel |
| `browser-identity-conflict` | relay → worker | — | worker re-mints its id (R-276) |
| `browser-choice-request` | relay → worker | `sessionId`, `requestId`, `agentName`, `boundMs` | only to a worker whose ack advertised `browser-choice` |
| `browser-choice-result` | worker → relay | `sessionId`, `requestId`, `decision: "confirm" \| "decline"` | |
| `browser-choice-withdraw` | relay → worker | `sessionId`, `requestId` | |
| `hello` (existing) | server → relay | + optional `intent: "choose"` | only to a relay whose record advertises `browser-choice`; a choose link creates no session card or tab group and uses a derived session id (R-279) |
| `relay-standby` | — | removed | (R-274) |

## Panel

- State: `browser { name, defaultName, kind, others }`; prompt kind `browser-choice` with `{ requestId,
  agentName, raisedAt }`.
- Commands: `ui.agent.browser-rename { name }`, `ui.agent.browser-choice-decide { requestId, confirm }`.

## As implemented in S1 (2026-10-03)

- The three choice frames carry the choice link's `sessionId`: the relay refuses a server frame whose
  `sessionId` is not its greeting's and routes worker frames to servers by it (`relay-mux.ts`).
- Names refuse control characters everywhere the agent or relay can send them; the panel's rename
  command accepts 1–40 characters and the worker strips control characters before storing.
- `relay-ack.browserId` (minted) is 8–64 `[A-Za-z0-9-]`; record and summary ids are 1–64 so legacy
  `run-…` / `pid-…` ids fit; `select_browser.browserId` is plain 1–64 (an impossible id gets the list).
- Panel state: `browser { name, defaultName, kind, others 0–1000 }` and `browserChoice` for the card.
- Until S4a the three tools are declared pending in the host (`tool-offering.ts`), so they are not yet
  offered; the README and locale checks skip pending tools.
- Open for S5: the host's per-call bound for `request_browser_choice` (120 s vs the flat call bound),
  and the answer when no connected browser can show the card.
