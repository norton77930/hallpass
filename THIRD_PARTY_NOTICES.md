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
| @modelcontextprotocol/sdk | 1.30.0 | MIT | MCP server |
| gifenc | 1.0.3 | MIT | extension off-screen document (GIF encoding for session recordings) |

Development and test dependencies (TypeScript, Vite, Vitest, Playwright, Testing Library, omggif and
others) are not part of any shipped artifact; their licences are in `node_modules/` as well.

The extension's icon and every string in `apps/extension/src/locales/` are original to this project.
