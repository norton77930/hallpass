# Tasks: Hermes and DeepSeek in the Side-Panel Conversation

**Input**: specs/021-hermes-deepseek-agents/ (spec.md, plan.md, research.md R-345..R-356, data-model.md, contracts/agents.md, quickstart.md)
**Tests**: required — project rule: every behaviour change has its failing test first (RED), then the change (GREEN).
**Slices** (plan.md): S1 = T637–T652 · S2 = T653–T668 · S3 = T669–T682 · S4 = T683–T694. S1 first, then S2 ∥ S3.

Paths: `BR` = `packages/agent-host/src/broker/`, `BT` = `packages/agent-host/tests/`,
`APP` = `apps/extension/src/side-panel/agent/conversation/`, `UT` = `apps/extension/tests/`.

## Phase 1: Setup

- [ ] T637 Add `packages/agent-host/agents/deepseek/package.json` (exact dependency `@deepseek-ai/dsh` `0.2.1-rc.2`, private, no scripts) and generate `packages/agent-host/agents/deepseek/package-lock.json` with `npm install --package-lock-only --ignore-scripts --omit=optional` in that folder; confirm every entry has `integrity` and only registry URLs (no local paths) (R-345, FR-350)

## Phase 2: Foundational (S1 — blocks every story)

- [ ] T638 [P] RED: contract test that `CONVERSATION_AGENTS` is `["claude-code","codex","hermes","deepseek"]`, availability accepts `notes: ["git-missing"|"pre-release"]`, a permission event accepts `rejectOnly: true`, and the error codes include `start-cancelled` and `agent-model-unreachable`, and the conversation projection accepts `replay?: "none"`, in `tests/contract/agent-conversation-021.contract.test.ts`
- [ ] T639 Extend `packages/contracts/src/conversation.ts` per contracts/agents.md (agent ids, `notes`, `rejectOnly`, two codes, `replay?: "none"`; all `strictObject`) — T638 GREEN
- [ ] T640 [P] RED: descriptor table tests in `BT/broker-agents.test.ts` — four descriptions with kind adapter/adapter/installed/fetched; Hermes found by `where.exe hermes` then `%USERPROFILE%\.local\bin\hermes.exe`; Hermes version `0.22.2` ready, `0.22.1` → version-problem showing both; DeepSeek needs-install until `<data>\agents\deepseek\0.2.1-rc.2\node_modules\@deepseek-ai\dsh\package.json` says `0.2.1-rc.2`; Git Bash missing → note `git-missing` on Hermes (still ready); DeepSeek note `pre-release`; Claude/Codex rows unchanged
- [ ] T641 Rework `BR/agents.ts` into the descriptor table (data-model.md) keeping Claude/Codex behaviour byte-for-byte; Hermes discovery + version + Git Bash probe (`where.exe bash` under a Git install or `%ProgramFiles%\Git\bin\bash.exe`); DeepSeek fetched availability — T640 GREEN
- [ ] T642 [P] RED: launch settings tests in `BT/broker-agent-launch-settings.test.ts` — Hermes strict writes `<data>\agents\hermes\managed\strict\config.yaml` with `agent.disabled_toolsets` exactly `[terminal, code_execution, delegation, browser_vault]`, agent-review exactly `[browser_vault]`, overwrites a tampered file, writes nothing else, returns env `{HERMES_MANAGED_DIR}` and agent mode `default` / `accept_edits` (never `dont_ask`); DeepSeek strict env `DSH_PERMISSION_MODE=read-only`, agent-review `workspace-write`, both `DSH_TELEMETRY_MODE=DISABLED`; no value ever equals `danger-full-access`; no key-like variable is set
- [ ] T643 Create `BR/agent-launch-settings.ts` (pure: mode → `{env, agentMode?, files}`; writer separate) — T642 GREEN
- [ ] T644 [P] RED: `adapterLaunchSpec` tests in `BT/broker-agents.test.ts` — Hermes `{command: <hermes.exe>, args: ["acp"]}`, DeepSeek `{command: node, args: [<dsh>\lib\bin.js, "--profile", "acp"]}`, env from T643, Claude/Codex specs unchanged; a `.cmd` Hermes shim is launched through `cmd.exe /d /s /c` like `run-command.ts`
- [ ] T645 Extend `adapterLaunchSpec` / launcher in `BR/agents.ts` and `BR/commands.ts` (`createAgentLauncher`) with the per-mode launch settings — T644 GREEN
- [ ] T646 [P] RED: install timeout test in `BT/broker-install.test.ts` — DeepSeek install bound 30 min, others 10 min; `NPM_CI_ARGS` unchanged
- [ ] T647 Per-agent install timeout in `BR/install.ts` (from the descriptor) — T646 GREEN
- [ ] T648 [P] RED: packaging tests in `tests/contract/qa-package.contract.test.ts` — the zip and `install.ps1` required files include `agents/deepseek/package.json` and `package-lock.json`
- [ ] T649 Add `deepseek` to `AGENT_MANIFEST_DIRECTORIES` in `scripts/package.ts` and the required files in `scripts/package/install.ps1` — T648 GREEN
- [ ] T650 Update every `Record<ConversationAgent, …>` site to compile with the two new agents without behaviour change for the panel yet (placeholder letters/strings are added in S3): `APP/agent-mark.ts`, `apps/extension/src/locales/catalog.ts`, `en-US.ts`, `zh-TW.ts` (English text for the new keys in both files is allowed only until T679 fills zh-TW) — `npm run typecheck` green
- [ ] T651 S1 gate: `npx tsc -b`, `npm run typecheck`, `npm test`, `npm run snapshot:check` green; report counts
- [ ] T652 Commit S1

