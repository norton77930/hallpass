# Coverage: Agent Questions as Side-Panel Cards

Measured 2026-11-04 in a Linux cloud session (Node 24.22.1); Windows-only checks still owed (bottom).

| Requirement | Evidence |
| --- | --- |
| FR-439, R-429 (forms advertised, no links; a fieldless MCP approval stays a permission card) | `packages/agent-host/tests/broker-questions-029.test.ts` "T868" (2) |
| FR-440, R-432 (each field kind, labels, options, limits, defaults, required; unsupported; skip-only bounds) | `packages/agent-host/tests/questions-029.test.ts` (5); contracts `conversation.test.ts` "029" (5); `broker-questions-029` "T869" (3) |
| FR-441, R-434 (Send exactly the values; invalid refused, card stays; first reply wins) | `questions-029` checkReply (4); `broker-questions-029` "T870" (4); `apps/extension/tests/side-panel-question-card-029.test.tsx` Send / limits / Skip (4) |
| FR-442, R-437 (waits like a card; no expiry; the box sends nothing meanwhile) | `broker-questions-029` "T875"; panel "while a question waits" |
| R-435 (answered, skipped, cancelled, withdrawn, agent-exited) | `broker-questions-029` "T874" (4); panel "each ending leaves its line" |
| FR-443, R-430 (the agent; the tool call only when announced; where the answer goes; the agent's waiting time) | `broker-questions-029` "T877"; panel "names the agent…" |
| FR-444, FR-449, SC-199, R-433, R-436 (summary; secret hidden; no value in events, logs, diagnostics, data files) | `questions-029` summarize (2); `broker-questions-029` "T879, T881"; panel "a secret field…" |
| FR-445 (another document's answer closes the card) | `broker-questions-029` second reply `not-found`; panel cards leave on `question-closed` |
| FR-446 (skip only) | `questions-029`; panel "a skip-only question…" |
| FR-447, D-029-3 (Claude Code's fallback-model question) | covered by the generic path: a single-choice form, Skip = decline (no special case in code) |
| FR-448, SC-201 (Hermes, DeepSeek unchanged) | `broker-questions-029` "T880" (2); the existing 021 suites pass unchanged |
| Fake agent `ask:form:*` | `tests/harness/fake-acp-agent.test.ts` "029" (8) |
| zh-TW | panel "speaks zh-TW"; every string in both locales (type-checked parity) |
| R-438 (the adapters' hints: chip, words, preview, answer box joined to its question) | `questions-029` "R-438" (4); `broker-questions-029` "R-438" (2, over the fake agent's `ask:form:claude` / `ask:form:codex`); contracts "R-438"; panel "R-438" (2) |
| Layout | rendered screenshot at side-panel width, light and dark: Send / Skip stay in view in a tall card |

Runs (T883, the CI order): typecheck 0 errors; `npm test` 3691 passed, 99 skipped (Windows-only on Linux);
`build:extension` ok; `test:contract` 386 passed, 4 skipped (the 019 contract now pins 33 error codes and
carries both question events); `snapshot:check` 0 forbidden paths, 0 hits; no stray `\tmp\hallpass-*` file.

Owed on Windows (T884, quickstart):
- `npm run probe:017` for R-428 (Hermes 0.22.2) and to confirm R-429 against the real Claude Code and
  Codex adapters;
- quickstart steps 3-6 with the real agents in the side panel (Claude Code's question tool, Codex's
  user-input request, two panel documents, a Codex MCP approval still a permission card).
