---

description: "Task list for Interrupt a Step, Confirm a Site Transition, Ask Before Uploading From a New Directory"
---

# Tasks: Interrupt a Step, Confirm a Site Transition, Ask Before Uploading From a New Directory

**Input**: `/specs/014-interrupt-transition-settings/spec.md`, `plan.md` (S1–S4), `research.md`
(R-185–R-190), `data-model.md`, `contracts/{interrupt,transitions,upload-directory}.md`,
`quickstart.md`.

**Tests**: TDD in every slice (one focused RED per module before the code); S2 and S3 each close
with a `code-reviewer` pass (new consent surfaces); S4 closes on the packaged gates, one
branded-Chrome run and one paid probe (SC-107).

**Numbering** continues from 013 (T324–T347): this feature starts at **T348**.

## Standing rules (owner, 2026-09-18 — binding for every task)

1. **Two attempts, then stop.** A task that fails its second attempt is not tried a third time;
   go back to the evidence or measure.
2. **Clean room.** Behaviour only; no reference identifier in `specs/` or source; answer
   strings, frame names and event names are ours.
3. **One writer at a time.** Brief 1 = S1; brief 2 = S2; brief 3 = S3; brief 4 = S4 tails +
   descriptions + docs. Version bump, branded run, probe, artifact refresh and coverage stay
   with the main session.
4. **No new permission; nothing private leaves.** `npm run snapshot:check` before the final commit.
5. **Measure the two unknowns first**: T349 (schema strictness) before any contract change;
   T366 (loopback switch) before the transition gate is written.
6. **Paid run**: one probe (T391), allowed by the owner for 013 and reused here unless withdrawn.

## Phase 1 — Setup

- [X] T348 Read the three contracts, `data-model.md`, `research.md` R-185–R-190 and the sources
  they name; confirm at HEAD: `stop.ts` has `begin/stop/stopSession` and no reason;
  `agent-bridge.ts:245-256` answers a call once; `prompts.ts` decisions are allow/deny/timed-out/
  stopped/released; `watchTabUpdates` exists in `chrome-adapters/tabs.ts`; `mcp-server.ts`
  intercepts `file_upload` at ≈ 1006 before `placeCall`; `readUploadConfig` is fail-closed;
  `AGENT_TOOL_NAMES` has 33; the agent manifest has no `webNavigation`.
- [X] T349 **Measure (R-187 §6)**: in a scratch test, feed `agentNativeResponseSchema`,
  `agentControlFrameSchema` and the `pair-result` shape an object with one extra unknown key;
  record in `research.md` R-187 §6 whether each strips or rejects. Decide: `notice` on the
  response frame (strips) or `hint` only (rejects); new frame types either way.

## Phase 2 — Foundational: contracts (blocks every story)

- [X] T350 RED: `tests/contract/agent-tools-014.contract.test.ts` — reasons `owner-interrupted`,
  `site-transition-declined`, `site-transition`, `upload-declined`, `upload-not-answered`,
  `upload-outside-allowed-directories` are in the reason vocabulary; `AGENT_PROMPT_KINDS`
  contains `transition` and `upload-directory`; `AgentEffectPrompt` accepts `transition`,
  `files`, `delivery` and rejects a `files[].path` that is not absolute; `effect-decide` accepts
  `rememberTransition` / `rememberDirectory`; panel state accepts `sessions[].inFlight`,
  `transitions[]`, `uploadRoots`; control frames `upload-consent-request` / `upload-consent-result`
  parse and an old-style frame without them still parses; link frames `upload-roots-list`,
  `upload-roots-remove`, `upload-roots` parse; `pair-result.features` optional; panel messages
  `session-interrupt`, `transition-clear`, `upload-root-clear` parse; `AGENT_LINK_PROTOCOL === 2`;
  tool count 33; the manifest snapshot has no new permission; no tool name or description
  mentions roots, config or a file path.
- [X] T351 GREEN: `packages/contracts/src/agent-tools.ts` — everything T350 pins, each addition
  optional or a new type; `notice` on the response frame only if T349 said "strips". Comment on
  `AGENT_LINK_PROTOCOL`: additive.

## Phase 3 — US1 interrupt (P1) — FR-178..184 (S1, brief 1)

