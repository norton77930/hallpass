# Tasks: Fixes from the Owner's First Hermes Trial (023)

**Input**: specs/023-agent-trial-fixes/ (spec, plan, research R-363..R-370, data-model, contracts/frames.md, quickstart)
**Tests**: required — project rule: every behaviour change gets its failing test first.
**Slices** (plan): S1 = Phase 3 (US1); S2 = Phase 2 + broker tasks of US3–US5; S3 = panel/worker tasks of
US2–US5; S4 = final phase. Reviews: `code-reviewer` after S2 and on the combined diff.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T702 Create `.scratch/023/` and record the owner's Hermes path, version (0.22.2) and whether the `mcp` component is importable (read only) in `.scratch/023/env.md`

## Phase 2: Foundational — contracts (S2 first step; blocks S3)

- [X] T703 Failing contract tests for `conversation-browser-attached`, notice codes `browser-tools-missing` / `key-env-not-in-browser` (variable name pattern), `ui.conversation.diagnostics` and reply `conversation-diagnostics` (≤ 50 lines, ≤ 500 chars) in `packages/contracts/src/conversation.test.ts`
- [X] T704 Add those schemas (strictObject, additive) per `contracts/frames.md` in `packages/contracts/src/conversation.ts`; commit so S3 can start

## Phase 3: User Story 1 — saved logins never offered (P1, S1, shippable alone) 🎯 MVP

**Independent test**: the real Hermes' offered tools contain no `browser_vault` in strict and automatic mode.

- [X] T705 [US1] Failing test: strict layer disables `[terminal, code_execution, delegation, browser]`, automatic `[browser]`, and no layer names `browser_vault` in `packages/agent-host/tests/broker-agent-launch-settings.test.ts`
- [X] T706 [US1] Replace `browser_vault` with `browser` (R-363, cite D-023-1) in `packages/agent-host/src/broker/agent-launch-settings.ts`; update affected expectations in `packages/agent-host/tests/broker-agents.test.ts` and `broker-conversation-agents-021.test.ts`
- [X] T707 [US1] Scratch measurement (R-364): with the owner's Hermes interpreter and `HERMES_MANAGED_DIR` = a copy of each layer, list direct + catalog tool names for the ACP tool set; record result in `.scratch/023/vault-measure.md` (no model call, owner's state untouched)
- [X] T708 [US1] Amend 021 change log: FR-348 was not met in 0.15.0/0.15.1, fixed by D-023-1 in `specs/021-hermes-deepseek-agents/spec.md`

## Phase 4: User Story 2 — waiting feedback (P1, S3)

**Independent test**: fake slow agent + silent model → starting line, seconds count, hint at 30 s; output clears it.

- [X] T709 [P] [US2] Failing UI tests: starting line for every agent with its expected time; "waiting N s" from send to first turn update; hint at ≥ 30 s; cleared by message chunk, thought, tool call or permission card; Stop still offered, in `apps/extension/tests/conversation-waiting-023.test.tsx`
- [X] T710 [US2] Implement in `apps/extension/src/side-panel/agent/conversation/ConversationTab.tsx` (StartingLine for all agents) and `TurnActions.tsx` (LiveLine timer, polite live region only at 30 s) (R-370)
- [X] T711 [P] [US2] en-US + zh-TW strings (starting with time, waiting seconds, server/VPN hint) in `apps/extension/src/locales/en-US.ts`, `zh-TW.ts` and `apps/extension/src/side-panel/agent-panel-keys.ts`

## Phase 5: User Story 3 — tab for every agent; browser-tools notice (P2, S2 broker + S3 panel)

**Independent test**: tab attached to a no-context agent arrives as a `.txt` file named in the message; a Hermes run without the browser greeting gets one notice; DeepSeek gets its notice at once.

- [X] T712 [US3] Failing broker tests: tab + no-context agent → file `<title>.txt` (title, address, blank line, text) in `hallpass-attachments`, named in the file text block, no `attachment-not-accepted`; context agent unchanged; image refusal unchanged, in `packages/agent-host/tests/broker-conversation-attachments.test.ts`
- [X] T713 [US3] Implement tab file placement in `packages/agent-host/src/broker/attachments.ts` and its use in `promptBlocks` / the refusal at `packages/agent-host/src/broker/conversation.ts` (R-366)
- [X] T714 [US3] Failing broker tests with fake agent: greeting frame within 10 s → no notice; none → one `browser-tools-missing` (also after a restart only once); DeepSeek → notice at once; Claude/Codex → never, in `packages/agent-host/tests/broker-conversation-browser-023.test.ts` (+ scenario in `tests/harness/fake-acp-agent.ts`)
- [X] T715 [US3] Implement descriptor fields `takesBrowserTools` / `checksBrowserTools` in `packages/agent-host/src/broker/agents.ts` and the check timer after session/new / session/load + frame handling in `packages/agent-host/src/broker/conversation.ts` (R-365)
- [X] T716 [P] [US3] Failing worker test: a `hallpass` greeting with a panel token sends `conversation-browser-attached` once per conversation run, in `apps/extension/tests/agent-runtime-browser-attached.test.ts`
- [X] T717 [US3] Implement the forward in `apps/extension/src/service-worker/agent-runtime.ts`
- [X] T718 [P] [US3] Failing UI tests: "current tab" enabled for no-context agents (still greyed for pages without text); notice texts per agent, in `apps/extension/tests/composer-attach-tab.test.tsx` and `conversation-notices-023.test.tsx`
- [X] T719 [US3] Implement in `ConversationTab.tsx` (tabReason), notice rendering, strings en/zh

