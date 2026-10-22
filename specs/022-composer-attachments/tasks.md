# Tasks: Attachments in the Side-Panel Conversation

**Input**: spec.md, plan.md, research.md (R-336..R-344), data-model.md, contracts/attachments.md
**Rule**: every behaviour task is preceded by its failing test (project rule, overrides the template default).

## Phase 1: Setup

- [X] T611 Record the adapter capability evidence (R-336) and the slice table in plan.md; no code (main).

## Phase 2: Foundational — S1 contracts + broker (blocks every story)

- [X] T612 [P] Failing contract tests for `ui.conversation.attach`, `attach-cancel`, extended `send` (empty text only with attachments), owner event `attachments`, projection `accepts`, `ui.tab.capture` and `tab-capture-result` in packages/contracts/src/conversation.test.ts and packages/contracts/src/agent-tools.test.ts
- [X] T613 Implement those schemas in packages/contracts/src/conversation.ts and packages/contracts/src/agent-tools.ts (panel union, broker union, link union)
- [X] T614 Failing tests for the staging store in packages/agent-host/src/broker/attachments.test.ts: piece order, declared size, limits (R-340), name sanitising and " (n)" (R-339), containment for `..\..\x`, `C:\x`, `con`, `a:b`, 300 chars (SC-151), exclusive final name, part removed on cancel / refusal / idle 120 s / expiry 10 min / conversation removal, folder gone
- [X] T615 Implement packages/agent-host/src/broker/attachments.ts
- [X] T616 Failing tests in packages/agent-host/src/broker/conversation.test.ts (or a new conversation-attachments.test.ts): capabilities read at initialize and reported; send with attachments builds text · image · resource · file-list blocks in that order; `attachment-not-accepted`; owner event carries attachments with thumbnails; replayed user image becomes an image attachment; staged data dropped on stop/exit/remove; text-only send unchanged
- [X] T617 Implement in packages/agent-host/src/broker/conversation.ts and packages/agent-host/src/broker/commands.ts (route attach / attach-cancel, projection `accepts`)
- [X] T618 Architecture review (link protocol) + code review (folder writes, containment, cleanup) of S1; fix findings with a failing test each

## Phase 3: US2 + US3 worker side — S2 viewed-tab capture

- [X] T619 [P] [US2] Failing tests in apps/extension/tests/tab-attach.test.ts: screenshot of the active tab within the image bound; restricted page refused; not-active refused; no consent card asked
- [X] T620 [P] [US3] Failing tests in the same file: page text with url/title, cut at 50 000; PDF tab returned as a file; PDF over 25 MB refused
- [X] T621 [US2] [US3] Implement apps/extension/src/service-worker/tab-attach.ts and route `ui.tab.capture` in apps/extension/src/service-worker/agent-panel-port.ts

## Phase 4: US1 + US4 + US5 panel — S3

- [X] T622 [P] [US1] Failing tests in apps/extension/tests/composer-attach-images.test.tsx: + menu entries and hint; paste image → chip; drop images; 6th refused; remove returns focus; attachment-only send; image prepared ≤ 2000 px and ≤ 700 000 chars (prepare function unit-tested with a fake bitmap/canvas)
- [X] T623 [US1] Implement apps/extension/src/side-panel/agent/conversation/attachments/ (prepare-image.ts, chips, + menu) and wire into Composer.tsx
- [X] T624 [P] [US4] Failing tests in apps/extension/tests/composer-attach-files.test.tsx: file chip, 25 MB refused before transfer, total limit, transfer in ≤ 512 KiB pieces awaited one by one then send with ids, failed piece → attach-cancel + refusal shown + nothing sent
- [X] T625 [US4] Implement the transfer (attachments/transfer.ts) and a `request(command): Promise<result>` in apps/extension/src/side-panel/agent/AgentShell.tsx
- [X] T626 [P] [US2] [US3] Failing tests: "Screenshot of this tab" / "Attach this tab" send `ui.tab.capture` and add the chip; refusals shown; entries disabled with reason when `accepts` says no (PDF still allowed)
- [X] T627 [US2] [US3] Implement the two entries in the + menu
- [X] T628 [P] [US5] Failing tests in apps/extension/tests/composer-attach-held.test.tsx: held first-use message keeps attachments, Allow sends them, decline gives them back; chips stay with their conversation on switch
- [X] T629 [US5] Implement in ConversationTab.tsx (HeldMessage.attachments, giveBack, per-conversation draft attachments)
- [X] T630 [P] [US1] Failing tests: user bubble shows thumbnails, file chips with path title, tab chip with "cut"; replayed image chip
- [X] T631 [US1] Implement the bubble attachments
- [X] T632 en-US + zh-TW strings for every new label and refusal (FR-339, SC-152); a11y names for + menu, entries, chips, remove buttons (FR-341)

## Phase 5: Polish & integration — S4

- [X] T633 Code review of the combined S2 + S3 diff; fix findings with a failing test each
- [X] T634 Typecheck, `npm test`, build, `npm run test:contract`, `npm run snapshot:check` (2026-10-21: full run under load had timeouts; serial rerun leaves mcp-server.test.ts timeouts that move between runs in code 022 does not touch, and side-panel-app.test.tsx, which fails the same way on 0.14.0 c703e2d)
- [X] T635 Fake-agent shots (attach phase) light/dark × en/zh, each image reviewed; compare page updated for the owner
- [X] T636 US6 regression: packaged conversation gate (text send, permission card, first use, stop) unchanged (2026-10-21: 5 passed / 4 failed, the same tests fail on the 0.14.0 build c703e2d in the same environment: the gate spec predates the 020 UI; end-to-end send on the dev host passed en + zh: bubble, prompt block order, file in hallpass-attachments, " (2)" never overwrites)

## Dependencies

T612–T618 (S1) block everything. After T618: S2 (T619–T621) and S3 (T622–T632) in parallel (disjoint paths;
main runs `tsc -b` and the extension build between slices). T633–T636 after both.

## MVP

US1 (images by +, paste, drop) on top of S1 is the smallest useful delivery; the tab entries and files follow.
