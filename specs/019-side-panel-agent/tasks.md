---
description: "Task list for 019 side-panel agent"
---

# Tasks: A Conversation in the Side Panel with the Owner's Own Coding Agent

**Input**: `specs/019-side-panel-agent/` — spec.md (FR-282 – FR-311, SC-134 – SC-140, D-019-1..11,
approved 2026-10-18), plan.md (slices S0 – S9, approved 2026-10-19 after architecture review),
research.md (R-312 – R-329), data-model.md, contracts/conversation-frames.md, quickstart.md.

**Tests**: TDD required (CLAUDE.md "test first"): every behaviour task is preceded by a RED test task.

**Rules for this run**: (1) implementers run unit + contract suites only, never `tsc -b` while another
writer is active; browser gates are run by the main session; (2) a thing that fails twice is measured,
not tried a third time; (3) R2: security-focused code review after S2 and after S6, final code review
before 0.13.0; no merge, release or paid probe without the owner; (4) real agents (Claude Code, Codex)
are used only in the S4 measurements and the S19 probe — everything else runs against the fake ACP
agent (R-329); (5) at most two writers at once.

## Format: `[ID] [P?] [Story] Description`

Story labels map to spec.md: US1 ask about the page, US2 owner controls files/commands, US3 first use,
US4 close and come back, US5 project folder, US6 conversation list, US7 external agents undisturbed.

---

## Phase 1: Setup (S0)

- [X] T516 Create specs/019-side-panel-agent/coverage.md with the baseline numbers of main 36c9c39
  (unit + extension-ui count, contract count, snapshot file count) and an FR/SC → task table filled as
  tasks close
- [X] T517 Add the two owner-approved runtime dependencies to packages/agent-host/package.json:
  `@agentclientprotocol/sdk` (exact version, current release) and `koffi` (exact version 3.3.3 or the
  current 3.x); `npm install`; confirm `npm run typecheck` and `npm test` stay green
- [X] T518 [P] Add the pinned adapter manifests packages/agent-host/agents/claude-code/package.json +
  package-lock.json (`@agentclientprotocol/claude-agent-acp` 0.81.2) and
  packages/agent-host/agents/codex/package.json + package-lock.json (`@agentclientprotocol/codex-acp`
  1.13.1), generated with `npm install --package-lock-only` in a scratch folder; lockfiles carry
  `integrity` for every package (R-314)

## Phase 2: Foundational — contracts and fake agent (S1)

- [X] T519 RED contract tests tests/contract/agent-conversation-019.contract.test.ts (new): `hello`
  accepts optional `role: "broker"` + `brokerSecret` and `panelToken`, a 0.12.5 hello still parses;
  frames `relay-gone`, `conversation-command/result/event/overview/page/browser-token` refuse unknown
  fields; `ui.conversation.set-mode` accepts only `strict` | `agent-review`; `permission-closed.answer`
  enum per contract; `ConversationError` codes per contract incl. `in-use-elsewhere`; site record accepts
  optional `changedBy` (`panel-agent` | `external-agent` | `owner`) + `changedAt`; `AGENT_LINK_PROTOCOL`
  still 2; `AGENT_TOOL_NAMES` unchanged
- [X] T520 Implement the schemas in packages/contracts/src/conversation.ts (new, re-exported from
  packages/contracts/src/agent-tools.ts) and the optional fields on `hello` and `siteModeRecordSchema`
  until T519 is green; update agentPanelStateSchema / agentPanelCommandSchema / agentPanelMessageSchema
- [X] T521 [P] Fake ACP agent tests/harness/fake-acp-agent.ts (stdio, built to dist for gate use) with
  scripted behaviours selected by env: answer text in chunks, tool calls with updates, request_permission
  for edit/execute, self mode change (inside and outside the allow-list), crash mid-turn, refuse
  `session/load` for an unknown id, `/rename` handled locally; unit test
  tests/harness/fake-acp-agent.test.ts drives it with `@agentclientprotocol/sdk` client

