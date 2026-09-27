---
description: "Task list for 016 readable panel"
---

# Tasks: A Readable Panel — Sessions You Can Tell Apart, Words That Mean What They Say

**Input**: `specs/016-readable-panel/` — spec.md, plan.md, research.md (R-203 – R-210), data-model.md,
contracts/ (session-label, panel, tab-group), quickstart.md.

**Tests**: TDD is required by the project (constitution VII): each behaviour task starts with a RED
test in the named file.

**Rules for this run**: (1) implementers run unit + contract suites only; browser gates and
screenshots are run by the main session, one at a time; (2) a thing that fails twice is measured
differently, not tried a third time; (3) the owner's branded browser is never launched by Claude;
(4) no merge, no release — the owner approves screenshots first.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T430 Record the 016 branch/worktree and baseline numbers (unit 1507 / contract 249 / snapshot 633 at 5f8f27c) at the top of specs/016-readable-panel/coverage.md (new)

## Phase 2: Foundational — contracts (slice S1a)

- [X] T431 RED contract tests in tests/contract/agent-tools-016.contract.test.ts (new): `session-label {type, sessionId, label}` is a strict member of the link frame union (rejects extra keys, empty label, label > 64); the session view accepts optional `label` (≤ 64), `startedAt` (ISO), `colour` (one of cyan, green, purple, pink, orange, grey, blue) and `state: "idle"`; a 0.8.0-shaped session view still parses
- [X] T432 Implement those additions in packages/contracts/src/agent-tools.ts (`AGENT_SESSION_STATES` gains `idle`; new exported `AGENT_SESSION_COLOURS` in rotation order; link protocol constant unchanged at 2) until T431 is green

**Checkpoint**: contract suite green.

## Phase 3: User Story 2 — each session card says which project, what it does, and offers only what applies (P1) — slices S1b + S2a

- [X] T433 [US2] RED host tests in packages/agent-host/tests/mcp-server.test.ts (describe "016 session label"): label = last segment of the server's working directory (spawn the test server with `cwd` set to a scratch folder); no label for the home directory and a drive root; with a client advertising `roots`, the first `file://` root wins; the frame is sent after `hello-ack` and again after a re-greeting; the path and label never appear in stderr
- [X] T434 [US2] Implement label derivation and sending in packages/agent-host/src/mcp-server.ts (and the post-greeting hook in packages/agent-host/src/bridge-link.ts if needed) until T433 is green (R-203, R-204, contracts/session-label.md)
- [X] T435 [US2] RED worker tests: apps/extension/tests/agent-bridge.test.ts (a `session-label` frame reaches a new `onSessionLabel` dep; unknown session ignored) and apps/extension/tests/agent-runtime-sessions.test.ts (session record gets write-once `firstSeenAt`, `colourIndex` from the persisted counter `agentSessionColourNext`, `label`; a re-greeting keeps `firstSeenAt`; a 0.8.0 record is filled on read; the projection carries `label`, `startedAt`, `colour`; `state` is `waiting` / `working` (inFlight > 0) / `idle`)
- [X] T436 [US2] Implement in apps/extension/src/service-worker/agent-bridge.ts, apps/extension/src/service-worker/agent-tab-manager.ts and apps/extension/src/service-worker/agent-runtime.ts until T435 is green (data-model.md)
- [X] T437 [P] [US2] RED panel tests in apps/extension/tests/session-card.test.tsx: title `agent · label`, fallback `agent · started HH:mm`; subtitle start time + held tabs / holds no tabs; states working / waiting (attention border) / idle with "last action" (just now, N min, H h M min); `<details>` holds the session id and nothing else shows it; "end session" always first; "interrupt this step" only when working (said-nothing line kept when pressed after the call ended); "take back tabs (N)" only when N ≥ 1; colour stripe per colour, none without a colour; both locales (contracts/panel.md)
- [X] T438 [US2] Implement apps/extension/src/side-panel/agent/SessionCard.tsx, the minute re-render timer in apps/extension/src/side-panel/agent/AgentShell.tsx, the colour tokens (light + dark, Chrome tab-group palette) in apps/extension/src/side-panel/agent/tokens.css and styles in agent.css, and the zh-TW / en-US strings in apps/extension/src/locales/zh-TW.ts and en-US.ts until T437 is green

