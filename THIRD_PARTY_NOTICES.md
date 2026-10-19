# Third-party notices

Hallpass is licensed under the Apache License 2.0 (see `LICENSE`). The artifacts it ships — the
extension bundle and the bundled MCP server, relay and installer — include the following third-party
packages. Each is used under its own licence, reproduced in its package directory under
`node_modules/` in a source checkout.

| Package | Version | Licence | Where it ships |
| --- | --- | --- | --- |
| react | 19.2.8 | MIT | extension side panel |
| react-dom | 19.2.8 | MIT | extension side panel |
| zod | 4.4.3 | MIT | extension, MCP server, relay |
| @modelcontextprotocol/sdk | 1.31.0 | MIT | MCP server |
| gifenc | 1.0.3 | MIT | extension off-screen document (GIF encoding for session recordings) |
| @agentclientprotocol/sdk | 1.9.0 | Apache-2.0 | side-panel agent broker (client for the owner's coding agent) |
| koffi | 3.3.3 | MIT | side-panel agent broker (Windows job object that ends agent processes with the browser) |

The side-panel agent's connectors (`@agentclientprotocol/claude-agent-acp`,
`@agentclientprotocol/codex-acp` and their dependencies) are not shipped: they are downloaded from the
npm registry at the versions pinned in `packages/agent-host/agents/*/package-lock.json` only after the
owner agrees, and each keeps its own licence in its install folder.

Development and test dependencies (TypeScript, Vite, Vitest, Playwright, Testing Library, omggif and
others) are not part of any shipped artifact; their licences are in `node_modules/` as well.

The extension's icon and every string in `apps/extension/src/locales/` are original to this project.
