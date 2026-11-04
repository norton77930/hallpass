# Implementation Plan: Agent Questions as Side-Panel Cards

**Branch**: `claude/charming-goldberg-a09vjh` | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)

## Summary

The broker tells each side-panel agent it can show form questions (D-029-1) and answers the protocol's
`elicitation/create`. It does this the way it answers permission requests today: a question in a live turn
becomes a `question` event, the panel draws a card, and the owner's Send or Skip comes back as one command.
The broker checks it against the question and replies to the agent. Stop, turn end, exit and the agent's own
withdrawal close the card. Claude Code and Codex start asking this way at once; Hermes and DeepSeek are
unchanged (FR-448, R-428).

## Technical Context

**Language/Version**: TypeScript, Node >= 24 (host), MV3 + React (side panel)
**Primary Dependencies**: existing only. The ACP SDK 1.9.0 already defines `elicitation/create` and its
schema (R-429). No new package.
**Storage**: none; events in memory only (R-436)
**Testing**: vitest `unit` (contracts, broker over the fake agent), `extension-ui` (the card); probe-017 on
Windows for the real agents (R-428, R-429)
**Constraints**: strict schemas at every boundary; nothing answered without Send (FR-441); no value in logs
or diagnostics (FR-444); host and extension upgrade together
**Scale/Scope**: ≤ 20 fields, ≤ 100 options per field (R-432); one or more open panel documents

## Constitution Check

| Principle | Result |
| --- | --- |
| I Requirements | PASS: issue #17, D-029-1..3 confirmed |
| II Clean room | PASS: adapters read for wire behaviour only; research says it in our words |
| III Traceability | PASS: FR-439..449 → R-428..437 → T864.. |
| IV Uncertainty | PASS: Hermes 0.22.2 open (R-428, probe-017); the card never names a source the question lacks (R-430) |
| V Least privilege | PASS: no manifest permission; links not advertised (D-029-1) |
| VI Privacy | PASS: answers go only to the agent; secret fields hidden (FR-449); no value stored or logged (SC-199) |
| VII Observable | PASS: SC-196..201, each with a test |
| VIII, IX, X, XI, XII | PASS: MV3 unchanged; no dependency; every ending defined (R-435) |

Post-design re-check: unchanged. R-430 narrowed D-029-2 to what the protocol carries; the spec was amended
(FR-443, User Story 3) rather than promising a server name the adapters do not send.

## Source Code (touched)

```text
packages/contracts/src/conversation.ts, index.ts        # question / question-closed events, question-reply command
packages/agent-host/src/broker/questions.ts             # NEW: form schema → fields, reply check, summary (pure)
packages/agent-host/src/broker/conversation.ts          # advertise forms; onElicitation; held questions; endings
packages/agent-host/src/broker/commands.ts              # question-reply
tests/harness/fake-acp-agent.ts                         # ask:form:<shape> keywords, withdrawal, secret field
apps/extension/src/side-panel/agent/conversation/
  QuestionCard.tsx                                      # NEW: the card and its controls
  conversation-log.ts, MessageList.tsx, ConversationTab.tsx   # timeline entry, answered line, reply command
apps/extension/src/locales/{en-US,zh-TW}.ts, catalog.ts
```

## Slices

Tasks in [tasks.md](tasks.md), by user story:

1. **Setup**: the fake agent's keywords (T864).
2. **Foundational**: the contracts (T865) and the pure module `questions.ts` (T866-T867).
3. **US1**: the broker (T868-T870), the card (T871-T872) and the strings (T873).
4. **US2**: every ending (T874), waiting (T875) and Skip in the card (T876).
5. **US3**: the tool call (T877-T878) and secret fields (T879).
6. **US4**: no change for Hermes and DeepSeek (T880).
7. **Polish**: no value in logs (T881), docs and coverage (T882), the gates (T883) and the Windows run (T884).