**Checkpoint**: unit + contract green.

## Phase 4: User Story 1 — status row (P1) — slice S2b

- [X] T439 [US1] RED tests in apps/extension/tests/agent-shell.test.tsx: no in-panel heading; the status row reads "connected · N sessions" with singular and zero forms in both locales and never an agent name; the menu lists every paired agent with its own unpair that sends one unpair for that agent only
- [X] T440 [US1] Implement in apps/extension/src/side-panel/agent/AgentShell.tsx and apps/extension/src/side-panel/agent/StatusRow.tsx (+ strings) until T439 is green; update apps/extension/tests/panel-a11y.test.tsx and apps/extension/tests/side-panel-app.test.tsx expectations that asserted the old heading/name

## Phase 5: User Story 4 — tab strip (P1) — slice S3

- [X] T441 [US4] RED tests in apps/extension/tests/agent-stop.test.ts (or the existing stop-signal test file): `AgentStopSignals.onChange` fires with the session id when its in-flight count changes (begin, end, batch step ids collapse to one call)
- [X] T442 [US4] RED tests in apps/extension/tests/group-presenter.test.ts (new): idle → working writes `⌛ Hallpass`; working → idle only after 1 s without a new call (fake timers); a new call inside 1 s keeps ⌛ without a write; waiting writes `🔔 Hallpass` and wins over working; no write when the wanted title equals the last written; a group created while waiting starts with 🔔; the session colour is applied on creation; stale query recognises `Agent`, `Hallpass`, `⌛ Hallpass`, `🔔 Hallpass` (contracts/tab-group.md)
- [X] T443 [US4] Implement `onChange` in apps/extension/src/service-worker/agent-tools/stop.ts, the presenter in apps/extension/src/service-worker/group-presenter.ts (new), title/colour constants and the stale title set in apps/extension/src/chrome-adapters/tab-groups.ts, and the wiring (stop signals, prompt raise/answer, group creation, colour from the session record) in apps/extension/src/service-worker/agent-runtime.ts and agent-tab-manager.ts until T441–T442 are green; existing tab-group tests updated for the new title
- [X] T444 [US4] (main session) Dispatch **code-reviewer** on S1 + S3 (claims: the new frame is compatible in all three host/worker combinations; the label is never logged or sent elsewhere; firstSeenAt/colour survive a worker restart; the presenter's timers never write to a released or ended group; stale cleanup never touches an owner group whose title is not one of the four); resolve every finding with a test

## Phase 6: User Story 3 — site rows (P2) — slice S2c

- [X] T445 [P] [US3] RED tests in apps/extension/tests/site-list.test.tsx (new, or the existing site-list test): no permissive badge; the select has `data-permissive="true"` only in skip-checks; checkbox label "allow reading console and network logs" with the site in its accessible name; no "granted" line; revoke visible text "revoke" and `aria-label` "revoke {site}"; both locales
- [X] T446 [US3] Implement in apps/extension/src/side-panel/agent/SiteList.tsx, agent.css and the locale files until T445 is green

## Phase 7: User Story 5 — robustness (P2) — slice S4

- [X] T447 [P] [US5] RED test in apps/extension/tests/agent-press-outcomes.test.ts (or agent-effects.test.ts): a `key` and a `type` whose keyboard dispatch never returns while `currentDialog` starts reporting a new dialog answer with the dialog (as the click path does), not page-not-responding; the focusing click of a keyboard call is raced too
- [X] T448 [US5] Implement in apps/extension/src/service-worker/agent-tools/effects.ts (`racingDialog` around `keyboard.type` / `keyboard.press` and the focusing click) until T447 is green (R-208)
- [X] T449 [P] [US5] Test in apps/extension/tests/agent-press-outcomes.test.ts beside the T402 cases: hold `mousePressed` past the deadline, resolve it late, assert `mouseReleased` was never sent; add one sentence to `dispatchInput`'s doc in apps/extension/src/service-worker/agent-tools/input.ts (R-209)
- [X] T450 [P] [US5] Measurement tests for R-210: apps/extension/tests/prompt-waiting.test.ts (pairing raised with the panel seen → presence lost at 30 s → bound 120 s from raise, ticks start) and packages/agent-host/tests/mcp-server.test.ts (ticks with a larger bound re-arm from `requestedAt`; progress text switches to the panel-not-seen sentence). If green: record "covered by D-011-7" in coverage.md; if red: fix at the seam the test names

## Phase 8: Gates and screenshots (main session)

- [X] T451 Write and run tests/e2e/packaged/agent-panel-016.spec.ts (quickstart expected results: two sessions from two scratch folders — spawn the harness MCP client with `cwd` set — titles, stripes vs group colours, ⌛ / 🔔 / plain titles, status row, menu, a keystroke opening `alert` answered with the dialog)
- [X] T452 Update tests/e2e/packaged/agent-panel-shots.spec.ts for the new panel and produce zh-TW / en-US × light / dark screenshots (two sessions, two sites); copy them to docs/media/016-*.png
- [X] T453 Run every `agent-*` gate on Chromium 151 attach; fix gate expectations that asserted 0.8.0 panel text or the "Agent" group title (tests/e2e/packaged/*.spec.ts, tests/e2e/fixtures/*) — expectations only, product changes go back to their slice

## Phase 9: User Story 6 — 0.9.0 and close-out (P3)

- [X] T454 [US6] Bump to 0.9.0 at the single sources (apps/extension/src/build-config.ts, packages/agent-host/src/tool-offering.ts) and the tests pinning 0.8.0 (as e6c8b6b did for 0.8.0)
- [X] T455 [P] [US6] Docs: README.md, README.zh-TW.md ("What 0.9.0 adds"), docs/zh-TW/operations-guide.md (panel section rewritten, new 9.6), docs/zh-TW/qa-guide.html (panel screenshots and wording), docs/design-notes.md (public summary, no reference identifiers), scripts/package/README.md (upgrade 0.8.0 → 0.9.0)
- [X] T456 [US6] `npm run package` and `npm run snapshot:check`; numbers into specs/016-readable-panel/coverage.md with the owner checks (Claude Code label, branded Chrome run, screenshot approval)
- [X] T457 Final verification (the one planned): `npm run typecheck && npm test && npm run test:contract && npm run snapshot:check`, then every `agent-*` gate on Chromium 151 attach, then the screenshot spec; spec status updated; memory updated
- [X] T458 Refresh the four owner-facing pages (試用指南, 操作手冊, 參考套件功能拆解, 技術原理) to 0.9.0 and write the owner hand-off (what to look at, what to approve, what to run)

## Dependencies & execution order

- T431–T432 first (contracts).
- **Wave 1** (parallel after T432): S1b worker+host (T433–T436) ‖ S4 robustness (T447–T450) — disjoint files (host, bridge, tab manager, runtime vs effects, input, prompt tests).
- **Wave 2** (after T436): S2 panel (T437–T440, T445–T446; files under apps/extension/src/side-panel and locales) ‖ S3 presenter (T441–T443; stop.ts, group-presenter.ts, tab-groups.ts, runtime, tab manager). S2 reads the projection only.
- T444 review after S3 (covers S1 too).
- Phase 8 after all slices; Phase 9 last.

## Parallel examples

- Wave 1: implementer A = T433–T436; implementer B = T447–T450.
- Wave 2: implementer A = T437–T440 + T445–T446; implementer-high B = T441–T443.

## Implementation strategy

MVP = US2 + US1 (the panel readable with identity and state); then the tab strip (US4); site rows and
robustness are independent increments; close-out waits for all and for the owner.
