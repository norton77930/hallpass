# Tasks: 043 page scripts on a local dev site

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[contracts/prompt-raised-043.md](contracts/prompt-raised-043.md)

Every behaviour change starts with the one focused failing test that would have caught its absence
(CLAUDE.md "Test first"). Slice A runs before slice B: both touch `packages/contracts/src/agent-tools.ts`
and `apps/extension/src/service-worker/agent-tools/prompts.ts`.

## Phase 1: User Story 1 - the terminal question says how to stop being asked (P1) - slice A

**Goal**: FR-620..FR-622. **Independent test**: the elicitation message for each tool in US1 scenarios 1-5.

- [X] T1200 [US1] RED: contract tests in `packages/contracts/src/agent-tools.test.ts` - `prompt-raised` parses
  with `alwaysInBrowser: true` on `kind: "effect"` and is refused with it on `diagnostics`, `transition` and
  `site-plan` (R-580)
- [X] T1201 [US1] RED: worker tests in `apps/extension/tests/prompts.test.ts` - the raised frame carries
  `alwaysInBrowser: true` for an effect question on a known site (evaluate, file_upload, click), and not for
  an unknown frame site or a diagnostics question (R-580, FR-621)
- [X] T1202 [US1] RED: host tests in `packages/agent-host/tests/terminal-consent.test.ts` - the R-581 hint is
  appended when `alwaysInBrowser` is present and `choices` lacks `session`; the message is unchanged when
  `choices` has `session`, when the field is absent, and for transition / site-plan / diagnostics (their
  "no always" assertions still hold); `enum` / `enumNames` unchanged (FR-620..FR-622, US1 scenarios 1-6)
- [X] T1203 [US1] GREEN: add the optional field to `promptRaisedFrameSchema` in
  `packages/contracts/src/agent-tools.ts`; set it in the raised frame in
  `apps/extension/src/service-worker/agent-tools/prompts.ts` (`ask`, effect branch, known deciding site);
  append the hint in `messageOf` in `packages/agent-host/src/terminal-consent.ts`; update
  `specs/031-outside-agent-experience/contracts/terminal-consent.md` with a pointer to
  `contracts/prompt-raised-043.md`

**Checkpoint**: `npx vitest run --project unit packages/contracts packages/agent-host/tests/terminal-consent.test.ts apps/extension/tests/prompts.test.ts` green; `npm run typecheck` green.

## Phase 2: User Story 2 - "this session" for page scripts on a local dev site (P2) - slice B

**Goal**: FR-623..FR-628. **Independent test**: US2 scenarios 1-7 by unit and UI tests; one live run.

- [X] T1204 [US2] RED: domain tests in `packages/domain/src/loopback-site.test.ts` - loopback for
  `http://localhost:3001`, `https://localhost`, `http://127.0.0.1:8080`, `http://[::1]:3000`,
  `http://127.1` (canonical 127.0.0.1); not loopback for `http://app.localhost`, `http://localhost.`,
  `http://127.0.0.2`, `http://[::ffff:7f00:1]`, `http://localhost.example.com`, `http://127.0.0.1.nip.io`,
  `https://example.com`, `file:///x`, a malformed string (FR-623, D-043-5, R-582)
- [X] T1205 [US2] GREEN: the helper in `packages/domain/src/loopback-site.ts`, exported from
  `packages/domain/src/index.ts`
- [X] T1206 [US2] RED: store tests in `apps/extension/tests/session-grant-store.test.ts` - a `scripts` grant is
  recorded, covered only for its kind / session / agent / site, read back after a reload, cleared on session
  end, agent forget and site forget; a `page-actions` grant never covers `scripts` and the other way round
  (FR-625, FR-626, R-583)
- [X] T1207 [US2] GREEN: kind `scripts` in `apps/extension/src/service-worker/session-grant-store.ts`;
  `scriptsGrantsFrom` in `apps/extension/src/service-worker/agent-tools/page-action-grants.ts`; wiring in
  `apps/extension/src/service-worker/agent-runtime.ts` beside `sessionGrants` / `diagnosticsSessionGrants`