**Checkpoint**: contracts and descriptors settled — S2 and S3 may start in parallel.

## Phase 3: User Story 1 + 2 — strict Hermes and DeepSeek (P1, S2)

**Goal**: each new agent asks before every in-folder edit and command under strict (SC-155/156).
**Independent test**: fake-agent scenarios `hermes` and `deepseek` through the broker harness.

- [ ] T653 [US1] Add scenarios `hermes` and `deepseek` to `tests/harness/fake-acp-agent.ts` imitating measured messages: Hermes `loadSession: true`, image true, modes default/accept_edits/dont_ask, permission options `allow_once`/`deny` (kinds allow_once/reject_once) with title and kind; DeepSeek no modes, `sessionCapabilities {list, resume, close}`, no `loadSession`, permission request carrying only `toolCallId` after a `tool_call` with `rawInput {command, justification}`, options `allow-once`/`reject-once`; plus a keyword that requests permission for an unannounced id; record received env names (not values) for assertions; route `conversation-harness.ts` scenario by agent id
- [ ] T654 [P] [US1] RED: `BT/broker-conversation-agents-021.test.ts` — Hermes strict starts with managed env and sets mode `default`; a permission card appears for an edit and Reject answers with the `deny` option id
- [ ] T655 [P] [US2] RED: same file — DeepSeek strict starts with `DSH_PERMISSION_MODE=read-only` and telemetry DISABLED, never calls `session/set_mode`; its permission card detail comes from the announced `tool_call` (command + reason); Allow answers `allow-once`
- [ ] T656 [P] [US2] RED: reject-only — a DeepSeek request whose id was never announced gives a card with `rejectOnly: true`, an "allow for this conversation" rule does not answer it, and `ui.conversation.answer` allow on it is refused `invalid-command`
- [ ] T657 [US1] [US2] Implement in `BR/conversation.ts`: mode map from descriptors (replaces `MODE_ALLOW_LIST` literal, same values for Claude/Codex), launch-time modes (no `set_mode` for DeepSeek; Hermes agent mode after `session/new`), announced-action store per `toolCallId` (cleared at turn end), card detail fallback, `rejectOnly` — T654–T656 GREEN
- [ ] T658 [P] [US4] RED: stop while starting — `ui.conversation.stop` during `starting` (fake agent that never answers `session/new`) kills the process tree, emits state stopped with `start-cancelled`, frees the cap slot, and the process is gone within 5 s (SC-159)
- [ ] T659 [US4] Implement stop-while-starting in `BR/conversation.ts` (`Conversation.stop` / pool stop; kill via existing tree kill; no broker timeout added) — T658 GREEN
- [ ] T660 [P] [US4] RED: model unreachable — an agent turn error naming connection refused / 401 / 403 or a missing key variable gives code `agent-model-unreachable` with the agent's setting location hint; the error text kept in the log never contains a value of any environment variable (only names) (SC-161)
- [ ] T661 [US4] Implement the classification in `BR/conversation.ts` failure path — T660 GREEN

## Phase 4: User Story 3 — automatic mode per conversation (P2, S2)

