# Tasks: Extra MCP Servers for Side-Panel Conversations

Every behaviour task starts with its failing test (project rule). IDs continue from 026 (T841).

## S1 — contracts

- [x] T842 Test first in `packages/contracts/src/conversation.test.ts` / `settings.test.ts`: the server
      (R-418 limits, names starting with `hallpass` refused), the view, overview / panel / settings `mcpServers`, the three
      commands in both unions, `mcp-server-refused`. Then the schemas.

## S2 — the host module

- [x] T843 Test first `packages/agent-host/tests/panel-mcp-servers-027.test.ts`: read (missing = empty,
      unreadable flagged), save (add, edit with rename, duplicate refused ignoring case, 10 at most,
      unreadable refused), remove, atomic write. Then `panel-mcp-servers.ts` list part. R-417, R-418.
- [x] T844 Test first (same file): session entries for an agent - only ticked, DeepSeek none, set
      variables with values, unset left out; Codex skips a name its owner entry cannot be merged over.
      Then the entries part and `codex-config.ts` by name. R-419, R-420.
- [x] T845 Test first (same file, fixture `tests/fixtures/tiny-mcp-server.mjs`): check works and lists
      tools; a missing command and a server that exits fail with a reason without a variable's value;
      the bound ends a hung one. Then the check part. R-421.

## S3 — conversations

- [x] T846 Test first (conversation harness): a Claude Code conversation's `session/new` carries the
      browser entry and the ticked extra with its variable; a later list change reaches the next run, not
      the running one; DeepSeek's carries none. Then `conversation.ts` / pool option. R-419.

## S4 — broker

- [x] T847 Test first `packages/agent-host/tests/broker-panel-mcp-027.test.ts`: overview views (set / not
      set, no value anywhere in the frame), save / remove / check commands and their refusals, `checking`
      then the result. Then `commands.ts`.
- [x] T848 Wire the file, the environment and the check into `broker.ts` and the pool.

## S5 — settings page

- [x] T849 Worker: pass `mcpServers` through the panel and settings state; forward the three commands.
      Test in `settings-port.test.ts`.
- [x] T850 Test first `apps/extension/tests/settings-mcp-servers.test.tsx`: empty state with the warning;
      add form (validation, agents ticked by default); row with variables set / not set, check results,
      Codex skipped; Check / Edit / Remove (confirm); DeepSeek line; unreadable list; both locales. Then
      the block in the Browser tools section.
- [x] T851 Locale keys and `settings-keys.ts`.

## S6 — docs and run

- [x] T852 README (both), CHANGELOG (both).
- [x] T853 typecheck, unit, extension-ui, build + contract, snapshot check; `coverage.md`.