- [X] T1208 [US2] RED: gate tests in `apps/extension/tests/` (the existing gate test file) - `evaluate` with
  `scriptsGrantCovers: true` admits under `ask` and `follow-a-plan`; prompts with a `null` site; the flag is
  ignored for every other tool; `skip-checks` unchanged (R-584)
- [X] T1209 [US2] GREEN: `scriptsGrantCovers` in `GateInput` / `decideGate`,
  `apps/extension/src/service-worker/agent-tools/gate.ts`
- [X] T1210 [US2] RED: worker tests - `apps/extension/tests/prompts.test.ts`: evaluate on a loopback deciding
  site offers `once, session, deny`, on a non-loopback or unknown frame site `once, deny`;
  `apps/extension/tests/agent-diagnostics-gate.test.ts`: on `http://localhost:3001` an Allow with session
  records a `scripts` grant and the next `evaluate` of that session raises no effect question; another
  session, `http://localhost:3002`, and a click on the same origin still ask; a page-actions grant does not
  admit `evaluate`; on `https://example.com` a session answer is a once and records nothing
  (`agent.session-grant.not-applicable`); update the existing "never turns a session answer into a grant"
  case in `apps/extension/tests/agent-effects.test.ts` only where it names a loopback site (US2 scenarios 1-7)
- [X] T1211 [US2] GREEN: `clientChoicesFor` in `apps/extension/src/service-worker/agent-tools/prompts.ts`;
  the evaluate effect path in `apps/extension/src/service-worker/agent-tools/diagnostics.ts` (compute
  `scriptsGrantCovers`, record the grant on Allow + session when loopback, report not-applicable otherwise)
- [X] T1212 [US2] RED then GREEN: UI tests in `apps/extension/tests/prompt-card.test.tsx` (*This session* shown
  for evaluate on a loopback deciding site, not on others) and `apps/extension/tests/session-card.test.tsx`
  (a scripts grant renders as its own line with its source); implement in
  `apps/extension/src/side-panel/agent/PromptCard.tsx`, `apps/extension/src/side-panel/agent-panel-keys.ts`,
  `apps/extension/src/locales/en-US.ts` ("page scripts"), `apps/extension/src/locales/zh-TW.ts` ("頁面腳本")
  (FR-624, FR-628)
- [X] T1213 [US2] RED then GREEN: contract - grants enum gains `scripts` in `packages/contracts/src/agent-tools.ts`
  (:4281-4291); update `tests/contract/prompt-waiting.contract.test.ts` (:174-188) so `scripts` parses and an
  unknown kind is still refused
- [X] T1214 [US2] Docs: amend `specs/017-session-site-plan/spec.md` FR-255 and
  `specs/031-outside-agent-experience/spec.md` D-031-8 / FR-470 with a one-line "amended by 043 for loopback"
  note and a change-log row each; README consent section one sentence on the loopback session option

**Checkpoint**: `npm run typecheck`, `npm test` green.

## Phase 3: Review and verification

- [X] T1215 code-reviewer on the slice B diff (R2), dispositions recorded
- [X] T1216 Live: with the built extension and a page on `http://localhost:<port>`, the panel card for an
  `evaluate` effect question shows *This session*; after it, a second `evaluate` raises no card and the
  session card lists the scripts grant (packaged `tests/e2e/packaged/agent-scripts-session-043.spec.ts`;
  the fixtures are all loopback, so the non-loopback case is unit-tested only)
- [X] T1217 Final: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:contract`,
  `npm run snapshot:check`; coverage.md written

## Dependencies

T1200-T1203 (slice A) -> T1204-T1214 (slice B) -> T1215 -> T1216 -> T1217. Inside slice B: T1205 before T1210;
T1207 before T1210; T1209 before T1211. T1204 / T1206 / T1208 are independent REDs [P] for one writer.

## Implementation strategy

US1 alone is shippable (MVP). US2 follows in the same branch and closes only after T1215.