- [ ] T662 [P] [US3] RED: changing Hermes strict → automatic between turns closes the agent, starts it with the agent-review managed layer and `accept_edits`, and continues with `session/load`; during a turn the change is refused as today
- [ ] T663 [P] [US3] RED: changing DeepSeek strict → automatic restarts with `workspace-write` and continues with `session/resume` (no replay)
- [ ] T664 [US3] Implement restart-on-launch-mode-change in `BR/conversation.ts` — T662–T663 GREEN

## Phase 5: User Story 5 — old conversations (P2, S2)

- [ ] T665 [P] [US5] RED: reopening a DeepSeek conversation after its agent stopped uses `session/resume` (not `session/load`), marks the conversation `replay: none`; resume failure → `cannot-resume` as today; Hermes reopening uses `session/load` and replays
- [ ] T666 [US5] Implement resume-without-load in `BR/conversation.ts` start path (replaces the hard `loadSession` refusal at start when the agent offers resume) and set `replay: "none"` on the projection (field from T639) — T665 GREEN
- [ ] T667 S2 gate: `npm test`, `npm run typecheck`; Claude/Codex broker tests unchanged and green (SC-162)
- [ ] T668 `code-reviewer` on S2 (consent path: card detail, reject-only, launch settings; lifecycle: stop while starting, restart on mode change); fix findings with a RED test each; commit S2

## Phase 6: User Story 4 + panel (P1, S3 — parallel with S2 after T652)

- [ ] T669 [P] [US4] RED: `UT/agent-menu.test.tsx` — the list shows four agents in contract order with letters/marks; Hermes not installed → install hint naming the tested release and the official installer; version mismatch shows both versions and cannot be picked; `git-missing` note text; DeepSeek needs download → first-use card with size; `pre-release` note; keyboard reachable and named
- [ ] T670 [US4] Implement in `APP/AgentMenu.tsx`, `APP/agent-mark.ts`, `APP/FirstUseCard.tsx` — T669 GREEN
- [ ] T671 [P] [US4] RED: `UT/conversation-view.test.tsx` — a starting conversation shows "Starting <agent>…", DeepSeek adds "the first start can take a few minutes", a Cancel button sends `ui.conversation.stop`; on `start-cancelled` the held first message returns to the composer and the state is not started
- [ ] T672 [US4] Implement in `APP/ConversationTab.tsx` — T671 GREEN
- [ ] T673 [P] [US2] RED: `UT/permission-card.test.tsx` — `rejectOnly` card says the action is unknown and shows only Reject (no Allow / Allow for conversation), keyboard order intact
- [ ] T674 [US2] Implement in `APP/PermissionCard.tsx` — T673 GREEN
- [ ] T675 [P] [US4] RED: `agent-model-unreachable` shows the hint naming where the agent's own setting lives (Hermes: its settings folder; DeepSeek: its settings / environment variable), never a key field
- [ ] T676 [US4] Implement in `APP/broker-words.ts` / conversation error view — T675 GREEN
- [ ] T677 [P] [US5] RED: a conversation with `replay: none` shows "earlier messages cannot be shown by DeepSeek; you can continue" and the composer stays usable
- [ ] T678 [US5] Implement in `APP/ConversationTab.tsx` — T677 GREEN
- [ ] T679 [US3] Mode menu notes for Hermes (automatic runs commands without a folder boundary, D-021-5) and DeepSeek (switching restarts the agent) in `APP/ModeMenu.tsx`; zh-TW for every new key in `apps/extension/src/locales/zh-TW.ts` (G26), test in `UT/composer.test.tsx`
- [ ] T680 [US5] RED→GREEN: "+" menu follows reported accepts for the two agents before and after start (descriptor expectation before start, start value wins) in `UT/composer.test.tsx`
- [ ] T681 S3 gate: `npm test` (extension-ui), `npm run typecheck`
- [ ] T682 Commit S3

## Phase 7: Integration, User Story 6 and release conditions (S4)