**Goal**: 中斷 ends the in-flight calls within a second, keeps everything, tells the agent.

**Independent Test**: `agent-interrupt.spec.ts` green (SC-100, SC-101).

- [X] T352 RED `apps/extension/tests/stop.test.ts` (or the existing stop test file): a flag
  carries a reason; `interruptSession(s)` flags only session `s`'s live calls with
  `owner-interrupted`; `stopSession` still says `owner-stopped`; batch step ids `call#n` are
  flagged with their parent; `handle.reason()` is undefined before a flag.
- [X] T353 GREEN `agent-tools/stop.ts`: reason on the flag, `interruptSession`, `handle.reason()`;
  runners that answer the literal `owner-stopped` (`wait.ts`, `batch.ts`, `effects.ts`,
  `diagnostics.ts`, `tabs.ts`, `upload.ts`, `dialogs.ts`) answer `handle.reason()`.
- [X] T354 RED `apps/extension/tests/agent-runtime-interrupt.test.ts`: with a runner that never
  resolves, `interruptSession` makes the dispatcher answer within 100 ms (fake timers) with
  `stopped / owner-interrupted` and the "nothing refused it" hint; with an operation marker
  present for the call the hint is the "may have taken effect" sentence; a runner resolving
  after the answer is discarded and `agent.call.late-result` is logged with the call id, `end()`
  is still called; with nothing in flight `interruptSession` returns `{ interrupted: 0 }` and
  nothing is logged as late; the session record, tab leases, group marking, attachment,
  viewport record, recording state and site modes are unchanged (assert on the fakes).
- [X] T355 GREEN `agent-runtime.ts`: the dispatcher races runner vs handle; hint selection from
  the marker; late-result discard; `interruptSession(sessionId)`; activity line `interrupt`;
  projection `sessions[].inFlight` from the registry.
- [X] T356 RED `prompts.test.ts`: `cancelSession(s, "interrupted")` resolves waiting asks with
  `{decision:"interrupted"}` and withdraws the card (state has no `prompt`); no site record is
  written by the runners on that decision (assert in `effects`/`upload` tests that
  `interrupted` maps to the stopped outcome with `owner-interrupted`, not to declined).
- [X] T357 GREEN `prompts.ts` + the runners' decision mapping; `batch.ts` interrupted report
  (`completed`, `interruptedAt`, `notRun`) and `plans.clear`.
- [X] T358 Panel: `agent-panel-port.ts` `ui.agent.session-interrupt` → `runtime.interruptSession`;
  `SessionCard.tsx` 中斷 button beside 停止, enabled iff `inFlight > 0`, a transient notice when
  pressed with 0; activity line text; locale keys (`agent.session.interrupt`,
  `agent.session.nothingToInterrupt`, `agent.activity.interrupt`) in `en-US.ts` and `zh-TW.ts`;
  a11y: button name, focus order. Unit test on the card's enabled state.
- [X] T359 Gate `tests/e2e/packaged/agent-interrupt.spec.ts` (Chromium attach recipe), fixture
  reuse from `agent-batch-wait`: (1) 20 s `wait` → panel 中斷 → answer within 1 s,
  `owner-interrupted`, hint present; (2) batch of 5 with step 3 a wait → 中斷 → completed [1,2],
  interruptedAt 3, notRun [4,5], stated plan gone (a later single step on that site asks);
  (3) ask-site click waiting on the card → 中斷 → card gone, answer interrupted, no site row;
  (4) a `type` whose input was delivered (fixture that hangs after the first keystroke) →
  "may have taken effect" hint; (5) after (1) the wait's condition becomes true → no second
  answer, diagnostic `late-result` in the panel log; (6) `click` on the same tab succeeds without
  pairing; (7) group marking, viewport emulation (set before), recording frame count unchanged;
  (8) 停止 still releases. Record numbers in `coverage.md`.

**Checkpoint**: US1 complete at unit and gate level.

## Phase 4 — US2 transitions + pair rows (P1/P2) — FR-185..192 (S2, brief 2)

**Goal**: an arrival on an undecided origin is reported by the causing call and asked at the
next call on that tab; pairs remembered and revocable.

**Independent Test**: `agent-transitions.spec.ts` green (SC-102, SC-103).

