# Data Model: Local Agent MCP Bridge

Entities are behavioural, not a schema. Field types are indicative; the closed Zod definitions live in
`packages/contracts/src/agent-tools.ts` and are summarised in `contracts/`.

## PairedAgent  (durable — chrome.storage.local)

The record of an agent the owner accepted.

| Field | Meaning |
| --- | --- |
| `agentId` | stable id the host reports for the agent (e.g. the MCP client name+instance) |
| `displayName` | what the owner saw in the pairing prompt |
| `origin` | the bridge/host the connection came through |
| `acceptedAt` | when the owner accepted |

Transitions: absent → **pending** (first connection, shown to owner) → **paired** (owner accepts) or
absent (owner declines). **paired** → absent (owner unpairs; FR-032, effective immediately on open
sessions). A second `agentId` is independent: accepting one never pairs another (US1 scenario 5).

## AgentSession  (ephemeral — chrome.storage.session)

One live connection of a paired agent.

| Field | Meaning |
| --- | --- |
| `sessionId` | one connection instance |
| `agentId` | the PairedAgent it belongs to |
| `tabGroupId` | the `chrome.tabGroups` group this session owns |
| `activePlans` | per-site approved plans under `follow-a-plan` (see StatedPlan) |

Ends when the connection drops or the agent unpairs. A tool call naming a tab outside `tabGroupId` is
refused (FR-034, SC-024).

## SiteMode  (durable — chrome.storage.local)

The owner's standing decision for one site.

| Field | Meaning |
| --- | --- |
| `site` | scheme + host (port included for fixtures) |
| `mode` | `ask` \| `follow-a-plan` \| `skip-checks` |
| `diagnosticsGranted` | boolean; gates US6 tools (FR-049) |

Default when absent: `mode: "ask"`, `diagnosticsGranted: false` (FR-041). The owner sets it from the
extension or from within an `ask` prompt (FR-042).

## StatedPlan  (ephemeral, inside AgentSession)

Under `follow-a-plan`, the ordered effects the agent declared and the owner approved for one site.

| Field | Meaning |
| --- | --- |
| `site` | the site it applies to |
| `steps` | ordered effect descriptors (tool + bounded args) |
| `admittedCount` | how many steps have run, so a step is never admitted twice |

A requested effect that matches the next unadmitted step runs unprompted; anything else on that site is
treated as `ask` (FR-041, US3 scenario 5). Reuses the *shape* of 002's plan admission, never its wire.

## ToolCall  (ephemeral, in flight)

One request from an agent, answered exactly once.

| Field | Meaning |
| --- | --- |
| `callId` | correlation id across MCP ⇄ native frame |
| `tool` | tool name (see contracts) |
| `tabId` | the agent tab it concerns (must be in the session group) |
| `args` | closed per-tool argument object |

Outcome is one of: `ok` (with the tool's result), `denied` (owner said no), `stale` (reference gone),
`busy` (a call already in flight on that tab), `not-readable` / `not-actionable` (restricted page),
`stopped` (owner pressed Stop), `timed-out` (no answer to an `ask` prompt), `failed` (page/browser
error). One in flight per tab (FR-043; US "busy" edge case).

## ElementReference  (ephemeral, page-scoped)

A stable handle from the existing `TargetRegistry`: names one element of one page as of one read;
invalid once the element or page is gone (R-106, reuses `mintTargetHandle`/`readLiveTarget`).

## AgentTab  (derived from live browser state + AgentSession)

A tab the session owns.

| Field | Meaning |
| --- | --- |
| `tabId` | Chrome tab id |
| `sessionId` | owning session |
| `url` | current URL (reported by tab-context and navigation answers) |

Visibly marked via its group (R-104). Reconciled on each call; a tab the owner closed answers "gone"
(FR-044, US4 scenario 5).

## Native frame  (worker ⇄ host)

A length-prefixed JSON message in each direction, closed schema (`contracts/`). Request:
`{ callId, tool, tabId?, args }`. Response: `{ callId, outcome, result? }`. Pairing and Stop are
control frames of the same channel. Nothing page-derived is logged by the host beyond stable outcome
codes (mirrors the remote proxy's redaction discipline).