## Phase 3: Broker lifetime and admission (S2) — US4 foundation

- [X] T522 RED relay-process tests packages/agent-host/tests/broker-lifetime.test.ts (new), fake native
  port + fake ACP agent started through `cmd.exe` with a detached grandchild: (a) after ack the relay
  spawns the broker and writes `brokers/<browserId>.json` with pid, browserRunId, secretSha256; (b)
  hard-kill the broker → 0 pids of its tree within 2 s; (c) close relay stdin, start a new relay with the
  same browserRunId → broker adopted, agent pids unchanged; (d) close stdin with no new relay → 0 pids
  after 15 s; (e) a new relay with another browserRunId → old broker shuts down
- [X] T523 [P] RED unit tests packages/agent-host/tests/relay-mux-broker.test.ts: a greeting with
  `role: "broker"` and no / wrong secret is refused (log code `broker-role-refused`); the right secret is
  stripped before forwarding (like `token`); `role` on any later frame is refused; routing of all other
  frames unchanged
- [X] T524 Implement packages/agent-host/src/broker/job.ts: create a job with
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE via koffi, assign the current process, keep the handle; on any
  failure the broker exits with a logged reason instead of running unprotected
- [X] T525 Implement packages/agent-host/src/broker-launch.ts (spawn with stdin secret, sidecar write,
  adopt by sidecar pid + browserRunId, `relay-gone` on leave) and wire it into
  packages/agent-host/src/native-host.ts after ack; extend the greeting check in
  packages/agent-host/src/relay-mux.ts (admission only) until T523 is green
- [X] T526 Implement packages/agent-host/src/broker.ts entry: job first (T524), read secret from stdin,
  dial the relay with `hello { role, brokerSecret }` via bridge-link `dialRelay`, handle `relay-gone`
  with a 15 s redial window, graceful shutdown (cancel turns, close agents ≤ 3 s), remove sidecar,
  `broker.log` with redaction (R-326, packages/agent-host/src/broker/redact.ts + its unit test first)
  until T522 is green
- [X] T527 Worker side: RED then implement in apps/extension/src/service-worker/agent-runtime.ts and a
  new conversation-relay.ts: one broker session per relay run, never a session card or tab group,
  `conversation-*` frames accepted only from that sessionId (unit test
  apps/extension/tests/conversation-relay.test.ts first)
- [X] T528 Measurement: run T522 on the real machine 10 times plus one manual Chrome close and one
  `taskkill /F` of chrome.exe with the built host; record pids before/after in coverage.md (SC-136
  first evidence)
- [X] T529 **Security-focused code review of S2** (code-reviewer): lifetime, adoption, secret handling,
  greeting admission, job failure path; fix findings before S3/S4 build on it

## Phase 4: User Story 3 — first use: install the connector (S3, P1)

