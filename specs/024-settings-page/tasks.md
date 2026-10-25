# Tasks: Settings Page (024)

**Input**: specs/024-settings-page/ (spec D-024-1..21, plan, research R-372..R-387, data-model,
contracts/frames.md, quickstart L1–L14)
**Tests**: required — project rule: every behaviour change gets its failing test first.
**Slices** (plan): S0 = Phase 1; S1 = host tasks (Phase 2 host part + host tasks of US1–US3, US7);
S2 = Phase 2 extension part + worker tasks of US4–US6; S3 = settings-page UI tasks; S4 = side-panel tasks
(US4 picker, US8); S5 = final phase. Reviews: `code-reviewer` after S1 and after S2,
`architecture-reviewer` on S1+S2, `code-reviewer` on the combined diff (R2 path decided 2026-10-24).
**Owners** (plan): S1 `packages/contracts/src/conversation.ts`, `packages/agent-host`, `tests/harness`,
release script; S2 `packages/contracts/src/{settings,agent-tools}.ts`, `apps/extension/src/service-worker`,
build files; S3 `apps/extension/src/settings`; S4 `apps/extension/src/side-panel`; locale files written by
main at the end of S2 (T752) and not touched by S3/S4.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup (S0)

- [X] T737 Create `.scratch/024/`; in a throwaway folder under it run a clean `npm ci` of the pinned Codex adapter tree and the DeepSeek tree, sampling the tree's byte size every 1 s; record size-over-time and final size in `.scratch/024/install-growth.md` and state whether growth is steady enough for a percent (R-376); no model call
- [X] T738 Record the decision from T737 per agent (percent shown / phase only) as an addendum to R-376 in `specs/024-settings-page/research.md`

## Phase 2: Foundational (blocks every story)

### Host contracts (S1, first step; blocks S2)

- [X] T739 Failing contract tests for `ui.conversation.check-agents {agent?}`, `install-cancel {agent}`, `test {agent}`, diagnostics `{agent}` form and reply with `agent`/`readAt`, and the optional overview fields `checkedAt`, `version` (≤ 64), `setupSteps`, `browserTools`, `install` (InstallState without pid, incl. `interrupted`), `lastTest`, `testing` in `packages/contracts/src/conversation.test.ts`
- [X] T740 Add those schemas (strictObject, additive) per `contracts/frames.md` in `packages/contracts/src/conversation.ts`; commit so S2 can start
- [X] T741 [P] Fake-agent knobs: `FAKE_ACP_VERSION_HANG` (hung `--version`), `FAKE_ACP_COUNT_PROMPTS` (file counting model calls), and a slow fake install command for broker tests, with self-tests in `tests/harness/fake-acp-agent.ts` and `tests/harness/fake-acp-agent.test.ts`

### Shared host state (S1)

