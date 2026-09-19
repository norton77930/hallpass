# Data Model: Reference Parity for the Local Agent Bridge

Extends 003's data model. Unchanged 003 entities (PairedAgent, SiteMode, StatedPlan, ToolCall) are not
repeated. Storage classes follow 003: `chrome.storage.local` = the owner's standing decisions;
`chrome.storage.session` = live state that dies with the browser; host-side files under the host data
directory.

## BridgeRecord  (host data directory — written by the relay, R-111)

| Field | Meaning |
| --- | --- |
| `port` | ephemeral loopback port the relay listens on |
| `token` | per-relay secret an mcp-server must present in `hello` |
| `relayPid` | the relay's pid; lets a server recognise a stale record |
| `startedAt` | ISO time |

One writer (the relay). Replaced on every relay start. A server that finds no record, or a record whose
port does not answer, keeps dialling every 5 s.

## AgentSession  (ephemeral — chrome.storage.session; amends 003)

| Field | Meaning |
| --- | --- |
| `sessionId` | minted by the mcp-server for its process lifetime (003 D-M3-3) |
| `agentId` | the PairedAgent |
| `tabGroupId` | the session's group |
| `mainTabId` | the tab most recently created, claimed or acted on; target of the indicator's control |
| `activePlans` | unchanged |
| `lastHelloAt` | when the relay last announced this session; used by the 15 s reconciliation after a relay restart |

Several sessions are live at once. Ends on `session-ended` from the relay, on `stop {sessionId}`, on
unpair, or when a relay restart passes 15 s without this session's `hello`. Ending releases every lease,
the group marking, the indicator and the debugger attachment.

## TabLease  (ephemeral — chrome.storage.session; new)

| Field | Meaning |
| --- | --- |
| `tabId` | the tab |
| `sessionId` | the one live session that holds it |
| `kind` | `agent` (created by the session) or `owner` (claimed from the owner) |
| `since` | ISO time |

Invariant: at most one lease per tab. Created by `tabs_create` and `tabs_claim`; released by
`tabs_close`, the tab closing, the session ending, or `tabs_release`. Every read and effect checks the
lease; a tab held by another session answers `refused/held-by-session {sessionId}`; an unheld tab
answers `refused/not-yours`. Listing (`tabs_context`) never needs a lease.

## FrameNode  (in a read answer)

| Field | Meaning |
| --- | --- |
| `frame` | opaque frame label in the answer (`0` = top; `f1`, `f2`… in tree order) |
| `parent` | parent frame label |
| `url` | frame url as the browser reports it (no page content) |
| `readable` | `true`, or `false` with `reason` (`not-allowed`, `no-answer`) |

The read answer lists frames once, then nodes; every node carries its `frame`.

## ElementReference  (page-scoped; amends 003)

Opaque string minted by the frame's own persistent registry (R-115) and bound to one element for that
element's connected lifetime. **Amended 2026-09-10**: an earlier draft described a worker-side name of
the form `f<frame>-<n>`. That second naming layer was built, found to add a translation surface and no
property, and removed — the page-side handle already is opaque, carries no frame id, stays with its
element, is never recycled and dies with its document, which is everything the requirement asks. Resolves to: the element, its frame, its rect in the frame's
viewport. Stale when the element is disconnected, the frame navigated, or the tab is gone. Never
reassigned.

## FrameOffset  (worker cache, per held tab)

`frame → {x, y}` offset of the frame's viewport origin in top-level viewport coordinates, obtained
through the debugger's frame-owner chain once per frame and invalidated on that frame's navigation.
Used to turn an element rect into the coordinates browser-level input takes.

## InputAttachment  (worker, per held tab)

| Field | Meaning |
| --- | --- |
| `tabId` | the held tab |
| `attached` | whether the debugger is attached |
| `diagnosticsEnabled` | whether the console/network/runtime domains are enabled (003 grant) |
| `unavailableReason` | set when attaching failed (`devtools-open`, `restricted-page`) |

One attachment serves both input and diagnostics (R-113). Released with the lease.

## ReadPageNode  (in a read answer; amends 003)

Adds to 003's `{ref?, role, name?, depth}`: `frame`, `href?`, `type?`, `placeholder?`, `options?`
(select), `hidden?`. Bounds: default depth 15, ≤ 10,000 nodes, ≤ `max_chars` (default 50,000, ceiling
50,000) characters of text; truncation reports the limit.

## PositionAction  (a `computer` call)

`{action, x, y, text?, key?, amount?, ms?}`; `x, y` in top-level viewport CSS pixels; refused with the
viewport size when outside it. Gated as an effect; the prompt carries a screenshot crop around the point.

## Indicator  (in-page, held tabs only)

Shown by the agent build's content script on every held tab: a small fixed element naming that an
agent is active, with one control "back to the agent's tab". The control's trusted click sends
`ui.agent.focus-main {tabId}` to the worker, which activates `mainTabId` and focuses its window. The
worker ignores the message unless it comes from a held tab's content script and the event was trusted.

## Native frame  (worker ⇄ relay ⇄ servers; amends 003)

Every frame carries `sessionId` (calls and control) or `callId` (answers), so the relay can route by
either. New control frames: `hello {sessionId, agentId, token, displayName}` (server → relay → worker),
`session-ended {sessionId}` (relay → worker when a server's socket closes), `relay-started {relayPid}`
(relay → worker on start; the worker begins the 15 s reconciliation), `ui.agent.focus-main` (content
script → worker, not over the bridge). Worker answers keep 003's `{callId, outcome, result?}`.

## AcceptanceRun  (tests/acceptance/probe-004/reports)

| Field | Meaning |
| --- | --- |
| `timestamp`, `browserVersion`, `extensionBuild`, `referenceVersion` | environment |
| `scenarios[]` | `{id, page, baselineSource: reference|browser-tree, baseline, observed, verdict, rawAnswers?}` |
| `verdict` | `done` only when every scenario is `pass`; any `fail` or `not-run` makes it `not-done` |
