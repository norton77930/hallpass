# Implementation Plan: Extra MCP Servers for Side-Panel Conversations

**Branch**: `feature-027-panel-mcp-servers` | **Date**: 2026-10-28 | **Spec**: [spec.md](spec.md)

## Summary

The owner keeps one list of extra MCP servers on the settings page (D-027-1: agents ticked per server).
The broker stores it in Hallpass's per-computer data folder, hands each ticked server to a side-panel
conversation's session besides the browser tools, and checks a server on request by starting it once and
listing its tools (D-027-2). Variable values are read from the broker's environment at start and never
stored. No agent file is written; no browser permission changes.

## Technical Context

**Language/Version**: TypeScript, Node >= 24 (host), MV3 + React (settings page)
**Primary Dependencies**: existing only - zod contracts, the ACP SDK (session `mcpServers`), the MCP SDK
client (the check), `cross-spawn` through the MCP SDK (a `.cmd` such as `npx` on Windows)
**Storage**: `%LOCALAPPDATA%\hallpass\panel-mcp-servers.json` (names, commands, arguments, variable names,
agents - no values), written by temp file and rename
**Testing**: vitest `unit` (contracts, host), `extension-ui` (settings page), a tiny MCP server fixture
**Constraints**: strict schemas; values never leave the broker's process except to the agent's session;
host and extension upgrade together
**Scale/Scope**: up to 10 servers, 3 agents, 3 commands

## Constitution Check

| Principle | Result |
| --- | --- |
| I Requirements | PASS - issue #21, D-027-1/2 |
| II Clean room | PASS - nothing of another product is used |
| III Traceability | PASS - FR-425..432 → R-417..422 → T842.. |
| IV Uncertainty | PASS - what each agent does with a server it cannot start is not assumed; only Check reports health (D-027-2) |
| V Least privilege | PASS - no manifest change; the program runs only because the owner added it, said on the page (FR-429) |
| VI Privacy | PASS - values never stored, shown, framed or logged (FR-428, SC-191); the page sees set / not set only |
| VII Observable | PASS - SC-189..192 |
| VIII, IX, X, XI, XII | PASS - MV3 unchanged; no new dependency; unreadable list and failed check have defined behaviour |

## Source Code (touched)

```text
packages/contracts/src/conversation.ts, settings.ts, index.ts      # server, view, 3 commands, overview field
packages/agent-host/src/broker/panel-mcp-servers.ts                # list file, validation, session entries, check
packages/agent-host/src/broker/codex-config.ts                     # owner entry by any name (was `hallpass` only)
packages/agent-host/src/broker/conversation.ts                     # extras resolved once per run, added to mcpServers
packages/agent-host/src/broker/commands.ts, broker.ts              # save / remove / check; overview field
apps/extension/src/service-worker/{conversation-relay,settings-port}.ts
apps/extension/src/settings/tools/                                  # the list, the form, Check, Remove confirm
apps/extension/src/locales/{en-US,zh-TW}.ts, settings-keys.ts
```

## Slices

1. S1 contracts (T842). 2. S2 host module + Codex names (T843-T845). 3. S3 conversations get the servers
(T846). 4. S4 broker commands + overview (T847-T848). 5. S5 settings page (T849-T851). 6. S6 docs, run (T852-T853).