- [X] T360 RED `apps/extension/tests/transitions.test.ts` (pure module): the six rules in order
  as a table (loopback; known; decided site; session-allowed; persisted-allowed touches
  lastUsed; expectedNavigate; else pending); `pending.to` replaced and `from` kept on a further
  change; a return to a known origin clears pending; per-tab scope (two tabs independent);
  release drops the tab's state; session end drops the session's allowances; the test switch
  disables rule (a) only.
- [X] T361 GREEN `agent-tools/transitions.ts` (pure rules over an injected `siteModes.get`,
  allowance lookups and the switch) + `transition-store.ts` (session storage per session+tab;
  local storage allowances; `lastUsedAt` touch; list/remove).
- [X] T362 RED `agent-runtime-transitions.test.ts`: `watchTabUpdates` events for a held tab drive
  the module; claim/create seeds `known`; `navigate` sets/clears `expectedNavigate` around its
  move (redirect to a third origin → pending); the dispatcher holds every tab-naming tool
  (reads included; `tabs_context` and session tools not held) behind `ask(kind:"transition")`;
  allow → pending cleared + session pair; `rememberTransition` → persisted; deny →
  `denied / site-transition-declined` with pending kept; a `navigate` away is admitted; timed-out
  → `not-answered`; the causing call's answer carries `notice.transition` (or hint per T349);
  `browser_batch` stops before a step whose tab has a pending transition with
  `stopped / site-transition` and the partial shape.
- [X] T363 GREEN `agent-runtime.ts` wiring (feed, seed, ask-before-tab-call, notice),
  `tabs.ts` navigate expectation, `batch.ts` stop-before-step, `prompts.ts` kind.
- [X] T364 Panel: `PromptCard.tsx` kind `transition` (both origins, 繼續 / 一律允許 / 拒絕, keyboard
  as the consent card), `effect-decide.rememberTransition`; `SiteList.tsx` section "記住的決定"
  with pair rows (from → to, last used, revoke → `ui.agent.transition-clear`);
  `agent-panel-port.ts` handler → store remove + `notify()`; projection `transitions`; locale
  keys; unit tests on the card's three answers and the row's revoke message.
- [X] T365 Descriptions (`tool-offering.ts` / contracts): `navigate` and `click` gain the
  contract sentence; contract test asserts it.
