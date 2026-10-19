# Data Model: A Conversation in the Side Panel (019)

All schemas are closed (`strictObject`) in `packages/contracts`. Additions to existing frames and
records are optional fields (link protocol stays 2, R-323). Hallpass stores no conversation content
anywhere (D-019-6).

## Conversation index (host file, one writer per write: the broker, R-319)

`%LOCALAPPDATA%\hallpass\conversations.json` — `{ "version": 1, "entries": ConversationEntry[] }`

| Field | Type | Notes |
| --- | --- | --- |
| `conversationId` | string, 16–64, `[A-Za-z0-9-]` | minted by the broker |
| `agent` | `"claude-code"` \| `"codex"` | |
| `agentSessionId` | string 1–200 | the agent's own session id, used for `session/load` |
| `title` | string 1–120 | first line of the first message, trimmed; owner can't edit in 019 |
| `folder` | `{ kind: "scratch" }` \| `{ kind: "project", path: string 3–1024 }` | fixed for life (FR-303); scratch path is derived from `conversationId` |
| `mode` | `"strict"` \| `"agent-review"` | last mode, shown in the list; every resume starts strict again (FR-289) |
| `createdAt`, `lastUsedAt` | ISO 8601 string | |
| `resumable` | boolean | false once `session/load` was refused (FR-304) |
| `lease` | `{ browserRunId, pid, at }`, optional | set while an agent runs it; another browser's `open` is refused while `pid` is alive (R-319) |

## Broker sidecar (host file, one writer: the relay that spawned the broker)

`%LOCALAPPDATA%\hallpass\brokers\<browserId>.json` — `{ pid, browserRunId, secretSha256, startedAt }`
(R-312). Read by a relay of the same browser on ack to adopt; removed by the broker on shutdown.

Validation: at most 50 entries; entries with `lastUsedAt` older than 30 days are dropped on write;
unknown fields refuse the file → the broker keeps it aside as `conversations.json.bad-<time>` and starts
an empty index (logged, never silent in the panel: "conversation list could not be read").

## Folder list (host file)

`%LOCALAPPDATA%\hallpass\folders.json` — `{ "version": 1, "folders": [{ "path", "addedAt" }] }`;
at most 30 folders; path must exist when added (R-320 dialog), existence re-checked when used (US5.4).

## Agent install record (host files)

`%LOCALAPPDATA%\hallpass\agents\<agent>\<adapterVersion>\` — an `npm ci` tree (R-314). Presence of
`node_modules\<adapter>\package.json` with the pinned version = installed. Staging folders
`.staging-*` are removed at broker start.

## Runtime state (broker memory only)

**RunningConversation**: `conversationId`, agent process handle, `agentSessionId`, `mode`,
`state` (below), `pendingPermission?` (request id, tool call summary, options), `allowRules:
Set<ToolKind>` (R-317, not persisted), `panelToken` (R-321), `startTabId?`, `eventLog` (≤ 256 KB, R-318),
`lastActivityAt`.

State transitions:

```
starting ──initialize+session/new|load+set strict──> idle
idle ──message──> running ──end_turn|cancelled|refusal──> idle
running ──request_permission──> waiting-for-owner ──answer──> running
idle ──10 min──> stopped (resumable)        any ──agent exit──> crashed (resumable, FR-298)
any ──consent withdrawn──> (browser access revoked; state unchanged)
any ──broker shutdown──> gone (the index entry stays)
```

Only `idle` counts as idle for the cap (FR-311): `running` and `waiting-for-owner` are never evicted.

## Extension storage

| Key | Shape | Notes |
| --- | --- | --- |
| `agentPanelConsent` | `{ granted: boolean, at: string }` | the one-time panel consent (FR-299, FR-309); absent = never asked |
| `agentPanelTab` | `"conversation"` \| `"connections"` | last tab (FR-284) |
| `agentSiteModes[origin]` | `+ changedBy?: "panel-agent" \| "external-agent" \| "owner"`, `+ changedAt?: string` | R-328; same commit as the schema |

Panel sessions (R-321) live in the worker's existing session table with `kind: "panel"` and
`conversationId`; they are never written to `agentPairings`.

## Tool kinds (R-317)

`edit`, `delete`, `move`, `execute`, `fetch`, `other` — the protocol's tool-call kinds that can
change something. `read`, `search`, `think` are never asked by the strict modes and never get rules.