**Goal**: picking an agent the first time asks, downloads the pinned connector and starts.
**Independent test**: empty `agents\` folder → card with size; cancel downloads nothing; accept installs
once; second conversation starts without the card.

- [X] T530 [P] [US3] RED unit tests packages/agent-host/tests/broker-agents.test.ts: discovery finds
  claude.exe / codex.cmd via `where.exe` then known per-user paths, reports missing; `--version` parsed;
  availability = missing | needs-install | ready | version-problem
- [X] T531 [US3] Implement packages/agent-host/src/broker/agents.ts until T530 is green
- [X] T532 [P] [US3] RED unit tests packages/agent-host/tests/broker-install.test.ts: install runs
  `npm ci --omit=optional --ignore-scripts --no-audit --no-fund` in `.staging-<random>` then renames to
  `agents\<agent>\<version>`; a failure or a tampered lockfile (integrity mismatch) leaves no folder;
  leftover `.staging-*` removed at broker start; npm stderr redacted
- [X] T533 [US3] Implement packages/agent-host/src/broker/install.ts until T532 is green; progress events
  to the conversation overview
- [X] T534 [US3] Map adapter start failures to `agent-version` (tested vs found version + redacted agent
  message) vs `agent-missing` per R-315, with a unit test against the fake agent failing at initialize
  and at session/new

## Phase 5: User Story 2 + User Story 1 core — the conversation (S4, P1)

**Goal**: a conversation that starts strict, streams the answer, lists actions, asks before changes.
**Independent test**: against the fake agent — strict before the first prompt, cards with three
answers, rules per conversation, any self mode change reset, pages ≤ 256 KB.

- [X] T535 [US2] RED unit tests packages/agent-host/tests/broker-conversation-modes.test.ts: strict set
  and confirmed before the first prompt on new, load and idle-resume; allow-list per agent (Claude
  default/auto, Codex read-only/agent); an agent-initiated mode change — inside or outside the list —
  cancels the pending action, restores the owner-chosen mode and emits a `mode` event with a note
- [X] T536 [US2] RED unit tests packages/agent-host/tests/broker-conversation-permissions.test.ts:
  request_permission → `permission` event, agent waits; allow-once / reject map to the adapter's once
  options; allow-conversation sends allow-once and records a rule (kind; `other` keyed by tool name);
  later same-kind requests answered by rule with `byRule`; "always" options never sent; no answer → the
  agent keeps waiting indefinitely (FR-294); agent exit while waiting → `permission-closed agent-exited`
- [X] T537 [US1] RED unit tests packages/agent-host/tests/broker-conversation-stream.test.ts: text
  chunks coalesced ≤ 1 per 50 ms; tool events with status transitions; stop → `session/cancel` and no
  further tool event of that turn; event log capped at 256 KB with oldest text coalesced; pages ≤ 256 KB
  with `more`; seq strictly increasing
- [X] T538 [US4] RED unit tests packages/agent-host/tests/broker-conversation-lifecycle.test.ts: idle 10
  min (fake clock) → agent closed, next message resumes via `session/load`; cap 3 evicts the idle-longest
  only, never running or waiting; all busy → `too-many-running`; crash → `crashed` + `agent-exited`
  notice, nothing retried; lease set while running, `open` from another browserRunId with a live pid →
  `in-use-elsewhere`, dead pid ignored
- [X] T539 Implement packages/agent-host/src/broker/conversation.ts (ACP client over
  `@agentclientprotocol/sdk`, modes, permissions, event log, idle, cap, crash) until T535–T538 are green
- [X] T540 Implement the broker command handler packages/agent-host/src/broker/commands.ts for
  `conversation-command` → result/overview/page frames, with a unit test for each command's refusal path
- [X] T541 Measurement with real agents (owner-approved spend, tiny prompts, scratch non-git folder, both
  strict modes): record each adapter's permission option ids for an edit and a command; whether either
  raises request_permission for MCP tools; whether either has a permission timeout; and whether Codex
  `read-only` edits a file inside the folder without asking — write results into research.md R-317
- [X] T542 **Owner checkpoint**: present T541's Codex in-folder result; if Codex edits in-folder without
  asking, the owner decides between restating SC-135 for Codex ("outside the folder") or another Codex
  setting T541 found; record as D-019-12 in spec.md
  — Done 2026-10-19: Codex asked as specified; Claude did not (owner's allow list). Owner chose
  conversation-scoped ask rules in strict mode (D-019-12, research R-317 "Measured in S4").
- [X] T542a [US2] RED then implement D-019-12 in packages/agent-host/src/broker/conversation.ts: for
  Claude, `session/new` and `session/load` in strict mode carry `_meta.claudeCode.options.settings =
  { permissions: { ask: [Edit, Write, NotebookEdit, Bash, PowerShell] } }`; switching to agent-review
  reloads the session without them and back to strict reloads with them (strict confirmed before the
  next prompt, a `mode` event says the conversation was reloaded); the fake agent records the `_meta` it
  received (tests/harness/fake-acp-agent.ts) so a unit test asserts it per mode and per resume

## Phase 6: User Story 1 + User Story 7 — the panel (S5, P1)

**Goal**: two tabs, the Conversation tab, external cards pinned above both.
**Independent test**: jsdom + packaged gate part 1 with the fake agent.

- [X] T543 [P] [US7] RED jsdom tests apps/extension/tests/side-panel-tabs.test.tsx: PromptCard and
  NoticeCard render above the tab bar on both tabs; Connections & sites shows exactly today's
  composition; count badge on the inactive Connections tab; last tab read from / written to
  `agentPanelTab` (storage wrapped in try/catch)
- [X] T544 [US7] Implement the tab bar in apps/extension/src/side-panel/agent/AgentShell.tsx (wrap lines
  265-318 as Connections & sites) until T543 is green
- [X] T545 [P] [US1] RED jsdom tests apps/extension/tests/conversation-view.test.tsx: agent picker,
  header with agent/folder/mode, streamed text, action list rows with status, Stop, permission card with
  three answers, mode switch renders exactly two choices, Codex strict note (FR-293), notices per
  `ConversationError` code, en-US and zh-TW strings
- [X] T546 [US1] Implement apps/extension/src/side-panel/agent/conversation/* (ConversationTab,
  ConversationHeader, MessageList, ActionList, PermissionCard, ModeSwitch) and locale strings until T545
  is green
- [X] T547 [US1] RED then implement worker forwarding in
  apps/extension/src/service-worker/conversation-relay.ts and agent-panel-port.ts: `ui.conversation.*`
  validated and forwarded; events fanned out to every panel document; a reconnecting panel gets the
  overview then pages from seq; the worker keeps no content (unit test
  apps/extension/tests/conversation-relay.test.ts extended)
- [X] T548 [P] [US3] RED jsdom then implement the first-use card (what, size, registry request, the
  owner's own settings apply, browser use under site rules) with Download / Cancel → `install` +
  `consent` commands; missing-agent guidance; install progress and failure + retry
- [X] T549 Packaged gate part 1 tests/e2e/packaged/agent-conversation.spec.ts (new) with
  `HALLPASS_TEST_MODE=1` + `HALLPASS_BROKER_TEST_AGENT` (quickstart §3): tabs + pinned external card (US7.1), streamed answer + actions (US1.1,
  1.2), Stop (US1.4), strict card each answer + per-conversation rule (US2), two modes offered (SC-140),
  first-use card + cancel (US3.1, 3.2); implement the env switch in the broker honoured only under a
  private `LOCALAPPDATA`

## Phase 7: User Story 1 (browser) — panel agent uses this browser (S6, P1)

**Goal**: the panel agent reaches this browser through a worker-issued token, under the same site rules.
**Independent test**: unit + gate part 2.

- [X] T550 [US1] RED unit tests apps/extension/tests/panel-sessions.test.ts: a hello with a live
  `panelToken` becomes a `kind: "panel"` session with agent id `panel:<conversationId>`, admitted by
  consent without touching `agentPairings`; an unknown token is refused `not-admitted`, never paired
  externally; external pairing of the owner's agent does not admit a panel session; the status-row unpair
  does not touch panel sessions; the gate decides exactly as for external sessions
- [X] T551 [US1] RED unit tests packages/agent-host/tests/mcp-server-panel.test.ts: with
  `HALLPASS_PANEL_TOKEN` + `HALLPASS_PANEL_BROWSER` the server uses agent id `panel:<id>`, dials only that
  browser's record, never reads the browser choice nor raises a choice card, sends the token in hello,
  never logs it, adds the one instructions line
- [X] T552 Implement the mcp-server side (packages/agent-host/src/mcp-server.ts) until T551 is green, and
  the broker side: token minted per agent run, `conversation-browser-token` sent and revoked on agent
  exit, Hallpass entry in `session/new` `mcpServers` with every field explicit (R-322)
- [X] T553 Implement panel sessions in apps/extension/src/service-worker/agent-runtime.ts (+
  pairing-controller.ts synthetic accepted pair result, checks at ~1804/1888, new panel-consent.ts for
  `agentPanelConsent`) until T550 is green; the token is never persisted by `tabs.announce`
- [X] T554 [US1] RED then implement the start tab (FR-306): `send.activeTabId` → broker → worker places
  that tab into the panel session's group on its first browser call of the turn without a claim card;
  other tabs go through claim (unit test in apps/extension/tests/panel-sessions.test.ts)
- [X] T555 RED then implement the consent switch in Connections & sites and withdrawal (FR-309): unpair-
  shaped teardown (prompts, plans, debugger, tab groups) for every panel session, tokens revoked, next
  conversation asks again (jsdom + unit)
- [X] T556 [P] RED then implement `changedBy`/`changedAt` in apps/extension/src/service-worker/
  site-mode-store.ts and the six writers (agent-panel-port.ts ~283/295, effects.ts, tabs.ts, dialogs.ts,
  upload.ts, diagnostics.ts) per R-328, schema already in T520; old records read unchanged; site list
  shows "changed by …" (FR-308)
- [X] T557 Packaged gate part 2 in tests/e2e/packaged/agent-conversation.spec.ts: fake agent's panel
  session reads a fixture page with the site in "ask" → consent card, then answers; first action on the
  viewed tab; consent withdrawal refuses the next call; site row shows the author
- [X] T558 **Security-focused code review of S6** (code-reviewer): admission by token, identity
  separation from external pairing, withdrawal teardown, token hygiene, `changedBy` writers; fix
  findings before S8

## Phase 8: User Story 4 + User Story 6 + User Story 5 — history and folders (S7, P2/P3)

**Goal**: conversations survive panel close and browser restart; list; project folders.
**Independent test**: unit + gate part 3.

- [X] T559 [P] [US6] RED unit tests packages/agent-host/tests/broker-index.test.ts: index write atomic
  (temp + rename), ≤ 50 entries and 30-day drop on every write, re-read before write (two brokers),
  corrupt file kept aside as `.bad-<time>` with an overview notice, `resumable: false` after a refused
  load, remove deletes only the entry
- [X] T560 [US6] Implement packages/agent-host/src/broker/index-store.ts until T559 is green
- [X] T561 [P] [US5] RED unit tests packages/agent-host/tests/broker-folders.test.ts: folder list ≤ 30,
  scratch folder per conversation under `scratch\<conversationId>` never deleted, missing folder →
  `folder-missing`, dialog result cancel / path, Constrained Language Mode detected → path-entry fallback
- [X] T562 [US5] Implement packages/agent-host/src/broker/folders.ts (PowerShell FolderBrowserDialog on a
  top-most owner, one at a time; open-folder via explorer.exe) until T561 is green; manual check of the
  dialog z-order over Chrome recorded in coverage.md
- [X] T563 [P] [US6] RED jsdom then implement the conversation list and folder chooser in
  apps/extension/src/side-panel/agent/conversation/ (ConversationList, FolderPicker): newest first,
  remove, cannot-continue label, in-use-elsewhere label, "new conversation in another folder"
- [X] T564 [US4] Packaged gate part 3: close the panel mid-turn, reopen → stream complete (US4.1); card
  raised while closed is shown on reopen and nothing ran past it (US4.2); idle resume with the fake clock
  (US4.3); simulated worker recycle (relay restart, same run) leaves the conversation running; list +
  remove (US6)

## Phase 9: Duplicate "hallpass" (S8)

- [X] T565 RED unit tests packages/agent-host/tests/broker-mcp-entry.test.ts: Claude gets a `hallpass`
  entry; Codex adapter started with `DISABLE_MCP_CONFIG_FILTERING=true`, entry with command/args/env/
  cwd/enabled/timeouts explicit, first input `/rename <title>`; an owner Codex entry with `url` →
  `hallpass_panel` name + instructions line
- [X] T566 Implement in packages/agent-host/src/broker/conversation.ts until T565 is green
- [X] T567 Measurement (owner-approved spend): with the owner's own `hallpass` configured, start one
  Claude and one Codex panel conversation and confirm the owner's `mcp-server.js` is not started; for
  the `url` fallback, measure whether a marker variable set on the adapter reaches Codex's servers and,
  if it does, make the worker ignore pairing requests carrying it; record in research.md R-322

## Phase 10: Polish, package, release (S9)

- [X] T568 [P] Package: scripts/package.ts adds the `broker` entry, keeps koffi external and copies
  `host/node_modules/koffi` (win32-x64 only) and `host/agents/*/package(-lock).json`; update
  tests/contract/qa-package.contract.test.ts pins (RED first); scripts/package/install.ps1 required files;
  uninstall.ps1 removes conversations.json, folders.json, agents\, brokers\, broker.log and keeps
  scratch\ with a message
- [X] T569 [P] Docs: README (side-panel conversation, consent, what is downloaded, scratch folders),
  docs/operations-guide.md, PRIVACY.md (registry request on consent, no content stored), CONTRIBUTING
  (fake agent); amend specs/006-side-panel/spec.md change log ("no chat" superseded by 019)
- [X] T570 Version 0.13.0 across packages, manifest and host pairing; full regression: typecheck, unit,
  contract, snapshot, every 0.12.5 packaged-gate spec unchanged on branded Chrome (SC-138)
- [X] T571 Process-cleanup trials on branded Chrome: 5 normal closes + 5 `taskkill /F` with two running
  conversations → 0 broker-tree pids each time (SC-136)
- [X] T572 **Final code review before 0.13.0** (code-reviewer), plus architecture-reviewer on the
  finished link/admission changes; fix findings
- [X] T573 **Paid probe S19** (owner approval first): quickstart §4 on branded Chrome with Claude Code
  and Codex — first-use install timing (SC-139), first words ≤ 10 s (SC-134), consent card on an "ask"
  site, refuse then allow once, mode switch, Chrome restart then continue (SC-137), 20-attempt strict run
  (SC-135 as decided in T542); report under docs (private, export-ignored)
- [X] T574 Close coverage.md (every FR/SC mapped to a passing task), update memory and handoff; owner
  owes merge, release, host reinstall

---

## Dependencies

S0 (T516–T518) → S1 (T519–T521) → S2 (T522–T529) → {S3 (T530–T534), S4 (T535–T542)}; S5 (T543–T549)
needs S1 and S4's command handler (T540) for T547/T549, its static UI (T543–T546, T548) only S1; S6
(T550–T558) needs S4 + S5; S7 (T559–T564) needs S4 + S5 and can run beside S6; S8 (T565–T567) needs S6;
S9 (T568–T574) needs all. Reviews T529 and T558 gate the slices that build on them.

## Parallel opportunities

- T518 ∥ T517; T521 ∥ T519/T520.
- In S2: T523 ∥ T522 (different test files); T524 before T526.
- S3 (host files) ∥ S5 static UI T543–T546 (extension files) once S1 lands.
- S6 (worker admission, mcp-server) ∥ S7 (broker index/folders, panel list) after S5.
- T568 ∥ T569.

## Implementation strategy

MVP = S1 + S2 + S3 + S4 + S5 without browser access: a strict conversation with the owner's own agent in
the panel (US1 text, US2, US3, US7). Then S6 makes it a browser agent (US1 complete), S7 adds history and
folders (US4–US6), S8 removes the duplicate tools, S9 ships 0.13.0.
