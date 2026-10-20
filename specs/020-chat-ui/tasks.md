# Tasks: A Side-Panel Conversation That Reads Like an Agent (020)

**Input**: `specs/020-chat-ui/` spec.md, plan.md. **Target**: 0.14.0.
Project rule: every behaviour change starts with its one focused failing test.

## Phase 1: Setup (S0)

- [X] T583 Commit spec, plan and tasks under specs/020-chat-ui on branch feature-020-chat-ui from main
- [X] T584 Pin react-markdown and remark-gfm exactly in apps/extension/package.json, `npm install`, record the side-panel chunk size before/after in specs/020-chat-ui/research.md (R-332); contract tests that list shipped dependencies updated if they pin the set

## Phase 2: Foundational (S1)

- [X] T585 Failing a11y test first (tests/panel-a11y.test.tsx reads the new token names), then the new light and dark token set in apps/extension/src/side-panel/agent/tokens.css (palette A, one 6-digit hex per line), every pair ≥ 4.5:1 (FR-322, SC-145)
- [X] T586 Apply the tokens to agent.css for both tabs without layout change in Connections & sites; existing extension-ui tests green

## Phase 3: US1 type first (S2, P1)

- [X] T587 [US1] Failing test: the tab opens with the composer focused and the agent chip on the last-used agent; fallback order FR-313 (apps/extension/tests/composer.test.tsx)
- [X] T588 [US1] Composer.tsx + AgentMenu.tsx (chips, agent states, install guidance) and the last-used write/read in chrome.storage.local (R-335)
- [X] T589 [US1] Failing test then implementation: sending to an agent without its connector shows the first-use card above the composer holding the message; consent fetches and sends; cancel keeps the text (FR-314)
- [X] T590 [US1] Failing test then implementation: agent and folder fixed after start, mode switchable (FR-315); ConversationTab.tsx wiring, old picker removed

## Phase 4: US2 replies (S3, P1)

- [X] T591 [P] [US2] Failing test with 10 hostile samples (raw HTML, script URLs, images, event attributes) and a table/list/code sample (SC-142), then Reply.tsx with react-markdown + remark-gfm, links in a new tab, images as links (FR-316)
- [X] T592 [P] [US2] Failing test then Copy on finished replies (FR-317)
- [X] T593 Code review of T591 (untrusted content rendering); fix findings

## Phase 5: US3 action log (S4, P2)

- [X] T594 [P] [US3] Failing unit test for turn grouping in conversation-log.ts (R-334), then the grouping
- [X] T595 [US3] Failing component test then TurnActions.tsx: live line (polite announcement), "N steps" collapse, failed/refused shown outside (FR-318)

## Phase 6: US4 permission + mode (S5, P1)

- [X] T596 [US4] Failing test then the permission card pinned above the composer, Enter does not send while waiting, Stop only, one-line record after the answer (FR-319, SC-144)
- [X] T597 [US4] Failing test then ModeMenu.tsx replacing ModeSwitch.tsx: explanations, Codex note, warning colour for the agent's own review (FR-320)

## Phase 7: US5 drawer (S6, P2)

- [X] T598 [P] [US5] Failing test then ConversationHeader.tsx (list + new buttons) and ConversationDrawer.tsx: groups Today / Last 7 days / Earlier, title search, Escape closes, focus returns, not-resumable and in-use rows (FR-321)

## Phase 8: US6 look, languages, access (S7, P2)

- [X] T599 zh-TW and en-US strings for every new key in agent-panel-keys.ts (FR-323); key parity test green
- [X] T600 Keyboard and screen-reader pass over the new controls (006 bar); fix gaps with tests

## Phase 9: US7 non-regression and release (S8, P1)

- [X] T601 Update packaged-gate selectors in tests/e2e/packaged/agent-conversation*.spec.ts only (no assertion change, SC-146); run on Playwright Chromium
- [X] T602 Branded Chrome 155: packaged gate + screenshots of the seven mockup screens in light and dark for the owner (SC-147); report in docs/reference-probe-019.md (020 section)
- [X] T603 Owner approves the look (palette A or B); apply the choice — 2026-10-20: palette A; the owner rejected the T602 layout and approved a planned layout redrawn from the mockup
- [X] T605 Layout aligned to the mockup (owner 2026-10-20): composer card pinned at the bottom in every state with agent/folder/mode chips and Send/Stop inside, compact icon header (list / new), centred welcome with fill-only suggestions, user bubble right and plain agent reply, menus open upward, Stop alone while running, short mode label, distinct agent badges, one-line drawer rows, Connections & sites restyled; test-first in apps/extension/tests/composer.test.tsx
- [X] T606 Owner-approved polish (2026-10-20): new-conversation icon always shown, first-use held message as a faded bubble with "Sends after you agree", waiting placeholder; Connections & sites as one-line site rows (mode chip menu, per-row more menu with diagnostics / changed-by / Revoke), short explanations, list-file path in the status menu, session cards with dot / name / meta / state pill, one upload folder per row with an × button; review fixes C1–C10 (title from the first message, live line last, "Waiting for you", inline code, permission answer order, radio colours, Copy icon, "Ready · last used", drawer badge + aria-current, popup padding); recovery P1–P5 (can't-continue notice with New conversation / Remove from list, Go to Connections & sites, Open conversation list, Jump to latest, "n more requests waiting"); test-first in apps/extension/tests/conversation-polish.test.tsx, conversation-recovery.test.tsx, connections-layout.test.tsx
- [X] T607 Findings from the full screenshot review (2026-10-20), Connections & sites: helper-down page (Q1), one menu open at a time (S1), upload folder as name over path (S3), sites without https:// (S4); Conversation: folder by name with the path on hover (A1/G2), one name per mode (A2), zh-TW ready (A3), drawer time never cut (G1), folder picker rows (J1), a crash said once in the panel's language (K1), long step paths (W1)
- [X] T608 Second review round: session card controls (Y1), unreadable agent version (M1), folder chooser refusals (J5/J6), failed download (L3), no shell scroll from screen-reader text (B1)
- [X] T609 Broker words in the panel's language: refusal details and conversation notices mapped from the broker's code (N3, sweep), too-many-running detail dropped (R1), a permission answer's code formatting (V6); composer chips on one row, folder chip shortened (N1, owner 2026-10-20)
- [X] T610 A conversation chosen from the list is shown at once (starting, then its history or its own cannot-continue page; a refusal returns to the one before); an unsent draft stays with its conversation
- [X] T604 Release 0.14.0: version, changelog, typecheck/unit/contract/snapshot, package, merge, public release, host reinstall

## Dependencies

T583 → T584 → T585 → T586 → (T587–T590) ∥ (T591–T593) ∥ (T594–T595) ∥ T598; T596–T597 after T590 (same
files); T599–T600 after all UI slices; T601–T604 last. Writers at most two at a time; ConversationTab.tsx
has one owner per wave.
