# Frames: Extra MCP Servers for Side-Panel Conversations

All optional additions; host and extension upgrade together.

- `conversation-overview`, the panel state and the settings state: `mcpServers?` (data-model).
- `ui.conversation.mcp-server-save { server, previousName? }`: adds a server, or replaces `previousName`
  (an edit, which may rename). Refused `mcp-server-refused` with the reason (duplicate name, list full,
  list unreadable); `not-found` when `previousName` is not in the list.
- `ui.conversation.mcp-server-remove { name }`: `not-found` when absent.
- `ui.conversation.mcp-server-check { name }`: ok at once; the result arrives in the overview.