- [X] T683 Main: `npx tsc -b`, `npm run build`, `npm run test:contract`, `npm run snapshot:check` on the combined state
- [X] T684 Packaged conversation gate (`tests/e2e/packaged/agent-conversation.spec.ts`) with cases for the `hermes` and `deepseek` fake scenarios: strict card, reject-only card, cancel while starting — via the `.scratch/t602` runner (`test-analyst`)
- [X] T685 [US6] Claude Code and Codex: existing gate cases and one strict turn each unchanged (SC-162)
- [X] T686 Move the dev Hermes install to a durable path: copy the 0.22.2 source out of the job folder to a folder under the user profile and reinstall editable with Python 3.14; `hermes --version` = 0.22.2
- [X] T687 Live, dev host on the owner's machine (owner installs the host with `!`): Hermes strict and automatic in a scratch folder per quickstart steps 3–4; owner's Hermes settings byte-identical before/after (SC-158)
- [X] T688 Live: DeepSeek first-use download (≤ 30 min), Cancel during start (process gone ≤ 5 s), strict and automatic per quickstart steps 2–6
- [X] T689 SC-157 release condition: DeepSeek real-model cases on the owner's model (owner-run `real-run.mjs --only real-dsh`) — strict asks before edit/create/delete/command; record in research R-349
- [X] T690 SC-161: search broker logs, panel logs and files Hallpass wrote during T687–T689 for the key value (owner-run search script; Claude never sees the value) — owner run 2026-10-23: QWEN_3_8_API_KEY and GEMINI_CLI_IDE_AUTH_TOKEN checked (process env + saved user variables), 1 638 files; no key in any file Hallpass wrote; the one hit was a test-harness debug dump of the fake Hermes's environment (job folder, 2026-10-22, not written by Hallpass), deleted
- [X] T691 Screenshots en-US / zh-TW × light / dark: agent list states, starting + Cancel, reject-only card, no-replay note (`.scratch/021/shots`) — retaken 2026-10-22 after T701 (reject-only card now shows the mode-fixed line); 1a / 1c / 1c2 kept from the earlier take (agent-list states unchanged since)
- [X] T692 `code-reviewer` on the combined 021 diff; fix findings with a RED test each
- [X] T693 Update spec 021 change log and coverage (FR-343..359 → tests), memory/progress
- [ ] T694 Owner OK, then 0.15.0 (022 + 021) release per the release recipe — `human` gate

## Phase 8: D-021-16 — DeepSeek's mode fixed once started; the first start takes the chosen mode (FR-360, FR-361)

- [X] T695 [US3] Contracts: `CONVERSATION_MODE_FIXED_AGENTS` (`deepseek`), error code `mode-fixed`, optional `mode` on `ui.conversation.start`; contract tests in `tests/contract/agent-conversation-019/021.contract.test.ts`
- [X] T696 [US3] RED: `BR` tests — a started DeepSeek conversation's switch is refused `mode-fixed`, running or stopped, with no second run; a DeepSeek start in automatic launches `workspace-write`, reports and lists automatic, and a resume keeps it (`broker-conversation-agents-021.test.ts`, `broker-commands.test.ts`); descriptor flag matches the contract (`broker-agents.test.ts`)
- [X] T697 [US3] Implement in `BR/agents.ts` (`modeFixedOnceStarted`), `BR/conversation.ts` (start mode, resume keeps a fixed mode, `setMode` refusal), `BR/commands.ts` — T696 GREEN
- [X] T698 [US3] RED→GREEN: a started DeepSeek conversation's mode chip is `aria-disabled`, opens nothing, and says why on screen and in its description (en-US, zh-TW); Claude Code and Hermes keep the switch; DeepSeek's menu before the start has no restart note (`UT/composer.test.tsx`; `APP/Composer.tsx`, `APP/ConversationTab.tsx`, `APP/ModeMenu.tsx`, locales, `agent-panel-keys.ts`)
- [X] T699 [US3] RED→GREEN (R-360): for each of the four agents the empty conversation's mode goes with `ui.conversation.start` and nothing is switched beside the first message (`UT/composer.test.tsx`); the broker starts each agent in automatic from its start - its launch settings, its mode id, one run, the first `mode` event and the index (`broker-conversation-agents-021.test.ts`)
- [X] T700 Spec: D-021-16, FR-360, FR-361, R-359, R-360, change log, quickstart step 4
- [X] T701 [US3] RED→GREEN (FR-361 fix): the mode chosen for one new conversation does not carry to the next - once the started conversation takes its first message the empty conversation is back on Ask first and the next start names no mode; the choice stays while the owner changes agent or folder before sending (`UT/composer.test.tsx`; `APP/ConversationTab.tsx`)

## Dependencies

- T637 → T641/T649. T638–T650 (S1) → everything else.
- S2 (T653–T668) ∥ S3 (T669–T682): disjoint paths (S2 owns `packages/agent-host`, `tests/harness`; S3 owns `apps/extension`). All contract changes are in S1, so S2 and S3 share no changing interface.
- T683–T694 after S2 and S3. T689 needs only the owner's run (can finish any time before T694).
- US6 (T685) closes only after every other story.

