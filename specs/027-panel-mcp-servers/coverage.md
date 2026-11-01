# Coverage: Extra MCP Servers for Side-Panel Conversations

Measured 2026-10-28 in a Linux cloud session (Node 24.22.1); Windows-only checks still owed (bottom).

| Requirement | Evidence |
| --- | --- |
| FR-425, FR-431 (schema, names, limits) | `packages/contracts/src/conversation.test.ts` "027" (4), `settings.test.ts`; form checks in `settings-mcp-servers.test.tsx` |
| R-417, R-418 (list file, save / edit / remove, unreadable never overwritten) | `packages/agent-host/tests/panel-mcp-servers-027.test.ts` (4) |
| FR-426, FR-427, FR-428 (what a run is handed; once per run; DeepSeek none; values only to the program) | `panel-mcp-servers-027.test.ts` session entries (2), `conversation-extra-servers-027.test.ts` (4, real fake-agent runs: session/new, a mode reload keeps the run's list, the next run reads it again) |
| R-420 (Codex) | `panel-mcp-servers-027.test.ts`, `broker-panel-mcp-027.test.ts` codexSkipped |
| FR-432, R-421 (Check) | `panel-mcp-servers-027.test.ts` (5: tools listed, missing command, a server that exits - its secret not in the reason, the bound, Windows launch line) with `tests/fixtures/tiny-mcp-server.mjs`; no fixture process left after the run |
| FR-428, SC-191 (no value in frames) | `broker-panel-mcp-027.test.ts` searches every frame for the test secret |
| FR-429, FR-430, page | `apps/extension/tests/settings-mcp-servers.test.tsx` (8), both locales; `settings-port.test.ts` "027" (state + forwarding) |
| Bundle | `tests/contract/qa-package.contract.test.ts` "imports nothing but Node built-ins": the Check uses an own stdio transport, not the SDK's CommonJS `cross-spawn` path |

Runs: typecheck 0 errors; unit + extension-ui 3718 tests, 87 failing - the same 87 as before (Windows-only tests
on Linux); contract 383, 2 failing (koffi win32 staging, `%LOCALAPPDATA%` host registration - Windows-only,
failing before); snapshot check 1034 files, 0 hits.

Owed on Windows (quickstart): `npx` through cmd.exe and the process-tree end after a Check (step 2); a real
agent listing the server's tools in a side-panel conversation and not in a terminal (step 3, SC-189, SC-190);
a variable set in Windows read after a browser restart (step 4).
