# Tasks: Agent Questions as Side-Panel Cards

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/frames.md](contracts/frames.md), [quickstart.md](quickstart.md)

Every behaviour task starts with its failing test (project rule, CLAUDE.md; it overrides the "tests are
optional" default). IDs continue from 028 (T863). `[P]`: a different file with no open dependency.

## Phase 1: Setup

- [ ] T864 [P] Extend the fake agent in `tests/harness/fake-acp-agent.ts` with prompt keywords, each asking
      one form question only when the client advertised `elicitation.form` (else `elicit:unsupported`, as
      `ask:elicit` does), and saying back `elicit:<action>` plus the accepted `content` as JSON:
      - `ask:form:kinds`: one field of each kind of R-432, one required;
      - `ask:form:secret`: a text field with `_meta.codex.isSecret`;
      - `ask:form:tool`: tied to a tool call it announced first;
      - `ask:form:withdraw`: a request it cancels with `$/cancel_request` after `FAKE_ACP_WITHDRAW_MS`
        (default 200);
      - `ask:form:empty`: a form with no properties sent as `session/request_permission`, as Codex sends an
        MCP tool approval;
      - `ask:form:big`: 21 fields;
      - `ask:form:outside`: asks right after its turn ended.

      Document each in the header list. Test first in `tests/harness/fake-acp-agent.test.ts`: each keyword's
      request shape, with and without the client capability.

## Phase 2: Foundational (blocks every story)

- [ ] T865 Test first in `packages/contracts/src/conversation.test.ts` ("029"):
      - `question` and `question-closed` events with every bound of data-model, including the ≤ 20 fields,
        ≤ 100 options and summary ≤ 400 limits;
      - `ui.conversation.question-reply` in both command unions;
      - `accept` values typed per data-model; `cancel` refused as a reply;
      - outcome `question-invalid`.

      Then the schemas in `packages/contracts/src/conversation.ts` and their exports in
      `packages/contracts/src/index.ts`. FR-440, FR-441, R-434.
- [ ] T866 Test first in `packages/agent-host/tests/questions-029.test.ts`, then implement the field mapping
      in `packages/agent-host/src/broker/questions.ts`. The function `questionFromRequest(request)` maps a
      form schema to the event's fields per R-432:
      - choice from `oneOf` and from `enum`; choices from `items.anyOf` / `items.enum` with min / max items;
      - text with format, length and pattern; number and integer with limits; yes-no;
      - defaults and the `required` list;
      - `title` falling back to the key; option descriptions;
      - `unsupported` for any other kind;
      - `skipOnly` when over a bound, when there is no showable field, or when a required field is
        unsupported;
      - `secret` from `_meta.codex.isSecret` (R-433);
      - `waitsMs` from `_meta.codex.autoResolutionMs`.

      The function is pure, with no ACP connection.
- [ ] T867 Test first (same test file), then implement in `packages/agent-host/src/broker/questions.ts`:
      - `checkReply(fields, values)` per R-434: unknown key, wrong type, value not offered, out of limits,
        pattern mismatch, a missing required field, a fraction for an integer, and unsupported fields left
        out;
      - `summarize(fields, values)` per R-436: choices by their labels, several joined with commas, yes / no,
        secrets as hidden, clipped at 400.

## Phase 3: User Story 1: answer an agent's question from a card (P1) 🎯 MVP

**Goal**: a Claude Code or Codex form question reaches the owner as a card, and Send replies `accept`
with exactly the entered values.
**Independent test**: over the fake agent, `ask:form:kinds` raises a `question` event. A `question-reply`
accept with one value per field makes the agent say back exactly those values. SC-196, SC-197, SC-200.

- [ ] T868 [US1] Test first in `packages/agent-host/tests/broker-questions-029.test.ts`, then implement in
      `packages/agent-host/src/broker/conversation.ts`:
      - `initialize` carries `clientCapabilities.elicitation = { form: {} }` and no `url` (FR-439, R-429);
        the fake's `ask:elicit` now gets a form instead of `elicit:unsupported`;
      - `ask:form:empty` still raises a `permission` card, unchanged (R-429).
- [ ] T869 [US1] Test first (same file), then implement in `packages/agent-host/src/broker/conversation.ts`
      an `onRequest("elicitation/create")` handler:
      - a `form` request for this session in a live turn becomes a held question (`q-<n>`), enqueued as
        `question` using `questionFromRequest`; the state goes to `waiting-for-owner`;
      - anything else of R-431 is answered `cancel` with no event: outside a turn (`ask:form:outside`),
        another session, request-scoped, url mode.
- [ ] T870 [US1] Test first (same file), then implement the reply path:
      - `ConversationPool.questionReply(conversationId, requestId, reply)` in
        `packages/agent-host/src/broker/conversation.ts`, with its case in
        `packages/agent-host/src/broker/commands.ts`;
      - accept runs `checkReply` first: an invalid reply answers `question-invalid` and the card stays;
      - a valid accept answers the agent `{ action: "accept", content }` and enqueues `question-closed`
        `answered` with its summary; the fake agent says back exactly the values (SC-197);
      - a second reply, as from another panel document, answers `not-found` (FR-445).
- [ ] T871 [P] [US1] Test first in `apps/extension/tests/side-panel-question-card-029.test.tsx`, then
      implement `apps/extension/src/side-panel/agent/conversation/QuestionCard.tsx`:
      - one control per field kind (radio list, checkboxes with min / max, text line with its format, number,
        checkbox);
      - defaults pre-filled; Send unavailable until required fields are filled, with the missing ones named;
      - an `unsupported` field listed as "can't be answered here";
      - the message and long text clipped with "show all" (R-432);
      - Send posts `question-reply` accept with the typed values (numbers as numbers, choices as values).
- [ ] T872 [US1] Test first (same test file, plus the existing `conversation-log` tests), then implement:
      - `apps/extension/src/side-panel/agent/conversation/conversation-log.ts` keeps open questions and puts
        each `question-closed` into the timeline as an answered line with its summary;
      - `MessageList.tsx` draws open questions with `QuestionCard`;
      - `ConversationTab.tsx` sends the reply command and shows a `question-invalid` refusal on the card;
      - two documents fed the same events show the same card and close it on the same `question-closed`
        (FR-445).
- [ ] T873 [P] [US1] Add every new string to `apps/extension/src/locales/en-US.ts`,
      `apps/extension/src/locales/zh-TW.ts` and `catalog.ts` (card title, waiting, Send, Skip, missing field,
      can't be answered here, show all, each ending's line). The existing locale-parity test must pass.

## Phase 4: User Story 2: decline or skip a question (P1)

**Goal**: Skip tells the agent the owner chose not to answer. Hallpass's own endings never answer for the
owner. **Independent test**: over the fake agent, Skip makes it say `elicit:decline`; Stop and exit make it
`cancel`; a withdrawn request closes the card. SC-198.

- [ ] T874 [US2] Test first in `packages/agent-host/tests/broker-questions-029.test.ts`, then implement in
      `packages/agent-host/src/broker/conversation.ts` every ending of R-435:
      - a `decline` reply gives `skipped`;
      - Stop, the turn's end and a mode drift give `cancel` and `cancelled`;
      - the agent's exit gives `agent-exited`;
      - `ask:form:withdraw` (request signal aborted) gives `withdrawn`, with no reply sent.

      In every case the held question is removed, and nothing is sent as `accept` (FR-441).
- [ ] T875 [US2] Test first (same file), then implement R-437 in
      `packages/agent-host/src/broker/conversation.ts`: every check that reads `this.cards.size` also counts
      held questions. That covers the idle stop, a mode change, a restart and a model change refused
      `busy`, and the `waiting-for-owner` state going back to `running` only when neither waits. No
      expiry (FR-442).
- [ ] T876 [P] [US2] Test first in `apps/extension/tests/side-panel-question-card-029.test.tsx`, then
      implement in `QuestionCard.tsx` and `conversation-log.ts`:
      - Skip posts `{ action: "decline" }`;
      - each ending's line (skipped, cancelled, withdrawn, agent-exited);
      - `skipOnly` shows the message and Skip only (FR-446);
      - `waitsMs` shows how long the agent waits.

## Phase 5: User Story 3: know who is asking (P1)

**Goal**: the card names the agent, and the tool call only when the question carries it (R-430).
**Independent test**: `ask:form:tool` raises a `question` with `toolCallId` and the announced `toolTitle`;
`ask:form:kinds` has neither; the card's text says the answer goes to the agent and may go on to the tool.

- [ ] T877 [US3] Test first in `packages/agent-host/tests/broker-questions-029.test.ts`, then implement in
      `conversation.ts`:
      - a question's `toolCallId` is kept only when the turn announced that call, and `toolTitle` is taken
        from the announcement;
      - an unknown id is dropped, never shown;
      - nothing is guessed from the message (FR-443).
- [ ] T878 [P] [US3] Test first in `apps/extension/tests/side-panel-question-card-029.test.tsx`, then
      implement in `QuestionCard.tsx`:
      - the title is "{agent} asks";
      - "During: {toolTitle}" appears only when present;
      - the fixed line says the answer goes to the agent and its model provider and may go on to that tool
        (FR-443).
- [ ] T879 [US3] Test first (both test files), then implement the secret field (FR-449, R-433):
      - `ask:form:secret`'s field is a hidden-text input;
      - its value reaches the fake agent;
      - the answered line says hidden;
      - the value is in no `question` / `question-closed` event and no panel text after Send.

## Phase 6: User Story 4: agents that cannot ask (P3)

**Goal**: Hermes and DeepSeek are unchanged (FR-448). **Independent test**: their existing launch and
conversation tests pass with no change to their expectations. SC-201.

- [ ] T880 [US4] Test first in `packages/agent-host/tests/broker-questions-029.test.ts`, with the fake agent
      launched as Hermes and as DeepSeek:
      - a run with no elicitation is unchanged;
      - their `initialize` carries the same capability, which is harmless when unused.

      Run the existing `broker-conversation-agents-021` and `broker-agents` suites unchanged.

## Phase 7: Polish and cross-cutting

- [ ] T881 [P] SC-199. Test in `packages/agent-host/tests/broker-questions-029.test.ts`: after a run that
      answers `ask:form:kinds` and `ask:form:secret` with known test values, no value appears in the
      broker's log lines, the diagnostics lines, or any file under the test's data folder. The secret is
      also absent from every frame.
- [ ] T882 [P] Add the user-facing entry to `CHANGELOG.md` (questions as cards, Claude Code's question tool
      back, Codex no longer answered blank) and the README's side-panel section; add `coverage.md` mapping
      each FR and SC to its tests (as in 027).
- [ ] T883 Run the gates: `npm run typecheck`, `npm test`, `npm run build:extension`, `npm run test:contract`
      and `npm run snapshot:check`. Record the counts in `specs/029-agent-question-cards/coverage.md`.
- [ ] T884 Windows (owner's machine):
      - `npm run build` and `npm run probe:017`; record the result for R-428 in `research.md`, and amend
        R-429 if Claude Code or Codex differ from it;
      - quickstart steps 3-6; record them under "Owed on Windows" in `coverage.md`;
      - add the spec's change log row.

## Dependencies

- T864 and T865 come first; T866 and T867 need T865's types.
- US1:
  - broker: T868 → T869 → T870;
  - panel: T871 → T872, in parallel with the broker after T865;
  - T873 any time after T871.
- US2: T874 and T875 after T870; T876 after T872.
- US3: T877 after T869; T878 after T871; T879 after T870 and T872.
- US4: T880 after T868.
- Polish: T881 after T879; T882 at any point after its story; T883 after all; T884 after T883.

## Parallel examples

- After T865: T866 (host module) ‖ T871 (card component) ‖ T873 (locales).
- After T870 and T872: T874 ‖ T876 ‖ T877 ‖ T878.

## Implementation strategy

- **MVP = Phase 1-3 (US1)**: forms advertised, a card, Send. This alone fixes Codex's blank answers and
  gives Claude Code its question tool back. Ship it only together with US2, since a card without Skip or
  Stop handling could leave a turn waiting with no clean way out. In practice the first release is
  US1 + US2.
- Then US3 (labels and secret fields), US4 (a no-change check), polish, and the Windows run.