## Phase 6: User Story 4 — key variable the browser cannot see (P2, S2 + S3)

**Independent test**: fake Hermes auth failure with the named variable only in user settings → notice with the name; never a value.

- [X] T720 [US4] Failing tests for `packages/agent-host/src/broker/user-environment.ts`: reads only the `model:` block `key_env` / `api_key_env` name from a Hermes home `config.yaml` (HERMES_HOME or default); `.env` names only; user environment names via a names-only query (injected runner in tests); the value never appears in any return, in `packages/agent-host/tests/broker-user-environment.test.ts`
- [X] T721 [US4] Implement `user-environment.ts` (no YAML dependency)
- [X] T722 [US4] Failing broker test: Hermes start/first-turn auth or model-setup failure + name only in user settings → `key-env-not-in-browser` with the name; present in env or in `.env` → none; other agents → none, in `packages/agent-host/tests/broker-conversation-keyname-023.test.ts`
- [X] T723 [US4] Wire it into the failure path in `packages/agent-host/src/broker/conversation.ts` (R-369)
- [X] T724 [P] [US4] Panel notice text (variable name, quit the browser completely incl. background, reopen) + test, en/zh

## Phase 7: User Story 5 — agent output on request (P3, S2 + S3)

**Independent test**: fake agent prints 80 lines incl. an env value and a key-shaped string → reply has the last 50, scrubbed, ≤ 500 chars; nothing logged or written.

- [X] T725 [US5] Failing broker tests: output always drained (no stall with 1 MB of output); ring 50 × 500; `withoutEnvironmentValues` then `redact()`; diagnostics reply; dropped with the conversation; never in the broker log, in `packages/agent-host/tests/broker-conversation-diagnostics-023.test.ts`
- [X] T726 [US5] Implement: stderr `pipe`, line ring, diagnostics request handling in `packages/agent-host/src/broker/conversation.ts` (R-367; replaces R-326 ignore)
- [X] T727 [US5] **Review gate S2**: `code-reviewer` on T703–T726 broker/contract diff (scrubbing, user-environment names, timer lifecycle, tab file paths)
- [X] T728 [P] [US5] Failing UI test + implement: conversation details show "agent output" on request, monospace, keyboard reachable, in `apps/extension/src/side-panel/agent/conversation/ConversationHeader.tsx` (+ test)

## Phase 8: Polish & integration (S4)

- [X] T729 Run `npm run typecheck`, `npm test`, `npm run build`, `npm run test:contract`, `npm run snapshot:check`; record numbers
- [X] T730 **Review gate combined**: `code-reviewer` on the whole 023 diff
- [X] T731 Live (owner installs the dev host with `!`): Hermes conversation before the `mcp` component → browser-tools notice screenshot (SC-166)
- [X] T732 Live: dry run of adding `mcp==2.0.0` to the owner's Hermes environment, show the owner the changes; then install (D-023-4); new Hermes conversation: no notice, screenshot via Hallpass works
- [X] T733 Live: re-run the measurement T707 through ACP for strict and automatic: `browser_vault` absent, `hallpass` tools present (SC-163)
- [X] T734 Live: attach the current tab in Hermes and DeepSeek, summary answer (SC-165); waiting seconds + 30 s hint with the model server unreachable (SC-164)
- [X] T735 Live: Claude and Codex conversation unchanged apart from waiting feedback (FR-374)
- [ ] T736 Search broker log, diagnostics replies and screenshots for the key prefix: none (SC-168); version 0.15.2, 021/022 change logs, memory + artifacts per release routine

## Dependencies

- T702 → T705–T708 (S1) can ship alone.
- T703–T704 (contracts) → S3 tasks (T709–T711 need none; T716–T719, T724, T728 need contracts).
- S2 broker: T712–T715, T720–T723, T725–T726 after T704; T727 after them.
- S3 panel/worker: T709–T711 anytime after S1; others after T704. S2 and S3 disjoint paths (packages/ vs apps/).
- T729–T736 after all; T732 after T731 (notice must be seen before installing).

## Parallel example

Writers: S2 `implementer` (effort high) on packages/ + tests/harness; S3 `implementer-sonnet` on apps/extension — after T704 is committed. Main runs `tsc -b` between waves.

## Implementation strategy

MVP = Phase 3 (US1) → may release as 0.15.2 alone. Then S2 ∥ S3, review, S4 live, release.