- [X] T742 Failing tests: atomic write/read of `install-state.json` and `last-test.json`; `install.lock` exclusive create, stale when pid dead, released at end; a second reader sees changes within 1 s while watching, in `packages/agent-host/tests/broker-shared-agent-state-024.test.ts`
- [X] T743 Implement `packages/agent-host/src/broker/shared-agent-state.ts` (paths under `agents\<agent>\` via host-paths, R-375; no absolute paths in tests)

### Extension contracts and channel (S2; R2 — authorization)

- [X] T744 Failing contract tests for `settingsCommandSchema` (closed union per frames.md; session/prompt commands refused), `worker.settings.state` / `result` / `toast`, `AgentChoices`, `AgentAppearance`, panel projection `conversation.choices` and session `site` in `packages/contracts/src/settings.test.ts` and `agent-tools.test.ts`
- [X] T745 Add `packages/contracts/src/settings.ts` and the projection additions in `packages/contracts/src/agent-tools.ts`; export from the contracts index
- [X] T746 Failing worker tests for the trust check: accepted only with `sender.id === runtime.id`, `frameId 0`, a tab, URL (hash dropped) equal to `settings.html`; refused for the side panel URL, another extension page, a content script, an iframe; settings ports never make `isVisible()` true, never change the badge or pairing bounds, in `apps/extension/tests/settings-port.test.ts`
- [X] T747 Implement `apps/extension/src/service-worker/settings-port.ts` (port `hallpass-settings`, R-373) and accept it in `bootstrap.ts`; leave `isTrustedControlSender` and `agent-panel-port.ts` visibility unchanged except excluding settings ports
- [X] T748 Failing worker tests: settings projection contents (data-model.md) with no prompts, consent cards or session details; every settings command dispatched to the same handler the panel uses today; a refused command logged and answered `ok: false`, in `apps/extension/tests/settings-port.test.ts`
- [X] T749 Implement projection + dispatch in `settings-port.ts`, reusing the existing handlers in `agent-runtime.ts` / `agent-panel-port.ts` (no second copy of permission logic)
- [X] T750 Failing build/contract tests: dist has `settings.html` and `settings.js`; manifest `options_ui {page: "settings.html", open_in_tab: true}`; permission list unchanged, in `tests/contract/manifest.contract.test.ts`
- [X] T751 Add the entry in `apps/extension/vite.config.ts`, `placeEmittedDocument` in `apps/extension/scripts/write-manifest.ts`, `options_ui` in `apps/extension/src/build-config.ts`; minimal `apps/extension/src/settings/index.html` + `main.tsx` mounting an empty page under `agent-shell settings-page`
- [X] T752 Main: add every new text of US1–US8 (both languages) to `apps/extension/src/locales/en-US.ts`, `zh-TW.ts`, `apps/extension/src/side-panel/agent-panel-keys.ts` and a new `apps/extension/src/settings/settings-keys.ts`; extend the scan in `tests/contract/locales.contract.test.ts` to `src/settings/**/*.tsx` (R-384); `npm run test:contract` green on locales
- [X] T753 Open-settings helper: failing test then implement `openSettings(route)` (focus an open settings tab and set its hash, else create one; routes per R-372) in `apps/extension/src/service-worker/open-settings.ts`, `apps/extension/tests/open-settings.test.ts`, plus panel command `ui.agent.open-settings {route}`

**Checkpoint**: S2 contracts and channel reviewed (`code-reviewer` after S2's channel tasks, R2).

## Phase 3: User Story 1 — agents' readiness at a glance (P1) 🎯 MVP

**Independent test**: four fake agents in four states → rows readable collapsed, attention cards open, summary "1 of 4 agents ready", zero model calls, states within 5 s with one hung `--version`.

- [X] T754 [US1] Failing broker tests: `check-agents` runs per agent in parallel with a 5 s bound per external command (hung `--version` → that agent Not installed "did not answer", others unaffected, total ≤ 6 s); result cached until Check again / install done / new settings connect; `.cmd` found, refused path → Not installed with reason; zero prompts counted, in `packages/agent-host/tests/broker-check-agents-024.test.ts`
- [X] T755 [US1] Implement bound + cache + `version`/`checkedAt`/`setupSteps`/`browserTools` in `packages/agent-host/src/broker/agents.ts` and the command in `packages/agent-host/src/broker/commands.ts` (R-374, D-024-19); keep the 15 s exec bound for launches
- [X] T756 [P] [US1] Failing UI tests: state mapping (R-374) to Ready / Ready with warnings / Needs a download / Downloading / Not installed; collapsed row (name, state, default mark, Enabled switch, progress bar, warning count); attention cards start open; name toggles the card; switched-off card dimmed keeping state; navigation counts and warning mark, in `apps/extension/tests/settings-agents.test.tsx`
- [X] T757 [US1] Implement `apps/extension/src/settings/SettingsPage.tsx` (top bar, left navigation, routes, summary), `settings/agents/AgentsSection.tsx`, `settings/agents/AgentCard.tsx` (version, checks, notes, warnings, actions, Hermes "installed by you"), `settings/settings.css`; send `check-agents` on connect and on Check again

## Phase 4: User Story 2 — prepare an agent before using it (P1)

**Independent test**: start a slow fake install, see percent/time left, cancel, restart and finish → Ready, told once; close and reopen the page mid-install; kill the browser → interrupted.

- [X] T758 [US2] Failing broker tests: progress estimate = installed package folders ÷ expected count from the shipped lockfile (R-376 addendum: ≤ 95 % before verified, Preparing with no percent before the first folder, ETA from 10 % on from the last 30 s); state file written each second; second broker following an install held by another lock does not run `npm ci`; install longer than the conversation idle time finishes with the broker alive, in `packages/agent-host/tests/broker-install-024.test.ts`
- [X] T759 [US2] Implement in `packages/agent-host/src/broker/install.ts` + `shared-agent-state.ts` (R-375, R-376) (no release-time size, R-376 addendum)
- [X] T760 [US2] Failing broker tests: `install-cancel` ends the process tree (fake child keeps no handle), removes `.install-*` and the lock within 5 s, state back to Needs a download; cancel with nothing running is `ok` and harmless, in `packages/agent-host/tests/broker-install-024.test.ts`
- [X] T761 [US2] Implement `AbortSignal` + `taskkill /T /F` in `packages/agent-host/src/broker/run-command.ts` and the command in `commands.ts` (R-377)
- [X] T762 [US2] Failing broker test: a state file left running by a dead pid becomes `interrupted` at broker start and stays until the next attempt; `cleanStaging` still runs, in `packages/agent-host/tests/broker-install-024.test.ts`
- [X] T763 [US2] Implement the start-up rewrite in `packages/agent-host/src/broker.ts` / `install.ts` (R-378)
- [X] T764 [P] [US2] Failing UI tests: Download / Cancel / Try again; progress, percent, time left marked as estimate, "closing this page does not stop it; closing the browser does"; collapsed progress bar; interrupted line; done/failed toast once across two open pages; Hermes setup steps found / not done with Check again and no download button; consent not granted → card offers the side-panel-agent switch first (FR-299 kept), in `apps/extension/tests/settings-install.test.tsx`
- [X] T765 [US2] Implement in `apps/extension/src/settings/agents/AgentCard.tsx` and `settings/agents/InstallProgress.tsx`; worker sends `worker.settings.toast` once per event (`settings-port.ts`)

## Phase 5: User Story 3 — check that an agent really works (P1)

**Independent test**: Test a working fake (passed with ms), an unreachable-model fake (failed naming the model server), Hermes fake without its MCP component (partial); Test during a conversation leaves it unchanged.

- [X] T766 [US3] Failing broker tests: TestRun spawns outside the pool (running cap unchanged, not in the index, no browser token), one prompt, 90 s bound, folder `agent-tests\<id>\` removed and process gone when the result is written; outcomes passed / partial / failed with start code, model ms or reason, browser tools, Hermes key-name hint (names only); one test per agent; a conversation of the same agent keeps its turn and history, in `packages/agent-host/tests/broker-agent-test-024.test.ts`
- [X] T767 [US3] Implement `packages/agent-host/src/broker/agent-test.ts` and the `test` command in `commands.ts`; write `last-test.json` (R-379)
- [X] T768 [P] [US3] Failing UI tests: Test button says it makes one model call; testing state; result line with outcome and time; failure text in owner words with what to do; result kept when the card is left and reopened; Test unavailable when not ready or not enabled, in `apps/extension/tests/settings-test.test.tsx`
- [X] T769 [US3] Implement in `apps/extension/src/settings/agents/AgentTest.tsx`

## Phase 6: User Story 4 — enabled agents and the default (P1)

**Independent test**: disable DeepSeek, make Hermes default → picker lists enabled agents with Hermes preselected; switching Hermes off moves the default by order and says so; a second browser's choices unchanged.

- [X] T770 [US4] Failing worker tests: `agentChoices` first run (all enabled; default from `conversationLastAgent` if ready, else order Claude, Codex, Hermes, DeepSeek; old key removed); set default only for enabled + ready; switching off the default moves it per D-024-15 with `defaultMovedTo` or `null`; projection to panel and page, in `apps/extension/tests/agent-choices.test.ts`
- [X] T771 [US4] Implement `apps/extension/src/service-worker/agent-choices.ts` and the `ui.settings.choices-set` handler (R-380)
- [X] T772 [P] [US4] Failing UI tests (settings): Enabled switch, Make default / Default mark, greyed Make default with reason, "Default agent is now Hermes" / "no default" notices, in `apps/extension/tests/settings-agents.test.tsx`
- [X] T773 [US4] Implement in `apps/extension/src/settings/agents/AgentCard.tsx`
- [X] T774 [P] [US4] Failing UI tests (panel): picker lists enabled agents only, preselects the default in a new conversation, follows a change without reload, open conversations keep their agent; enabled-but-not-ready shows one reason line and a link to `#agents/<agent>`; no download or install prompt inside a conversation (FirstUseCard download path → settings link), in `apps/extension/tests/conversation-agents-024.test.tsx`
- [X] T775 [US4] Implement in `apps/extension/src/side-panel/agent/conversation/AgentMenu.tsx`, `ConversationTab.tsx`, `FirstUseCard.tsx`; remove `last-agent.ts` use

## Phase 7: User Story 5 — manage what agents may do (P2)

**Independent test**: change a mode, revoke + undo, unpair, remove an upload folder on the page → the side panel's consent behaviour follows each.

- [X] T776 [P] [US5] Failing UI tests: Sites & permissions order — outside agents (where/when, Unpair), sites (mode + meaning, change at once with notice, revoke with confirmation then Undo for a few seconds, empty-state line), upload folders (Remove, "added when an agent asks" line, no Add); `#sites?site=<origin>` marks the row or says it is no longer listed, in `apps/extension/tests/settings-sites.test.tsx`
- [X] T777 [US5] Move/adapt `SiteList.tsx` and StatusRow's unpair list into `apps/extension/src/settings/sites/SitesSection.tsx`, `OutsideAgents.tsx`, `UploadFolders.tsx` (D-024-21) using settings commands
- [X] T778 [US5] Failing worker test: a site-mode change, revoke and unpair sent from the settings port have the same effect on consent prompts as from the panel before (004/006/016), in `apps/extension/tests/settings-port.test.ts`

## Phase 8: User Story 6 — browser tools (P2)

**Independent test**: four agents with status and reason; the side-panel-agent switch is the only control and behaves as 019 FR-309.

- [X] T779 [P] [US6] Failing UI tests: per-agent status (Claude available, Codex available / after the helper download, Hermes needs its browser component, DeepSeek not supported), switch above the list, read-only note; switch off → `ui.conversation.consent {granted:false}`, in `apps/extension/tests/settings-tools.test.tsx`
- [X] T780 [US6] Implement `apps/extension/src/settings/tools/BrowserToolsSection.tsx`, moving `PanelConsentSwitch.tsx` there

## Phase 9: User Story 8 — the side panel shows what is happening now (P2)

**Independent test**: one outside session on a site → Sessions shows connection + card with Stop and the permissions link, no standing-permission controls; no session → empty line + settings link.

- [X] T781 [US8] Failing UI tests: tabs Conversation / Sessions; stored `"connections"` reads as `"sessions"`; Sessions holds connection state, NotConnected with Retry, session cards unchanged; no site list, upload folders, unpair, browser name or consent switch; card with a site shows "Manage this site's permissions ↗" sending `open-settings #sites?site=`; empty state line + link; waiting count unchanged; prompt cards above both tabs, in `apps/extension/tests/side-panel-tabs.test.tsx` and `apps/extension/tests/sessions-tab-024.test.tsx`; update `connections-*.test.tsx` expectations that pin the old tab
- [X] T782 [US8] Implement in `apps/extension/src/side-panel/agent/AgentShell.tsx`, `StatusRow.tsx` (connection line only), `SessionCard.tsx`; menu entry "Settings" opening `#agents` (R-381)

## Phase 10: User Story 7 — connection and last output (P3)

**Independent test**: connection block, rename this browser, copy details without user paths, show / copy an agent's last lines with read time, nothing read before asked.

- [X] T783 [US7] Failing broker tests: diagnostics `{agent}` returns the latest run (conversation or test) with `readAt`; user profile path replaced in lines; no key values (scrub as today); unknown agent → empty lines, in `packages/agent-host/tests/broker-diagnostics-024.test.ts`
- [X] T784 [US7] Implement the lookup in `packages/agent-host/src/broker/conversation.ts` / `commands.ts` (R-387)
- [X] T785 [P] [US7] Failing UI tests: helper connected / not / outdated, extension and helper versions and match, bridge browsers with this one marked, Rename (018 effect), Copy details without user paths; per agent Show last lines (request only on press), read time, Copy, "printed nothing"; helper missing → page still opens, says what is missing, extension-side sections usable, upload folders say they need the helper, in `apps/extension/tests/settings-connection.test.tsx`
- [X] T786 [US7] Implement `apps/extension/src/settings/connection/ConnectionSection.tsx`, moving `BrowserRow.tsx` rename there

## Phase 11: Polish & cross-cutting (S3 end + S5)

- [X] T787 [P] Appearance (D-024-20): failing tests that the top bar's theme / language choice writes `agentAppearance` and both the page and the side panel follow at once, default System = today's behaviour, in `apps/extension/tests/appearance-024.test.tsx`; implement `apps/extension/src/appearance.ts` + `ui.settings.appearance-set`, and data-theme / locale selection in `side-panel/App.tsx` and `settings/main.tsx`
- [X] T788 [P] Accessibility and width: failing tests for keyboard reach of every control, visible focus, landmark/heading structure, live-region notices, 375 px navigation as a top row without sideways scroll, in `apps/extension/tests/settings-a11y.test.tsx`; fix in `settings.css` / components
- [X] T789 Run `npm run typecheck`, `npm test`, `npm run build:extension`, `npm run test:contract`, `npm run snapshot:check`; record numbers in `.scratch/024/checks.md`
- [X] T790 E2E fixtures: default tab `#agent-tab-sessions` in `tests/e2e/fixtures/side-panel-driver.ts`; new `tests/e2e/fixtures/settings-page-driver.ts`; `unpairAgent` in `fixtures/agent-pairing.ts` through the settings page; switch affected specs (agent-panel-016, -shots, -states, -multi, agent-conversation, agent-demo-shots, agent-site-plan, agent-transitions, agent-upload-directory, agent-claim, agent-first-run, agent-pairing, agent-pairing-withdraw) to the new fixtures (R-385)
- [X] T791 New gate spec `tests/e2e/packaged/agent-settings-024.spec.ts` covering L1–L14 (quickstart.md) with fake agents and the slow-install knob; screenshots to `.scratch/024/shots/` with a rerunnable capture script
- [X] T792 Run the packaged gate (all `agent-*` specs) on the unattended attach setup via `test-analyst`; record pass/fail per spec in `.scratch/024/gate.md`
- [X] T793 `acceptance-verifier`: judge L2, L3, L5, L11, L12, L13 screenshots against prototype A (judged diff list, not pixel-exact) with gates in `.claude/acceptance/024-settings-page.json`
- [X] T794 Owner machine (with the owner's agreement, three short model calls): Test on the real Claude, Codex and Hermes once each; record outcomes in `.scratch/024/real-agents.md`
- [X] T795 `code-reviewer` on the combined diff; fix findings; amend 019 change log if any panel behaviour beyond FR-282/FR-309 placement changed
- [X] T796 Release 0.16.0 per the release recipe (bump, `npm run package`, host reinstall) — `human` gate: merge, public snapshot and tag only with the owner's approval

## Dependencies

- T737–T738 → T758–T759 (progress design).
- T739–T740 (host contracts) → S2 (T744+) and all broker story tasks; T741 → broker tests using knobs.
- T742–T743 → T758, T766.
- T744–T753 (extension channel, build, locales) → every S3 and S4 task.
- US1 broker (T754–T755) → US2/US3 UI (cards show readiness) — UI tasks may start against fake projections.
- US4 worker (T770–T771) → T772–T775.
- US8 (T781–T782) independent of US5–US7 UI except the settings route helper (T753).
- All stories → T789 → T790–T793 → T795 → T796.

## Parallel opportunities

- S1 broker work (T741–T743, T754–T767, T783–T784) runs while S2 builds the channel once T740 is committed.
- After T752: S3 (`apps/extension/src/settings`: T756–T757, T764–T765, T768–T769, T772–T773, T776–T777, T779–T780, T785–T788) and S4 (`apps/extension/src/side-panel`: T774–T775, T781–T782) in parallel — disjoint folders, locale files frozen.
- Failing-test tasks marked [P] in different files can be written together.

## Implementation strategy

1. MVP = Phase 1–3 (US1): the page opens, shows real readiness with zero model calls.
2. Then US2 + US3 (preparing and testing move out of conversations), US4 (choices + picker).
3. Then US8 + US5 + US6 (moving the standing permissions; the panel loses them only when the page has them, spec Assumptions).
4. Then US7, polish, gate, review, release.
