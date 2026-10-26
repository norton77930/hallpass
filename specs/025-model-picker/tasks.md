# Tasks: Side-Panel Model Picker (025)

**Input**: specs/025-model-picker/ (spec D-025-1..12, FR-398..412, SC-178..183; plan; research R-398..R-410;
data-model; contracts/frames.md; quickstart L1-L10)
**Tests**: required - project rule: every behaviour change gets its failing test first.
**Slices** (plan): S1 = Phase 2; S2 = broker tasks of US1-US4; S3 = panel tasks of US1-US4; S4 = Phase 7;
S5 = Phase 8. Reviews: `architecture-reviewer` on S1 + S2, `code-reviewer` on S2 and on the combined diff
(R2 - host/extension contract, owner-approved 0.17.0).
**Owners** (plan): S1 `packages/contracts`, `packages/agent-host/src/broker/model-offer.ts`; S2
`packages/agent-host`, `tests/harness`; S3 `apps/extension/src/side-panel`, `apps/extension/src/service-worker`,
locales, `apps/extension/tests`; S4 `apps/extension/src/settings`, locales (after S3); S5 `tests/e2e`.
**Fixtures**: test fixtures copy the *shapes* in research R-398 with invented model names; never the
names in `.scratch/025/acp-shapes` (the owner's own provider and models).

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T797 Raw `session/new` answers of the four agents kept in `.scratch/025/acp-shapes/` (private), the probe script in `.scratch/025/probe.mjs`

## Phase 2: Foundational - contracts and the offer parser (S1; blocks S2 and S3)

- [X] T798 Failing contract tests in `packages/contracts/src/conversation.test.ts`: `ModelEntry`, `ModelOffer` (refines: defaults are listed values; no efforts for `models`; `configIds` iff `config`; bounds 64/16, value 1-512, name 1-120, description 1-300), `ModelChoice`, `ConversationModelState`; START with `model`; `ui.conversation.set-model` (at least one of model/effort) in both panel and broker unions; `model` event (`effortChanged` optional); availability `models`; view `models` / `model`; entry `model`; error codes `model-unknown`, `model-refused`; nothing else accepted (strict)
- [X] T799 Add those schemas per `contracts/frames.md` and data-model.md in `packages/contracts/src/conversation.ts`, with comments citing R-398..R-402
- [X] T800 Failing unit tests in `packages/agent-host/tests/broker-model-offer-025.test.ts` over four invented fixtures shaped as R-398 (Claude: `model` + `thought_level` with `default`, plus `mode` and `model_config` options; Codex: `model` + `thought_level` without default, plus `mode`, `collaboration_mode`, `model_config`, and a `models` field; DeepSeek: grouped `model` with JSON-tuple values; Hermes: `models` only): source chosen per R-399; only model/effort read (FR-399); groups flattened with group name as description; default first; values passed through byte-for-byte; bad entries dropped; garbage input = reports none, never throws; `resolveTarget(offer, current, wanted)` returns the parts to send, or "unavailable" (FR-407)
- [X] T801 Implement `packages/agent-host/src/broker/model-offer.ts` (pure: `readModelOffer(answer)`, `currentOf(answer)`, `resolveTarget`, `requestsFor(offer, sessionId, parts)` building `session/set_config_option` / `session/set_model` params)

## Phase 3: User Story 1 - pick a model before the first message (P1) 🎯 MVP

Independent test: with the fake agent, a new conversation started with a chosen model is on it before the first prompt; the panel's chip offers the remembered list.

### Broker (S2)

- [X] T802 [US1] Fake agent: `FAKE_ACP_MODELS` = `config` (model + effort, a default entry), `config-no-effort`, `models` (Hermes-like), `none`, `refuse` (set requests answered with an error), `effort-moves` (a model change moves the effort); every request recorded in order to `FAKE_ACP_REQUEST_LOG`; `config_option_update` on demand by prompt keyword; header documents them; self-tests in `tests/harness/fake-acp-agent.test.ts`
- [X] T803 [US1] Failing tests in `packages/agent-host/tests/broker-model-store-025.test.ts`: `<data>\agent-models.json` read/write per data-model; re-read before write keeps another broker's agents; offer replaced only by a `session/new`; choice written on start-with-choice and accepted change; unreadable file kept aside `.bad-<time>` and empty start; no absolute paths in tests
- [X] T804 [US1] Implement `packages/agent-host/src/broker/model-store.ts` (via `writeHostFileAtomically`, R-401)
- [X] T805 [US1] Failing tests in `packages/agent-host/tests/broker-model-start-025.test.ts`: start with `model` sends `session/set_config_option` (model, then effort) after `session/set_mode` and before any `session/prompt` (recorded order, SC-179); start without `model` uses the store's choice; only differing parts are sent; no `model` event at start (FR-401); the store's offer is replaced; the entry gets `model`; a refused start-time switch still starts, one `model-refused` notice, first message goes after it; an unoffered remembered model sends nothing and says `model-unavailable` once (FR-407); Hermes-like uses `session/set_model`; `none` sends nothing; no request other than `session/*` (FR-402)
- [X] T806 [US1] Implement in `packages/agent-host/src/broker/conversation.ts` (`Conversation.start` after the mode confirmation; `StartRequest.model`; live `modelState`) and the pool's `start` / `startNew` / index write; `commands.ts` passes START's `model`
- [X] T807 [US1] Failing then green: overview availability carries `models: { offer, choice? }` from the store (no `current`), views carry live `models` while running, `model` from the entry otherwise, in `packages/agent-host/tests/broker-model-start-025.test.ts`

### Panel (S3)

- [X] T808 [P] [US1] Failing tests in `apps/extension/tests/side-panel-model-chip-025.test.tsx`: chip after the mode chip with the model name, effort appended only when not the default; no remembered offer → "Default" and the popup line "list appears once the conversation starts" (FR-400); offer with no models → no chip; popup: models radiogroup (default first, current checked, long name ellipsised with full name in title and accessible name), divider, effort radiogroup only when offered; choosing keeps the popup open (FR-398); Escape returns focus to the chip; the choice goes in `ui.conversation.start.payload.model`; the last choice is preselected
- [X] T809 [US1] Implement `apps/extension/src/side-panel/agent/conversation/ModelMenu.tsx` and the chip in `ConversationTab.tsx` (prototype A, `.scratch/025-prototypes/index.html`); styles beside the mode chip's
- [X] T810 [P] [US1] Locale keys (en-US and zh-TW) for the chip, popup, divider label, "Default", the no-list line, the busy description, the change line, both notices in `apps/extension/src/locales/{en-US,zh-TW}.ts`; locale parity test passes

## Phase 4: User Story 2 - change the model during a conversation (P1)

Independent test: an accepted change adds exactly one line; a refused one keeps the model, shows the agent's text, sends one request.

### Broker (S2)

- [X] T811 [US2] Failing tests in `packages/agent-host/tests/broker-model-change-025.test.ts`: `set-model` while idle sends one request and enqueues one `model` event (names), updates entry and store choice; `effort-moves` sets `effortChanged` and names the effort now reported (FR-404, D-025-12); refused → `model-refused` result with scrubbed agent text + one notice, model kept, exactly one request (FR-405); value not in the offer → `model-unknown`, nothing sent; during a turn, a card, a mode reload or another switch → `busy` (FR-403); `canSend` refuses `busy` while a switch is in flight; a `config_option_update` the owner did not ask for updates the view, adds no line (FR-409); DeepSeek's fixed mode does not block a model change
- [X] T812 [US2] Implement `Conversation.setModel` + `config_option_update` handling in `conversation.ts`, the pool's `setModel`, and `ui.conversation.set-model` in `commands.ts`

### Panel (S3)

- [X] T813 [P] [US2] Failing tests in `apps/extension/tests/side-panel-model-chip-025.test.tsx`: running conversation's chip shows `models.current`; a choice sends `ui.conversation.set-model`; while a turn runs or a card waits the chip is `aria-disabled`, focusable, described as changeable after the turn (FR-403); the `model` event renders one line (with the effort when `effortChanged`); `model-refused` / `model-unavailable` notices render in the owner's language
- [X] T814 [US2] Implement in `ConversationTab.tsx`, `ModelMenu.tsx`, `conversation-log.ts` (line and notices)
- [X] T815 [P] [US2] Worker: test that `ui.conversation.set-model` and START with `model` are forwarded unchanged, in the existing relay test file under `apps/extension/tests/`; change `conversation-relay.ts` only if the test fails

## Phase 5: User Story 3 - a continued conversation keeps its model (P2)

Independent test: after an idle stop, a crash or opening from the list, the fake agent is put back on the conversation's model before the next prompt.

- [X] T816 [US3] Failing tests in `packages/agent-host/tests/broker-model-resume-025.test.ts`: resume after idle stop / crash / `open` re-applies the entry's `model` before the next `session/prompt` (recorded order); Claude-like mode reload (`session/load` on the same run) re-applies when the agent reports otherwise; Hermes-like restart re-applies; nothing sent when already on it; no line; a no-longer-offered model → default + one `model-unavailable`; an unknown-session resume path unchanged; the store's offer is not replaced by a load/resume (R-401)
- [X] T817 [US3] Implement in `conversation.ts` (`resume` passes the entry's model as target; `reload` and `restart` re-apply) and the pool's `resume`
- [X] T818 [P] [US3] Failing then green: a stopped conversation's chip shows the entry's `model` (name from the agent's remembered offer, value otherwise), not openable until it runs, in `apps/extension/tests/side-panel-model-chip-025.test.tsx`

## Phase 6: User Story 4 - the remembered list follows the agent (P3)

- [X] T819 [US4] Failing then green in `packages/agent-host/tests/broker-model-store-025.test.ts`: a later `session/new` with a different list replaces the offer; `none` records an empty offer (chip hidden); two brokers' writes keep both agents
- [X] T820 [P] [US4] Failing then green in `apps/extension/tests/side-panel-model-chip-025.test.tsx`: switching the agent chip switches the model chip to that agent's offer and choice; an agent with an empty offer has no model chip

## Phase 7: #18 / #19 settings page (S4, after S3)

- [X] T821 [P] #18: failing test then DeepSeek's `DOWNLOAD_SIZE` (~730 MB) in `apps/extension/src/settings/agent-model.ts`, shown on its card
- [X] T822 #19: failing tests then: ETA row while downloading (from `install.etaSeconds`); toast close button with visible focus ring and ≥ 24 px hit area; "Accepts" says "Not known yet" (en) / zh-TW equivalent instead of "–"; selects labelled "Theme" / "Language"; zh-TW running text on the settings page uses 代理程式 for "Agent" (R-409) - in `apps/extension/src/settings/*`, locales, settings tests

## Phase 8: Polish, gate and release preparation (S5 + main)

- [X] T823 Packaged gate: model scenarios L1-L9 in `tests/e2e/packaged/agent-conversation.spec.ts` (fake agent, `FAKE_ACP_MODELS`), screenshots L10 (en/zh-TW × light/dark × 320/380 px) to `.scratch/025/shots`
- [X] T824 #20: measure the `settings-024` L2 timing (three full runs, readiness log), record in `.scratch/025/gate-020.md`, fix the wait in `tests/e2e/packaged/settings-024.spec.ts` from that measurement; three full green runs
- [X] T825 Free real-agent probe (quickstart): four agents, offer parsed, set accepted, agent config hashes unchanged (SC-181); report in `.scratch/025/probe-real.md`
- [X] T826 Version 0.17.0 (host + extension + package script) per the release checklist used for 0.16.x; README tool/feature list mentions the model chip; CONTRIBUTING fake-agent knobs list `FAKE_ACP_MODELS`
- [X] T827 Coverage file `specs/025-model-picker/coverage.md` (FR/SC → test or gate); spec change log entry
- [X] T828 Final verification: typecheck, `npm test`, build, `test:contract`, `snapshot:check`, gate runs above

## Dependencies

- Phase 2 (T798-T801) blocks everything else.
- Broker US1 (T802-T807) before broker US2 (T811-T812) before US3 (T816-T817) - same files.
- Panel tasks (T808-T810, T813-T815, T818, T820) need only Phase 2; they run beside the broker tasks.
- Phase 7 after the panel tasks (shared locale files).
- Phase 8 after all.

## Parallel opportunities

- S2 (broker) and S3 (panel) after S1: two writers, disjoint files.
- S4 (#18/#19) once S3 is done, beside the end of S2.

## Implementation strategy

MVP = Phase 2 + US1 (a chosen model before the first message). Then US2, US3, US4 in order on the broker
side while the panel builds the chip against the schemas; then #18/#19, the gate, #20, the probe, 0.17.0.
