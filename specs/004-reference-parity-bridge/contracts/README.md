# Contracts: Reference Parity for the Local Agent Bridge

The closed schemas live in `packages/contracts/src/agent-tools.ts` (amended) and are the single source.
This file lists what changes at each boundary so tasks can be cut against it. Every change is additive
to 003 except where marked **breaking**; the narrow build imports none of it.

## 1. Bridge link (relay ⇄ mcp-server, loopback)

| Frame | Direction | Fields | Note |
| --- | --- | --- | --- |
| `hello` | server → relay | `sessionId, agentId, displayName, token` | token = the relay's record token; a wrong token closes the socket |
| `hello-ack` | relay → server | `relayPid` | server considers the bridge up |
| any 003 call/control frame | server → relay → worker | unchanged, `sessionId` present | relay forwards verbatim |
| any worker answer | worker → relay → server | unchanged (`callId`) | relay routes by `callId`, control by `sessionId` |
| `session-ended` | relay → worker | `sessionId` | emitted when a server socket closes |
| `relay-started` | relay → worker | `relayPid` | first frame after the native port opens |

**Breaking** for 003's link only (not for any tool): the record file is written by the relay, and the
server dials. Both processes ship together in `@hallpass/agent-host`, so there is no compatibility window.

## 2. Tool surface (agent ⇄ mcp-server), additions and amendments

| Tool | Change |
| --- | --- |
| `tabs_context` | result rows gain `holder: "this" \| {sessionId} \| "none"`, `windowId`, `active`; lists every tab in the browser |
| `tabs_claim` **(new)** | `{tabId}` → `{tabId, groupId}`; refusals `held-by-session {sessionId}`, `tab-gone`, `restricted-page` |
| `tabs_release` **(new)** | `{tabId}` → `{released: true}`; the tab leaves the group and loses the indicator |
| `read_page` | args gain `max_chars?` (≤ 50,000) and `depth?` (default 15, ≤ 32); result gains `frames[]`; nodes gain `frame, href?, type?, placeholder?, options?, hidden?`; bounds 10,000 nodes / 50,000 chars; interactive filter is viewport-scoped |
| `get_page_text`, `find` | cover all readable frames and open shadow roots; results unchanged in shape except `frame` on find matches |
| all effect tools | unchanged args; delivery is browser-level input; new failure reason `input-unavailable {reason}` |
| `computer` **(new)** | `{tabId, action: "screenshot" \| "left_click" \| "right_click" \| "double_click" \| "triple_click" \| "type" \| "key" \| "scroll" \| "wait", x?, y?, text?, key?, amount?, ms?}`; refusal `outside-viewport {width, height}` |
| every tool | refusals `held-by-session {sessionId}` and `not-yours` replace 003's `tab-owned-by-another-session` / group check; `stale-reference` unchanged; `bridge-lost` for a call in flight when the link drops |

Element references are opaque strings; agents must not parse them.

## 3. Worker ⇄ content script (agent build only)

| Message | Direction | Purpose |
| --- | --- | --- |
| `collect-subtree` | worker → frame | one frame's subtree with persistent refs |
| `resolve-ref` | worker → frame | ref → rect in the frame's viewport, or stale |
| `cursor` | worker → top frame | move/hide the phantom cursor |
| `indicator` | worker → frame | show/hide the in-page indicator with the session's label |
| `ui.agent.announce` | content script → worker | the page reports that it has loaded, so the worker can answer with that tab's indicator state; a navigation therefore re-raises the indicator without the worker tracking navigations |
| `ui.agent.focus-main` | content script → worker | trusted click on the indicator's control |

## 4. Worker ⇄ side panel

`worker.agent.state` gains `sessions[]` (several) and, per tab, `holder`. No other panel change.

## 5. Acceptance run (probe ⇄ agent, probe → report)

The probe passes `--json-schema` per scenario; the agent must answer with
`{scenario, steps: [{tool, args, outcome, raw}], baseline?, observed, notes}`. The report schema is
`AcceptanceRun` in [data-model.md](../data-model.md).
