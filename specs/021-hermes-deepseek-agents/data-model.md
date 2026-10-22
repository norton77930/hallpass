# Data Model: Hermes and DeepSeek in the Side-Panel Conversation

## Agent description (broker, `broker/agents.ts`)

| Field | Claude Code | Codex | Hermes | DeepSeek |
|---|---|---|---|---|
| id | `claude-code` | `codex` | `hermes` | `deepseek` |
| kind | adapter | adapter | installed | fetched |
| program found | `claude` CLI | `codex` CLI | `hermes` (where.exe, then `%USERPROFILE%\.local\bin\hermes.exe`) | — |
| version rule | tested range (019) | tested range (019) | exactly 0.22.2 | package exactly 0.2.1-rc.2 |
| package fetched | adapter | adapter | — | `@deepseek-ai/dsh` |
| install timeout | 10 min | 10 min | — | 30 min |
| launch | `node <adapter bin>` | `node <adapter bin>` + shim | `hermes acp` | `node <dsh>/lib/bin.js --profile acp` |
| strict | agent mode `default` + ask rules | agent mode `read-only` | launch: managed layer strict + agent mode `default` | launch: `DSH_PERMISSION_MODE=read-only` |
| agent-review | agent mode `auto` | agent mode `agent` | launch: managed layer agent-review + agent mode `accept_edits` | launch: `DSH_PERMISSION_MODE=workspace-write` |
| always | — | — | — | `DSH_TELEMETRY_MODE=DISABLED` |
| continue a session | `session/load` | `session/load` | `session/load` | `session/resume` (no replay) |
| notes | — | — | Git Bash missing → note | pre-release → note |

Validation: a mode not listed for an agent is refused (existing `MODE_ALLOW_LIST` rule, now per description).

## Managed layer (Hermes)

`%LOCALAPPDATA%\hallpass\agents\hermes\managed\<mode>\config.yaml`, written by the broker before each launch
(overwritten with fixed content; nothing else in the folder):

- strict: `agent.disabled_toolsets: [terminal, code_execution, delegation, browser_vault]`
- agent-review: `agent.disabled_toolsets: [browser_vault]`

## Availability (contract, extended)

`missing | version-problem | needs-install | ready` (unchanged) plus `notes: ("git-missing" | "pre-release")[]`
(optional, empty when none).

## Announced action (broker, per conversation)

`toolCallId → { title?, kind?, detail? }` from `tool_call` / `tool_call_update`; read by the permission card;
cleared when the turn ends.

## Permission card (contract, extended)

Existing card + `rejectOnly?: true` when neither the request nor the announced action describes the action.

## Conversation state (extended)

`starting` may end in `start-cancelled` (owner stopped it): process killed, conversation back to not started,
held first message returned to the composer. New error codes: `start-cancelled`, `agent-model-unreachable`.
