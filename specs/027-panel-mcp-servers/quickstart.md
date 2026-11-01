# Quickstart: Extra MCP Servers for Side-Panel Conversations

1. Automated: the 027 tests in `packages/contracts`, `packages/agent-host/tests/panel-mcp-servers-027.test.ts`,
   `packages/agent-host/tests/broker-panel-mcp-027.test.ts`, `apps/extension/tests/settings-mcp-servers.test.tsx`.
2. Settings page → Browser tools: add `everything` with command `npx`, arguments
   `-y @modelcontextprotocol/server-everything`; press Check: Works, with its tools.
3. Start a Claude Code conversation in the side panel; ask it to list its tools: the server's tools are there.
   Start `claude` in a terminal: they are not; `~/.claude.json` is unchanged (SC-190).
4. Add a variable name that is not set: the row says Not set. Set it in Windows, restart the browser: Set.
5. Untick Codex for the server; a Codex conversation does not get it.
6. Remove it (confirm); the next conversation does not get it.