## Parallel examples

- After T652: one `implementer` (effort high) on T653–T668 and one `implementer-sonnet` on T669–T682.
- Within S1: T638, T640, T642, T646, T648 RED tests in parallel by one worker.

## Implementation strategy

MVP = S1 + US1/US2 strict (T637–T661): both agents usable under strict with the asking bar. Then automatic
mode and old conversations, then the panel polish. Hermes and DeepSeek are not tied (G30): if one fails its
release condition (SC-157), it ships hidden and 0.15.0 goes with the other.

## Coverage (T693)

Live rows are the steps of `.scratch/021/live/results.jsonl` (dev host, 2026-10-22) and the owner-run
`real-run.mjs` cases (2026-10-21); "gate" is `tests/e2e/packaged/agent-conversation.spec.ts`. Test files are
under `packages/agent-host/tests/` (broker) or `apps/extension/tests/` (panel) unless the path starts with `tests/`.

| FR | Tests | Live evidence |
|----|-------|---------------|
| FR-343 agent list and states | `agent-menu.test.tsx`; `broker-agents.test.ts`; `tests/contract/agent-conversation-021.contract.test.ts` | live step 1 |
| FR-344 Hermes found, tested version only | `broker-agents.test.ts`; `agent-menu.test.tsx` | live step 1 |
| FR-345 no install of Hermes or Git, install hint | `broker-agents.test.ts`; `agent-menu.test.tsx` | live step 1 |
| FR-346 Hermes strict: tools off, edits ask | `broker-agent-launch-settings.test.ts`; `broker-conversation-agents-021.test.ts` | live step 6, `real-herm-strict` |
| FR-347 Hermes automatic = accept edits, never dont_ask | `broker-agent-launch-settings.test.ts`; `broker-conversation-agents-021.test.ts` | live step 6b |
| FR-348 saved-logins tool off in every mode | `broker-agent-launch-settings.test.ts` | none beyond the launch settings |
| FR-349 owner's Hermes settings untouched | `broker-agent-launch-settings.test.ts` (writes only the Hallpass-owned layer) | live settings hashes: config.yaml, auth.json, SOUL.md identical; only Hermes runtime state changed |
| FR-350 DeepSeek fetched on first use, pinned | `broker-install.test.ts`; `broker-agents.test.ts`; `tests/contract/qa-package.contract.test.ts` | live steps 1 and 2 |
| FR-351 DeepSeek read-only / workspace-write, never full access | `broker-agent-launch-settings.test.ts`; `broker-conversation-agents-021.test.ts` | live steps 3 and 5, `real-dsh-ro`, `real-dsh-ww` |
| FR-352 DeepSeek usage reporting off | `broker-agent-launch-settings.test.ts` | none beyond the launch settings |
| FR-353 card detail from the announced action; reject-only | `broker-conversation-agents-021.test.ts`; `permission-card.test.tsx` | gate (fake DeepSeek scenario); never arose on the real DeepSeek |
| FR-354 starting state; Cancel leaves no process | `broker-conversation-agents-021.test.ts` (SC-159); `conversation-agents-021.test.tsx`; `conversation-relay.test.ts` | live step 2, gate |
| FR-355 no key handled; model-unreachable hint | `broker-conversation-agents-021.test.ts` (SC-161); `conversation-agents-021.test.tsx` | live step 6b (model server error shown as such); T690 key search still open |
| FR-356 "+" menu follows accepts | `composer.test.tsx` | none |
| FR-357 Hermes replays, DeepSeek no-replay note | `broker-conversation-agents-021.test.ts`; `conversation-agents-021.test.tsx` | none (reopening not exercised live) |
| FR-358 English and zh-TW, keyboard and names | `agent-menu.test.tsx`; `composer.test.tsx`; `conversation-a11y.test.tsx` | T691 screenshots pending |
| FR-359 Claude, Codex, 022 unchanged | existing broker and panel tests, unchanged | gate (Claude/Codex strict turn), live step 7 |
| FR-360 DeepSeek mode fixed once started | `tests/contract/agent-conversation-021.contract.test.ts`; `broker-conversation-agents-021.test.ts`; `broker-commands.test.ts`; `composer.test.tsx` | live step 5 |
| FR-361 mode chosen before the first message; next conversation back on Ask first | `broker-conversation-agents-021.test.ts`; `broker-commands.test.ts`; `composer.test.tsx` | live steps 5, 6 and 6b (new conversation header Ask first) |
