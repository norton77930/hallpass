---
description: "Task list for 018 multi-browser selection (DRAFT - waits for the owner's answers)"
---

# Tasks: Several Browsers, One Bridge — the Owner Chooses Which Browser an Agent Uses

**Input**: `specs/018-multi-browser-selection/` — spec.md (FR-266 – FR-281, SC-127 – SC-133, draft),
plan.md (slices S0 – S9, S4 split a/b), research.md (R-266 – R-279).

**Status**: Approved 2026-10-03 (owner: every proposed answer). Task
text marked ⟨Qn⟩ changes with owner question n (plan.md "Owner questions").

**Tests**: TDD required (CLAUDE.md "test first"): each behaviour task starts with a RED test.

**Rules for this run**: (1) implementers run unit + contract suites only, never `tsc -b` while another
writer is active; browser gates are run by the main session, Playwright Chromium with `--no-sandbox`;
(2) a thing that fails twice is measured, not tried a third time; (3) R2: architecture review (done on
the plan, 2026-10-03, sound with changes, applied) + security-focused code review of S4b + final code
review before 0.11.0; no merge or release without the owner.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup (S0)

- [X] T493 Record the owner's answers to questions 1–8 in spec.md (decisions D-018-*, FR text), then
  write data-model.md and contracts/browser-tools.md (tool descriptions, refusal shapes, frames) and
  quickstart.md; baseline numbers at the top of coverage.md (new)

## Phase 2: Foundational — contracts (S1)

- [X] T494 RED contract tests tests/contract/agent-tools-018.contract.test.ts (new): per-browser record
  schema (strict); optional `browserId`/`browserKind`/`browserName`/`features` on `relay-ack` and a
  0.10.0 ack still parses; frames `browser-name`, `browser-peers`, `browser-identity-conflict` ⟨Q2:
  `browser-choice-request/result/withdraw`⟩; refusals `browser-not-chosen` / `browser-disconnected` with
  `browsers[]`; tools `list_browsers`, `select_browser` ⟨Q2: `request_browser_choice`⟩ in
  `AGENT_TOOL_NAMES`, not batch steps; protocol still 2; `relay-standby` gone
- [X] T495 Implement in packages/contracts/src/agent-tools.ts (+ bilingual hint constants) until T494 green
- [X] T496 [P] RED + implement `defaultBrowserNames` in packages/domain (kind names, numbered by
  connection order) ⟨Q3⟩; host paths `browsersDirectory()`, `browserChoicesDirectory()`

## Phase 3: Relay (S2)

- [X] T497 RED relay process tests (packages/agent-host/tests/relay-process.test.ts, "018"): two relays
  with fake native ports both write their own `browsers/<id>.json` and both serve; closing one leaves
  the other; a same-browser same-run replacement still exits the old relay (T169); same id + different
  run = collision → no write + `browser-identity-conflict` (R-276); one legacy `bridge.json` owner,
  re-claimed when its owner leaves, a loser keeps serving (R-277); a protocol-2 server still attaches
- [X] T498 Implement in native-host.ts, bridge-link.ts, relay-ownership.ts (per-browser writer with
  absent→republish repair, dead-pid sweep matching `*.json` only, `browser-peers` from the 1 s poll,
  `browser-name` rewrite, browser id on `relay.started`) until T497 green

## Phase 4: Extension identity and naming (S3) [P with Phase 3]

- [X] T499 [P] [US4] RED identity store tests (new browser-identity.test.ts): minted once in
  `storage.local`, survives a second store instance; kind detection; re-mint on conflict keeps the name
  with a suffix; ack carries identity, read within the relay's ack bound (R-279)
- [X] T500 [P] [US4] Implement service-worker/browser-identity.ts + agent-bridge.ts ack until T499 green
- [X] T501 [P] [US4] RED panel tests: "This browser: <name> [Rename]" (1–40 chars, control chars
  stripped), "N other browsers connected" from `browser-peers`, en-US + zh-TW; rename command
  validated in the worker; implement until green

## Phase 5: Server resolution (S4a, S4b) — the R2 core

- [X] T502 [US1] RED exhaustive table tests for pure `resolveBrowser` (new resolve-browser.test.ts):
  0/1/many connected × no choice / remembered online / remembered offline ⟨Q7⟩ / session-bound online /
  session-bound absent within and beyond the attach bound (R-278) → use / refuse-not-chosen /
  refuse-disconnected
- [X] T503 [US1] Implement resolve-browser.ts, browser-directory.ts (per-browser records + legacy
  `bridge.json` entry, R-277), browser-choice-store.ts (one file per agent ⟨Q1, Q5⟩) until T502 green
- [X] T504 [US1] RED + implement `list_browsers` / `select_browser` host-answered (no pairing, exempt
  from FR-272), wired to a record source for the existing single dial (S4a checkpoint: unit green)
- [X] T505 [US1] [US2] RED mcp-server tests (S4b): a refusal sends 0 frames to any worker; resolution at
  initialize, every dial and `placeCall`; bound at the first forwarded call ⟨Q6⟩; per-browser pairing
  (B asks again, FR-275); switch drains running calls then closes the old link; `stop`/timeout routed to
  the link that carried the call; tab id issued by another browser refused before forwarding; a worker
  recycle of the bound browser does not refuse; self-selected switch rule ⟨Q8⟩
- [X] T506 Implement in mcp-server.ts (link map by browser; per-browser pairing/features/run; tab-id
  provenance; screenshot cache cleared on switch) until T505 green
- [X] T507 **Security-focused code-reviewer on T502 – T506** (routing = authorization)

## Phase 6: In-browser choice (S5) ⟨Q2⟩

- [X] T508 [US3] RED coordinator tests: cards only in browsers advertising the feature (from the
  worker's ack), derived session id for choice links (R-279), first confirm wins + withdraw others,
  decline everywhere / 2 min → "no browser chosen", earlier choice unchanged
- [X] T509 [US3] RED worker + panel tests: choice card (PromptCard), withdraw, prompt-waiting / badge /
  closed-panel rules; implement coordinator + card controller until T508/T509 green

## Phase 7: Retire stand-by (S6)

- [X] T510 Remove the stand-by branch, worker status, backoff cap, persisted record, panel text and
  `relay-standby` (R-274); update agent-bridge / wiring / shell / relay-process / link-frame tests

## Phase 8: Uploads (S7) ⟨Q4⟩

- [X] T511 Either key upload directories per browser (RED + implement) or amend FR-275 (proposed)

## Phase 9: Gate, probe, release (S8, S9)

- [X] T512 Gate fixture: two CDP endpoints (`HALLPASS_CDP_ENDPOINTS`, two private profiles, one shared
  private LOCALAPPDATA); new tests/e2e/packaged/agent-multi-browser.spec.ts for SC-127 – SC-132
- [X] T513 agent-* regression on Playwright Chromium (two batches, fresh browser per spec file)
- [X] T514 Probe S18 (SC-133, paid, owner's run per the 004 standard)
- [ ] T515 0.11.0 (tool-offering + manifest), README tool list, uninstall removes `browsers/` and
  `choices/`, docs; final code-reviewer; coverage.md close-out