- [X] T366 **Measure (R-186 §6)**: can the gate set `chrome.storage.local` in the extension
  context before the first held-tab navigation (the fixture's extension-context hook)? If yes,
  the switch; if not, a second fixture server bound to the machine's LAN address. Record the
  result in `research.md` R-186 §6 and in the spec file header.
- [X] T367 Fixtures `tests/harness/page-fixtures.ts`: page `transition-a` with a link to
  `/go-b` that 302-redirects to fixture B (a second origin per T366: second port counts as a
  different origin under the switch); page `transition-b` plain; a `transition-batch` page
  whose step-2 link lands on B.
- [X] T368 Gate `tests/e2e/packaged/agent-transitions.spec.ts`: A `skip-checks`, B undecided;
  (1) click → answer names A→B; (2) `get_page_text` on that tab → card; 繼續 → completes; a
  second A→B in the session → no card; (3) new session, 一律允許 → kill worker → A→B → no card,
  panel row present; (4) 拒絕 → `site-transition-declined`, tab still held, `navigate` to A
  admitted; (5) switch unset + loopback → no card; B set to `follow-a-plan` → no card;
  `navigate` naming B → no card; return to A → no card (4/4); (6) A→B→C before the next call →
  one card A→C; (7) batch step 2 lands on B → stopped before 3 with `site-transition`; (8)
  revoke the row → next A→B asks. Numbers into `coverage.md`.

**Checkpoint**: US2 + the pair half of US3 complete.

## Phase 5 — Review gate 1

- [X] T369 `code-reviewer` over S1+S2 (claim: the interrupt keeps everything and never
  double-answers; the transition rules are applied in order, per tab, with origin identity;
  reads are held only by a pending transition; the causing call stays honest; storage keys and
  their lifetimes; batch interaction). Findings fixed in S2 before S3 starts; record in
  `coverage.md`.

## Phase 6 — US4 upload directory + directory rows (P2) — FR-191..195 (S3, brief 3)

**Goal**: a file outside the list is asked about on the panel; "from now on" is written by the
host; rows revocable; the agent cannot touch the list.

**Independent Test**: `agent-upload-directory.spec.ts` green (SC-104 directory half, SC-105).

- [X] T370 RED `packages/agent-host/tests/upload-config-store.test.ts`: `add` on an empty/absent
  file writes `{uploadRoots:[dir]}` through a temp file + rename (assert no partial file on a
  simulated failure); `add` merges and de-duplicates by realpath; `remove` drops one; relative
  path, missing directory, a file → refused with a reason and no write; malformed existing
  content → treated as `[]` and reported `malformed`.
- [X] T371 GREEN `packages/agent-host/src/upload-config-store.ts`.
- [X] T372 RED `upload-policy.test.ts`: `allowFiles` admits exactly the named realpaths for one
  call and nothing else in their directories; `outside-roots` is surfaced as a distinct code to
  the caller.
- [X] T373 GREEN `upload-policy.ts`.
- [X] T374 RED `mcp-server` consent flow test with a fake link (existing harness pattern):
  worker advertised `upload-consent` + `outside-roots` → `upload-consent-request` sent with the
  files and directories; `once` → files admitted, list unchanged, call sent; `always` →
  store.add called with the directories, call sent; `deny` → `upload-declined`; no result within
  the bound → `upload-not-answered`; `interrupted` → stopped / owner-interrupted; session end
  during the wait → interrupted; worker without the feature → `upload-outside-allowed-directories`;
  `too-large` / `not-a-file` / `too-many-files` → unchanged `upload-not-allowed`.
- [X] T375 GREEN `mcp-server.ts` (pending-consent map, timer, feature check, reasons); `toolReply`
  passes `hint`/`notice` through.
- [X] T376 RED relay test: `upload-roots-list` → `upload-roots {roots, path}`; `upload-roots-remove`
  → store.remove → `upload-roots`; unaddressed frames still dropped; an unknown frame type still
  dropped.
- [X] T377 GREEN `relay-mux.ts` / `native-host.ts`.
- [X] T378 RED worker `agent-bridge` + runtime: `pair-result` carries `features:["upload-consent"]`;
  `upload-consent-request` raises `ask(kind:"upload-directory", files)`; the decisions map to
  the result frame (`once`/`always`/`deny`/`timed-out`/`interrupted`); `upload-roots-list` is
  sent on `relay-ack` and after each result; `upload-roots` updates the projection;
  `ui.agent.upload-root-clear` sends `upload-roots-remove` and keeps the row until `upload-roots`
  arrives (or re-sends on the next `relay-ack`).
- [X] T379 GREEN bridge + runtime + `agent-panel-port.ts`.
- [X] T380 Panel: `PromptCard.tsx` kind `upload-directory` (paths listed in full, 這些檔案這次 /
  這些資料夾以後都可以 / 不准), `effect-decide.rememberDirectory`; `SiteList.tsx` directory rows
  (root, revoke, "pending" note); locale keys; unit tests.
- [X] T381 Contract (in `agent-tools-014.contract.test.ts`): the MCP request handlers of
  `mcp-server.ts` never import or call `upload-config-store` (static import graph assertion as
  the 005 "no download-starting call" test does); no tool description or answer contains the
  config path.
- [X] T382 Fixture: the gate's private host data directory starts from the empty template; a
  temp directory with one fixture file outside every root; an `ask`-mode upload page (reuse
  `agent-upload`'s).
- [X] T383 Gate `tests/e2e/packaged/agent-upload-directory.spec.ts`: (1) `file_upload` outside →
  card with the absolute path; 以後都可以 → upload ok, `config.json` lists the directory, panel
  row, second upload no card; (2) new run, 這次 → ok, list unchanged, second upload asks; (3)
  不准 → `upload-declined`; (4) unanswered (shortened bound via env for the gate, documented in
  the spec header) → `upload-not-answered`; (5) inside the list → no card; (6) revoke the row →
  file no longer lists it, next upload asks; (7) `ask` site → directory card then site card;
  (8) two files from two directories → one card, 以後都可以 allows both. Numbers into
  `coverage.md`.

**Checkpoint**: US3 + US4 complete.

## Phase 7 — Review gate 2

- [X] T384 `code-reviewer` over S3 (claim: the allow-list can grow only by the owner's answer on
  the panel and only over the extension link; path canonicalisation and containment; atomic
  write and the two-writer merge; feature-flag gating for old sides; the bound and its cleanup;
  no agent-reachable path to the store). Findings fixed before S4; record in `coverage.md`.

## Phase 8 — US5 tails + release (P3) — FR-196..199; SC-106..108 (S4, brief 4 + main session)

- [X] T385 [P] RED+GREEN tails: `noteUpload` for `file_upload` (message `input`) and
  `upload_image`; `upload.ts` sets `delivery` from the arguments; `PromptCard` picks
  `agent.summary.upload_image.input` / `.drop` (both locales); `RECORDED_TOOLS` + `viewport` with
  the overlay label `viewport WxH` / `viewport cleared`; unit tests on each; extend
  `agent-recording.spec.ts` (viewport frame) and `agent-upload.spec.ts` (activity line, card text).
- [X] T386 [P] Descriptions: `file_upload` contract sentence (`contracts/upload-directory.md`);
  contract assertion.
- [X] T387 [P] Version 0.6.0 (R-189): `build-config.ts`, `tool-offering.ts` `SERVER_VERSION`,
  watermark strings in the offscreen/overlay/recorder tests, offering snapshot. (main session)
- [X] T388 [P] Spec amendment (R-190): FR-195's old-host sentence; spec header status →
  implemented. (main session)
- [X] T389 [P] Documents: `README.md` (0.6.0 note; 中斷; transition question; directory question;
  upgrade note "reinstall the host to be asked"), `README.zh-TW.md`, `docs/zh-TW/operations-guide.md`
  (three paragraphs), `docs/zh-TW/qa-guide.html` (the two new cards, the two row kinds, 中斷),
  `docs/design-notes.md` §3 (consent chaining: interrupt, transition, directory; the settings
  page deliberately not built). No reference identifier.
- [X] T390 Branded Chrome: the three new gates + `quickstart.md` §5 regression on the owner's
  Chrome 153 through the attach recipe; a real redirect (A → a login provider) with the switch
  unset proves rule (a); numbers and version into `coverage.md`. (main session)
- [X] T391 **Probe (paid)**: `tests/acceptance/probe-004/scenarios/s14-transition.json` —
  "Open the account page and click 'sign in'. If the site moves you somewhere else, stop and
  check with me before reading it."; assert the click's answer carries the notice and the
  model reports the question rather than reading; register S14 in `probe-004/run.ts`; result
  and model into `coverage.md`. (main session)
- [X] T392 `coverage.md` — FR-178..199 ↔ tests/gate steps ↔ SC-100..108, both reviews' findings,
  the two measurements (T349, T366), what remains for the owner (merge, rebuild, host reinstall,
  extension reload, public snapshot 0.6.0). (main session)
- [X] T393 功能拆解 artifact refresh (Ss9GGEjLAb4CGYvYzPwob5): 012/013/014 sections; rows
  上傳圖片 → `upload_image`, 區域放大 + scale, viewport row, 中斷但可續 → ok, 跨網域轉換時確認 →
  ok (cell corrected: the agent path never had "document change revokes"), 排程/設定頁 → 刻意不做
  (decide in the moment), 上傳檔案 row mentions the directory question; tool count 33; glance
  numbers. (main session)
- [X] T394 Final verification (Completion Contract): `npm run typecheck && npm run test:unit &&
  npm run test:contract && npm run snapshot:check` green; commit; report. (main session)

## Not scheduled

- Elicitation through the MCP client as a second consent channel (discussed 2026-09-22; a
  later feature if a client supports it for the QA team's tools).
- A per-call interrupt from a call list (R-185 alternative b).

## Dependencies

T348 → T349 → T350/T351 → S1 (T352–T359) → S2 (T360–T368; T366 before T367) → T369 →
S3 (T370–T383) → T384 → S4 (T385–T389 parallel; T390 after the build; T391 after T390; T392,
T393 last; T394 final).

## Implementation strategy

Four implementer briefs, one at a time, each ending on its gate spec green on Chromium; two
reviews on the consent surfaces; the main session keeps the measurements' decisions, the
version, the branded run, the probe, the artifact and the coverage record. Stop at the second
failure of any task and return to the evidence file or a measurement.
