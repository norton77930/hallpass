# Data Model: Extra MCP Servers for Side-Panel Conversations

## Panel MCP server (stored, and the save command's payload) — R-418

| Field | Type |
| --- | --- |
| `name` | string 1..40, `[A-Za-z0-9_-]`, not starting with `hallpass` (any case) |
| `command` | string 1..400 |
| `args` | string[] ≤ 30, each ≤ 400 |
| `variables` | string[] ≤ 10, each `[A-Za-z_][A-Za-z0-9_]{0,99}` |
| `agents` | non-empty subset of `claude-code`, `codex`, `hermes` |

File: `{ "servers": PanelMcpServer[] ≤ 10 }`.

## Server view (overview → settings page) — R-422

Server fields, with `variables` as `{ name, set: boolean }[]`, plus optional `check`
(`{ outcome: "works", tools: string[] ≤ 50, toolCount, at }` or `{ outcome: "failed", detail, at }`),
`checking: true`, `codexSkipped: true`.

Overview: `mcpServers?: { servers: view[] ≤ 10, unreadable?: true }`.
