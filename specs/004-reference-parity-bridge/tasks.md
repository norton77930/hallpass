---

description: "Task list for Reference Parity for the Local Agent Bridge"
---

# Tasks: Reference Parity for the Local Agent Bridge

**Input**: Design documents from `/specs/004-reference-parity-bridge/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/README.md), [quickstart.md](./quickstart.md),
evidence in `docs/design-notes.md`

**Tests**: **Required.** Same rule as 003: a focused failing test precedes every behaviour change (prove
red by reverting the fix, never by assertion). **In addition**, this feature's definition of done is the
acceptance probe on the owner's Chrome 152 (spec "Acceptance standard", D-004-6): every slice ends with
its probe scenarios green and the report attached. No task is complete on a fixture alone.

**Organization**: one phase per slice in the owner's order S0–S6 (plan.md "Slice ordering"); each slice
is one user story of spec.md except S3/S4, which split US4 into its read half (S3) and its act half (S4).
Numbering continues from 003 (T001–T071): this feature starts at **T072**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different file, no dependency on an incomplete task
- **[Story]**: US1–US7 from spec.md; Setup / Foundational / Polish carry no story label
- Every task names the exact file it touches

## Path Conventions

npm workspace, 003 layout. Real paths for this feature:

- `packages/agent-host/src/` — `native-host.ts` (relay, now the listener), `relay-mux.ts` (NEW), `bridge-link.ts`, `mcp-server.ts`
- `packages/contracts/src/agent-tools.ts` — amended closed schemas
- `apps/extension/src/service-worker/` — `agent-runtime.ts`, `agent-tab-manager.ts`, `agent-tools/{input,frames,refs,computer,diagnostics}.ts`, `index-agent.ts`
- `apps/extension/src/content-runtime/` — `registry.ts` (NEW), `collector.ts`, `indicator.ts` (NEW), `cursor.ts` (NEW), agent content-script entry (NEW)
- `apps/extension/src/build-config.ts` — agent profile gains `content_scripts`
- `tests/acceptance/probe-004/` — NEW probe (`run.ts`, `scenarios/*.json`, `reports/`)
- `tests/e2e/packaged/agent-*.spec.ts`, `tests/e2e/fixtures/pages/`, `apps/extension/tests/`, `packages/agent-host/tests/`, `tests/contract/`

**Archive guard (every slice's closing task)**: `npm run build:extension:test` → `dist/test/manifest.json`
byte-identical to `tests/acceptance/narrow-manifest.pre-004.json`; `npm test` (unit + extension-ui), `npm run
test:contract`; launched 001/002 gate unchanged (SC-038).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: give every later task a home and freeze the archive baseline; no behaviour here.

- [X] T072 Copy the current `apps/extension/dist/test/manifest.json` (rebuild first with `npm run build:extension:test`) to `tests/acceptance/narrow-manifest.pre-004.json` and add a vitest guard `apps/extension/tests/narrow-manifest-guard.test.ts` that fails when the built narrow manifest differs from it (SC-038)
- [X] T073 [P] Create `tests/acceptance/probe-004/` with `run.ts` (empty CLI: parses `--slice`/`--all`, exits 2 when `HALLPASS_CDP_ENDPOINT` is unset), `scenarios/` and `reports/` (with `.gitkeep`), and add root script `probe:004` = `node --experimental-strip-types tests/acceptance/probe-004/run.ts` in `package.json`
- [X] T074 [P] Add fixture pages under `tests/e2e/fixtures/pages/`: `frames.html` (nested same-site + cross-site iframe with a button and an input in each), `hover-menu.html` (pure CSS `:hover` submenu), `combobox.html` (per-keystroke suggestion list), `shadow-host.html` (open shadow root with a button; a closed one beside it), `canvas.html` (toolbar whose active tool is readable from a data attribute)
- [X] T075 [P] Add `tests/acceptance/probe-004/README.md`: the owner's one-time setup from quickstart.md §1 (remote-debugging shortcut, `dist/agent` loaded, `.mcp.json` only in this project) and the report format

**Checkpoint**: `npx tsc -b` green; guard test green against the unchanged narrow build; fixtures served by the existing fixture server.

**Result note (2026-09-09, B1)**: baseline `tests/acceptance/narrow-manifest.pre-004.json` + guard
`apps/extension/tests/narrow-manifest-guard.test.ts` (raw-string equality, fails loudly when the build
is missing). Probe skeleton `tests/acceptance/probe-004/{run.ts,cli.test.ts}` + `probe:004` script;
`run.ts` has no sibling imports because `tsconfig.tests.json` sets `allowImportingTsExtensions: false`
(the repo's strip-types convention is a `.js`+`.d.ts` pair, not a `.ts` specifier). Fixture pages are
real `.html` files under `tests/e2e/fixtures/pages/` served by `tests/harness/page-fixtures.ts` through
a new `PAGE_FILES` list; `frames.html` uses a `__CROSS_ORIGIN__` token the server rewrites to a sibling
fixture port, so the cross-origin frame case is real (no `srcdoc` needed). Verified: `npx tsc -b`
clean, unit 824, contract 210, all seven pages 200 on 19443. Two spec fixes folded in: the report path
is `tests/acceptance/probe-004/reports/`, and the unit command is `npm test` (there is no
`test:unit` script).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the contract changes every slice builds on, defined once so slices do not fight over `agent-tools.ts`.

- [X] T076 [P] Contract test `tests/contract/agent-link-frames.contract.test.ts`: `hello {sessionId, agentId, displayName, token}`, `hello-ack {relayPid}`, `session-ended {sessionId}`, `relay-started {relayPid}` parse; a call frame without `sessionId` is rejected; the new bridge record `{port, token, relayPid, startedAt}` parses and the old `{pid}` shape does not
- [X] T077 [P] Contract test `tests/contract/agent-tools-004.contract.test.ts`: `tabs_context` rows carry `holder` (`"this"` | `{sessionId}` | `"none"`), `windowId`, `active`; `tabs_claim`/`tabs_release` args and results; `read_page` args `max_chars` (≤ 50,000) and `depth` (default 15, ≤ 32), result `frames[]`, node fields `frame, href?, type?, placeholder?, options?, hidden?`; `computer` action enum and coordinate rules; refusal reasons `held-by-session`, `not-yours`, `input-unavailable`, `bridge-lost`, `outside-viewport`
- [X] T078 Amend `packages/contracts/src/agent-tools.ts` to make T076 and T077 green: link frames and record schema, the three new tools, `read_page` bounds (`AGENT_READ_PAGE_MAX_NODES = 10_000`, `AGENT_READ_PAGE_MAX_CHARS = 50_000`, default depth 15), node fields, refusal reasons; keep every 003 tool's arg shape unchanged
- [X] T079 Extend the 003 narrow-bundle literal assertion (find it: it lives with the other narrow/profile guards under `apps/extension/tests/`, e.g. `build-config`/`profile` tests — create `apps/extension/tests/narrow-bundle-guard.test.ts` if no such assertion exists) so the narrow worker bundle contains none of the new tool names or frame types

**Checkpoint**: contracts compile; 003 suites unchanged; narrow bundle guard green.

**Result note (2026-09-09, B2)**: all 004 schema work landed in `packages/contracts/src/agent-tools.ts`
(+ `index.ts` exports). The bridge record moved to contracts as `agentBridgeRecordSchema`
(`{port, token, relayPid, startedAt}`); 003's `bridgeRecordSchema` in `agent-host/src/bridge-link.ts`
still exists with a `// 004 S1` marker because retiring it is the link inversion itself. Same for the
new `agentLinkFrameSchema` union, which sits beside the untouched 003 control frames until S1 folds
them together. `sessionId` is now **required** on `agentNativeRequestSchema` — the one breaking change;
two call sites carry `// 004 S1` markers (`mcp-server.ts` router.call, `agent-tools/batch.ts` step
dispatch) and ten 003 test frame builders gained ids. Additive result fields (`holder`, `windowId`,
node `frame`, result `frames[]`) are optional so 003 handlers behave unchanged. T079's guard was found
in `tests/contract/shipping-artifact.contract.test.ts` (not the file the task named) and extended with
**token** matching, because the narrow build legitimately ships `agent.summary.<tool>` catalogue keys.
Locales gained the three new `agent.summary.*` sentences. Verified: `npx tsc -b` clean, unit 907/85,
contract 222/20, archive guard green.

---

## Phase 3: S0 — User Story 1: Prove it on the owner's browser (Priority: P1) 🎯 first

**Goal**: the acceptance probe exists and produces the report the owner asked for; the baseline source is decided by evidence, not assumption (R-118).

**Independent Test**: with only 003 installed, `npm run probe:004 -- --slice S0` attaches to the owner's Chrome, spawns one `claude -p` session, and writes a report in which E1–E4 reproduce as failed scenarios.

- [X] T080 [P] [US1] Unit test `tests/acceptance/probe-004/report.test.ts`: the report writer turns `AcceptanceRun` into `probe-004/reports/004-<timestamp>.md` + `.json`; verdict is `done` only when every scenario passes; a `not-run` scenario names its replacement page; raw answers appear only on failure
- [X] T081 [US1] Implement `tests/acceptance/probe-004/report.ts` (make T080 green)
- [X] T082 [P] [US1] Unit test `tests/acceptance/probe-004/agent-runner.test.ts`: builds the `claude -p --model sonnet --effort low --output-format json --json-schema <file> --mcp-config <file> --strict-mcp-config --allowedTools "mcp__hallpass__*,mcp__claude-in-chrome__*" --max-turns N` argument list from a scenario file; parses the structured answer; times out and reports `agent-timeout`; runs K scenarios concurrently with distinct working directories (so each spawns its own mcp-server, reproducing E1)
- [X] T083 [US1] Implement `tests/acceptance/probe-004/agent-runner.ts` (make T082 green); the probe's `mcp.json` points at `packages/agent-host/dist/mcp-server.js`
- [X] T084 [US1] Implement `tests/acceptance/probe-004/environment.ts`: reads `HALLPASS_CDP_ENDPOINT` `/json/version` (browser version), confirms the agent extension id and the reference extension id are present via `/json/list` after waking them, confirms the bridge install (host manifest + registry key) and the `claude` CLI version; writes the environment table
- [X] T085 [US1] **Baseline-source spike**: scenario `scenarios/s0-baseline-source.json` asks the agent to call the reference's `tabs_context` and `read_page` on `about:blank`; record in the report whether the reference's tools are reachable from `claude -p`. If not, implement the fallback in `tests/acceptance/probe-004/baseline.ts`: the browser's accessibility tree over the gate's debugging session (`Accessibility.getFullAXTree`) for tree scenarios, and record `baselineSource: browser-tree`
- [X] T086 [US1] Scenario files for the E1–E4 reproduction: `scenarios/s0-first-call.json` (tabs_context; expects success), `s0-pairing-timing.json`, `s0-owner-tab.json`, `s0-artifact-frame.json` (claude.ai artifact page; expects frame nodes) — written to **fail on 003** and to be reused as the S1–S3 acceptance scenarios
- [X] T087 [US1] Wire `run.ts`: environment → scenarios for the slice → concurrent runner where the scenario says so → report; exit 1 on `not-done`
- [X] T088 [US1] Run `npm run probe:004 -- --slice S0` against the owner's Chrome 152 with the 003 build; attach `probe-004/reports/004-<timestamp>.md` showing the environment table, the baseline-source decision, and E1–E4 as failed scenarios; run the archive guard (T072 test, unit, contract, launched 001/002 gate)

**Result note (2026-09-09, B3, T080–T084)**: `report.ts`, `agent-runner.ts`, `environment.ts` under
`tests/acceptance/probe-004/`, all unit-tested with an injected fake spawner — no test may start a paid
agent session. The strip-types sibling-import constraint is solved by a run-time dynamic `import(new
URL(file, import.meta.url).href)` in `run.ts`, so TypeScript never resolves a non-literal specifier and
`tsconfig.tests.json` is untouched. R-118's flag set was corrected against CLI 2.1.266 (see research.md):
`--json-schema` takes JSON **text**, `--max-turns` exists but is hidden, `--allowedTools` takes
wildcards, prompt on stdin. Live `--slice S0` against the owner's Chrome 152 reports zero environment
problems (browser 152.0.7977.77, both extension ids present, host manifest + 2/2 registry keys +
`dist/mcp-server.js`, CLI 2.1.266). unit 930/88, contract 222/20.

**Result note (2026-09-09, B4, T085–T088)**: baseline source resolved by running it — a non-interactive
agent session sees **no** reference tools (27 local-bridge tools, zero reference), so the automated tier
is the browser's own accessibility tree (`probe-004/baseline.ts`) and the reference tier is recorded once
per capability from an interactive session; the spec's acceptance standard point 4 was amended to match.
CDP pairing works (`probe-004/pairing.ts`, drives the durable pairing record through the agent worker's
own debugging socket, 20 s delay honoured) — a *pending* prompt still cannot be resolved from a debugging
client because the decision route requires a trusted side-panel sender, which is correct and stays.
First report `probe-004/reports/004-2026-09-09T05-49-56Z.md`: verdict **not-done, 0/5**, exit 1. E1 is
reproduced exactly (three concurrent sessions, all `bridge-unavailable`); **E2–E4 failed with E1's
symptom**, so only E1 is independently evidenced until S1 lands — recorded as a finding, not as four
clean reproductions. Two probe bugs found and fixed with tests first (Windows `shell: true` mangled both
the path containing a space and the inline JSON schema; the shell is gone). Eleven sessions spent, six
billable, well under $2. unit 945/89; contract 222/20 and the narrow-manifest guard were run by the main
session afterwards, both green.

**Checkpoint**: the probe is the definition of done for every later slice; its first report is the "before" picture.

---

## Phase 4: S1 — User Story 2: Several agent sessions share one browser (Priority: P1)

**Goal**: invert the link (relay listens, servers dial), multiplex sessions, recover the link in ≤ 10 s, release ended sessions in ≤ 15 s (R-111).

**Independent Test**: two `claude -p` sessions run `tabs_context` concurrently, both succeed; killing the relay or a server recovers as FR-057/FR-058 state.

- [X] T088a [US2] `packages/agent-host/src/mcp-server.ts` registers every entry of `AGENT_TOOL_DESCRIPTORS` in a loop, so B2's contract work already advertises `tabs_claim`, `tabs_release` and `computer` to agents with no worker handler behind them. Add one explicit list of implemented tool names and register only those; the three land on it in T105 (claim/release) and T139 (computer). A unit test asserts an unimplemented descriptor is not registered
- [X] T089 [P] [US2] Unit test `packages/agent-host/tests/relay-mux.test.ts`: registers a connection on `hello` (rejects a bad token by closing it), routes worker answers by `callId` and control frames by `sessionId` to the right connection, emits `session-ended {sessionId}` when a connection closes, forwards server frames to the worker unchanged, handles two sessions with interleaved calls
- [X] T090 [US2] Implement `packages/agent-host/src/relay-mux.ts` (pure, make T089 green)
- [X] T091 [P] [US2] Unit test `packages/agent-host/tests/bridge-link.test.ts` (amend): the relay writes `{port, token, relayPid, startedAt}`; the server-side `dialRelay` retries every 5 s while no record or no answer, presents the token, resolves on `hello-ack`, and re-dials after a socket close; a record whose `relayPid` is dead is treated as absent
- [X] T092 [US2] Amend `packages/agent-host/src/bridge-link.ts`: relay-side `listenAndPublish()`; server-side `dialRelay()` with the 5 s loop (make T091 green)
**Result note (2026-09-09, B5, T088a + T089–T092)**: `IMPLEMENTED_AGENT_TOOL_NAMES` in `mcp-server.ts`
now gates registration, so the descriptor table alone no longer advertises a tool (the three unimplemented
ones stay in the table and are pinned by a test). `relay-mux.ts` is pure — connections are `{send}`
handles, routing is `callId → sessionId → connection`, which makes reconnect-remapping and "a closed
session's pending calls stop routing" fall out rather than being special-cased; a frame for an unknown id
is dropped, never broadcast (the isolation property). `bridge-link.ts` gained `listenAndPublish` (relay
side, mints a per-start token, retracts only its own record) and `dialRelay` (server side, 5 s retry,
injected clock/connector, real `loopbackConnector` default); 003's `pid`-shaped schema is deleted and
`readBridgeRecord` parses the contracts schema. Red was re-proved **behaviourally** by breaking the fix,
and two dial-loop assertions were strengthened when a revert failed to trip them. unit 966/90.

- [X] T093 [US2] Rewrite `packages/agent-host/src/native-host.ts`: on start, listen on loopback, write the record, send `relay-started {relayPid}` to the worker, run the mux; on the native port closing, close every server socket and remove its own record; no `bridge-unavailable` exit path remains
- [X] T094 [US2] Amend `packages/agent-host/src/mcp-server.ts`: replace the listener with `dialRelay()`; keep `sessionId` per process; on link loss answer in-flight calls `bridge-lost` and keep the router; re-`hello` on reconnect; pairing per `agentId` unchanged
**Result note (2026-09-09, B6, T093–T094)**: the link is flipped. The relay builds the mux *before*
opening the port (a server dialling in the same tick must have somewhere to go), publishes the record,
announces `relay-started`, and on Chrome's stdin closing drops every server socket, retracts the record
and exits 0; its `bridge-unavailable` exit path is gone. The server dials from `oninitialized` — not
earlier — because the greeting carries the MCP client's name, and dialling before that would ask the
owner to pair with "Unknown agent". **Reason mapping**: `bridge-unavailable` now means *only* "no record
at all" (no relay ever published: Chrome not running, host not installed); every "record exists but this
session is not on the link" case answers `bridge-lost`. Two real `mcp-server` processes were shown
attaching to one relay, with out-of-order answers landing on the right session and exactly one
`session-ended` per close (`relay-process.test.ts`, proven red first). 003's "refuses a second relay
while one is attached (D-M3-4)" test was **retired on purpose** — R-111 abolishes that invariant — with
a pointer to its replacement. unit 970/91.

- [X] T094a [US2] The worker's `pair-result {agentId, accepted}` carries neither `callId` nor `sessionId`, so the relay multiplexer drops it as unaddressed and pairing cannot complete over the real link. Add `sessionId` to the `pair-result` control frame in `packages/contracts/src/agent-tools.ts` (it is a `strictObject`, so this is a contract change), echo the requesting session's id from `apps/extension/src/service-worker/agent-bridge.ts`, and cover it in `tests/contract/agent-link-frames.contract.test.ts` plus a worker unit test
- [X] T095 [P] [US2] Unit test `apps/extension/tests/agent-runtime-sessions.test.ts`: several sessions live at once, each with its own group; `session-ended` releases that session (leases, marking, debugger) and no other; `relay-started` begins a 15 s reconciliation that releases sessions whose `hello` does not return; a `stop` without `sessionId` still stops everything (003 reading)
- [X] T096 [US2] Amend `apps/extension/src/service-worker/agent-runtime.ts` and `agent-tab-manager.ts` (`endSession` per session, `lastHelloAt`) (make T095 green); reconnect retry alarm cadence stays for the *native port* only
**Result note (2026-09-09, B7, T094a–T096)**: `pair-result` gained a required `sessionId` and the worker
echoes it on **both** arms (accept and the decline `.catch`, the easier one to miss); `notifyUnpaired`
now takes a session id and `unpair` fans out to **every** live session of that agent — 003's version told
at most one. The audit found the worker originates only two frame shapes and tool responses already carry
`callId`, so `pair-result` was the whole defect; but `agent-bridge.ts` was also *rejecting*
`session-ended`/`relay-started` outright, so they never reached the runtime — link-frame parsing added.
Sessions are a registry in the worker; `session-ended` releases exactly one; `relay-started` arms a
`chrome.alarms` reconciliation whose window lives in `chrome.storage.session` (`agentReconcileFrom` +
per-session `lastHelloAt`), so a worker evicted mid-window still releases the stale sessions on wake —
the release never depends on the worker remembering anything. unit 976/92, contract 223/20.

**Two gaps B7 reported rather than silently narrowing** (both folded into S2 below): the tool runners
still take session-scoped deps, so two calls that interleave across an `await` can read the other
session's id (sequential calls are correct); and pending `ask` prompts are keyed by `callId`, not by
session, so releasing a session cancels none of its prompts. A third: the reconnect test passed against
the old code, so the claim it must really catch — a reconnect for session A while B is live rebuilding
the tool context and invalidating A's refs — is not yet proven; T098's journey is where it belongs.

- [X] T097 [US2] Update `packages/agent-host/src/install/` host manifest description and `specs/003-local-agent-mcp-bridge/quickstart.md` note: the relay now publishes the record (one-line pointer to 004)
**Result note (2026-09-09, B8 — S1 NOT closed)**: the journey is written but never reached its
assertions, and it exposed two blockers plus one planning contradiction of mine.

1. **The shared `acceptPairingIfAsked` helper is not a reliable pairing signal, and it is copied into
   every 003 `agent-*.spec.ts`.** It returns early when the panel text contains the agent's display
   name — which the *pairing prompt itself* renders — so it can skip the Accept click entirely; and
   `agent.pairedTitle` ("已配對的代理程式" / "Paired agents") is a permanent section heading that is on
   screen even above the text "no agents paired". Neither is evidence of pairing. This is pre-existing,
   not introduced by 004, and it means 003's agent journeys were weaker evidence than they looked.
   → **T098a**.
2. **FR-057's 10 s recovery is not met, and my own T096 text told B7 not to fix it.** When the relay
   dies, the worker's only reaction is `scheduleRetry()`, i.e. the `AGENT_RETRY_ALARM` with a
   one-minute floor (`agent-runtime.ts:57`), so nothing re-opens the native port inside 10 s. The
   evidence document's G2 says the reference reconnects in **5 s and uses alarms only as a backstop
   while the worker sleeps**; the server-side 5 s dial loop (B5) is only half of that. → **T096a**.
3. The gate must run `HALLPASS_LOCALE=zh-TW` against the owner's browser (its UI language is zh-TW; the
   fixture requires the locale to match the browser's language).
4. `packages/agent-host/src/host-paths.ts:8` still documents the pre-R-111 direction.

- [X] T096a [US2] Worker-side fast reconnect of the native port, matching the reference's cadence (G2): on `onDisconnect`, re-open after ~5 s with a bounded backoff, keeping `AGENT_RETRY_ALARM` only as the backstop for a suspended worker (`apps/extension/src/service-worker/agent-bridge.ts:234-240`, `agent-runtime.ts:57`). Red test first: a disconnect leads to a re-open attempt inside the FR-057 bound without any alarm firing. Also fix the stale direction comment in `packages/agent-host/src/host-paths.ts:8`
- [X] T098a [US2] Make pairing observable in the packaged journeys: replace the copied `acceptPairingIfAsked` with one shared helper that (a) waits for the *pending prompt* by its own locale key rather than the display name, (b) clicks Accept, and (c) confirms pairing by a signal that is false when nothing is paired — not the permanent section heading. Update every `tests/e2e/packaged/agent-*.spec.ts` that copies it. This closes a 003 evidence hole as well as unblocking T098
**Diagnosis (2026-09-09, main session) — why the journey still could not pair.** B9's new helper made a
real defect visible: `relay.log` shows `relay.mux.dropped unaddressed` twice and the server never logs
`agent.pair.answered`. Cause is **not** the relay or the frame shape (the mux routes control frames by
`sessionId`; the server does put `sessionId` in `pair-request`; the worker does echo it on both arms).
It is `apps/extension/src/service-worker/pairing-controller.ts:134-135`: `waiting` is a **single slot**
(`{agentId, resolve}`), and `reducePairing`'s `pending` is a single agentId-keyed record. With several
sessions of one agent — the normal case after S1 and exactly what D-004-2 requires — the second
`decidePairing` overwrites the first session's resolver, so the first server waits out its whole pairing
bound and answers `not-paired`. The already-paired fast path (`decidePairing` returning `true` when there
is no pending) is correct and unaffected. → **T096b**.

- [X] T096b [US2] Make pairing answer **every** waiting session of an agent: `waiting` in `apps/extension/src/service-worker/pairing-controller.ts` becomes a list; a `connection` event for an agent that already has a pending prompt joins that prompt instead of replacing it; one `decide` resolves every waiter for that agentId; `abandonPending` refuses them all. Red test first: two concurrent `decidePairing` calls for one agent, one owner decision, both promises resolve. Also make the relay's `relay.mux.dropped unaddressed` log name the frame's `type` (a stable protocol code, nothing page-derived) so this class of defect reports itself, and remove the now-unused single-session leftovers `connectedAgentId`/`contextSessionId` in `agent-runtime.ts` that make `npm run typecheck` fail
**Result note (2026-09-09, B10 + main session)**: T096b done — `waiting` is a list, a second session of
an agent with a pending prompt joins it (one prompt for the owner, not one per session), one decision
resolves every waiter, abandon refuses them all; red was three timeouts and a replaced prompt. The relay
now logs the dropped frame's `type`, which immediately paid for itself: it named `pair-result`, and
reading the *running* worker source over CDP showed the browser was still serving a **pre-T094a build** —
the packaged fixture's reset closes the worker target but an unpacked extension keeps serving the
resources it was loaded with. The main session then established the reload recipe: CDP
`Extensions.loadUnpacked {path}` on the **browser** socket with the same path reloads in place; verified
the running bundle now carries the current code. → **T098b** makes the gate assert this instead of
discovering it twice. One follow-up defect found and left for T104: `decidePairing`'s `if
(!state.pending) return true` makes an already-paired agent wait on *another* agent's open prompt; the
check wants `state.pending?.agentId !== request.agentId`.

- [X] T098b [US2] Make a stale build impossible to miss: the packaged fixture (`tests/e2e/fixtures/packaged-extension.ts`) reloads the unpacked build over CDP `Extensions.loadUnpacked` before the run, and asserts the running worker's source carries a build marker matching `apps/extension/dist/agent` — a mismatch fails immediately with a message naming the fix, instead of surfacing as an unrelated red case
**Result note (2026-09-09, B11)**: T098b landed as a **byte comparison**, not a marker: the fixture
reloads `dist/agent` over CDP `Extensions.loadUnpacked` and compares every running extension-origin
script against its file on disk, so no build-output change was needed and the narrow archive guard is
untouched. Proven both ways against a deliberately doctored bundle — and the earlier literal-marker
check was shown to be insufficient (it reported "current" for a stale-but-similar bundle). Journey case
1 now gets **alpha PASS** (pairing is no longer the blocker, `bridge-unavailable` is gone) but **beta
FAIL with `bridge-lost`**: the journey issues both first calls together, so beta's first call races its
own dial, and `callTool` answers `bridge-lost` immediately when it is not yet attached. Alpha only
survives because the pairing prompt gave it a head start. The relay log shows both sessions attaching
~4 s apart and **no dropped frames**, so this is not routing.

**Decision (main session):** FR-055 says a session's first call *succeeds* whether or not other sessions
are live, so failing instantly while the link is still coming up is the wrong contract — and it is the
same confusing first-call failure the owner hit on 2026-09-09. A call that arrives before the dial has
attached **waits** for it, bounded; only "no record at all" still fails immediately. → **T094b**.

- [X] T094b [US2] In `packages/agent-host/src/mcp-server.ts` `callTool`: when not attached, first check for a bridge record — **no record → `bridge-unavailable` immediately** (nothing to wait for). If a record exists, **await the link attaching**, bounded by the FR-057 recovery bound (10 s), then run the call; only on timeout answer `bridge-lost`. In-flight calls when an established link drops keep answering `bridge-lost` as now. Red test first: a call issued before `dialRelay` attaches succeeds once the attach lands, and a call with no record still fails fast without waiting
- [X] T098 [US2] Packaged attach-mode journey `tests/e2e/packaged/agent-sessions.spec.ts`: two headless MCP clients (003 harness) through two mcp-server processes and one relay: both `tabs_context` succeed with distinct groups; the second's read of the first's tab is refused; killing the relay process → both recover within 10 s; killing one server → its group marking gone within 15 s, the other untouched. **Also cover the reconnect claim B7 could not prove in a unit test**: while session B is live, session A's server reconnects with the same id and A's element references from before the drop still resolve (no tool-context rebuild, no fresh nonce)
**Result note (2026-09-09, B12) — S1's journey is green.** T094b landed as a bounded wait
(`ATTACH_TIMEOUT_MS = 10_000`, env `HALLPASS_AGENT_ATTACH_TIMEOUT_MS`): no record → `bridge-unavailable` at
once; a record but not attached → wait for the attach, then run the call; only the bound answers
`bridge-lost`. Mid-call drops are unchanged. **All five journey cases pass on the owner's Chrome 152**
(zh-TW, 19.5 s), including the three that had never run: relay killed → both sessions recovered inside
FR-057's 10 s with groups and markings intact; one server killed → its marking gone inside 15 s, its tab
left open, the other session untouched; and alpha's pre-drop element reference still resolved after its
reconnect while beta was live. The S1 probe's flagship scenario **`s1-three-sessions` passes**: three
concurrent `claude -p` sessions, all three first calls `ok`, **zero `bridge-unavailable`**, every
cross-session read refused — the owner's E1, closed with the real tool chain (SC-029). unit 989/92.

**Two decisions the harness needed (main session):**
- `s1-relay-killed` failed, but *before* the kill: both sessions' `tabs_create` answered `bridge-closed`
  at session start. That reason is 003's "the link dropped while the owner's pairing answer was
  pending" path (`mcp-server.ts:236,501`) and it survives S1 unchanged — yet FR-057 says the link comes
  back without the owner's intervention, so a pairing whose link dropped should be **re-requested on
  the next attach** rather than turning the call into a failure. → **T099a**.
- `s1-server-killed` cannot be expressed today: the runner requires every session of a scenario to
  pass, so a deliberately killed session always fails it. The scenario format needs a per-session role.
  → **T099b**. (The claim itself is already proven live by journey case 4.)

- [X] T099a [US2] Fold `bridge-closed` into the recovery contract: when the link drops while a pairing answer is pending, the next attach must re-request pairing and the waiting call must continue rather than answering `failed/bridge-closed` (`packages/agent-host/src/mcp-server.ts:236,501`). Keep a real failure for the case where the bound passes with no attach. Red test first: a call whose pairing is interrupted by a link drop succeeds once the relay is back and the owner's answer arrives
- [X] T099b [US2] Give a probe scenario a per-session role so a deliberately killed session is judged as expected rather than as a failure: add `judge: "pass" | "expected-killed"` per session in the scenario schema (`tests/acceptance/probe-004/scenarios.ts`), have the runner require only the surviving sessions to pass, and have `s1-server-killed.json` assert the survivor is unaffected. Then write and run it
**Result note (2026-09-09, B13)**: T099a done — a link drop with a pairing pending no longer settles
the exchange; the next attach re-requests and the waiting call continues, so `bridge-closed` is gone
from the tool surface while `denied` stays distinct from a link problem, and a link that never returns
still fails as `timed-out/not-paired`. T099b done — scenarios carry a per-session `judge`, so
`s1-server-killed` can kill one session and judge only the survivor. S1 probe: **`s1-relay-killed`
pass** (both sessions recovered; no `bridge-closed` anywhere) and **`s1-server-killed` pass** (survivor
kept working and listed only its own tab), but **`s1-three-sessions` regressed to fail** — every call in
sessions 2 and 3 answered `timed-out/not-paired`. unit 994/92.

**Diagnosis (main session): two relay processes were alive at once.** `bridge.json` named only the
newer, so new servers dialled that one and got their `hello-ack` from it (the relay acks, not the
worker), passed the attach gate, and then waited out the pairing bound in silence because the *worker's*
native port belonged to the **other** relay. That is R-111's one-writer invariant breaking on relay
respawn after a kill, and it is why the scenario that runs last measured a split bridge. A related leak
sits in `apps/extension/src/service-worker/agent-bridge.ts:262-269`: the `bridge-unavailable` branch
drops its port reference **without disconnecting it**, so Chrome keeps that relay alive — and the branch
is now dead anyway, since B6 removed the relay's `bridge-unavailable` path. → **T099c**.

- [X] T099c [US2] Enforce "exactly one relay owns the record" so a split bridge cannot happen: a relay whose published record no longer names its own pid is orphaned by definition (servers only dial the record) and MUST exit 0, letting the worker's reconnect re-establish a single link — watch the record file from `packages/agent-host/src/native-host.ts`. Also fix the port leak in `apps/extension/src/service-worker/agent-bridge.ts:262-269`: disconnect the port before dropping the reference, and remove the `bridge-unavailable` branch that B6 made unreachable. Red test first: a second relay started against an existing record exits without disturbing the first
- [X] T099 [US2] Probe scenarios `scenarios/s1-three-sessions.json` (3 concurrent `claude -p`, 0 `bridge-unavailable`, cross-access refused ×10 → SC-029), `s1-relay-killed.json`, `s1-server-killed.json` (SC-030); run `npm run probe:004 -- --slice S1` on the owner's Chrome 152; attach the report; archive guard

**Result note (2026-09-09, B14) — S1 CLOSED.** T099c enforces one owner of the record: a relay polls it
every second and, on finding a parsed record naming a different pid, logs `relay.superseded`, closes its
listener and exits 0. A missing or unparseable record is explicitly not a supersession. The implementer
deviated from my red-test wording on purpose and was right to: the *superseded* relay exits (the record
owner survives), because first-wins would make every ordinary worker restart race a dying relay's stale
record and could leave the worker with no relay at all. The dead `bridge-unavailable` branch in
`agent-bridge.ts` is deleted, closing the port leak with it.

**S1 probe: verdict `done`** (`probe-004/reports/004-2026-09-09T09-32-53Z.md`) — `s1-three-sessions`
ok/ok/ok, `s1-relay-killed` recovered/recovered, `s1-server-killed` survivor clean. SC-029 and SC-030
are met with the real tool chain.

**S0 re-run (`004-2026-09-09T09-29-42Z.md`) — E1 no longer masks anything**, which is what S1 owed:
no `bridge-unavailable` anywhere and no blanket `not-paired`; each item now carries its own symptom.
E1 passes (ok/ok/ok). **E2 also passes** — `paired-same-call`; it no longer reproduces on the owner's
machine, because S1's pairing-at-initialize, the many-waiter fix and the bounded attach wait together
removed the race. S2's pairing tasks are still owed by spec, but the symptom is gone. E3 observes
`owner-tab-missing` and E4 observes `host-chrome-only` — their own symptoms, fixed by S2 and S3.

**Carried into S2**: the packaged journey was not re-run after T099c (the S1 probe exercised the same
bundle live, but that is not the same evidence); T099d (move the reload + byte comparison into the
probe's environment check, reusing the fixture's) is unstarted; and the kill scenarios showed one
intermittent `lost-tab` across runs that is worth watching rather than closing.

### S1 review findings (code + architecture, 2026-09-09) — fix before S2 builds on them

Both reviewers independently reported the same High. Severity notes below are the reviewers'; the
scheduling is mine. Items already scheduled elsewhere are not repeated, but two of them were upgraded.

- [X] T099e [US2] **(High, both reviewers)** The relay resolves the greeting socket's session only to key `calls`, then forwards the frame unchanged, and the worker keys everything on the frame's own `sessionId` — so one greeted connection can name another live session and read its tabs, end it, re-label its agent, or steal its answers by re-greeting with its id. Not reachable today only because every server stamps its own id; **S2 makes it reachable** by disclosing other sessions' ids in `holder` / `held-by-session`. In `packages/agent-host/src/relay-mux.ts` `fromServer`: refuse (log a stable code) a frame whose `sessionId` is absent or differs from `connectionSessionId(connection)`; a repeat `hello` for a held id closes the previous connection rather than leaving it attached; stop writing session ids to `relay.log`. Correct the file header comment, which states isolation as a security property it does not yet provide. Red test first: a greeted connection naming a foreign session is refused
- [X] T099f [US2] **(Medium)** The record lease detects supersession but cannot repair: `removeBridgeRecord` is read-then-delete and `writeBridgeRecord` truncates in place, so a dying relay can delete the live relay's record; the poll then treats "missing" as not-supersession and never republishes, leaving a live relay with no record and every call answering `bridge-unavailable` — the owner's E1 symptom returning through the mechanism built to remove it. Make the poll republish its own record when it reads none, and write via temp file + rename
- [X] T099g [US2] **(Medium)** Frames from a stale native port are honoured — `agent-bridge.ts` adds `onFrame` per port with no `port !== opened` guard, though the disconnect listener has one — and a superseded relay's `close()` fans out `session-ended` for every socket on its way out, releasing sessions whose servers are about to re-greet the winner. Guard `onFrame` on the current port and skip the fan-out on a supersession exit. The existing superseded-relay test never inspects what the loser wrote to Chrome
- [X] T099h [US2] **(Medium)** `attempts` is reset when `connectNative` *returns*, not when the host answers. Chrome returns a Port even for a host it cannot spawn and fails asynchronously, so every failed spawn reports `connected`, clears the retry alarm, mints a placeholder session, then disconnects and resets the backoff — the 60 s ceiling never engages and Chrome respawns the launcher every 5 s for the life of the browser. Reset `attempts` on the first `relay-started` frame instead
- [X] T099i [US2] **(Medium)** Session liveness rides on `pair-request` rather than on `hello`: the relay consumes `hello` and never forwards it, so the worker's session registry, `lastHelloAt` and `announce` all happen inside `decidePairing`. S2 revisits pairing, and any change to *when* a pair-request is sent would silently break FR-058. Forward `hello` (without the token) to the worker as the announcement, register and announce on it, and let `pair-request` mean pairing again
- [X] T099j [US2] **(Medium)** The cross-process contracts are strict and versionless while the relay is spawned by Chrome and outlives an upgrade, so a host upgrade with an old relay still running fails as an endless dial loop with no log naming the cause. Add a `protocol` field to the link greeting and the bridge record; the server logs a distinct mismatch code and the relay exits when the stamp changes
- [X] T099k [US2] **(Medium)** After a relay kill the bounds compose with no margin: the server waits 5 s, still reads the dead pid, waits 5 s again, so the attach lands at ≈10 s — FR-057's bound, not inside it — and a call issued in the first second can time out just before it. Re-check the record when a call arrives unattached, or use a short first retry after a detach. Also verify live (60 s idle) whether worker eviction makes a call answer `bridge-unavailable` immediately: the relay retracts the record on stdin end, and only the one-minute alarm can re-open the port. If reachable, leave the record on stdin end — a dead-pid record is already treated as absent, so the call would wait and answer `bridge-lost`, the honest reason
- [X] T099l [US2] **(Low)** Sweep orphaned agent tab groups at worker start: `clearAgentGroupMarking` is reachable only through `endSession`, so a browser restart with tab restore, or an extension reload, leaves titled groups nobody owns

**Result note (2026-09-09, B15 — T099e/g/h)**: the mux now refuses a frame whose `sessionId` is not the
greeting connection's (closing that socket, since every legitimate server stamps its own id on every
frame) and closes the displaced connection on a repeat `hello`; session ids are out of `relay.log`;
the header comment states the trust context instead of claiming isolation as a security property. The
stale-port guard and the superseded relay's silent exit both landed with red tests. **T099h was worse
than reported**: because `connected` was set when `connectNative` returned, every failed spawn — i.e.
every 5 s — also disarmed the retry alarm (leaving nothing to wake an evicted worker), overwrote the
worker's current-session pointer with a placeholder while a real session was live, ran the disconnect
arm that **cancels the owner's open pairing prompt or effect question**, and reported `connected` in the
panel with no host behind the port. All four are fixed by treating the relay's first frame as the only
evidence of a link. unit 1000/92, contract 223/20, packaged journey still green (13.1 s).

**Result note (2026-09-09, B16 — T099f/i/j)**: the record is written temp-then-rename (with a bounded
retry for Windows' rename-over-open-destination, a real hazard when every server polls that path), and
the supersession poll republishes its own record when it reads **absent** — same `startedAt`, so the
worker is not told a restart happened. `unparseable` is deliberately distinct and inert: a file this
process cannot attribute is either someone's torn write or another build's shape, and republishing over
it would take the link from a possibly-live relay, which is the failure the task exists to remove.
`removeBridgeRecord` stays read-then-delete by design; the fix makes the invariant convergent (the live
relay puts its record back within a second) rather than impossible. Session announcement moved to
`hello`, forwarded to the worker with the token stripped, so pairing cadence no longer carries liveness
and S2 can change pairing freely. Protocol stamped `AGENT_LINK_PROTOCOL = 1` on both the record and the
greeting, refused with a distinct code on each side and logged once rather than every 5 s; a record with
no stamp reads as a mismatch, not as an address. unit 1007/92, packaged journey green (12.5 s).

**Carried into S2** (small, and they touch files S2 rewrites anyway): T099k (bounds margin after a relay
kill, plus the 60 s idle measurement) and T099l (sweep orphaned agent groups at worker start).

**Upgraded severity on two already-scheduled items** (do not re-file): T103a's interleave is a *grant*, not only a mis-read — A's request naming B's tab passes the ownership check whenever B's call flips the shared `sessionId` between dispatch and the lazy check, and it is a plausible source of the intermittent `lost-tab` seen in the kill scenarios. T104's `decidePairing` follow-up is worse than "waits": a `connection` for a second *unpaired* agent replaces the pending prompt, so the first agent's sessions time out at 45 s and its prompt vanishes from the panel.

**Spec-level, main session's to do**: the 15 s reconciliation bound is only valid for an unpacked extension — Chrome clamps alarms below 30 s for packed ones — so FR-058's number must either state the packed bound or the mechanism must change. The stale comment claiming one minute is Chrome's floor goes with it.

**Checkpoint**: the owner's E1 cannot recur; the feature is usable from more than one session.

---

## Phase 5: S2 — User Story 3: Pair without racing the clock; work on the owner's tab (Priority: P1)

**Goal**: pairing at initialize with progress and a ≥ 30 s bound (R-112); tab leases, `tabs_claim`/`tabs_release`, holders in `tabs_context`, the in-page indicator with its trusted control (R-117).

**Independent Test**: unpair; reconnect; accept after 20 s; the same call succeeds. Open a page by hand; the agent lists, claims and reads it; the indicator's control brings the main tab forward.

- [X] T100 [P] [US3] Unit test `packages/agent-host/tests/pairing-timing.test.ts`: pairing is requested on MCP `initialize`; a tool call arriving while pairing is pending waits up to `PAIRING_TIMEOUT_MS` (default 45 000, floor 30 000) and sends a progress notification every 5 s; an accept at 20 s makes that call succeed; no answer → `timed-out/not-paired: no answer` and the request is withdrawn
- [X] T101 [US3] Amend `packages/agent-host/src/mcp-server.ts` (make T100 green)
**Result note (2026-09-09, B17 — T099k/l, T100/T101)**: the dial loop now retries at 500 ms after a link
*this server had* drops, doubling back to the 5 s cadence, so an attach after a relay kill lands at
~0.5–3.5 s instead of ~10 s — inside FR-057 with margin, and one mechanism rather than a second
record re-check in `callTool`. Orphaned agent groups are swept at worker start, fail-soft. **The
eviction question was measured, not guessed**: with a real server against the owner's Chrome, the relay
died and was respawned twice inside a 60 s idle (so the worker *was* evicted), but each respawn
published a new record and the dial loop re-attached on its own; the call after the idle answered `ok`
in 6 ms and `bridge-unavailable` never appeared. Not reachable — `removeBridgeRecord` left as it was
rather than changed on a speculative sub-second window. For pairing, S1 had already delivered most of
R-112 (the request is raised at MCP `initialize`, the 45 s bound and override exist, a call waits for
its own attach and for a pending exchange, and a mid-decision drop keeps the exchange open); what was
genuinely missing and is now added: **progress notifications** every 5 s when the client supplies a
progress token, FR-059's `not-paired: no answer` wording, withdrawal of a timed-out exchange so the next
call raises it again (with a late answer still winning), and the 30 s floor asserted against the shipped
bound. unit 1016/93, packaged journey green.

**New finding for the lease work (T102–T104)**: the idle trace shows the relay torn down and respawned
roughly every 25–30 s while a session sits idle, each respawn re-running the pairing request and opening
a fresh reconciliation window. Harmless today because the paired answer returns instantly and each
`hello` re-announces the session — but leases must not be released by that churn, so cover an idle
session across at least two respawns when the lease store lands.

- [X] T102 [P] [US3] Unit test `apps/extension/tests/tab-leases.test.ts`: at most one lease per tab; `claim` on an unheld tab succeeds and groups it (`kind: owner`), on a held tab answers `held-by-session {sessionId}`, on a restricted page `restricted-page`; `release` ungroups; tab close and session end release; `ownership()` now answers `this | held-by-session | not-yours | gone`; two simultaneous claims → exactly one wins
- [X] T103 [US3] Implement the lease store in `apps/extension/src/service-worker/agent-tab-manager.ts` (`agentTabLeases` in `chrome.storage.session`, `mainTabId` per session updated on create/claim/effect) (make T102 green)
**Result note (2026-09-09, B18 — T102/T103)**: the lease store is in. `TabOwnership` is now a four-fact
answer (`this` / `held-by-session {sessionId}` / `not-yours` / `gone`) read from `agentTabLeases` in
`chrome.storage.session`, not from the tab group — the group stays as the *visible* marking and
`contextFor` reconciles it. The wire words are deliberately unchanged for now (both refusals still say
`denied/tab-not-owned`), because emitting the new codes would advertise a `tabs_claim` that does not
exist yet; T104/T105 change them together. `adopt` writes an `agent`-kind lease, `release` ungroups,
`endSession` drops only its own leases, and a tab the owner closed drops its lease. **Leases survive the
idle churn**: two full respawn cycles (`beginReconciliation` → `announce` → `reconcile`) with no session
activity leave both leases, the group and `mainTabId` intact and `reconcile()` returning nothing.
`touch()` exists and is tested but nothing calls it yet — wiring "mainTabId updates on effect" needs
T103a's session-scoped deps. unit 1026/94, packaged journey green.

**T103a's target moved — the exploit window is not where the review placed it.** Every runner reads
`deps.ownsTab(tabId)` synchronously at entry, in the same microtask as the session pointer being set, so
a plain two-call interleave cannot beat an entry check. The two real windows are: (1)
`agent-tools/batch.ts:151` dispatches each step directly, bypassing `handleToolCall`, so every step's
ownership check reads whatever the shared pointer holds *now*, after arbitrary awaits — and a tab that
legitimately changed hands mid-batch (release + claim, which leases now make ordinary) is granted to the
wrong session; (2) `agent-tools/reads.ts:265` and `agent-tools/upload.ts:76` read
`deps.context.forCall(callId)` **after** awaiting the ownership check, so one session can bind its page
with another's channel nonce, runtime epoch and grant id. The red test must force (1); (2) is a second,
cheaper red in the same file.

- [X] T103a [US3] Thread `sessionId` through the tool runners' deps (`context: AgentSessionContext`, `ownsTab`) across `apps/extension/src/service-worker/agent-tools/*.ts` so two calls interleaving across an `await` cannot read another session's id (B7 finding: today they are pointed at the calling session synchronously before entering the runner, which is correct only for sequential calls), and key pending `ask` prompts by session so releasing a session cancels its own prompts. Red test first: two interleaved calls from different sessions
**Result note (2026-09-09, B19 — T103a)**: the shared session pointer is gone. Runners now take
`context: AgentSessionContexts` with `forCall(sessionId, callId)` and `ownsTab(sessionId, tabId)`, and
every runner reads `request.sessionId`; `agent-runtime.ts` lost `placeholderSessionId`, the mutable
pointer, the connect-time reset and the exported `sessionId()` accessor, replaced by a session-keyed
context map. Prompts carry their session and `releaseSession` cancels its own. `touch` is wired through
a new `onEffect` so `mainTabId` follows an effect. The interleave tests are honest by construction —
the deps answer about whichever session the runner names and can only fall back to the pointer when
given none, so the same test runs against both shapes and only the threading changes the answer. The
decisive red: **a batch step was granted on a tab its session no longer held** (`outcome: ok` where
`denied/tab-not-owned` was required), plus a read binding its page with another session's channel nonce.
unit 1030/95.

**Two follow-ups B19 found and left** (both pre-existing, neither in its scope): `agent-runtime.ts`
`onStop` cancels prompts **globally** even on the branch where the frame names a session, so a stop
about session A expires session B's live prompt — a visible defect for the owner; and `stops` is keyed
by call id with no session dimension, so a session-wide stop is all-or-nothing. → **T105a**.

- [X] T105a [US3] Make Stop session-scoped: on a `stop` naming a session, cancel only that session's prompts and stop only its calls (`apps/extension/src/service-worker/agent-runtime.ts` `onStop`, and give `stops` a session dimension). An unnamed `stop` stays the owner's stop-everything (003's reading). Red test first: a stop naming session A leaves session B's live prompt standing
- [X] T104 [US3] Tool handlers in `apps/extension/src/service-worker/agent-tools/tabs.ts`: `tabs_context` lists every tab with `holder`, `windowId`, `active` (no page content); `tabs_claim`, `tabs_release`; every read/effect handler checks the lease instead of the group
- [X] T105 [US3] Register `tabs_claim`/`tabs_release` in `packages/agent-host/src/mcp-server.ts`; refusal mapping `held-by-session`/`not-yours`
**Result note (2026-09-09, B20 — T104/T105/T105a)**: `tabs_context` lists every tab in the browser with
`holder` (`this` / `{sessionId}` / `none`), takes no lease and reads no document; `tabs_claim` and
`tabs_release` are implemented and registered. The wire words switched: a boolean `ownsTab` could not
name a holder, so all six runners now take `tabOwnership` returning the four-fact answer, and refusals
carry `held-by-session {sessionId}` or `not-yours`. Stop is session-scoped — a named stop touches only
that session, an unnamed one is still the owner's stop-everything. Existing tests were restated, not
weakened: 003's SC-024 loop had **conflated** "another session's tab" with "the owner's tab" and now
asserts each separately, and the journey's recovery predicate had to become holder-aware (left as it
was it never matched, so the FR-057 poll silently burned its full 180 s and reported a 180 s recovery —
worth remembering as a way a green-looking test can hide a bound). unit 1039/95, journey green (14.3 s).

**Two items B20 raised rather than deciding alone:**
- `tabs_context` carries no **title**, because the contract shape has none — but FR-060 requires "title,
  address, active state and window", so the contract is what is wrong. → **T105b**.
- `tests/e2e/packaged/agent-actions.spec.ts:89` and `agent-tabs.spec.ts:141` still assert the old
  `tab-not-owned` and will fail on the next packaged gate. → **T105c**.

- [X] T105b [US3] Add `title` to the tab view in `packages/contracts/src/agent-tools.ts` and to the adapter that builds it, so `tabs_context` answers FR-060's "title, address, active state and window". Contract test first; the title comes from the browser's own tab record, never from the document
- [X] T105c [US3] Restate the **three** stale packaged assertions (B21 restated two and found a third) that still assert the retired refusal word — `tests/e2e/packaged/agent-actions.spec.ts:89` and `agent-tabs.spec.ts:141` — to `not-yours` or `held-by-session` as the case requires, keeping each claim, and run both in attach mode
**Result note (2026-09-09, B21)**: `title` is on the tab view, from the browser's tab record (never the
document), and the panel projection follows the same shape. The indicator is built and unit-green: its
control asks the trust question through one seam whose default is the event's own trusted flag, and the
test drives a **real** DOM click through both halves so the trust check is the only difference between
"does nothing" and "sends once" — jsdom makes the flag non-forgeable, which is why the seam exists. The
indicator is marked and excluded from both the element collection and the visible-text clone, asserted
on a page carrying a real button beside it. The narrow manifest stayed byte-identical.

**Blocking finding — the declared content script breaks the packaged read path.** Same build, one
difference: with `content_scripts` in the loaded manifest, `agent-actions.spec.ts` fails at the first
`find` with `stale`, reproduced twice; with the declaration removed and nothing else changed, that
journey passes (13.1 s), which also confirms T105c's `not-yours` restatement is right. The mechanism was
not diagnosed — `all_frames` + `document_start` on `<all_urls>` meeting the programmatically injected
runtime in the same isolated world is the suspect, but that is a design question, not a test fix.
→ **T107a**. Note this blocks S3 as well: S3's frame reading was going to run in the same entry.

**Also found**: `tests/e2e/packaged/agent-tabs.spec.ts:128` asserts `tabs_context` returns exactly the
session's own tab, which B20 made wrong (it lists every tab now). A third stale assertion T105c did not
name. → folded into **T105c**.

- [X] T107a [US3] Diagnose why the declared agent content script makes the packaged read path answer `stale`, then fix it. Consider the end state: the reference has **one** declared reader in every frame and no programmatic injection, and S3 needs exactly that — so the answer may be to land that shape now rather than make two runtimes coexist in one isolated world. Build the red loop first (a failing packaged run, or a smaller reproduction), find the mechanism, and only then choose
- [X] T106 [P] [US3] Unit test `apps/extension/tests/indicator.test.ts` (jsdom): the indicator renders on `indicator {show, label}`, is removed on `{show: false}`, its control sends `ui.agent.focus-main` only for `isTrusted` clicks, and it is never part of a collection (marked so the collector skips it)
- [X] T107 [US3] Implement `apps/extension/src/content-runtime/indicator.ts` and the agent content-script entry `apps/extension/src/content-runtime/agent-entry.ts` (make T106 green); declare `content_scripts` for the **agent profile only** in `apps/extension/src/build-config.ts` (`all_frames: true`, `match_about_blank: true`, `run_at: document_start`; T072 guard proves narrow unchanged)
**Result note (2026-09-09, B22 — T107a)**: diagnosed, not guessed. A `chrome.runtime.onMessage`
listener that returns `false` without answering makes `chrome.tabs.sendMessage` **resolve `undefined`**
instead of rejecting with "receiving end does not exist". The declared script put such a listener in
every frame, so the worker's probe stopped throwing the error it used as its proxy for "no runtime
here"; the probe answer parsed as invalid, was classified `stale-context` instead of
`document-replaced`, the injection branch was skipped, and **the page runtime was never injected at
all** — the first `find` failed before reading anything. Fix: classify an empty probe answer as "no
receiver" explicitly, so silence and no-listener are the same fact. Two lines, and correct in the end
state too: when the declared script becomes the only runtime it answers the probe, and "silence means no
runtime in this frame" stays the right rule for S3's per-frame reads. Ruled out on the way: bundling
(the new bundle contains none of the page runtime), binding/epoch staleness (neither path was reached),
and listener coexistence (once injected, the runtime's synchronous answer wins — verified in-browser).
The end state (one declared runtime, no programmatic injection) is still the right destination and is
still a separate scope. Journey green **with the declaration present** (13.8 s). unit 1044/96.

- [X] T108 [US3] Worker handler for `ui.agent.focus-main` in `agent-runtime.ts`: accept only from a held tab's content script; `tabs.update(mainTabId, {active: true})` + `windows.update(windowId, {focused: true})`
- [X] T109 [P] [US3] Side panel: list several sessions; per tab show `holder`; locale strings in both locale tables (`agent.session.*`, `agent.tab.holder.*`)
**Result note (2026-09-09, B23 — T108/T109/T105c)**: the indicator's loop is closed. The tab acted on is
Chrome's own attribution of the sender, the authority is the lease (never the group), and a body `tabId`
that disagrees with Chrome's refuses the message **whole** rather than silently correcting it. The proof
is by weakening: each of the three guards was broken in turn and each broke exactly one refusal test —
the decisive one being session A's page naming a tab session B holds, which activates B's main tab
without the guard and nothing with it. The panel gained a Sessions section in both locales. T105c needed
**two more restatements than it named**: the same B20 family had left a length-based poll predicate that
could only ever burn its full timeout, and a post-close "list is empty" assertion. unit 1052/97,
contract 224/20 (the locales contract caught the unlisted panel keys), packaged `agent-tabs` green.

**Finding B23 raised rather than widening its own scope**: the panel projection carries only each
session's *own* tabs, so in production every projected row's holder is `this` — the panel renders the
`none` and `{sessionId}` cases correctly and they are covered by tests, but the owner cannot actually
see them until the projection carries the browser's tabs. That is a panel-state contract change.
→ **T109a**.

- [X] T109a [US3] Widen the panel projection so the owner sees what the agent sees: `agentPanelStateSchema` carries the browser's tabs with their holder, not only the session's own. Contract test first; no page content in the projection, the same rule `tabs_context` follows
**Result note (2026-09-09, B24)**: the panel projection now carries the browser's tabs with their
holder — and the holder on a panel row deliberately cannot be `this`, because the panel is nobody's
session. Verified live: the real side panel listed three unheld tabs as "沒有工作階段持有", the case the
owner previously could never see. The S2 journey is written and cases 1–4 pass (an owner tab opened
through CDP is listed with its title and `holder: none`, claimed, read, and a second session's claim is
refused naming the holder; an unheld tab answers `not-yours`).

**Case 5 is red, and it is my decomposition error, not the implementer's.** T107 built the page half
(`applyIndicator`) and T108 built the return half (`focus-main`), but **no task ever wrote the sender**:
nothing in the worker sends `{type: "indicator", show: true}`. The indicator therefore never appears.
Cases 6 and 7 are coded and were blocked behind it — including the trusted-click half, which *is*
reachable (a CDP `Input.dispatchMouseEvent` at the control's own rect centre, preceded by a negative
`element.click()` that must move nothing). → **T107b**.

**Design decision for T107b (main session)**: the worker raises the indicator when a tab joins a session
(claim or adopt) and lowers it on release, session end and unpair. A navigation reloads the content
script at `document_start`, which loses the indicator — rather than have the worker track navigations,
**the page asks**: the content script announces itself on load and the worker answers with that tab's
indicator state. That is the same shape as the T107a lesson (the page's silence is a fact the worker
reads, not something it infers) and it self-heals after a worker restart too.

- [X] T107b [US3] Write the indicator's sender: the worker raises `{type:"indicator", show:true, label}` when a tab joins a session (`tabs_claim`, `adopt`) and lowers it on release, session end and unpair; the content script announces itself on load and the worker answers with that tab's state, so a navigation re-raises it without the worker tracking navigations. Red test first for raise, lower, and the re-raise after a reload; the message goes only to tabs the session holds
- [X] T110 [US3] Packaged attach-mode journey `tests/e2e/packaged/agent-claim.spec.ts`: an owner-opened fixture tab is listed as `none`, claimed, read; a second session's claim is `held-by-session`; `not-yours` on an unclaimed tab; indicator visible on the held tab and gone after release; focus-main activates the main tab within 1 s; pairing accepted at 20 s inside one call succeeds
**Result note (2026-09-09, B25 — T107b/T110)**: the indicator has its sender. The raise/lower hooks live
in the tab manager because that is the one place every join and leave writes a lease — the tools would
each have had to remember. The announcement is answered by an ordinary worker→tab message rather than a
reply channel, so the content script's single listener still returns `false` honestly and nothing waits
on a response: the T107a trap was avoided by design, not by luck. **The S2 journey is fully green
(27.7 s, all seven cases)**, and two details make it real evidence: case 5 passes *after* the tab was
navigated, so what is proven is the announce/re-raise path rather than only raise-on-claim; and case 6's
negative half genuinely fired — a scripted `element.click()` reached the control and returned "clicked",
yet the main tab was still not active a second later, while the CDP mouse event moved it inside 1 s.
unit 1063/98, contract 225/20. `ui.agent.announce` added to contracts README §3 by the main session.

**Two loose ends carried into T111's brief**: the lower-on-unpair path is implemented but covered only
indirectly, and one full unit run reported a single failure whose name was lost, not reproduced on two
immediate re-runs — it needs one clean run before being called noise.

**Result note (2026-09-09, B26)**: the unexplained unit failure did not recur in a clean full run
(1063/1063) — treated as a one-off. Lower-on-unpair now has a direct test, red proven by reverting.
`agent-pairing.spec.ts`'s two `[]` assertions restated to "no row is this session's". **S2 probe: verdict
`done`, 2/2** (`probe-004/reports/004-2026-09-09T14-32-44Z.md`) — `s2-owner-tab` listed a CDP-opened tab
as `holder: none`, claimed it, read it, released it, and the next read was refused `not-yours`;
`s2-pairing-20s` answered `paired-same-call`.

**But S2's debt is still open**: the S0 re-run **crashed before writing its report** with a Windows
`EBUSY` on removing a scenario's session workspace while a spawned process still held it as its cwd. All
four observed values were lost, so **whether E3 flipped is unknown** — the closest evidence is
`s2-owner-tab`, which is the same shape and passed, but it is not the S0 file's answer. This is a probe
infrastructure defect that can lose a whole paid run's evidence at cleanup. → **T111a**.

**Two smaller findings**: SC-031 asks for 5 pairing runs and the runner has no repeat option, so only 1
was done; and the unpair lower loop iterates `tabs.context(...).tabs`, which since B20 is *every tab in
the browser*, so an unpair sends a lower to unheld tabs — harmless (it is the answer an unheld tab's
announcement gets anyway) but it contradicts the sender's own "only a tab the session holds is told"
rule. → **T111b**.

- [X] T111a [US3] Make the probe unable to lose a paid run's evidence: write the report **before** any workspace cleanup (or in a `finally`), and make the cleanup itself survivable — a Windows `EBUSY`/`ENOTEMPTY` on removing a session workspace must be retried and then ignored with a line in the report, never thrown. Add a `repeat` option to the scenario schema so SC-031's five runs are one invocation. Red test first for each
- [X] T111b [US3] Scope the unpair lower to tabs the session actually holds (`agent-runtime.ts` unpair loop), matching the sender's own rule; and re-run the restated `agent-pairing.spec.ts` in attach mode, which B26 could not fit
**Result note (2026-09-09, B27)**: the probe can no longer lose a paid run — the slice loop is wrapped
so `finish` always runs and records whatever stopped it as a `not-run` row, and workspace removal
retries then **ignores** the failure with a "Run notes" line naming the directory left behind. Both were
red-first. A `repeat` option landed and `s2-pairing-20s.json` now carries `repeat: 5` for SC-031 (not yet
exercised by a paid run). Proof the fix works: both of this brief's runs wrote their reports and lost
nothing, which is exactly what the previous run could not do.

**T111b's premise was wrong and the implementer said so** rather than inventing a red: the unpair loop
iterates the *session's own* tab ids, not every browser tab — it is `tabs_context` that lists them all.
The change was made anyway (the lease is the authority the announcement path already uses) and kept as a
regression pin, but it is a clarity change, not a bug fix.

**The S0 re-run is blocked by my own ordering error.** `agent-pairing.spec.ts` ends by *unpairing* the
agent, and I put that spec before the S0 run in B27's brief, so every S0 scenario was refused
`not-paired` and E3/E4 are still unanswered. Seeding the durable record over CDP was not enough — the
probe's helper answers a pairing request that is already in flight, and with no request pending there is
nothing to answer. The probe must not depend on what a preceding journey left behind. → **T111c**.

**Also**: `npm test` reported **1050 passed / 97 files** where the previous brief had 1064/98, with a
`spawn EPERM` in Vitest's worker teardown for `auth-controller.test.ts` on both runs. That is not
harmless noise — a whole file's ~14 tests did not run, and it is in the suite the archive guard lives
in. → **T111d**.

- [X] T111c [US3] Make the probe establish its own pairing instead of depending on the browser's leftover state: the environment check verifies an accepted pairing for the agent id and, if there is none, runs a minimal warm-up session and accepts the request that session raises (the helper can only answer a request in flight — a seeded record is not enough). Then no ordering of journeys before a probe run can refuse every scenario. Red test first
- [X] T111d [US3] Find out why `apps/extension/tests/auth-controller.test.ts` no longer runs (`spawn EPERM` in Vitest's worker teardown, reproducible), and fix it so the file executes again. A file that silently does not run is a hole in the suite the archive guard is measured in; report the cause before fixing. **Fact established by the main session**: the file passes in isolation (`npx vitest run apps/extension/tests/auth-controller.test.ts` → 18 passed), so this is an interaction in the full run — worker spawn pressure, a leaked handle from another file, or a teardown race — not a defect in the file
**Result note (2026-09-09, B28)**: three findings, each better than the task that produced it.

**T111d — the file was never missing.** Six full runs (three sequential, three *simultaneous*, ~294
overlapping worker spawns) all reported 98 files / 1068 tests. The arithmetic settles it: 1068 − 1050 =
18, exactly `auth-controller.test.ts`'s count, and it came back on its own. The cause is a Windows
process-creation refusal during Vitest's per-file worker recycle under machine pressure — B27's run was
made right after a paid probe with ~50 live node processes from other sessions on the box. The file was
the victim of a failed spawn, not the culprit. **No code fix**, correctly: trading the suite's module
isolation for an unreproducible environmental flake is not a repair. Practice change instead: run
`npm test` **before** a paid probe run, not after.

**The "lost failure" from B25 is identified and is real**: running `npm test` concurrently with a live
probe makes `packages/agent-host/tests/mcp-server.test.ts` "tells the agent the bridge is unavailable
when no relay has published a record" fail, because the live run had published a real record **that the
unit test reads from the machine's own host data directory**. A unit test reading real machine state is
a test-isolation defect, not a flake. → **T111e**.

**T111c is written and tested but the live path exposed a product defect.** The warm-up did exactly what
was asked — started a session, the session raised the request, the helper accepted it in flight and
reported success — and the record was empty immediately afterwards. Direct evidence:
`STORAGE NOW: {"agentPairings":{"paired":[]}}`. Mechanism: `pairing-controller.ts` caches the durable
state in `loaded` and every mutation writes that **cache** back, so a write that did not go through the
controller is invisible to it and is overwritten by the next mutation — here the `abandon` that follows
the warm-up session's link dropping. The cache claims an authority over `chrome.storage.local` it does
not have. → **T111f**. E3 and E4 are still unmeasured; the run refused itself at the pairing gate
instead of burning five sessions that would all have answered `not-paired`, which is the environment
check doing its job.

- [X] T111e [US3] Give `packages/agent-host/tests/mcp-server.test.ts` its own host data directory so no unit test reads the machine's real bridge record (the host already takes a `HostEnvironment` for exactly this). Audit the other agent-host tests for the same reach into real machine state. Red test first: the case must fail while a record exists in the real directory and pass once isolated
- [X] T111f [US3] The pairing controller's cache must not outrank the storage it caches: subscribe to `chrome.storage.onChanged` for its own key and drop or refresh `loaded` when the record changes underneath it (`apps/extension/src/service-worker/pairing-controller.ts`). Red test first — an external write followed by an unrelated mutation must not lose the external change. This also unblocks the probe's warm-up
**Result note (2026-09-09, B29) — E3 FLIPPED.** The pairing cache no longer outranks its storage: the
controller watches `chrome.storage.onChanged` for its own key and drops the cache on any change,
re-reading only the durable half and re-attaching the in-memory prompt (the prompt lives in the worker,
not in storage, and dropping it would leave its waiters unresolved). Live confirmation: the probe's
warm-up pairing stuck, which is what it could never do before. **T111e's premise was wrong and the
implementer refused to manufacture a red**: every agent-host test already passes an explicit host
environment and none reads the machine's real directory — verified with a real record present on disk,
19/19 green. So LOCALAPPDATA isolation is not the hole B25 saw.

**S0 re-run** (`probe-004/reports/004-2026-09-09T15-46-33Z.md`), verdict `not-done` 2/5:
- **E3 `s0-owner-tab` → `owner-tab-listed` — PASS.** This is what S2 owed.
- **E4 `s0-artifact-frame` → `host-chrome-only` — fails as expected**, S3's fix.
- E1 → `ok; ok; ok` — pass. `s0-baseline-source` → `reference-unreachable`, pre-existing.
- **E2 `s0-pairing-timing` → `timed-out: not-paired: no answer` — a regression to close before S2 ends.**

**Diagnosis (main session)**: this is T111f's missing half, and the warm-up's success is what hides it.
The CDP helper writes the *durable* record; it cannot call the decision route, which is the only thing
that settles a pending prompt's waiters. The warm-up passes because it is judged on "does a record
exist"; the scenario fails because it is judged on "did the call succeed", and the call's waiter is
still holding for a decision that never arrives. Now that the controller sees external writes, it can
close this properly. → **T111g**.

- [X] T111g [US3] When the controller learns from `chrome.storage.onChanged` that an agent is now paired, **settle that agent's waiting sessions** — a durable record saying "paired" is the answer anyone waiting on that decision was waiting for. Keep the reverse true as well: an external write that removes a pairing must not silently leave a session believing it is paired. Red test first: a waiter is resolved by an external accept, with no decision coming through the panel route
- [X] T111 [US3] (scenarios + S2 run done by B26; the S0 re-run is what remains, see T111a) Probe scenarios `s2-pairing-20s.json` (5 runs → SC-031), `s2-owner-tab.json` (list/claim/read/indicator/focus-main → SC-032); run `--slice S2`; attach report; archive guard

**Result note (2026-09-09, B30) — S2 CLOSED.** The controller now *acts* on what it learns: an external
write that marks an agent paired settles that agent's waiting sessions, one that removes a pairing stops
the panel projecting it, and the reconcile runs **through** the existing queue rather than racing it —
the cache still has no authority, the queue still does. **S0 is now 3/5** with both remaining failures
explained and scheduled (`probe-004/reports/004-2026-09-09T15-59-20Z.md`): E1 `ok/ok/ok`, **E2
`paired-same-call`**, **E3 `owner-tab-listed`**, E4 `host-chrome-only` (S3's), `s0-baseline-source`
`reference-unreachable` (the reference publishes no callable tools). unit 1077/98.

**Finding for S3, not adjusted**: E4's observed word is right but the agent's own note contradicts its
meaning — `read_page` returned **0 nodes** on the artifact page, "no host chrome buttons and no artifact
body… at all", where the owner's original run saw 4 outer-chrome buttons. The scenario's two-way mapping
has no word for "empty" so it lands on `host-chrome-only`. S3 must find out whether the page now reads
as empty for a *different* reason than frame exclusion, and the scenario needs a distinct word for it.
→ folded into **T112**'s brief.

**Checkpoint**: E2 and E3 cannot recur; the agent's first call and first tab behave as the references do.

---

## Phase 6: S3 — User Story 4 (read half): See inside embedded frames (Priority: P1)

**Goal**: every readable frame is part of one page tree, text and find cover frames, unreadable frames are listed not fatal (R-114 read half).

**Independent Test**: on `frames.html` the tree lists the buttons of both iframes with their frame; on the claude.ai artifact page the tree contains the artifact body.

- [X] T112 [P] [US4] Unit test `apps/extension/tests/frame-merge.test.ts`: merges per-frame subtrees in `getAllFrames` order under their parent frame, assigns opaque labels (`0`, `f1`, `f2`…), carries `frame` on every node, lists a frame that did not answer within the bound as `readable: false, reason: no-answer` and a forbidden one as `not-allowed`, applies the node/char bounds across the whole page and reports which limit truncated
- [X] T113 [US4] Implement `apps/extension/src/service-worker/agent-tools/frames.ts` (make T112 green)
**Result note (2026-09-10, B31 — measurement + T112/T113)**: **the artifact page is not empty.** Driven
over CDP against the owner's live Chrome, `read_page`'s exact request returns **4 nodes** — the same
four outer-chrome buttons the owner saw originally, none hidden, all surviving every filter. The 0-node
reading in the S0 report was a condition of that run, not a property of the page or the collector, so
there is no second defect underneath and frame merging hides nothing. The missing artifact body is
purely the frame exclusion: injection is pinned to frame 0 and the body lives in one child frame.

`mergePageFrames` is in. A frame that does not answer is bounded by a **real wait** — every frame is
asked in parallel against **one shared deadline** (2 s), so a page of quiet frames costs one bound and
not one per frame, matching the page-wide node and character ceilings. A frame that loses the race, or
throws, is listed `no-answer` and the merge still returns everything else; `not-allowed` is decided from
the frame's scheme *before* asking, so a frame that could never answer does not spend the budget. Child
frames are paired with owner nodes **by order**, not by url, because `srcdoc` and `about:blank` frames
have no distinguishing url and a url match would silently file content under the wrong element. unit
1086/99.

**Decision (main session): the frame enumerator is the scripting API's all-frames execution, not
`webNavigation`.** B31 found `chrome.webNavigation` is absent from the agent build; adding it means a
new permission plus an exemption from the scope guard, for information the `scripting` permission we
already hold returns anyway (one result per frame, each carrying its id). Least privilege decides it.
R-114 amended.

- [X] T114 [P] [US4] Unit test `apps/extension/tests/collector-frame.test.ts` (jsdom): the content-runtime answers `collect-subtree` for its own document only (no parent/child traversal) and includes its frame-local viewport rects
**Result note (2026-09-10, B32 — T114 done, T115 partial)**: the page half is in — the collector now
marks an iframe node as a frame owner and reports rects in its own frame's viewport, which is the fact
`mergePageFrames` splices on and which no collector output previously carried. The enumerator is in and
uses the scripting API's all-frames execution; because its results carry frame ids but not parentage,
each frame reports its own index chain (all cross-origin-legal) and the chains are matched into parent
links, which also yields the DOM order the merge pairs owners by.

**The real hazard was not the two scripts sharing an isolated world** — they guard on different global
keys and each removes only its own listener. It is **re-injecting frame 0**: reaching children with an
all-frames injection would re-run the page runtime in the top frame, mint a fresh document epoch, and
fail every in-flight read on that tab as `stale-context`. Injection is therefore now **by named frame**,
never all-frames.

**Decision (main session) for the remaining wiring**: `parseProbeResult` rejects a probe whose canonical
origin differs from the **tab's** origin, so a real cross-origin child frame would throw and be listed
`no-answer` — wrong, and it would look like the merge working while silently dropping exactly the frames
this slice exists for. The check's purpose is to catch a document moving under us between probe and
read, and that purpose is per-document: the expected origin for a frame's probe is **that frame's own**,
established by its probe and required of that same frame's later answers. The top frame's behaviour is
unchanged. Fix it that way rather than removing the check.

**Result note (2026-09-10, B33 — T115, `read_page` done)**: per-frame delivery landed (only the
probe/collect/injection sites moved; the effect sites still address frame 0, which is S4's), the frame
facts now survive sanitisation behind an opt-in flag so the archived remote shape is untouched, and the
origin check is per-document as decided — the top frame still gets the tab's origin, a child establishes
its own, and the existing collection-time comparison is what then requires *that same frame's* later
answers to match, so the "document moved under us" catch survives per frame. **`read_page` on a modelled
`frames.html` returns `Top action`/`Child action`/`Grandchild action`/`Cross action` with their frame
labels and all four frames `readable: true` — the cross-origin child is read, not listed `no-answer`.**
unit 1093/101.

Four things the change touched that were not in the plan, each handled: a single-frame answer stays
**byte-identical** (the merge path is taken only when a tab has more than one frame, which the contract
already reads as "the top document alone"), so no existing expectation was edited; enumeration has a
floor, because a failed all-frames execution would otherwise answer "empty page"; a **ref-rooted read
stays single-document**, since a root names an element of one document and sending it to siblings would
return their whole contents under a root they never had; and the interactive filter drops the iframe
owner nodes, so under the default filter a child's nodes follow its parent's rather than nesting under
the owner, while `filter: "all"` nests them — labels and the frame list are right either way.

**Decisions (main session) for the two remaining read tools**, which B33 correctly refused to settle
alone:
- **`get_page_text`**: concatenate each readable frame's text in frame order and apply the page-wide
  character bound across the whole result, exactly as the node bound works. Its result shape does **not**
  gain a frame list — `contracts/README.md` §2 says its shape is unchanged, and the structured read is
  where frame accounting belongs. A frame that does not answer contributes nothing.
- **`find`**: thread the frame into the resolve-target message and resolve **per frame, in parallel
  against one shared deadline**, the same shape the subtree read uses. Matches carry their frame, and
  the existing "too broad" rule applies across the merged match set rather than per frame.

- [X] T115 [US4] Amend `apps/extension/src/content-runtime/collector.ts` and the agent content-script message handler (make T114 green); the worker's read/find/text handlers in `agent-tools/` go through `frames.ts`
**Result note (2026-09-10, B34 — T115 complete)**: `get_page_text` concatenates readable frames in frame
order under the page-wide character bound with its shape unchanged (a frame it could not read sets
`truncated`, the only channel that shape has for "not all of the page"), and `find` resolves per frame in
parallel on one deadline with `frame` on each match and "too broad" decided over the merged set. The
shared ask-every-frame logic — one deadline, forbidden schemes refused before asking, the enumeration
floor — is now one function all three read tools use. unit 1101/101.

**Case 4 of the journey cannot be produced in a browser, and B34 refused to fake it**: a web page cannot
frame a `chrome://` url at all, the agent manifest declares no web-accessible resources so it cannot
frame one of its own pages either (the narrow manifest working), and the enumerator only ever returns
frames it could inject into — so a forbidden frame never appears in a real enumeration. It stays covered
at unit level, where a forbidden scheme is listed `not-allowed` before being asked and the page still
answers with every other frame.

**BLOCKER for T116/T117 and every packaged journey: the test TLS leaf is inside its 24-hour refusal
window.** The leaf's lifetime is 7 days and there is no renew action — reissuing means `remove` then
`install`, which touches `CurrentUser\Root` (no elevation, but Windows may show a trust dialog the owner
has to approve). Owner action; recurs weekly.
*(2026-09-16: no longer so — the leaf lives 30 days and `install` renews it, silently while the CA's
private key is still in `CurrentUser\My`; the dialog returns only when a new CA has to be issued.)*

**Correction (2026-09-10, main session, after B56).** I called this a product defect. **It is very
likely not one**, and the B55 note below overstates it — read this first.

B56 disproved my `includeFrameFacts` hypothesis by reading the code: the wire message to the content
script is byte-identical for the top document in both paths, and `includeFrameFacts` only adds fields
after receipt. That sent me back to the read's own rules, where the answer appears to be:

**FR-067, deliberately copied from the reference: a non-`all` read keeps only viewport-intersecting
elements** (`projectNodes`, the `offscreen === true` drop). And the fixture puts the top document's own
`#top-btn` and `#top-input` **after two 320px iframes**, a heading and three lines of prose — roughly
890px down a page whose journey viewport is 720px tall. They are below the fold, so a `filter:
"interactive"` read is *correct* to omit them. Every child frame's controls survive because each document
reports visibility against **its own** viewport, and a 320px iframe's controls sit at the top of it.

So the journey asserts something a viewport-gated read must not return. **The claim is still worth
making** — a framed read should carry the top document's own controls — so the honest fix is the fixture,
not the assertion: move the top controls above the iframes so the claim becomes observable. Same shape as
the hover lesson: change what cannot show the capability, never the expectation.

**A separate question this exposed, worth its own answer and not to be fixed in passing:** because each
document gates on its own viewport, a control inside an iframe that is entirely scrolled out of the
parent still counts as on-screen. Whether the reference does the same is a G9 detail
(`docs/design-notes.md`) that nobody has checked.

**Prove it before changing anything** — the same read with `filter: "all"` must contain `Top action`. If
it does not, this correction is wrong and the defect is real.

**Result note (2026-09-10, B55) — the first-ever run of this journey found a real defect, which is
what it was for.** The frame list is right (`0,f1,f2,f3`, all readable, the cross-origin frame present),
but the merged node list carries **no node from the top document at all** while every child's and
grandchild's controls survive — the exact inverse of the gap 003 had. No unit suite caught it: the fakes
answer any frame the same way, so a top document that answers differently from its children is invisible
to them.

Diagnosis (main session, narrowed to one seam): the top frame *does* answer — an unreadable root would
have made the whole read fail, and it did not — so its nodes are being dropped after collection, not
before. The single-document path is green and differs from the merge path by exactly one thing: it
collects with no `frameId` and no `includeFrameFacts`, while the merge asks every frame, the top one
included, with `{frameId, includeFrameFacts: true}`. `frameId: 0` being falsy was the obvious suspect and
was checked and cleared — every consumer uses `?? 0`. So the seam is `includeFrameFacts` changing what
the collector's walk returns for the top document.

**Verified (2026-09-10, B57) — the correction above was right, and it was measured, not argued.** Free
CDP probe on the unmodified fixture: `{"interactiveHasTop": false, "allHasTop": true, "viewportInfo":
{"innerHeight": 954, "rectTop": 1032.26}}`. The button sits 1032px down a 954px viewport, and the `all`
read carries it while the interactive read does not — FR-067's viewport gate behaving exactly as
specified. **No product defect.** The fixture's top controls were moved above the iframes (checked first
that both frame unit suites build synthetic DOMs and do not depend on the file's order), and the journey
then passed **every** claim, including the four that had never run once: frame list and cross-origin
frame; the top document's own controls carrying `frame: "0"`; frame-inequality across top/child/grandchild;
the cross-origin child's button actually read rather than merely listed; `get_page_text` spanning
same-origin and grandchild; `find` resolving a control inside a frame with the right role and frame. The
`chrome://` case is asserted at unit level by design, per the journey file's own comment.

- [X] T116 [US4] Packaged attach-mode journey `tests/e2e/packaged/agent-frames.spec.ts` (read half): `frames.html` tree has both iframes' controls with `frame` set; `get_page_text` includes both frames' text; `find` resolves a description inside a frame; a `chrome://` frame case lists `not-readable`
**Result note (2026-09-10, B44) — E4 did not flip, and the way it failed is the lead.** The artifact
page now answers with a **frames list naming the artifact's own frame as readable**, and six nodes
instead of four — so enumeration and the merge reached the frame. What did not arrive is its body.
B44's hypothesis, offered without acting on it: `read_page` defaults to the interactive filter, whose
role list is a closed set of controls, and an artifact's body is headings, tables and prose — roles that
filter drops in the top frame too. The scenario asks for "headings or table text" while issuing a read
that excludes them, so as written it may be unable to observe the thing it is testing. **That must be
measured, not assumed**, and the measurement is free (drive the extension over CDP, no agent quota).
→ **T117a**.

**Two more things B44 surfaced, both mine to settle:**
- `s0-baseline-source` expects the reference to be reachable, which the S0 run of 2026-09-09 established
  is **false by construction** — the reference publishes no callable interface, and the spec's
  acceptance standard was amended to a two-tier baseline because of it. The expectation is stale
  against a fact we have since recorded; correct it to the established one with a note. That is not
  making a red go green: no product claim rides on it.
- **SC-033's "within 10% of the baseline" cannot be judged today.** The harness compares an observed
  word against an expected word; it never captures the browser's own tree per scenario, and fills the
  baseline field with the expectation string. So the acceptance standard's comparison half has no
  machinery behind it. → **T117b**.

- [X] T117a [US4] Measure, over CDP and without agent quota, what the artifact page returns under `filter: "all"` and under `get_page_text` now that the frame is enumerated. If the body arrives, the scenario asks the wrong question and must ask the owner's actual one — can the agent see the artifact's content — and then be re-run. If the body does not arrive, the merge is not delivering child-frame nodes and that is the defect. Report which, with counts
- [X] T117c [US4] **The defect the measurement isolated**: the structural read delivers no child-frame nodes. On the artifact page, `filter: "all"` returns 6 nodes and **0** come from the artifact's own frame, while `get_page_text` returns 6748 characters of that same frame's body and the frames are all enumerated `readable: true`. So enumeration, the merge's placement and the text path are all fine — the frames are answering the structural collect with nothing. B45's suspect is the per-frame structural collect or its projection (`agent-tools/reads.ts` `collectDocument`, which adds the frame id and the frame-facts flag), not `frames.ts`'s placement, since that emits unpaired children anyway. Diagnose it first — build the red loop, find the mechanism — then fix. A unit test must pin it, and the free CDP measurement is the confirmation
- [X] T117d [US6] Broaden what `filter: "all"` can see, so "read the whole page" means the page. The reference builds an accessibility tree; this project walks a **selector list of controls**, which is why a document of headings, tables and prose yielded nothing anywhere until headings were added. Add the structural roles the reference's tree carries — paragraphs and text blocks, lists and list items, tables with their rows and cells, images with their alternative text, landmark regions — to the **agent walk only**, keeping `interactive` exactly as it is and the archived 001/002 walk untouched. **SC-036 depends on this**: "within 10% of the baseline's node count on a repository page" is unreachable while the walk sees only controls and headings. Red test first, on a document made of prose and a table
**Result note (2026-09-10, B47 — T117d)**: the structural read now carries paragraphs, quotes, code
blocks, lists and their items, tables with rows, cells and headers, images that carry alternative text,
and landmark regions — agent walk only, with the reviewed walk asserted to collect **zero** nodes from
the same document, so the widening is provably one-sided. **The artifact page went from 11 nodes to 210,
201 of them from the artifact's own frame.** Three judgement calls worth keeping: an empty alternative
text is the page calling an image decoration, so it gets no node; a header or footer inside an article
or section is not a landmark and is left out rather than reported as a fourth banner; and the implicit
word for an image matches the explicit one real pages write, because one concept under two words is a
filter an agent gets wrong. Two neighbouring tests went red as a true consequence and were **corrected
rather than silenced** — they now assert the roles they actually see while still stating their own
point. unit 1178/111.

**B47 was honest about what it did not close**: a repository page went 49 → 86, still far short of a
browser's own tree, so SC-036 was made reachable rather than met. It also caught a mistake in my
wording — SC-036 measured the **default** read, which deliberately returns only what can be acted on,
against a tree of the whole page. **SC-036 has been restated** (spec change log, 2026-09-10):
containment of the page's headings, links and controls, measured against the read that actually claims
to return everything, because a node-count ratio against a tree full of generic containers is the wrong
denominator.

- [X] T117b [US4] Give the probe the comparison the acceptance standard now promises: capture the browser's own tree for a scenario's page in the same run and judge **containment** — every heading and link that tree names must appear in the full read, every control it names in the default read — so SC-036 is a verdict the harness reaches rather than a sentence in the spec
**Result note (2026-09-10, B45) — the hypothesis was wrong, and the measurement says so plainly.** Under
`filter: "all"` the artifact's frame contributes **zero** nodes; the interactive filter was never what
hid the body. The same frame's **text** merges fine (6748 characters, the artifact's own headings and
table rows). So the capability is half delivered: text across frames works, structure across frames does
not. → **T117c**, which is the last piece of the owner's fourth original problem.

B45 also corrected two scenarios and was careful to say which kind of correction each was: the artifact
scenario asked "can the agent see the content" while issuing a call whose answer on that page cannot
carry it — the **expectation word is unchanged**, only the observing call, which is fixing a badly-posed
question rather than adjusting an expectation. And `s0-baseline-source` expected the reference to be
reachable, which this feature's own run proved false by construction; corrected to the established fact
with the reason recorded in the file, and it now passes. **S0 is 4/5.**

One more real finding, measured without quota: the probe agent read the artifact page **before it had
rendered** — zero characters at t+0, 6748 at t+5. A wait step was added to the scenario afterwards and
is **not yet verified by a run**.

**Result note (2026-09-10, B46) — the structural read was never frame-broken.** Both suspects were
wrong, including mine. The agent's collection walks a **selector list of controls**, so a document made
of headings, tables and prose yields zero targets **in any frame, including the top one** — measured
directly: the artifact's frame holds 320 elements, 6 headings, 3 tables and 6687 characters, and
**0** matches for that selector. That is exactly why the text path worked while the structural path
returned nothing with the frame still marked readable: it *answered*, with an empty list. Headings are
now in the agent walk (the reviewed 001/002 walk untouched, and `heading` is not interactive so the
default read is unchanged), and the artifact's frame went from **0 to 6** nodes.

**Why the unit test could not have caught it**: it answers the collect message from a table of canned
nodes, so no document is ever walked and the selector under test never runs — and every child in its
table had been given a button. It models the page's shape but never asks what the real page asks, which
is a child frame with no control in it. The regression test went to the collector, where the walk is.

**This exposes the real gap** — the reference builds an accessibility tree while this project walks a
list of controls, so prose, tables and list items are invisible to the structural read everywhere.
→ **T117d**.

**Result note (2026-09-10, B48) — S0 IS 5/5, `done`.** (`probe-004/reports/004-2026-09-09T20-33-51Z.md`)
`s0-artifact-frame` observes **`artifact-body-read`**: the wait held for 8014 ms, then the text read
returned 4899 characters carrying the artifact frame's own body — the `今天的四個證據` heading and the
E1–E4 rows, the content the owner could not see on 2026-09-09. Both of that scenario's corrections are
now verified by a run rather than asserted. Every other scenario passes. **All four of the owner's
original failures are closed by evidence from real agent sessions on their own browser.** Honest scope
note kept from B48: this scenario claims the *text* read; the structural read of that page was measured
separately (11 → 210 nodes, 201 from the frame) and is not what this row proves.

T117b landed with two guards worth keeping: a scenario that reports no read, and a page for which no
tree was captured, each **fail with their own words** rather than passing vacuously — a containment
check that compares nothing would otherwise be the easiest green in the suite. Failures name the ratio
and the missing names, up to five then a count. One implementation detail worth remembering: the tree
is captured over **one reused socket per target**, because the accessibility domain is enabled per
client and a second connection answers with an empty tree, which reads exactly like "the page was
empty". unit 1185/111.

- [X] T117 [US4] Probe scenario `s3-artifact-frame.json` (claude.ai artifact page: tree contains ≥ 90% of the baseline's nodes incl. the frame's → SC-033 read part); run `--slice S3`; attach report; archive guard

**Checkpoint**: E4's read half cannot recur.

---

## Phase 7: S4 — User Story 5 + User Story 4 (act half): Inputs the page cannot tell from a person's (Priority: P2)

**Goal**: browser-level pointer and keyboard input through the existing `debugger` permission; hover real; per-key typing; phantom cursor; refs inside frames act via owner offsets (R-113, R-114 act half, R-119).

**Independent Test**: on `hover-menu.html` hover then read lists the submenu; on `combobox.html` typing shows suggestions; on `frames.html` a click on an iframe button lands.

- [X] T118 [P] [US5] Unit test `apps/extension/tests/input-attachment.test.ts`: attaches lazily on first effect per held tab, keeps the attachment across same-tab navigation, shares it with diagnostics (domains enabled only under the grant, disabled on site change), detaches on release/session end; attach failure → `input-unavailable {reason: devtools-open | restricted-page}` for every effect on that tab, reads unaffected
- [X] T119 [US5] Implement `apps/extension/src/service-worker/agent-tools/input.ts` (attachment + `sendCommand` wrapper) and amend `agent-tools/diagnostics.ts` to use it (make T118 green)
**Result note (2026-09-10, B35 — T118/T119)**: one holder-counted attachment store now serves both
input and diagnostics. 003's diagnostics rules are all intact — its own detach is simply "drop the
diagnostics holder" — and the only lifetime change is that when the grant stops applying while a
lease-held input attachment remains, the attachment survives and **only the domains go off**; with no
holder left it detaches exactly as 003 did, which is why the diagnostics gate suite is untouched and
still green. **The FR-071 proof is the strong version**: not merely that attaching for input enables no
domain, but that what the page said during an input-only attachment was **never buffered** — after the
owner later grants the site, the domains are enabled once, the tab is not re-attached, and the first
granted read returns nothing from before. Attach failure is classified once per tab but re-tried on each
acquire, so a closed developer-tools window is noticed; there is no fallback path at all. unit 1108/102
(verified by the main session — B35's own run showed 1095 because the known machine-pressure flake lost a
whole file again).

**Follow-up B35 named for T121**: the attachment store is still created lazily inside diagnostics, so
the input holder's release is tested at the store but not yet wired to leases. Nothing leaks today
because no input holder can exist in production; hoist it when the first real effect producer lands.

- [X] T120 [P] [US5] Unit test `apps/extension/tests/pointer-delivery.test.ts`: click = move → press → release at the element's centre in top-level coordinates; hover = move only; right/double/triple set button/click count; scroll = wheel at point; drag = move → press → move → release; a `cursor` message precedes each pointer sequence and a hide follows the last
- [X] T121 [US5] Implement pointer delivery in `agent-tools/input.ts` and rewire the effect handlers in `agent-tools/effects.ts` from the content-runtime executors to it (keep the 003 observation/verification step) (make T120 green)
**Result note (2026-09-10, B36 — T120/T121)**: pointer effects now leave through the debugger, and the
ordering test carries its own weight — deleting only the move line turned **two** tests red with a diff
naming the absent pointer move, where a "was a click sent" assertion would have passed. 003's
verification discipline did not move: the settle window, the re-probe, the verdicts, the invalidation on
an unverified verdict and the effect hook all stayed. What did change is where the *synchronous*
evidence comes from — a protocol dispatch returns when the events are queued, so the worker now reports
only what it measured itself (the target's own box, the dragged element re-measured after the gesture,
the click count it delivered) and leaves everything else about the document to the probe. The attachment
store is hoisted to the runtime and released by the lease on tab release, tab close, session end, stop
and unpair. unit 1119/103.

**Decision (main session), confirming B36's deviation**: `scroll` stays on the existing executor path.
The tool's targeted mode means "bring this into view", not "turn the wheel here", and rewiring it would
silently change what the tool means to an agent that has been using it since 003. The coordinate wheel
belongs to the position tool in S6, where "here" is the argument.

- [X] T122 [P] [US5] Unit test `apps/extension/tests/key-delivery.test.ts`: `type` sends per character keyDown/keyUp with the key's code and text; a character with no key mapping is inserted via the insert-text path; `key` handles modifiers and repeat as 003 did; final value verified
- [X] T123 [US5] Implement keyboard delivery in `agent-tools/input.ts` (make T122 green)
**Result note (2026-09-10, B37 — T122/T123)**: typing goes out one keystroke per character, each
carrying its own text, and the value assertions are earned rather than asserted — the recorded protocol
traffic is **replayed into a simulated control**, so "the field holds the string" is a claim about the
delivery. Reverting to a single value-set turned three tests red while every final-value test stayed
green, which is exactly why the sequence had to be the load-bearing one. "Has no key to press" is
decided by the **layout**, not by a list of awkward characters: a US keyboard's keys and their shifted
forms are keystrokes, and anything a person would reach through an input method — an emoji, a CJK
character, an accented letter — falls to the insert path, iterated by code point so an emoji is one
insert and not two halves. unit 1130/104.

**Two decisions (main session), confirming B37's calls**: typing into a **named** target clicks the
control's centre first, because a key event goes wherever the page has focus and a click is the only
route the debugger offers for putting the caret there — which is also a person's route, and the tool was
already restricted to text controls. And `replace` mode clears with a select-all keystroke and Delete
rather than setting the value, so the control's own handlers see the emptying; a silent value set is the
very thing this slice removes.

- [X] T124 [P] [US5] Unit test `apps/extension/tests/frame-offsets.test.ts`: for a ref in frame `f2`, the rect from the frame's runtime plus the cached owner offsets (frame-owner → box model, chained to top) yields top-level coordinates; the cache is invalidated when that frame navigates
- [X] T125 [US4] Implement offsets in `agent-tools/frames.ts` and the `resolve-ref` content-runtime message (make T124 green)
- [X] T126 [P] [US5] Unit test `apps/extension/tests/cursor.test.ts` (jsdom): the cursor overlay is `pointer-events: none`, top frame only, moves on `cursor {x, y}`, hides on `{hide: true}`, and is excluded from collection
- [X] T127 [US5] Implement `apps/extension/src/content-runtime/cursor.ts` (make T126 green)
**Result note (2026-09-10, B38 — T124–T127)**: a reference from a child frame now resolves to
top-level coordinates by accumulating its owner chain, and the red test is genuinely multi-level — the
fixture is three deep and every assertion is about the innermost frame, so a one-hop implementation and
a grandparent-only implementation are both distinguishable from the sum. When any hop cannot be
measured the answer is *no location*, never `{0,0}`, so the effect refuses instead of clicking the
origin. The cursor reuses the indicator's single exclusion mechanism rather than a second one, proven by
deleting that one line.

**Decision (main session) — measure the offsets per effect, drop the cross-effect cache.** B38 reported
two honest gaps in url-based invalidation: a **same-url reload** and a **parent re-layout with no
navigation** are both undetected, and either leaves an offset that silently clicks the wrong place. A
silent wrong click is the worst failure this feature can produce, and the measurement is two protocol
calls per hop against an effect that already probes, collects, settles and re-probes — the cache was
buying nothing worth that risk. Keep a memo **within a single delivery** so a chain is not measured
twice; drop it when the delivery ends. → **T125a**.

**Decision (main session) — the geometry domain is a stated exception, not a leak.** Measuring offsets
needs the DOM domain enabled on the shared attachment, which contradicts the module's own claim that
only diagnostics enables anything. It is not one of the three diagnostics domains, it returns structure
rather than page content, and nothing subscribes to its events — so the invariant is not "no domain but
diagnostics" but "**no domain whose events we consume, and nothing enabled that carries page content,
outside the grant**". State that precisely in the module and pin it with a test that no event from the
geometry domain is buffered or reachable. → **T125b**.

- [X] T125a [US5] Replace the cross-effect frame-offset cache with a per-delivery memo: measure the owner chain when an effect needs it, reuse it within that one delivery, discard it afterwards. Red test first — a frame that reloads at the same url, and a parent that re-lays-out without navigating, must both give a correct point rather than a stale one
- [X] T125b [US5] State the attachment's real invariant in `agent-tools/input.ts` and pin it: the geometry domain may be enabled for measurement, but no domain whose events we consume, and nothing carrying page content, is enabled outside the owner's diagnostics grant. Test that no geometry-domain event is buffered or reachable, alongside the existing console/network assertions
**Result note (2026-09-10, B39 — T125a/T125b)**: the offset measurement now holds **no state at all** —
the frame-token map, the domain flag and the accumulated offsets live inside one delivery and are
dropped when it returns, so there is nothing to invalidate because nothing survives. Both staleness
cases are covered with expectations that are the **sum of both hops**, so a one-hop or grandparent-only
implementation still fails them, and the fixture's owner boxes are now mutable, which is how a page
moves without saying so. The invariant is stated in the module and pinned by a test that measures on an
**ungranted** site, then grants it and emits geometry events carrying page values alongside a real
console line, asserting the console read contains only the console line and none of the page values.
That test was green on arrival, so its red-capability was proven twice by deliberate mutation and
reverted from copies. unit 1146/106.

**S4's remaining tasks (T128 journey, T129 probe) are blocked on the test certificate**, as is S3's
journey (T116) and its probe (T117). Unit work continues in S5 meanwhile.

**Result note (2026-09-10, B55): `agent-input.spec.ts` does not exist — this task includes writing it.**

**Result note (2026-09-10, B58): the journey is written and blocks at claim 1 on a real gap — but the
fixture is the thing at fault, and the gap is worth recording anyway.**

The finding: a point resolves through `elementFromPoint`, which registers *any* live element, but the rect
lookup that follows (`locateInFrame`, `effects.ts`) only answers for handles the walk collected, and the
walk is a fixed selector list that does not include `span`. So a point over a plain `span` gets a handle
and no rect, and the effect answers `target-not-located`. `hover-menu.html`'s trigger is a `span`
styled `display:block` that covers its `li` pixel-for-pixel, so no point inside the li resolves to the li.

**Why the fixture is what changes.** Real hover menus hang off links, buttons or role-carrying elements —
python.org's proven trigger is a link — so a bare `span` trigger models nothing that exists, and it is
invisible to reads and `find` as well, not just to point effects. Making the trigger walk-eligible keeps
the claim intact and makes it observable, which is the same call as the frames fixture and the hover page.

**The gap is real but bounded, and I checked the thing that would have made it serious.** My worry was
S6: a coordinate-based tool that required walk-eligibility would fail on exactly the canvas apps it
exists for, and the S6 oracle is a drawing canvas. It does not — `agent-tools/computer.ts` works on
viewport coordinates alone (`insideViewport`, `cropAround`), resolves no element and never calls
`locateInFrame`. So the coordinate path is unaffected; the gap is confined to *targeted* effects given a
point instead of a ref, whose normal flow is find → ref → effect, and a ref is always walk-eligible.
Recorded, not fixed.

Claims 2-5 are written but have never been exercised — the test aborts at claim 1.

**Update (2026-09-10, B62) — the honesty fix is in, and it was done well; two disclosed gaps make it
not yet usable as the instrument it was meant to be.**

`verifyPageEffect` now takes `pointOnTarget` and answers **`target-missed`** for the click family when the
delivered point did not land on the target — a new closed cause, deliberately distinct from
`target-not-located` ("found it and hit something else" vs "never found it"). The confirmer asks the page
what is actually at the delivered point via the existing `elementFromPoint` primitive, **chosen precisely
because it is independent of the rect-collection machinery under suspicion** — good judgement, since a
check built on the suspect path could have agreed with it and confirmed nothing. Red proven by reverting;
1424/1424 green.

**Two gaps it disclosed rather than hid, and both matter for exactly the work that comes next:**
1. It matches the handle **exactly**, not "or a descendant". A click on a button whose icon or label span
   sits under the point would resolve to the child and be called a miss — a **false refusal** on ordinary
   pages, and a regression risk for 003's proven clicks.
2. It always asks **frame 0**, not the frame that claimed the target. For a framed target it asks the
   wrong document, so a framed click refuses **whether or not the coordinate was right**.

Gap 2 means the journey cannot yet tell us anything about the framed case: every framed click would refuse
regardless. Both must close before the refusals become the trace we are after.

**My own omission, for the record:** B62 could not run the journey because it reported `HALLPASS_CDP_ENDPOINT`
unset — my brief said "attach mode" without spelling out the variable. The owner's branded Chrome was
running the whole time (Chrome/152.0.7977.77 answering on 9222). Not a blocker; a brief defect.

**Update (2026-09-10, B61) — my hover hypothesis is disproven, and the false `verified` is now pinned
to a line.**

*Disproven, with measurement:* the submenu does not close between the two effects. Live in Chromium, the
target's box stayed `{x:273, y:255.19, w:192, h:36.78}` across an idle gap with the pointer parked — `:hover`
does not expire on its own, and nothing sends another pointer event in between. And even if it had closed,
a zero box makes `viewportRect` return undefined, `sanitizeRect` drops the field, and `locateInFrame`'s
`entry.rect` check fails — which is a **refusal**, not a click at the wrong point. So that mechanism cannot
produce what we saw.

*Confirmed, at a line:* `verifyPageEffect` (`effect-verification.ts:127-137`) returns `"verified"` for the
whole click family from one fact — the document did not navigate and the epoch and origin still match.
**Nothing checks that the dispatched point landed on the target.** So any delivered click reads `verified`
wherever it physically lands. That is exactly B60's frame case.

The comment there is not careless; its reasoning is sound for what it claims ("the events were delivered
and the document they were delivered into is still the one they were aimed at") and it deliberately
refuses to claim page semantics it did not observe. The gap is narrower than that principle: **whether the
point hit the target is our own arithmetic, not the page's business, and it is checkable.**

**So the fix order inverts (main-session decision).** Fix the honesty first, not the coordinate. Once a
click confirms it actually hit its target, the wrong-point defect stops being invisible and starts
reporting itself as a refusal in every test that touches it — which is a far better instrument than more
console tracing, and three briefs have now lost their window to harness setup chasing that trace.

**Result note (2026-09-10, B60) — the most serious finding of this feature, and it would have shipped
silently.** Two observations, and the second is the dangerous one:

1. **A click inside a frame lands nowhere**, on our own fixture, **same-origin**, no cross-process
   boundary — and the tool answers `{"effect":"activated","documentChanged":false,"verified":true,
   "verdict":"verified","clicks":1}`. Every page-authored echo on the page (both grandchildren, both
   children, the top document) still read `"not clicked"` afterwards. So this is **not** a refusal: it is
   a false positive. The verification chain says *verified* while nothing was hit.
2. **A click misses on a page with no frames at all.** Claim 1 resolved "Release notes" and the page
   navigated to `#guide` — the trigger's own href. The delivered point was the **trigger's** box, not the
   resolved target's.

Both are one class: **the rect used for delivery is not the target's rect**, and the effect reports
success anyway. An agent that believes it clicked one control while the browser clicked another is the
worst failure this product can have — on a real site that is destructive, and no existing test sees it
because the fakes hand back a rect that is correct by construction.

**What I checked and eliminated (main session):** B60's own guess was positional pairing of rects to
nodes. That is wrong — `sanitizeSemanticNodes` takes each node's own `rect` field per node
(`content-broker.ts:476`), there is no zip by index. The `entry.targetHandle === input.ref && entry.rect`
comparison in `locateInFrame` is also not the culprit: the click was **not** refused, so a matching handle
*and* a rect were both found.

**Live hypothesis for the flat-page miss, worth testing first because it is cheap:** the target is
revealed by hover, and each effect delivers independently. If the submenu closes between the `hover`
effect and the `click` effect, the click's own re-collection measures a target that is no longer shown,
and what it gets back is the ancestor's box — whose centre is the trigger, which is exactly where the
click landed. 003's flat-page clicks are green precisely because their targets are always visible.

**This is R1 and the S4 review is owed.** Fix first, then `code-reviewer` on the finished work.

**MEASURED (2026-09-10, B64) — the flat-page defect is `find` ranking, not coordinates, not frames.**
Four values, live, MCP tools driven directly with no LLM:

- `find("Release notes")` returned **three** matches, in this order: `[0]` `listitem` labelled
  `"Documentation
 Getting started
 Release notes
 API r…"` — the **ancestor `<li>`**, whose name
  concatenates every descendant's text; `[1]` `listitem` labelled `"Release notes"`; `[2]` `link`
  labelled `"Release notes"` — the actual target.
- The caller took `matches[0]`. Its rect is `{x:85.6, y:172.64, w:149.79, h:41.6}` — **pixel-identical to
  the trigger's box**, because the submenu `<ul>` is `position:absolute` and contributes nothing to the
  `<li>`'s in-flow box.
- Dispatched point, read back from the page's own capture-phase click listener: **`{x:160, y:193}`** —
  exactly that `<li>`'s centre.
- The submenu link's real box: `{x:86.4, y:255.84, w:192, h:36.8}`, centre ≈ `182, 274`.

**So every layer below `find` behaved correctly.** `locateInFrame` returned the right rect for the ref it
was given; the delivery dispatched the exact centre of it. The defect is that **`find` ranks a containment
match on an ancestor above an exact match on the control itself**, and it does not refuse as `too-broad`
either, so a caller taking the first match clicks a container whose box is the trigger's.

This also retires the frame-offset theory for this case and, with it, the argument for re-architecting
delivery around per-target dispatch **on the strength of this defect**. The Codex reading stays on file as
a design option, not as this bug's fix.

**Second defect, independent and pre-existing (B64).** The browser-level `key` tool has answered
`verified: false` unconditionally since T123: `effect-verification.ts:164` requires
`executed.focusRetained === true`, `deliverKeyboard`'s key-press branch never sets it, and `input.ts`'s
`press()` returns `Promise<void>` — **`focusRetained` has no producer anywhere in the 004 path**. Proven
structurally rather than by bisect, because **this workspace has no git history** (`git status`: not a
repository), so there is no before/after to run. Worth remembering: no brief can be asked to bisect here.

**Update (2026-09-10, B65): both measured defects fixed; 003's journey unlocked a long way.**
`find` now collapses ancestor chains by real DOM containment before the `too-broad` bound is evaluated and
ranks an exact-name match above a merely-containing one — `too-broad` for genuinely distinct siblings
(002/FR-026) untouched. `key` now produces `focusRetained` via the same page-side primitive the click
confirmation uses, rather than the check being dropped.

`agent-actions.spec.ts` now passes click, type, scroll, key, hover, **double_click, drag, right_click,
triple_click** and form_input, all `verified: true` — the last four had never been reached in two runs. It
now fails further along, at `read_page({filter:"interactive"})` on the form fixture returning no checkbox
named `"agree"`, which B65 rightly refused to chase under its time box.

One thing to revisit: the focus check carries a fixed `sleep(50)` found empirically against the real
browser (the dispatch resolves before the renderer settles focus). Real race, right instinct, fragile
constant — a bounded poll is the durable form.

**Update (2026-09-10, B66): 003's journey is fully green again, claims 1 and 2 pass for the first time,
and claim 3 is now the single remaining defect — reporting itself.**

The checkbox was `offscreen`, measured (viewport 666px, element at top 1077) — the same class as the
frames fixture, so the fixture moved and the assertion did not. The focus check's fixed `sleep(50)` is now
a bounded poll with its own red test. `agent-actions.spec.ts` — 003's whole journey and our regression
floor — passes **1/1** end to end.

**Claim 3, the nested-frame click, is the one thing left, and the honesty fix is earning its keep.** Where
B60 saw a false `verified: true` with nothing hit anywhere, the same click now delivers and answers
**`verdict: "target-missed"`**. `find` resolves the grandchild cleanly, so B65's ranking fix is not
implicated and did not cause this. It is a real two-level frame offset defect (R-114), and it now
announces itself instead of lying — which is exactly why that fix went first.

Claims 4 and 5 have still never run; they sit behind claim 3 in the same sequential test.

**Update (2026-09-10, B67): the offset defect is confirmed, measured and fixed — and a second one was
hiding behind it.**

The composed offset was wrong by **(+80.4, +350.15)**: true `{x:94, y:550.775}` against our chain's
`{x:174.4, y:900.925}`. The by-order sibling pairing was exactly the mis-key its own comment warned about.
Fixed the way both references pointed: a same-origin chain of any depth now composes **in-page**, each
frame walking `frameElement` up to the top, addressed by Chrome's own frame ids so no pairing is possible.
Verified three times at three window sizes. Cross-origin still falls back to the CDP chain, deliberately
untouched. `agent-actions.spec.ts` stays green.

**Claim 3 is still red, and now every number is right**: frame-local rect exact, offset exact, dispatched
point exact, and `elementFromPoint` **inside the grandchild document** at the local point finds the button.
Yet the verdict is `target-missed` and the echo never fires.

**Checked and eliminated (main session):** handle collision between the two identical grandchild documents.
Handles are 16 random bytes (`mintTargetHandle`), so a ref cannot be claimed by the wrong frame.

**Live hypothesis, and it is the one the reference already answered.** The grandchild's content can sit
outside the *visible box of an ancestor iframe* — a 320px-tall child frame cannot show content 700px down
the top viewport. Hit-testing inside the grandchild document is unaffected by that clipping, which is
exactly why `elementFromPoint` finds the button while a real click at the composed top-level point does
not. The G5 correction records that the reference calls **`scrollIntoView({block:"center"})` before
measuring** and that we do not — this is the class of failure that mitigates.

**Update (2026-09-10, B68): the clipping hypothesis was exactly right, and the reference's own habit was
the fix.** Measured: composed point `{x:169.46, y:710.6}`, top viewport height **666**, child iframe box
ending at y=669.35 — the point fell outside the viewport entirely and the top document's
`elementFromPoint` there returned **null**. Hit-testing inside the grandchild document was unaffected by
that clipping, which is why every number looked exact.

Fixed by doing what the reference has always done and we never did (G5 correction):
`scrollIntoView({block:"center"})` on the target, in the frame that owns it, **before** its rect is
measured — threaded as a flag set only by the one collection a delivery computes a coordinate from, so
`find` and `read_page` never scroll the owner's page. The browser cascades the scroll up through the
nested iframes on its own. **The click now genuinely lands**: the fixture's own echo reads
"grandchild clicked" in the failure screenshot.

**One defect left on this claim, and it is now a false negative rather than a false positive.** The
post-click confirmation answers `target-missed` for a click the page itself proves landed. That is the
safe direction to be wrong in — it under-claims rather than lying — but it is still wrong and it is what
blocks claims 4 and 5 from ever running.

**Update (2026-09-10, B69): the input journey is GREEN, 1/1 — all five claims, including 4 and 5 which
had never once run.** Root cause of the false negative was the epoch: the confirmation compared the
grandchild's freshly-probed epoch against the **top document's** epoch, so `resolveHandleOnTab` refused
with `stale-context` before `elementFromPoint` was ever asked. Each document mints its own epoch, and the
point-confirmation path never carried the frame's own alongside its rect. Fixed by threading the claiming
frame's epoch from locate through to confirm, the pattern `refs.ts` already used. The "refuse, not pass"
property is intact — a document that really does navigate between locate and confirm is still refused;
we simply stopped comparing one document's freshness against another's.

The implementer also strengthened the fakes: each frame now answers with a **distinct** epoch, where
before every frame shared one and this class of bug was structurally invisible. That is the same lesson as
the rect fakes that were "correct by construction".

**Regression, and it is mine (main session, verified in code).** `agent-actions.spec.ts` now fails at
`drag` (`not-moved`), having been green in B65 and B66. `deliverPointer` decides movement by
`after.x !== from.rect.x || after.y !== from.rect.y` — it re-locates and compares. B68's `scrollIntoView`
runs on **every** locate, so the re-measure re-centres the element to the same place it centred it before,
and a genuinely moved element measures identical. The scroll normalises the very difference the check
exists to see.

Two properties the fix must hold: a locate whose purpose is to **verify** must not scroll, and a
multi-point effect must measure **all** its points in one scroll state or its coordinates disagree with
each other.

**Update (2026-09-10, B70): both journeys GREEN. T128's claims are all closed.**
`agent-actions.spec.ts` **1 passed** (drag genuinely reorders the list and reports `verified: true`);
`agent-input.spec.ts` **1 passed**, all five claims.

The scroll is now an explicit `scroll: boolean` at the call site rather than something inferred from the
effect — a verify-only remeasure never scrolls. **And property 2 was real, not theoretical**: with only
property 1 fixed, drag still failed live, differently — each endpoint's own `scrollIntoView` shifted the
page, so `to` was measured in a scroll state `from`'s coordinates no longer matched, and the tool reported
`moved: true` while the list never reordered. A drag now resolves both endpoints *before* locating either,
scrolls once, and remeasures without scrolling.

**Still open, and it is the last one in this path:** the paid frame-click scenario answers `click-missed`,
now via `target-not-located` on the **cross-origin** frame, followed by `bridge-lost` on the next call.
Cross-origin was deliberately left on the old CDP fallback when the same-origin path moved in-page (B67),
so this is the untouched half. The `bridge-lost` is its own concern and should not be waved past.

- [X] T128 [US5] Packaged attach-mode journey `tests/e2e/packaged/agent-input.spec.ts`: hover opens the CSS submenu and it is clickable; per-key typing shows the combobox suggestions; frame button click lands (`frames.html`); DevTools-attached tab answers `input-unavailable`; `ask` mode still prompts once per effect
**Result note (2026-09-10, B49)**: five scenarios written; **only S3 was run**, deliberately — the free
measurements showed the others would buy a known failure. The containment verdict worked end to end for
the first time (`probe-004/reports/004-2026-09-09T20-55-53Z.md`, 1/1), and B49 refused to celebrate it:
**the pass is vacuous**. The browser tree captured for that page names 0 headings and 0 links, because
the accessibility query on the page target does not reach the artifact's cross-origin frame — so the
half of SC-033 the scenario exists for was judged 0 of 0. The agent's own answer shows the capability is
real (209 nodes, 201 of them from the frame), but the *check* is blind exactly where the feature
matters. → **T129a**.

**Three decisions (main session), all forced by B49's free measurements:**
- **The probe must set a site's mode, the way it already establishes its own pairing.** An undecided
  site sends every effect to an owner prompt, and an unanswered prompt times out — so every S4 scenario
  and the reference-lifetime one would fail unattended for a reason that has nothing to do with what
  they test. Setting the mode is the same class of environment step as pairing, and the acceptance
  standard's promise is that nothing is left for the owner. A scenario that is *about* consent sets
  `ask` explicitly and answers the prompt itself, as S2's already do. → **T129b**.
- **The baseline must reach cross-origin frames**, or containment cannot judge the one capability this
  feature exists for. → **T129a**.
- **Containment must not be defeated by transcription.** The extension names a control with a trailing
  private-use icon glyph where the browser's tree does not; raw containment scored 3 of 4 while the paid
  run scored 4 of 4 only because the agent silently transcribed the visible text without the glyph. A
  check that depends on an agent's transcription is not a check. Normalise both sides — strip
  private-use and formatting characters before comparing. → **T129a**.

**B49's predicted hard red for SC-036, measured free and recorded rather than run**: on the repository
page, containment would be **28 of 137** headings and links and **7 of 14** controls, with names like
"Latest commit", "About" and "Repository files navigation" missing, against a browser tree of 995
visible nodes where the full read returns 86. So the structural walk is still far short of the page.
→ **T137a**, and it needs a measurement before a change.

- [X] T129a [US5] Make the containment check able to judge what it claims: capture the accessibility tree of **each frame's own target**, not only the page's, so a cross-origin frame's headings and links are in the baseline; and normalise both sides before comparing (strip private-use and formatting characters, collapse whitespace, fold case) so a name cannot match or miss on a glyph an agent transcribed away. Red test first for each half
- [X] T129b [US5] Let the probe establish a scenario's site mode as part of its environment, recorded in the report, the way it already establishes pairing — so an effect scenario measures the effect rather than an unanswered prompt. A scenario about consent keeps `ask` and answers its own prompt
- [X] T129c [US5] The site-mode store has the **same cache defect T111f fixed for pairing**: it holds its state for the worker's lifetime with no `chrome.storage.onChanged` invalidation, so the mode the probe writes is only guaranteed to be seen by a worker that has not already read that site — which would make T129b silently ineffective. Mirror the pairing controller's watch. Red test first: an external write followed by an unrelated read must not lose the external change
- [X] T137b [US6] **Decided (main session).** Three changes, together: `truncatedBy` gains `depth`, so an agent told "truncated" can learn which limit to raise; `filter: "all"` applies **no depth default** — it is the read that asks for everything, and a caller may still pass a depth; and the depth ceiling rises past what a real page needs, because 32 provably cannot reach one. The default read keeps its depth: it is a working list, not the page. Contract test first
- [X] T137a [US6] Measure, free, why the full read returns 86 nodes where the browser's tree has 995 visible on the same page, and report the mechanism before changing anything. Candidates to rule in or out: the collection's own node bound, the viewport filter reaching the full read when it should not, and elements the walk still does not name. SC-036 depends on the answer
**Result note (2026-09-10, B50)**: the probe now sets a scenario's site mode from the scenario file,
writing only that site's entry and preserving the rest, with the modes it decided printed in the
environment table — so a reader knows what the run assumed. The consent scenarios declare nothing and
keep answering their own prompts. The containment baseline now opens **each frame's own target** and
merges, so the artifact's cross-origin frame contributes the headings and links whose absence made the
last run's `0 of 0` a vacuous pass; and both sides of a name comparison are normalised, so a
private-use glyph can no longer decide a match — the check no longer depends on what an agent
transcribed. unit 1193/111.

**T137a stopped at the honest place.** On the repository page the browser exposes 995 nodes and the
agent's own selector matches **586** on the same document, so neither the collection bound (two orders
of magnitude above) nor the viewport filter (guarded to the default read) explains a read of 86. Of the
three names B49 saw missing, one *is* matched by the walk and two match nothing at all. **The 586 → 86
step is unexplained**, and B50 refused to change the walk without the mechanism: the two live candidates
— a `filter` argument lost on the wire versus a drop inside the collection — call for different fixes.
It is measurable free, through the real server over stdio the way B45–B47 measured. → folded into
**T137a**'s next brief.

**B50 also found a defect that would have made its own work ineffective**: the site-mode store caches
for the worker's lifetime with no change notification, exactly as the pairing controller did before
T111f — so a mode written from outside is only seen by a worker that has not already read that site.
→ **T129c**.

**Result note (2026-09-10, B51)**: the site-mode store now sees writes from outside, proven live — the
environment table printed the two modes the run set and **no effect hit an owner prompt**. The node gap
is measured and the mechanism is mine: **the depth default of 15 applies to `filter: "all"` as well**.
On the repository page the selector matches 587 elements; depth 15 yields 86, depth 20 yields 194, and
depth 32 — the ceiling a caller may ask for — yields 550, with 35 elements deeper still. So the full
read cannot reach a real page even at its maximum, and `truncatedBy` names nothing, so the agent is told
"truncated" without being told what to raise. The collection bound and the walk are both ruled out: at
depth 32 the walk names 550 of 552 eligible elements. **That 15 came from the reference, which builds an
accessibility tree where generic containers are collapsed — a DOM walk's depth is not the same measure,
and I took the number without its premise.** → **T137b**.

**The S4 run failed on the harness, not the capability**: both scenarios ended `stop_reason: tool_use`
with exit 1 at $0.34 of a $0.50 cap, i.e. the **12-turn budget ran out mid tool call**. A seven-step
scenario plus the environment turns does not fit in twelve. Hover and per-key typing remain unobserved
on a real page, nothing was adjusted, and about $0.68 bought no observation — the lesson is that a
scenario's turn budget has to fit the scenario. → **T129d**.

- [X] T129d [US5] Give a scenario its own turn budget, defaulting high enough for a multi-step one, and keep the dollar cap as the real guard — a turn limit that cannot fit the steps spends the money and buys nothing. Then re-run the S4 slice
**Result note (2026-09-10, B52)**: depth is fixed and the numbers are decisive. A full read on the
repository page now returns **585 nodes reaching the file table, README and CHANGELOG** instead of 86
stopping at the header; `truncatedBy` finally says `depth`, so "truncated" is actionable; the default
read keeps its depth and stays the working list. The new ceiling is 64 because that is the deepest
nesting the product can *express* — and the page's own deepest matched element sits at **33**, so the
old ceiling of 32 was literally one level short of a real page. The turn budget defaults to 40 and the
literal 12 was removed from every scenario, so a scenario states a turn count only when it wants to stop
sooner; the dollar cap stays the guard. Both S4 scenarios completed all seven steps this time instead of
dying at turn twelve. unit 1196/111.

**A new, real defect, and it is what both S4 scenarios died on**: a reference `find` has just resolved
is rejected by the effect tools as `target-not-located`. On the navigation page, `find` returned
`role=button label="Web APIs"` and the hover answered `failed/target-not-located` without executing —
the page was unchanged, 471 nodes before and after. On the search page the same shape: `find` resolved
the search box, and typing answered `failed/target-not-located`. So the two items the owner ranked first
are still unobserved, and the cause is between find and act rather than in either. → **T129e**. (B52
also flagged that the ref's form is not the `f<frame>-<n>` shape the data model describes — that is
expected and not a defect: the worker-side naming layer was deliberately removed in B41 and the
page-side handle, which already has every property required, is what an agent sees. The data model
should be corrected to say so; mine to do.)

- [X] T129e [US5] Diagnose why an effect refuses a reference `find` has just resolved (`failed/target-not-located`), then fix it. Free to measure — drive the real server over stdio as B45–B52 did, no agent quota. Note that reads and find were made frame-aware in S3 while the effect path's resolve was deliberately left addressing the top frame, and that references became per-document and persistent in S5; either is a candidate, neither is a conclusion. Build the red loop first
**Result note (2026-09-10, B53 — T129e)**: one line, and the mechanism was never about the reference.
The effect path asked each document for its **structure without its target metadata**, and that second
category is the only thing that puts a handle on a collected node — so every node came back nameless,
the handle comparison could never match, and the refusal was decided before a pointer or key was ever
sent. Both candidate stories are discarded: it reproduces on a single-document page where no frame
offset is measured at all, and the handle `find` returns is byte-identical to the registry's.

**Why every suite was green is the more valuable half**: two different lies, both about the *collection*
rather than the reference. Some suites inject the locator wholesale, so the defective request never
runs; the one that does exercise it had a fake returning a **named** node regardless of what the
request asked for — describing a document nobody has, one that names its elements when the collection
did not ask for names. Making the fake honour the request is what turned the tests red.

**Measured free, before and after**: hovering a link on a plain page went from `target-not-located` to
`verified`; and on the search page, typing now answers `text-entered, verified, charactersChanged: 7`
with the page growing 1381 → 1405 nodes and the suggestion list among the additions — which is exactly
what that scenario exists to observe.

**Still open, and a different mechanism**: the documentation navigation's hover now executes and
verifies, but its submenu does not open — nothing added, 471 nodes before and after, even with a settle.
Its trigger's role is *button*, which suggests a menu that opens on click rather than on hover, i.e. the
page may be the wrong choice rather than the capability being absent. Establish that free before another
paid run. → folded into **T129**.

**Certificate reissued by the owner's authorisation, 2026-09-10** (`E8F468D4…`, verify clean), so the
packaged journeys are unblocked.

**Result note (2026-09-10, B54) — the hover scenario had two independent reasons it could never pass,
and both were mine.** First, the page: the documentation navigation's menu is **click-driven**, proven
three ways — no pointer listener on the trigger or any ancestor, no CSS rule anywhere on the document
that opens a descendant of a `:hover`, and a trusted pointer move leaving visible links at 0 while a
trusted click takes them to 13. Second, the observation channel: **`filter: "all"` keeps hidden nodes**,
so a menu that opens by *becoming visible* sits in the read both before and after and adds nothing — the
scenario read `all` on both sides, so a perfectly working hover would still have scored "absent".

The page is now one whose stylesheet was **checked before it was chosen** (a rule that opens a submenu
on `:hover`, matching exactly one trigger and one submenu on the live document, with no event listeners
anywhere on it), and the observation is the visible read. **The capability is already proven free**: one
hover took a nav item from 1 to 17 visible links, and the visible read's additions were the submenu's
own items. B54 stated the distinction I asked for without being prompted twice — the expectation is
untouched; what changed is a fixture that provably cannot exhibit the capability and a channel that
provably cannot see it, and it said that choosing a fixture which can show the capability is not
weakening the claim while adjusting the expectation would have been.

**Result note (2026-09-10, B55) — hover passes on a real site; the typing scenario never reached its
own claim.** Report `tests/acceptance/probe-004/reports/004-2026-09-09T23-37-14Z.md`.

- **`s4-hover-nav` PASS.** `find` resolved the trigger, `hover` answered
  `{"effect":"hovered","documentChanged":false,"verified":true,"verdict":"verified","targetVisible":true}`,
  and the visible node count went **28 → 36**, the four additions being the submenu's own items. This is
  the capability the owner ranked first and it is now observed end to end by a real agent on a real page.
- **`s4-wikipedia-typing` FAIL, but not on the capability.** The scenario's opening
  `read_page(filter: "all")` on a very large article came back as 175,083 characters, over the transport's
  inline ceiling, so it was spilled to a file the probe agent has no permission to open. It spent ~$0.38
  of its $0.50 cap trying, and `find` / `type` / the after-read never ran. Nothing was adjusted.

**Finding worth keeping, and a correction of my own first guess.** I suspected no default character cap
was applied; that is wrong — `capPageNodes` defaults to the 50,000-character ceiling and it was applied.
The caps count **node text**, while what the transport measures is the **serialized answer**, whose size
is dominated by per-node overhead (ref, role, href, frame label, depth) across up to 10,000 nodes. So a
read can sit inside both documented ceilings and still be too large to return. Whether that needs a
product fix is a real question, and the honest way to answer it is the GitHub capacity scenario (T137)
rather than changing a ceiling now on one page's evidence. The scenario itself opens with `filter: "all"`
for no reason — a typing claim needs the interactive read — so that is the scenario fix.

`s4-artifact-click.json`, named in this task line, still does not exist.

**Update (2026-09-10, B57): typing now passes; the third scenario is blocked on a real finding.**
`s4-wikipedia-typing` opened with `filter: "all"` for no reason a typing claim needs; steps 3 and 7 now
read `interactive`, `expect` and `answerSchema` untouched, and it came back **`suggestions-shown`,
verdict done 1/1** (`reports/004-2026-09-10T00-15-08Z.md`). Per-key delivery is now observed on a real
public site by a real agent, which with `s4-hover-nav` closes both of the capabilities the owner ranked
first.

**`s4-artifact-click.json` cannot be written against its pinned page.** A free read of the artifact
oracle shows its frame carries only `heading`, `paragraph`, `table`/`row`/`cell`/`columnheader`,
`list`/`listitem` and `main` — **no interactive role anywhere inside it**. There is nothing there for a
click to land on. B57 stopped rather than inventing a fixture or silently swapping the oracle, which was
the right call.

**Decision (main session):** the act half moves to a different real public page, and this is not a
weakening. SC-033's act half claims that *a click inside a frame lands with the frame's offset applied*;
any real cross-origin frame holding a real control proves exactly that. Pinning it to the artifact page
was my own over-constraint — that page is the oracle for the **read** half because that is where the
owner's E4 failure was observed, and the read half stays pinned to it. The replacement is chosen the way
the hover page was: measured free first, and it must have a genuinely cross-origin frame whose offset is
**not** zero, since the offset is the whole point of the claim.

**Update (2026-09-10, B58): the replacement page is chosen and measured; the run is the one step left.**
`developer.chrome.com/docs/devtools/overview`, whose single embedded frame is a `youtube.com/embed/...`
document — genuinely cross-origin, and the only frame on the page (a first candidate was rejected for
carrying two identically-labelled controls, which would make `find` ambiguous). Frame box
`{x: 329.58, y: 478.23, w: 853.85, h: 480.29}`, control box `{x: 720.78, y: 682.23}` — **offset well away
from the top-left**, which is the point of the claim. A real click flips the frame's tree from
`button "Play video"` to `button "Pause video"` plus the full control set, so the state change is
page-authored and unmistakable. `s4-artifact-click.json` is written; it has not been run.

**Update (2026-09-10, B59): the frame-click scenario ran and FAILED, and this one looks like a real
product defect rather than another fixture problem.** Observed `click-missed` against `click-landed`
(`reports/004-2026-09-10T01-17-26Z.md`). The agent's click answered
`{"outcome":"failed","reason":"target-not-located"}` **for a ref `find` had just resolved inside the
cross-origin frame**, and the pre/post reads were byte-identical (42/42 nodes, nothing added or removed),
so nothing was delivered anywhere.

This is the same words as the B53 failure but not the same cause — that one was a collection asking for
structure without target metadata, and it is fixed and commented in `locateInFrame`. Here `find` resolved
the ref, so the frame's registry minted and still holds it; what failed is the effect's own
handle-to-rect lookup afterwards.

**Do not conclude from one observation.** The decisive experiment is free: the same click inside a frame
on our own `frames.html`, which is claim 3 of the input journey and **has never run** — the journey aborts
at claim 1. If the fixture frame click works, the defect is specific to that embedded player's document;
if it fails too, clicking inside *any* frame is broken, which would be one of the owner's four original
failures still open. Run that before spending another paid scenario. **S4 is not closed.**

**Update (2026-09-10, B71): the cross-origin failure reproduces free on our own fixture, and it is the
twin of the epoch bug.** Neither packaged spec had ever clicked into `frames.html`'s cross-origin child —
`agent-frames.spec.ts` only reads it, and claim 3 clicked the same-origin grandchild. A new claim 3b now
does, and fails reproducibly with `{effect:"activated", verified:false, verdict:"target-missed"}` — no
paid run needed to see it.

All four hypotheses in the brief were instrumented and **ruled out**: the content script does run in that
frame; the handle and rect are right (frame-local `{x:16, y:123.6, w:84.85, h:21.2}`, exactly the
button's box); the CDP fallback offset is **correct** (`{x:78.8, y:305.26}` against a true
`{x:78, y:304.46}` — sub-pixel); and the click physically lands (the fixture's own echo reads
"child clicked" on the very call reported `verified:false`).

**The real cause is the other half of the check B69 fixed.** `resolveHandleOnTab` compares the asked
frame's own `canonicalOrigin` against `input.canonicalOrigin`, which is always the **top tab's** origin.
For any genuinely cross-origin frame that mismatch is structural, not racy, so confirmation always answers
`stale-context`. B69 threaded the frame's own **epoch**; the **origin** was never threaded, and nothing
exercised it until a click reached a second origin. The sibling resolver `resolveOnActiveTab` already
takes an explicit `frameOrigin` for exactly this reason.

**Update (2026-09-10, B73-B75): input now reaches a genuinely cross-site frame. All three packaged
journeys green.** The platform question was settled by measurement (B73): from the extension's own service
worker, `Target.setAutoAttach {flatten:true}` yields a `sessionId` per OOPIF, `sendCommand({tabId,
sessionId})` is accepted, and a click at the frame's **own** coordinates fires its handler — no
composition at all. A bare `{targetId}` is refused; the pair is the working form.

B74 added a **true-OOPIF fixture** (`localhost` parent, `127.0.0.1` child) and proved it out-of-process
**differentially**: the new fixture's child appears as its own CDP target, the old `frames.html`'s children
never do. Our suite had never exercised one — every "cross-origin" claim so far was cross-origin but
**same-site**.

B75 routed delivery. The correlation problem — which of *our* numeric frames a CDP session belongs to —
was solved by planting a nonce in a specific frame and reading it back through each session with one
bounded `Runtime.evaluate`. Candidate 1 (target id as frame id) was rejected with a reason: it collapses
back into the by-order pairing we removed. Exact by construction, skipped entirely when a tab has no
session.

**Two things for the owed S4 review, recorded now so they are not lost:**
1. **The nonce is planted in the page's MAIN world.** Page scripts can therefore read it. Frames of one
   page can `postMessage` between themselves, so a hostile page could in principle echo another frame's
   nonce and mis-correlate a session — steering input to a frame the agent did not choose. Whether that is
   reachable, and what it would cost, is exactly a fresh-context question.
2. `Target.setAutoAttach` widens what the attachment can reach. The session is documented as carrying
   input dispatch only, with the one bounded nonce read as a stated exception — that module-doc line is
   what a reviewer should test the code against.

**Disclosed gap (B75, honest):** keyboard dispatch still goes through `{tabId}` unconditionally, so typing
into a field inside a true OOPIF may not land. Only the click is tested.

**Update (2026-09-10, B82): the refusal now carries its reason; the run that reads it is still owed.**
Two answers that were one are now split, on the principle the confirmation was built on, one level deeper —
*do not report a thing you did not observe*:

- **`target-missed`** — we asked, and the point was over something else. It now carries **what was there**,
  bounded exactly the way `find`'s candidates already are.
- **`target-unconfirmed`** — the round trip was refused upstream (the `stale-context` family, already the
  cause twice: epoch in B69, origin in B72). Calling that a *miss* was a lie: we do not know that it
  missed. It has its own closed cause now, and `verified` is unchanged in strictness.

typecheck clean end to end, unit 1213, contract 226. The packaged specs and the paid run did **not**
happen: all four packaged tests failed waiting on the pairing prompt, which is environment state, not this
change — earlier briefs ran the same specs green. Stale `mcp-server.js`/`native-host.js` processes and a
`dist/agent` rebuilt but not force-reloaded have both caused exactly this before.

**One gap to close before the answer is worth reading:** the miss detail reuses `readLiveTarget`'s name —
the HTML `name` attribute — not the accessible name the collector computes for an ordinary read. On a
player control that attribute almost certainly does not exist, so the answer would come back blank and
tell us nothing. It must reuse the collector's existing name computation; that is not a new design, it is
the one already used everywhere else.

**Update (2026-09-10, B80/B81) — tree clean and green; a fourth theory dead; the live page is still
unexplained.** The stalled session's instrumentation is fully removed and the `resolve-point` logic was
read and confirmed untouched. `npm run typecheck` was **red** on four `exactOptionalPropertyTypes` errors
in `input.ts` from B76's keyboard-session threading — B76 had reported typecheck clean, because the root
`tsc -b` project list does not include `apps/extension` at all, and the script's `&&` chain never reached
the tests project either. Both fixed; typecheck is now clean end to end. **Worth remembering: "tests
green" and "typechecked" are not the same claim in this repo, and one command gives false comfort.**

Local reproduction of the real target's shape — a button with a descendant covering its centre, inside a
true OOPIF — **passes** (`verified: true`), in both the OOPIF and the same-site cross-origin case. So that
is not the difference either.

**Four theories are now dead by measurement:** the rect does not go stale; session routing works; the
target is not hidden under an overlay; and a descendant inside the button does not break it. The capability
is proven locally end to end — click **and** type into a genuine out-of-process frame, asserted on the
frame's own page-authored echo. What remains unexplained is one paid scenario on one heavy live page,
where the click demonstrably works (the video starts) but our confirmation disagrees.

**The decisive question is still the one B79 stalled on: did `content.resolve-point` run at all?**

**Update (2026-09-10, B78) — the overlay theory is probably wrong too, and the two measurements
disagree in an informative way.** Driving the **real** production `find`+`click` over stdio reproduces
`target-missed` exactly, on the same control and the same rect. But hand-driving the same control with
Playwright shows `elementFromPoint` at the target's centre returning a `<div>` that is a **descendant** of
the target `<button>` — and the video's `paused` flipped `true`→`false`, so the click functionally worked.

**A descendant is already a hit.** The confirmation has treated `targetElement.contains(element)` as
success since the B63 descendant fix, so if the production click really resolved to a descendant it would
have answered `verified`. It did not. So the two paths are not seeing the same thing, and the
"overlay covers the button" story does not survive.

B78 refused to pick a branch on that evidence, which was right. It also could not correlate the two reads
because several stray same-URL tabs from earlier runs made tab matching ambiguous — a harness problem, not
a product one.

**The method that actually works here is already proven:** B77 instrumented the worker and read its own
console over a second DevTools socket. That gives the confirmation's own inputs and answer directly,
instead of inferring them from two external observations that may not be the same click.

**Correction (2026-09-10, B77 — my B76 hypothesis was wrong, and it was measured, not argued).** The
page does **not** move between measuring and dispatching. Instrumented on the real failing page: the
target's rect at locate time was `{x:395.6, y:207.2, w:72, h:72}` in the frame's own coordinates
(`frameId 1433`, origin `https://www.youtube.com`, a real OOPIF session), and **byte-identical** 27 ms
later. There is no staleness window to close — in fact the production path has no round trip there at all;
the 27 ms was the diagnostic's own second measurement. So shortening the path and adding a retry would both
have fixed nothing, and B77 stopped rather than build them. Exactly right.

**The detail that matters is in the after-read:** the clicked control became **"Show player controls"**,
not "Pause video". Something did change in the player. That is not the signature of a click landing
nowhere; it is the signature of a click landing on **something else that is legitimately on top** — an
embedded player's overlay covers its own button, so `elementFromPoint` at the target's centre answers with
the overlay, and our confirmation calls that a miss.

If that is what is happening, the confirmation is over-strict rather than wrong: a real user clicking the
same pixel also hits the overlay, and the page decides what that means. "The point was over the target's
box but another element is on top" is a different fact from "the point was somewhere else entirely", and
only the second is a miss.

**Update (2026-09-10, B76): the keyboard half is routed too; the capability is proven end to end on a
true OOPIF.** `Input.dispatchKeyEvent` and `Input.insertText` now carry the session the focusing click
resolved. The OOPIF fixture gained a text input with a page-authored echo, and the packaged claim now
clicks **and types** into a genuinely out-of-process frame, asserting the frame's own echo reads back the
characters. All four packaged tests across three specs pass. Everything else that dispatches on `{tabId}`
was checked and is correct by design: the geometry chain never sees an OOPIF, and the `computer` tool is
deliberately viewport-coordinate and tab-level.

**The paid scenario has moved up a level, and the new failure is about real pages, not about frames.**
It now answers `target-missed` (the confirmation ran and said the point hit something else) where it used
to answer `target-not-located` (nothing could be located at all). So the session routing works on the real
site too. What fails is that the page **moves between our measurement and our dispatch**: the before/after
reads show a large set of unrelated top-page nodes changing across the click.

This is the last structural difference from the reference on this path. Claude in Chrome scrolls **and**
measures **inside one injected function**, returning the coordinates from that single call. Ours scrolls
during a collection, returns a rect, computes a point, and dispatches — several round trips, and a heavy
page reflows inside that window. Note also that the confirmation we built is what makes a *safe* retry
possible at all: without it a retry would be blind, and a blind retry on a moving page is how an agent
clicks something nobody asked for.

**ANSWERED and CLOSED (2026-09-10, B83).** The click tool's own answer, verbatim:
`{"effect":"activated","documentChanged":false,"verified":false,"verdict":"target-missed","clicks":1,
"role":"div"}` — and the scenario's own page evidence: `removedAfterClick` contains **"Play video"**,
`addedAfterClick` contains **"Pause video"** and the full control set. Report
`reports/004-2026-09-10T12-08-24Z.md`. **`observed: click-landed`, scenario passes.** All three S4
scenarios now pass.

**So B78's overlay theory was right after all** — it was the hand-driven measurement that misled us, not
the theory. The topmost element at the point is a **nameless `div`**: the embedded player's own
click-catching overlay, sitting directly over the button. The empty label is not the blank-label bug it
would have been before B83's fix: that div genuinely has no aria-label, title, alt, caption, own text,
name or placeholder, so the collector's own name computation honestly returns nothing.

**The click functionally reached the real control.** Our confirmation is **over-strict on this page**, not
wrong about what is on top. It is also no longer blocking anything, so it does not get fixed under time
pressure.

**Follow-up recorded, deliberately not done now:** should "the point hit an anonymous element that covers
the target's own box" be told apart from "the point was somewhere else entirely"? A real user clicking
that pixel hits the same overlay, and here the intended control did activate. But an overlay can equally
be a modal that legitimately blocks the click, and the two are geometrically identical — so this is a
design decision about what the agent is told, not a bug. The honest shape is a third distinction alongside
`target-missed`/`target-unconfirmed`, leaving the verdict unverified in both while telling the agent it
was covered, which is actionable: it can read the page and see whether the effect happened.

- [X] T129 [US5] Probe scenarios `s4-hover-nav.json` (MDN/Bootstrap → SC-034), `s4-wikipedia-typing.json` (SC-034), `s4-artifact-click.json` (click inside the artifact frame → SC-033 act part); run `--slice S4`; attach report; archive guard

**Checkpoint**: hover, per-key typing and acting inside frames match the reference on real pages.

---

## Phase 8: S5 — User Story 6: Read once, use many times; read the whole page (Priority: P2)

**Goal**: persistent weak registries and opaque refs (R-115); reference bounds, fields, `max_chars`, viewport filter (R-116); open shadow roots (D-004-5).

**Independent Test**: three reads on the GitHub page and a first-read ref still clicks; node count within 10% of the baseline; a control inside an open shadow root is listed and clickable.

- [X] T130 [P] [US6] Unit test `apps/extension/tests/registry.test.ts` (jsdom): an element keeps its index across collections; a disconnected element is pruned and its ref answers `stale`; a new element gets a new index, never a recycled one; the registry dies with the document
- [X] T131 [US6] Implement `apps/extension/src/content-runtime/registry.ts` and switch the collector to it (make T130 green)
- [X] T132 [P] [US6] Unit test `apps/extension/tests/refs-opaque.test.ts`: the worker mints `f<frame>-<n>` from (frame label, index), resolves it back, answers `stale-reference` for a gone element or a navigated frame, and never reuses a ref for another element; a later `read_page`/`find` leaves earlier refs valid
- [X] T133 [US6] Amend `apps/extension/src/service-worker/agent-tools/refs.ts` (make T132 green); remove the per-read replacement and its tool-description sentence in `agent-tools.ts` (003 M6 limitation)
**Result note (2026-09-10, B40 — T130–T133)**: an element now keeps its handle across collections and
loses it only when it leaves the document. **Index recycling is proven impossible twice over** — after
three elements are removed and pruned, a new one takes an index none of them used and every retired
index resolves to nothing; and after a frame navigates the numbering moves past everything the previous
document was given, so an old reference answers stale forever rather than landing on a stranger.
**Weak holding is proven by exposing the holders**: the index-to-element hold is a weak reference and
the reverse a weak map, and the target records no longer carry the element at all, so a record can never
be the strong reference that keeps a removed node alive. Pruning stays per collection, so a wait for an
element to disappear still gets its answer between reads. A nice observation from the run: the contract
prose promising that earlier refs stay good was written ahead by B2 — until this slice it was a promise
the runtime did not keep. The 003 change-log entry recording the per-read replacement as a known
limitation is **superseded**. unit 1158/108.

**Decision (main session): drop the worker-side reference book rather than wire it.** B40 built it as
the mint/resolve seam but left it unwired, and correctly refused to do half the wiring — translating
refs on every path that sends one to the page would leave `find` and `read_page` speaking different
dialects mid-slice. The better answer is that the second naming layer is not needed: the page-side
handle already has every property FR-066 asks for — opaque, carrying no frame id, stable per element,
never recycled, and dying with its document — so a worker-side rename would add a translation surface
and no property. Remove it; unused machinery is worse than none. → folded into **T134/T135**'s brief.

- [X] T134 [P] [US6] Unit test `apps/extension/tests/collector-fields.test.ts` (jsdom): nodes carry `href`, `type`, `placeholder`, select `options`; open shadow roots are traversed (closed are not); interactive filter keeps only viewport-intersecting nodes, `all` keeps everything; depth default 15; 10,000-node and `max_chars` truncation reported with the limit
- [X] T135 [US6] Amend `apps/extension/src/content-runtime/collector.ts` and the read handler bounds (make T134 green)
**Result note (2026-09-10, B41 — T134/T135 + the removal)**: the unused worker-side naming layer is
gone with its test. Fields, open shadow roots, the viewport filter and the capacity all landed with
their own reds. **The ceiling was three ceilings**: below the merge's limit sat a second one in the
single-document branch and a third in the collection itself, so ten thousand nodes could never have
reached the merge — all three are now one function with one limits object, and a cut by filter or depth
still reports "truncated" with no limit named, because there is no limit to raise. The archive guard
earned its keep again: emitting a select's options broke the existing privacy assertion that a control's
content must never reach a review card, so the new fields are emitted only under the agent's collection
policy and the archived path stays byte-identical. unit 1162/108.

**Decision (main session) — a closed shadow root stays invisible, and that is recorded, not hidden.**
B41 reports that a caller cannot tell a control is behind a closed root: the node is simply absent,
indistinguishable from one that does not exist. Making it distinguishable requires *detecting* the
closed root, and the only API that does is the one D-004-5 chose not to use. Accept it: the reference we
follow for page reading traverses no shadow root at all, so open-root traversal already exceeds it, and
inventing a marker would mean reaching for the API the decision refuses. It goes in the spec's
Assumptions as a stated limit.

**Decision (main session) — the text read gets the same ceiling as the structured read.** B41 left
`get_page_text` at its old character bound with no caller argument while `read_page` rose to the
reference's. That is half a change: it would be odd for the structured read to return more of a page's
text than the text read, and an agent choosing between them should not have to know which is bigger.
Raise it to the same ceiling with the same caller-adjustable argument. → **T135a**.

- [X] T135a [US6] Give `get_page_text` the same character ceiling and the same caller-adjustable limit as `read_page`, so the two reads agree about how much of a page they will return. Contract test first; truncation reports the limit that applied, as the structured read does
**Result note (2026-09-10, B84) — three claims green, one real defect, and it is a specified answer the
code never produces.** Green: a first-read ref survives two more reads and still clicks (page-authored
echo); open shadow roots are traversed and the **closed**-root button is positively absent, which is the
intended behaviour and now asserted as such; a ~69,300-character fixture reports `truncated: true`,
`truncatedBy: "chars"` at the 50,000 ceiling, and `max_chars: 5000` cuts it further.

**Red: a removed element does not answer `stale-reference`.** It answers
`{"outcome":"failed","reason":"target-not-located"}` with no `refusal` object. The literal
`"stale-reference"` exists **only** in `packages/contracts/src/agent-tools.ts`'s refusal schema — grepping
the whole extension and contracts trees found **no code path that ever constructs it**. `refusalOutcome()`
maps only `stale-target`/`stale-context`/`stale-binding` to `outcome: "stale"`; everything else falls
through to `failed`. So a caller has no documented way to tell "your ref is dead, read again" from "I could
not find that anywhere", which are different next moves.

This is the first journey to exercise genuine **element removal** rather than navigation or document-change
staleness — the same pattern as every other slice in this feature: the first real run of a journey finds
something no unit suite could.

**CLOSED (2026-09-10, B85).** A ref whose element has left the document now answers `stale-reference`
with its refusal object, distinct from "I could not find that anywhere". The registry already knew the
difference — a handle it minted whose `WeakRef` no longer derefs, versus a handle it never saw — and the
collector now carries that fact out (`rootTargetGone`, captured **before** the prune retires the entry,
which is the subtlety: after pruning, the two cases look identical).

The cross-frame aggregation is the ordering the brief called out and it was implemented exactly: a frame
with a real rect wins first; failing that, **any** frame saying "gone" makes the page's answer stale, and
not-located only when **every** frame says unknown. Reversed, a dead ref in a framed page would have
reported as not-located.

All four claims green. Five packaged tests across four specs green; unit 1215, contract 226, typecheck
clean.

- [X] T136 [US6] Packaged attach-mode journey `tests/e2e/packaged/agent-refs.spec.ts`: three reads then a first-read click; removed element → `stale-reference`; `shadow-host.html` open-root button listed and clicked, closed-root button absent; a long fixture reports truncation by limit; `max_chars` raises the text
**Update (2026-09-10, B86): S5 ran, 1/3.** Report `reports/004-2026-09-10T12-58-42Z.md`. Both reds are
scenario-authoring, not product — and B86 said so rather than dressing either up.

- **`s5-github-refs` PASS** — `first-read-ref-resolved`. SC-035 is closed: a ref from the first read still
  resolves after a later read, on a real public page.
- **`s5-github-capacity` FAIL** — `agent-error: exit 1`, `total_cost_usd 0.5096`. The session was still
  mid tool-use when it hit its $0.50 cap. The scenario asks the agent to **copy every node name verbatim**
  on a ~1000-node page; the transcription, not the claim, is what costs the money.
- **`s5-shadow-page` FAIL** — `shadow-control-too-broad`. `find("Button")` answered `too-broad`, so no ref
  was ever obtained and the shadow-root traversal itself was never exercised. **No evidence either way on
  FR-068.**

Both existing scenarios were read before running and still match their criteria — `s5-github-capacity` is
the **containment** form (full read for headings and links, default read for controls), not the old
node-count ratio. Nothing to flag there.

**The lesson worth keeping from the shadow page.** Its uniqueness was verified free before choosing —
`Accessibility.getFullAXTree` showed exactly one node with role `button` and the exact name "Button" among
2337. But `find` does not match that way: it collided with a sidebar nav *link* also named "Button" and
with several unnamed `role=button` nodes. **Verify a query's uniqueness through `find` itself, not through
a proxy that matches by different rules.** The free measurement was right about the page and wrong about
the tool.

**Update (2026-09-10, B88): the baseline was corrected, and the real gap is a quarter the size it
looked.** The judge now checks headings, links **and** controls against the **full** read (SC-036
Amendment 2) — the default read is viewport-gated by design and measuring it against an ungated tree
measured the gating, not the reading.

**The "21 missing" was mostly a transcription artifact.** Driving the tools directly with no LLM:
`read_page filter=all` returned **594 nodes, `truncated: false`**, and of 156 expected names only **7**
were genuinely absent. Three of the four candidate causes were ruled out **with values**: no ceiling
(`truncated: false`), no frames (`frameCount: 1`), and not lazy loading (a second immediate read missed the
**same** 7, while the browser's tree named all 7).

**So it is cause 3: our walk does not collect those seven.** They are ordinary heading/link/button roles we
collect 500+ of elsewhere on the same page, and no shadow root is involved. For two of them the accessible
name arrives through an `aria-describedby`-linked, `aria-hidden` tooltip popover — a name-computation path,
not a role we skip. B88 correctly refused to fix name resolution blind inside its time box.

**And the scenario is still unaffordable as written.** It hit the cap again at `total_cost_usd 0.5196`,
mid tool-use, because it asks the agent to transcribe a ~600-node page verbatim. The judge never ran. The
transcription is not the claim — containment is — so the scenario's *question* has to change, not its
criterion.

**Update (2026-09-10, B89): the seven are fixed — a real accessible-name gap — and my premise for the
scenario redesign was wrong.**

All seven reached the walk; none was a selector gap. Two causes, both now fixed inside the **existing**
name computation:
- **`aria-labelledby` was never consulted at all.** B88 guessed `aria-describedby`; B89 read the attribute
  and corrected it. The two icon buttons carry their whole name in a tooltip popover the page marks
  `aria-hidden`, referenced by `aria-labelledby`.
- **`ownText` was plain `textContent`.** The browser's name-from-content algorithm joins each child's
  contribution with a space and **excludes `aria-hidden` descendants**; ours did neither, producing
  `"Python53.9%"` and pulling a visually-hidden counter into a heading's name.

Red test built from the real page's markup shapes, red confirmed before the fix; 1218 unit tests green.

**My premise for the cheaper question was wrong, and B89 checked rather than assumed.** The probe captures
the browser baseline **after** the run, deliberately — so the judge compares against the page the session
actually saw, not one read minutes later. There is no pre-run capture and no prompt templating today, so
the baseline cannot simply be injected into the prompt.

**The subtlety that plan must not walk into:** if the names are captured *before* the run for the prompt
and judged against a baseline captured *after*, a page that changes in between will make the agent
correctly report a name as absent and be marked wrong for it. Both captures are needed, and the judgement
belongs to the names present in **both**.

The scenario failed again at `total_cost_usd 0.5204`, unchanged, exactly as expected — the name fix does
not make a transcript cheaper.

**And the reason to do the redesign is correctness, not cost:** transcription is what produced the false
"21 missing" when the truth was 7. Evidence that depends on what an agent chose to copy is not evidence.

**Update (2026-09-10, B90): the question is now uncheatable and cheap to answer — and the cost was never
where three briefs thought it was.**

The judge takes a short `notFound` list instead of a transcript, judged on the **intersection** of a
before-capture and the existing after-capture (so a name that leaves the page mid-run decides nothing —
the trap named in the brief, with its own unit test), plus two decoy names that must appear in `notFound`.
An agent that answers without looking fails on the decoys. The old transcript path is preserved for the
scenario that still uses it, rather than edited to fit.

**But the run still hit the cap, and the reason overturns the shared premise.** Output was only **4,891
tokens**; `cache_read_input_tokens` was **993,223**. The money is not in what the agent writes — it is in
the **tool result's own size**. One `read_page filter=all` on a 1,033-node page is a very large payload,
carried through every subsequent turn.

**This is the same fact recorded during S4 and not connected until now:** the caps count node *text*, while
what the transport and the model actually pay for is the *serialized* answer, whose size is dominated by
per-node overhead across up to 10,000 nodes. Wikipedia's 175,083-character read was the first sighting;
this is the second, and it now has a price attached.

Two consequences, and they are different in kind: this scenario's claim **intrinsically requires** one
full read of a real page, so its budget is the honest thing to raise — not the question, which is now
sound. And separately, a full read of an ordinary page costing tens of thousands of tokens is a **product**
observation worth its own look, since the reference's identical caps suggest a more compact serialization
is possible.

**Update (2026-09-10, B91): SC-036 is CLOSED, and the shadow scenario was chasing the wrong claim — my
error.** The capacity scenario passes: **genuine names 156/156 reported found; decoys 2/2 correctly
reported not found**, against a 1,033-node baseline. Report `reports/004-2026-09-10T14-48-35Z.md`. Its
budget was raised to $2 for that one scenario, with the reason recorded in the file: the claim
intrinsically needs one full read of a real page, and that read's payload is the page's cost, not the
agent's diligence. The 156/156 is only possible **because** B89 fixed the accessible-name computation.

**The shadow scenario: ~12 public sites surveyed, none verifiable — because I had it chasing a clause the
requirement does not contain.** FR-068 reads: *"Reads, finds and text extraction MUST include elements
inside open shadow roots."* **Clicking is not in it.** I added "and clickable" to the briefs myself, and
that is what made every candidate fail — docs sites repeat control names, so `find` answers `too-broad`,
which is correct behaviour and nothing to do with shadow roots. The clickable half is already proven
anyway, on our own fixture, by T136's green claim 3.

`vaadin.com/docs/latest/components/button` was verified to have 17 native **open** shadow roots and its
shadow-hosted control names **do** come back in `read_page` — which is exactly what FR-068 claims.

**Real defect, now reproduced on two independent sites (B87, B91): `find` answers `no-match` for a
shadow-root control until a `read_page` has run first.** FR-068 names *finds* explicitly, so this is
squarely in scope and not a harness quirk.

**Update (2026-09-10, B92): the `find` defect is fixed, and it was never a traversal gap.**
`find`'s own collection passed **no bounds**, so it defaulted to **200** nodes, while `read_page` uses
**10,000**. Open-shadow-root matches are appended **after** every light-DOM match, so on a real page with
200+ ordinary elements the shadow control fell outside `find`'s ceiling and never got a handle. A prior
`read_page` minted it under the larger ceiling and the registry kept it — which is exactly why "run a read
first" appeared to be the cure. One-line fix: `find` now collects under the same ceiling. Red test builds
220 decoys ahead of a shadow-only button and calls `find` with **no** prior read; red confirmed, then
green. 1225 unit tests pass; `agent-refs.spec.ts` still green.

**The scenario failed again on its query — `shadow-find-too-broad` — and the agent said plainly that it
repeated the mistake B86 recorded:** it verified uniqueness with a strict-equality proxy script instead of
through `find` itself. That is the third time this exact substitution has cost a run. The failure is
*evidence the fix works*: `find` now sees shadow content on the very first call and answers `too-broad`
rather than `no-match`. Next candidate from the same page's shadow content: `"Close the dialog"`.

**Update (2026-09-10, B93): verification did its job — none of the four candidates hold, and no paid run
was spent on a guess.** Through `find` itself over the real MCP server (no LLM): `"Button"` →
`too-broad`; `"Close the dialog"`, `"Left"`, `"Right"` → **`no-match`**.

**And the free read explains why, which is the useful part:** `read_page(filter:"all", max_chars:50000)`
on that page returns **2,352 nodes and still says `truncatedBy: "chars"`**. The three missing names are not
absent from the page — they are **past the ceiling**. `find` now collects under the same ceiling as the
read (B92), so it cannot see them either. That is the caps behaving as specified, not a defect.

**So the page constraint is now explicit and was never stated before:** the shadow content a scenario
targets must sit **within the read's ceilings** — early in a short document, not in the tenth demo of a
long component page. Every candidate so far failed that test without anyone naming it.

**Cost check on this scenario specifically:** five briefs (B86, B87, B91, B92, B93) have gone into it. The
capability itself is **already proven** on our own fixture (T136 claim 3, green), and the pursuit has paid
for itself once — it is what exposed and fixed the `find` bounds defect. What is still missing is only
public-site evidence for FR-068.

**Update (2026-09-10, B94): a page finally clears the size constraint — and exposes a third, different
`find` finding.** `mdn.github.io/web-components-examples/editable-list/`: `read_page(filter:"all")` returns
`{truncated: false, nodeCount: 14}`, and the entire page's content lives inside one **open** shadow root
(the light DOM is just the custom-element tag and a script). Conditions 1 and 2 confirmed.

Condition 3 failed, but **not** for either reason we have seen before: `find("⊕")` answered **`no-match`**
on a **14-node** page whose own `read_page` lists a node with exactly that name. Not the bounds bug (B92),
not the truncation constraint (B93) — a matcher behaviour with short, symbol-only accessible names. Third
distinct `find` finding in this slice; the tool has earned a closer look.

Per the rule, the scenario was **not** written against an unverified query. Worth trying first: the same
page has text-named controls inside that same shadow root, which sidesteps the symbol question entirely
and would close FR-068's public-site evidence without a diagnosis.

**CLOSED (2026-09-10, B95).** All three S5 scenarios pass. The shadow scenario landed on
`mdn.github.io/web-components-examples/editable-list/` with a **text**-named control —
`find("First item on the list")` resolved to exactly one match, verified **through `find` itself**, free,
first call, no prior read — and the paid run answered `shadow-find-resolved`. FR-068 now has public-site
evidence for the clause it actually makes: reads and finds reach inside an open shadow root.
`find("⊕")`'s symbol-only-name behaviour stays an open finding, deliberately out of this scenario's scope.

- [X] T137 [US6] Probe scenarios `s5-github-refs.json` (SC-035), `s5-github-capacity.json` (node count within 10% of baseline, links have targets → SC-036), `s5-shadow-page.json` (a public page using open shadow roots, e.g. a Lit/Shoelace documentation page); run `--slice S5`; attach report; archive guard

**Checkpoint**: the agent reads once and uses many times; capacity matches the reference.

---

## Phase 9: S6 — User Story 7: Act by position (Priority: P3)

**Goal**: the `computer` tool over the S4 input path (R-120).

**Independent Test**: on `canvas.html` a position click changes the active-tool attribute; on excalidraw a toolbar click changes the tool state visibly.

- [X] T138 [P] [US7] Unit test `apps/extension/tests/computer.test.ts`: each action maps to the S4 delivery at `(x, y)`; outside the viewport → `outside-viewport {width, height}`; `screenshot` returns the same shape as the screenshot tool; `wait` respects the 003 bound; the effect prompt carries a crop around the point
**Result note (2026-09-10, B42 — T135a/T138 done, T139 partial)**: the two reads now agree about how
much of a page they return. The position tool's schema has its tab, and `computer.ts` is written and
dispatches **nothing of its own** — it ends in four calls into S4's existing pointer and keyboard
delivery, so it is a coordinate front door rather than a second implementation. The refusal test is the
right shape: it asserts the named viewport size **and that no pointer command was sent**, which is the
half a clamping implementation would fail. **The tree is red as B42 left it** (the tool is written but
not routed), with the remaining work listed precisely — routing in the effect runner, the crop on the
prompt, the capture and sleep dependencies, the implemented-tools entry, and one test case written
against a controller API that does not exist. Picked up immediately by the next brief.

- [X] T139 [US7] Implement `apps/extension/src/service-worker/agent-tools/computer.ts` and register the tool in `packages/agent-host/src/mcp-server.ts`; **add the missing `tabId` argument to the `computer` schema first** (B2 followed `contracts/README.md` §2 literally, which omitted it — every other tool names its tab and the references address a tab too), and extend `tests/contract/agent-tools-004.contract.test.ts` for it (make T138 green)
**Result note (2026-09-10, B43 — T139 complete; ALL OF 004'S CODE IS NOW WRITTEN)**: the position tool
is routed and the tree is green at **1171/109**. The gate prompt carries a crop of the page centred on
the point, taken **only when the gate actually asks**, so an allowed site never pays the capture; when a
crop cannot be made the field is omitted rather than sent as a whole-viewport image labelled with a
rectangle it is not. The rewritten prompt test drives the real controller through the panel's own seam
and proves three things: the prompt carries the crop, the call answers denied, and **no pointer command
was sent** — a denied position effect touches the page no more than a denied click. The tool still
dispatches nothing of its own. Two shared-path consequences named honestly: a position call on an `ask`
site attaches the debugger *before* the owner answers, because the viewport must be known to refuse an
outside point honestly (covered by the attachment's own invariant), and the screenshot logic moved to a
shared module with the read path delegating to it, unchanged. The implemented-tools test now asserts the
**mechanism** rather than an example, so it goes red the day a contract tool lands ahead of its handler.

**Finding (main session): the probes are NOT blocked by the test certificate.** The probe references no
fixture server, no local TLS and no localhost; its scenarios run against public pages only. Only the
packaged journeys (T116, T128, T136, T140) need the certificate. So S3–S6 can have their real acceptance
evidence now — including the answer to the owner's fourth original problem.

**Follow-up B43 named**: the panel receives the crop in its projection but does not render it, so the
owner is told *where* only in the data, not on screen. → **T139a**.

- [X] T139a [US7] Render the position prompt's crop in the side panel, so an `ask` on a coordinate effect shows the owner where rather than a number. Both locales; follow the panel's existing patterns
**CLOSED (2026-09-10, B94).** `tests/e2e/packaged/agent-computer.spec.ts` written and green, 1 passed,
all three claims: a positional click on the canvas toolbar changes the active tool (asserted on the
fixture's own `data-active-tool`, not a verdict word); a point outside the viewport is refused
`outside-viewport` with dimensions matching the page's own measurement within 2px; and in `ask` mode the
panel really renders the crop as a non-empty `data:image/png` before the owner answers, with a denial
leaving the fixture untouched. The toolbar's coordinates were measured, not hardcoded.

- [X] T140 [US7] Packaged attach-mode journey `tests/e2e/packaged/agent-computer.spec.ts`: `canvas.html` toolbar click by position changes the active tool; outside-viewport refused; `ask` mode prompt shows the crop
**CLOSED (2026-09-10, B95).** `observed: toolbar-tool-changed`, report
`reports/004-2026-09-10T15-57-23Z.md`. Measured free first: a positional click at the rectangle tool's
measured centre flipped `aria-pressed` from the selection tool to it, and the before/after screenshots
differ — the app's own state is the evidence, since a drawing canvas has nothing to read. Two real
harness lessons came out of it: a consent-gated tool needs its site mode set like every other effect tool,
and **excalidraw persists the last-used tool in the profile**, so the first run failed on a stale
precondition where "no visible change" was the correct answer for that start state. Fixed with an explicit
reset before the baseline capture.

- [X] T141 [US7] Probe scenario `s6-excalidraw.json` (before/after screenshots vs baseline → SC-037); run `--slice S6`; attach report; archive guard

**Checkpoint**: canvas pages are workable; the tool surface matches the reference's.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Owner decision (2026-09-10): one locale, zh-TW, not both.** SC-028 is amended in `spec.md` with the
reasoning. The localised surface is the side panel and the free release matrix already proves it in both
locales; the paid probe measures agent-facing tools that carry no localised text. Run `--all` **once**, in
zh-TW, which is also the attached browser's own UI language — an en-US probe against that browser fails on
panel waits for reasons that have nothing to do with the product.

## Phase 8 — the owed S4 review's findings (2026-09-10, `code-reviewer`, Opus/high)

**Verdict: the claim does not hold.** *"An effect is delivered to the element the agent named, or the agent
is told honestly that it was not."* The blind spot the brief predicted is still there — it **moved** from
`click`, which is genuinely confirmed now, to the sibling gestures that never got the same check. Every
question was answered, including the one that came back clean.

**Fixed (2026-09-11, B96): T146, T147 and T148 all red-first and green.** `type` now polls focus on the
ref it clicked, exactly the way `key` already did, and `browser.enter-text` answers `focus-lost` when it
did not hold. Both confirmers and `locateInFrame`'s single-document branch now catch what
`resolveHandleOnTab` throws — a confirmation that cannot be made is `target-unconfirmed`, never
`handler-error`. A shadow-hosted hit re-hit-tests through the host's own shadow root until it can descend
no further, while an unrelated ancestor still correctly answers `missed` (that second case had its own test
before the fix, so the widening could not go too far). Unit 1231, contract 226, typecheck clean.

**Worth keeping, on the shadow claim:** it was receiving **`target-missed`** all along and nobody saw it,
because the assertion looks at the page's own echo and never at the verdict. Both halves of that are true
at once — asserting on page evidence is what made the test tell the truth about the *click*, and it is also
what hid the tool's lie about it. A claim about an effect should assert both from now on.

**My omission, recorded so it stops recurring:** B96 could not run the packaged specs because the brief had
no Environment section and never spelled out `HALLPASS_CDP_ENDPOINT`. The owner's Chrome was up the whole time.
Same mistake as B82. **Every brief that runs a packaged spec must carry the variable, spelled out.**

- [X] T146 **(High)** `type` with a named target clicks to place the caret using `centreOf(target.rect)` —
  the exact arithmetic that was wrong before — then never confirms it and answers `verified: true`
  unconditionally (`effects.ts:1179-1211`, `effect-verification.ts:143`). A rect stale by a banner's height
  focuses the neighbouring field and the agent's text goes there, reported as success. The `key` branch two
  lines away already does the right thing; reuse it, do not build a second mechanism
- [X] T147 **(High)** A confirmation that **throws** escapes as `failed / handler-error`, so an effect that
  **landed** is reported as failed (`effects.ts:1121-1133`, `content-broker.ts:799-807`,
  `agent-bridge.ts:208-214`). Routine trigger: a click navigates to a PDF or `chrome://`, `resolveBoundPage`
  throws `unsupported-page`, and the agent — told it failed — retries and acts twice. Same dishonesty class
  as the original defect, mirrored. Also on the keyboard path, and on `locateInFrame`'s single-document
  branch (`effects.ts:622-628`), which lacks the try/catch its multi-frame sibling has
- [X] T148 **(Medium)** A target inside an **open shadow root** always confirms `missed`
  (`content-runtime/index.ts:264-305`): `document.elementFromPoint` returns the shadow **host**, an
  *ancestor*, so `contains` is false. The click landed. This contradicts the shadow support B92 just
  added — `find` can now reach a control that `click` will always report as missed — and it also throws
  away the tab binding (`effects.ts:946`)
**Fixed (2026-09-11, B97): T149, all four.** The winning session's origin must now match the claimed
frame's — the check the review called free, on data that was already in hand and being discarded. The nonce
is minted with `crypto.getRandomValues` the way handles already were; **every** candidate is scanned and a
session is returned only when exactly one echoes, so the page can no longer win by creating its iframes in
a chosen order; and the global is deleted after the round trip, win or lose. Red proven for the two
behavioural ones by reverting the resolver and re-running. Six packaged tests **ran** (not skipped), and
the shadow claim now asserts `verified: true` alongside the page's own echo.

**Fixed (2026-09-11, B98): T155, T150 and T151, all red-first.** The focus confirmation now carries the
claiming frame's `frameId`, epoch and origin, and the rule is written into the module doc naming all three
occurrences by name — so the next confirmation that reaches past a present `TargetRect.frame` fails review
on the doc alone. `hover` now asks the same confirmer the click family uses instead of trusting
`width > 0 && height > 0`. A drag whose endpoints do not share a frame is **refused** before anything is
delivered, rather than releasing at coordinates from the wrong space and reporting `verified: true`.
Unit 1237, contract 226, typecheck clean. **14 packaged tests ran** — the whole `agent-*` family, not the
six I asked for.

**Running the wider set surfaced two failures nobody had seen**, both outside B98's scope and correctly
left alone:

**RESOLVED (2026-09-11, B99 + main session): T156 is not a consent leak, and the evidence is the owner's
own decision.** Verified against `spec.md` D-004-4, which says in the owner's approved words that input
uses the existing debugging permission, that the browser's "this tab is being controlled" notice **is
accepted as visible**, and that the diagnostics grant "**stays a separate consent and is not implied**".

What actually happens on revoke: the three diagnostics domains are disabled synchronously and the tab's
buffer is deleted, and `read_console` / `read_network` / `evaluate` each gate on the grant independently —
so **no diagnostics content survives the revoke**. What survives is the bare CDP attachment, held by the
**input** holder under a separate, still-valid consent. The invariant "nothing that grant enabled may
outlive it" **holds**.

The journey's assertion was written when diagnostics owned the debugger exclusively, and it asks "is any
debugger attached" — which now **conflates the two consents the spec says are separate**. Correcting it to
assert the real invariant (no diagnostics data reachable after revoke) is a **stronger** claim than the one
it replaces, not a weaker one, and that distinction is the whole reason it is authorised here.

**T157 is the same shape:** a `type` at a ref **no frame ever minted** correctly answers
`not-located`/`failed`. B99 traced the keyboard path to the *identical* `locator()` wrapper the click family
uses, T136's split included: stale only when some frame reports its own minted element gone, not-located
when every frame says unknown. The journey expects `stale`, which contradicts a documented contract. The
expectation is what is wrong.

B99 changed neither, and refused to pick the design side on its own. That was right.

- [X] T156 **(High — possible consent regression)** `agent-diagnostics.spec.ts:42`: after the owner revokes
  the diagnostics grant, the debugger does not detach within 20 s. This lands squarely on what the S4
  review flagged as an unverified caveat — `Target.setAutoAttach` is sent once at attach, and the
  attachment deliberately survives navigation. **If revoking a grant no longer detaches, the consent
  boundary has moved**, and that is more serious than any wrong click. Establish first whether it
  ever detached before this feature's attachment changes, or whether the journey has always been red here
- [X] T157 **(Medium)** `agent-batch-wait.spec.ts:41`: a `type` at a ref no frame claims answers `failed`
  where the journey expects `stale`. Same stale-vs-not-located distinction T136 fixed for the locate path;
  the keyboard path evidently does not reach it. Check which is right before changing either side

- [X] T155 **(High, regression from T146 — and the same family for the third time)** `type` into a genuine
  cross-site frame answers `verified: false`. `createFocusConfirmer` (`effects.ts:463-481`) passes
  `binding.canonicalOrigin` and `binding.documentEpoch` — the **top document's** — and no `frameId` at all,
  so the focus confirmation asks the wrong document exactly as the click confirmation did before B69
  (epoch) and B72 (origin). Thread the claiming frame's identity the way the click path already does, and
  **write the rule into the module doc**: a confirmation carries the *frame's* identity, never the tab's.
  Three occurrences is a pattern, not a coincidence

- [X] T149 **(Medium, security)** The OOPIF correlation nonce is weak in four independent ways
  (`effects.ts:555-593`, `chrome-adapters/scripting.ts:139-148`): `Math.random()` where this codebase
  already has `crypto.getRandomValues` for exactly this purpose; **first echo wins**, in an order the page
  controls by choosing when it creates iframes; the winning session's `url` is **discarded** instead of
  checked against the claimed frame's; and the global is **never deleted**, leaving a stable tell that this
  extension drives the tab. Cheapest correction first: **compare origins** — the data is already in hand
- [X] T150 **(Medium)** `hover` answers `verified` from `width > 0 && height > 0` on the same suspect rect
  (`effects.ts:1092-1107`). An overlay takes the pointer, the menu never opens, the agent is told it did.
  Hover is the one gesture whose entire purpose is to change what is under the pointer
- [X] T151 **(Medium)** A cross-frame drag mixes coordinate spaces (`effects.ts:1061-1071`): endpoints are
  located independently but only `from`'s session is used, so a drop lands in the wrong document — and
  `moved` is measured on `from`, so it still answers `verified: true`. Refuse endpoints that do not share a
  frame
- [X] T152 **(Medium)** `find`'s 200 → 10,000 bound puts an O(matched²) `contains` walk plus ~10,000 forced
  visibility reads on the **owner's** page thread, per `find`, per frame (`refs.ts:110`,
  `targets.ts:504-552`), and raises the chance of losing the shared 2 s frame bound — which `find` reports
  as a plain `no-match` with no "a frame did not answer" channel, unlike `read_page`. Also worth telling the
  owner: 50× more handles makes `find` answer `too-broad` on queries that used to resolve
- [X] T153 **(Low)** A frame whose parent could not be scripted is treated as top-level and its offset
  becomes `{0,0}` (`scripting.ts:166-174`, `frames.ts:653-660`) — precisely the outcome `frames.ts:473-475`
  says must never happen. `undefined` (→ `target-not-located`) is the safe answer
- [X] T154 **(Low)** `Target.detachedFromTarget` is keyed on the deprecated `targetId` rather than
  `sessionId` (`input.ts:227-230`); dead sessions accumulate for the life of an attachment

**All nine review findings closed (2026-09-11, B96-B100).** T152's quadratic is measured, not asserted:
**3,998,000 `contains` calls before, 0 after** — a candidate ceiling short-circuits to `too-broad` rather
than walking. T153 turned out to be **two coupled bugs**: an unscriptable parent fell back to the literal
"top document" id, *and* the offset walk measured a truncated chain anyway; both now answer honestly.
T154 rekeys the session table on `sessionId`, since the deprecated `targetId` can simply be absent from a
detach. The two authorised expectation corrections each carry their reason in a comment.
Unit 1240, contract 226, typecheck clean.

**Still owed: the packaged `agent-*` family has not run since B98.** Everything since is proven at unit
level only.

**Clean answers, worth keeping:** `Target.setAutoAttach`'s line **holds** — the only methods ever sent with
a `sessionId` are the three `Input.*` and the one `Runtime.evaluate`, and no domain is ever enabled on a
child session. And `scrollIntoView` is **confined correctly**: one producer, and every caller that passes
`true` is a post-gate delivery — reads and finds never scroll the owner's page.

## Phase 9 — second review: the fixes themselves (2026-09-12, `code-reviewer`, Fable/high)

Run because nine fixes landed under time pressure in the area where one bug class had already shipped three
times, and nobody had reviewed the fixes. **It found exactly what it was for: one fix moved its defect
instead of removing it.**

**Fixed (2026-09-12, B104): T158 and T159.** Containment now walks `parentNode ?? host` from the hit up
to the target, crossing the boundary `Node.contains` cannot, and the named gap has its test: *the target is
the host*. The three pinned properties still hold. `hover` needed no separate change — both gestures share
one confirmation message, which is why one fix covered both, and that is recorded in the test rather than
duplicated.

T159 moved the focus check **before** the keystrokes, so a click that missed now refuses with
`charactersChanged: 0` instead of reporting honestly after the text has already gone somewhere. Its
decision on focus-moving controls is the right one and is written at the call site: this worker **cannot**
tell a wrong-field click from an OTP box auto-advancing, so the only fact it stands behind is whether the
caret was on the named target *before* typing — and it checks nothing after.

**T160 was refused, correctly.** Unlike the click family, `wait`'s and `upload`'s refs carry **no frame
identity at all**; the pointer tools only have it as a by-product of needing coordinates. So a real fix
needs a *new* "which frame owns this ref" probe plus threading through `content-broker.ts`'s shared identity
checks — which every other tool depends on. B104 named that design and left it rather than shipping an
untested change to shared plumbing at the end of its window.

- [X] T158 **(High, blocking — T148 moved the defect)** A target that **is** an open shadow host now
  confirms `missed` on a click that landed. `Node.contains` does not cross a shadow boundary: before the
  fix `elementFromPoint` returned the host and `host.contains(host)` was true; now we descend into the
  shadow tree, so `host.contains(inner)` is false (`content-runtime/index.ts:78-88` and `:303-305`).
  Realistic because the walk mints hosts — any component that puts its role on the host
  (`<vaadin-button role="button">`, Lit, Lightning) becomes the ref. `hover` inherits the same false miss.
  Fix with shadow-crossing containment (`parentNode ?? root.host` from the hit up to the target).
  **The test gap is named:** B96 covered "target inside an open root" and "unrelated ancestor", never
  "the target *is* the host"
- [X] T159 **(Medium)** `type` delivers the text **before** it checks the caret (`effects.ts:1327-1348`).
  The finding's own scenario is now *reported* honestly, but the text — including `replace` mode's
  select-all and delete — has already gone into the wrong field. A poll **between** the click and the
  typing would refuse before delivering. Prevention beats an honest post-mortem here. Second half: controls
  that move focus **by design** while typing (OTP auto-advance, combobox → listbox) now answer
  `focus-lost`, `verified: false` — decide what the honest answer is for those
- [X] T160 **(Medium — the fourth occurrence of the frame-identity bug)** `wait.ts:150-161` and
  `upload.ts:122-123` evaluate a ref against **frame 0** with the **binding's** identity
  (`evaluateConditionOnLeasedTab` has no `frameId`). A `wait {present, ref}` on a ref minted in a nested
  frame answers `stale-target` and invalidates the binding. Outside `effects.ts`, so the module-doc rule
  written in T155 did not reach it — **extend the rule's reach, not just this call site**
- [X] T161 **(Low, four small ones)** the focus confirmer is boolean, so it cannot draw the
  miss/unconfirmed distinction its sibling does (`effects.ts:516-518`); the OOPIF candidate `url` is
  attach-time only and goes stale after a same-site cross-origin navigation (fails closed, `input.ts:220`);
  `oopif` is deleted **before** `await debug().detach`, so an attach in that window resurrects it
  (`input.ts:251-256`); and `unsupported-page` becomes `target-not-located` ("re-read the page") rather
  than `not-actionable` (`effects.ts:717-722`)

**Clean, and worth keeping:** T151 is correct *for the right reason* — non-session frames compose into page
coordinates, so `sessionId` equality is exactly the coordinate-space boundary. T152 cannot refuse a query
that used to resolve. T153's readers all refuse a self-parent. T149 compares **origins**, not whole URLs,
and the nonce is cleared on every path that planted it. T155 has **no fourth occurrence inside
`effects.ts`** — all three confirmers thread the frame.

**The cross-spec bridge detach: nothing found**, after enumerating the extension's per-tab tables, session
release, stop handles, listener wiring and the host relay's own `sessions`/`calls` sweeps. Cheapest next
instrument if it recurs: the relay already logs `sessions.size` on detach — add `calls.size` beside it to
rule out a pending-call leak.

**One coverage loss to repair, honestly reported:** the corrected diagnostics assertion is stronger at the
tool boundary but no longer proves the **domains** are actually disabled — `domains(tabId, "disable")`
swallows failures, so a revoke that left them on would still pass. Assert
`state(tabId).diagnosticsEnabled === false` as well.

## Phase 10 — the acceptance run's result (2026-09-12, B103)

`npm run probe:004 -- --all`, zh-TW, 18 scenarios, ~14 minutes on the owner's Chrome 152.
**15/18 passed.** Report `reports/004-2026-09-12T13-00-46Z.md`. Unit 1241 green beforehand.

Passing: all five S0, `s1-relay-killed`, both S2 (including `s2-pairing-20s` at **5/5 repeats**), S3,
`s4-artifact-click`, `s4-hover-nav`, all three S5 (capacity at its recorded $2), and S6.

**Fixed (2026-09-12, B105): T161's four, plus the diagnostics coverage repair.** The focus confirmer is
now three-way like its sibling, so a caught throw answers *unconfirmed* rather than a definite miss.
The session entry is deleted **after** the detach await, with a test that opens a real race window rather
than asserting the ordering. `unsupported-page` now answers `not-actionable` — and widening that union made
`tsc` find a **second** call site nobody had noticed, which is exactly what a type checker is for. The
stale-`url` case is a comment explaining that it fails **closed**, with the real fix named.

The diagnostics repair was done properly: rather than bolt an assertion on, B105 traced which path had
**no** unit coverage at all (the owner unchecking the box, as opposed to a navigation) and covered that
one.

Packaged family: **14 ran, 13 passed, 1 skipped** (privacy, expected). The single red was `bridge-lost` on
`agent-actions` — **the same accumulation, now seen on a third path**. Unit 1246, contract 226, typecheck
clean.

**Update (2026-09-12, B107) — the guard is fine; B106's reading was wrong, and this correction is
properly evidenced.** `relay.log` no longer truncates (append, with one size-bounded rotated generation —
chosen over per-pid files so a failing run's lines stay contiguous). With the evidence preserved, the
`relay.superseded <pid>` line turns out to print the **winner's** pid and never the speaker's, so a line
naming a just-started relay was written by that relay's **predecessor**. Confirmed by showing the named pid
had **zero** mux activity in its own lifetime — a process replaced before its first poll tick, not one
reporting on itself. **The log line's real defect is an attribution gap: it never says who is speaking.**

**The actual mechanism, named precisely:** a session's MCP server can be **mid-call on a relay that is then
legitimately superseded**. The old relay deliberately does not announce `session-ended` while superseded,
so the worker keeps the session — but the in-flight call on the closing socket has **no answer coming**,
and the server times it out as `bridge-lost`. **An in-flight call has no handoff across a relay change.**

**Design decision (main session), since B107 correctly left it:**
1. **A superseded relay finishes what it started.** It must not close a socket with calls in flight; it
   drains them, under a bound, and then exits. That preserves the answer instead of discarding it.
2. **A call that still cannot be finished is answered honestly.** `bridge-lost` invites a blind retry, and
   a retry is only safe if the call never reached the browser — which is exactly what nobody knows here.
   It needs its own reason meaning *this call's outcome is unknown*, the same principle as
   `target-unconfirmed`. **A silent retry stays forbidden**: the call may have clicked something.
3. Give `relay.superseded` the speaker's pid, so the next person reading that log is not misled the way
   B106 was.

**Fixed (2026-09-12, B108): T162, all three parts, and T166.** A superseded relay now drains its
in-flight calls (5 s bound, logging what it abandons) before closing, `relay.superseded` names the speaker
as well as the winner, and a call that was **already forwarded** when the link dropped answers
**`call-unconfirmed`** instead of `bridge-lost`. That boundary is drawn exactly where it should be:
`bridge-lost` stays on the two paths where the call never left the process, because those are the only ones
where a retry is safe.

The evidence is unusually good: besides the unit tests, there is a **subprocess-level** test that writes a
call's answer to the *superseded* relay's own stdin **1.5 s after** a winner took the record — well past
the 1 s detection poll — and proves it still reaches the server. That demonstrates the drain rather than
asserting it.

T166's root cause was ours: a tab with no committed address was mapped to `""`, while Chrome's own
convention — **already asserted a few lines away in the same spec** — is `about:blank`.

**First fully green family run (2026-09-12, B108): 14 passed, 1 skipped, 0 failed**, including
`agent-sessions` — the spec that deliberately kills relays and servers, and the likeliest place a drain
regression would show. **No `bridge-lost` anywhere.** One clean run is not proof for a low-probability
symptom, but it is the first time the family has been green at all.

**And T165 did not reproduce in that run either**, with the family's full accumulated state present — which
is the condition B107 saw it under. So the "only with accumulation" reading does not hold either. It is
rarer than either theory, and the honest position is: **two of three observations say the mapping is
right**, and nothing should be changed on one unreproduced sighting.

**Note on T165 (2026-09-12):** `agent-reads` **passed alone**, the
  PDF answering `not-readable` correctly (B108), matching B102 and contradicting B107's family run. So it
  appears **only with the family's accumulated state** — which raises a real possibility worth testing
  before touching the mapping: in that context the binding may genuinely *be* stale, making `stale` the
  honest answer and the journey's assumption of a fresh binding the thing that is wrong. Get the evidence
  from a family run, not from the spec alone

- [X] T162 **(High — a real product defect, and the run was designed to answer this)** **The bridge drops
  after accumulated state, and it is the relay, not the test harness.** In `s6-excalidraw` — the 18th and
  last scenario, after dozens of tab creations, two deliberate relay/server kills in S1 and five repeated
  pairing cycles in S2 — a `computer` call answered `failed/bridge-lost`; an immediate retry succeeded.
  This run drove the probe through `claude -p` over CDP, **not** the Playwright family, so the same drop
  now reproduces on two independent paths, only ever after accumulation. That settles the question the
  second review could not: **it is product-side.** The reviewer's own cheap next instrument still applies —
  the relay already logs `sessions.size` on detach; add `calls.size` beside it to test a pending-call leak
  first
**Update (2026-09-12, B106) — my accumulation theory is wrong, and the evidence for the failing run was
destroyed by our own logging.**

- **The failure shape contradicts accumulation.** The failing calls are **not** adjacent to any dial or
  relay detach: many `ok` calls run immediately before and after each one, with the link apparently still
  attached. That is a **transient send-time hiccup**, not a monotonic growth finally tipping over.
- **`relay.log` is truncated whenever any relay process starts** (`native-host.ts`), so by the time the
  failing run was inspected, later short-lived relays had overwritten it. B106 did **not** claim the
  counters were flat — it said it has no evidence either way, which is the honest answer and also names a
  defect that must be fixed before this is measurable at all.
- **A concrete anomaly, and it would explain the symptom exactly:** a relay logged `relay.superseded`
  naming **its own just-started pid** (`relay.started 10528` … `relay.superseded 10528`), which the guard
  at `native-host.ts:142` (`if (reading.record.relayPid === process.pid) return;`) exists to prevent. A
  relay that supersedes itself while a session's dial is attached produces a transient `bridge-lost`
  surrounded by working calls — which is precisely what was observed.

Reproduced again on the packaged family: 12 passed, 2 failed, both `bridge-lost`, this time on
`agent-actions` **and** `agent-input`.

**T163 done (B106).** Both S1 scenarios now judge the **access** claim instead of tab visibility:
`s1-server-killed` asks whether the surviving session still works and still sees its own tab, and
`s1-three-sessions` keeps its cross-session refusal step untouched. Each carries a `note` recording that
S2's `holder` marker — the fix for the owner's E3 failure — is why the old visibility wording had to go.
B106 deliberately did **not** strengthen step 4 into a `held-by-session` shape it could not guarantee,
which is the right restraint.

- [X] T163 **(Medium — stale expectations, the same shape as the diagnostics and batch-wait ones)**
  `s1-server-killed` and `s1-three-sessions` both judge on **tab visibility**: "own-tab-only", failing if
  the list "contains any tab you did not create yourself". **S2 deliberately made every tab visible with a
  `holder` marker** (`agent-tools/tabs.ts:156-165`) — that *is* the fix for the owner's original E3
  failure, where the agent could not see or claim the owner's tabs. So these scenarios now measure a
  property the product deliberately removed. S1's actual claim is **access**: a foreign-held tab is refused
  **naming the holder** (SC-029), not that other tabs are invisible. Restate them to that, and say so in
  the scenario's note
- [X] T165 **(Medium — the `stale` misclassification is real after all; CLOSED 2026-09-13 B116, root cause found and fixed)** B102 could not reproduce it with
  `chrome-extension://` and reasonably called it a one-off. B107's family run reproduced it with a **PDF**:
  `agent-reads` got `stale` where FR-039 wants `not-readable`. So the classification gap is genuine and
  page-kind-dependent, not transient. Same seam as before: `reads.ts:463` maps only `not-actionable` to
  `not-readable`
  **2026-09-13 (B115):** the full `agent-*` family run under T167's investigation passed `agent-reads`, PDF
  included - now **1 sighting in 4** family runs, and that one sighting (T145) ran with a foreign agent
  session attached (T167, cause 1). Not reclassified. Decision rule, so nobody re-litigates it: run the
  family once with the gate's new foreign-server refusal silent; `agent-reads` green there closes this as
  not reproducible in a clean environment, red there is the measurement that finally justifies touching
  `reads.ts:463`

  **CLOSED (2026-09-13, B116).** The clean family run - the first with no foreign agent server on the
  bridge - **reproduced it**: `get_page_text` on `manual.pdf` answered `stale`. So the decision rule
  fired, and the seam was not `reads.ts:463` after all: the mapping there is right, the *input* to it
  was wrong. `bindSupportedTab` (`content-broker.ts`) classified the tab from `tab.url`, and a tab
  created a moment ago reads `url: ""` until its document commits - a PDF's viewer commits late, so
  under load the classification saw no address at all, threw `no-active-tab`, and that is the
  `stale` branch. The same pre-commit shape as T167's second cause, on the read path. Fix: classify
  from `tab.url || tab.pendingUrl` - the address the tab is on its way to - which can only refuse a
  page earlier, never admit one, because the content-runtime probe still asks the document itself.
  Red test: `url: ""` + `pendingUrl: …/manual.pdf` → must throw `unsupported-page`, was
  `no-active-tab`; a tab with no address at all still answers `no-active-tab`. `content-broker.test.ts`
  40/40. Family run after the fix: **14 passed, 0 failed, 1 skipped** (zh-TW attach) - the first
  all-green attach-mode family. The `agent-tabs` red in the same first clean run was the test racing
  Chrome's own `tabs.get(id).url` before the blank document committed; it now polls for where the tab
  ends up.
- [X] T166 **(Low)** `agent-tabs`: navigating to `about:blank` answers `""` for the URL

**Fixed (2026-09-12, B109): T160.** A `discoverRefFrame` step asks each frame whose registry claims the
ref, resolved **once** before `wait`'s poll loop rather than per tick, and threaded into both
`evaluateConditionOnLeasedTab` and `setFilesOnTab`. On a single-document page **no discovery machinery runs
at all**, and that is pinned by its own regression test — as important as the new-behaviour one. The T155
rule now lives above `evaluateConditionOnLeasedTab` in `content-broker.ts`, the shared funnel every future
frame-identity caller passes through, instead of in one leaf file.

**T164 turned out to be neither of the two causes I named, and the measurement is worth more than the
guess.** Through `find` itself, no LLM, repeated and unaffected by wait time: `find` answers **`no-match`
for the search box's exact, literal accessible name**, while `read_page` **in the same session** reports
two `textbox` nodes — neither `hidden` nor `offscreen` — under the **same** collection bound. So the bound
(B92) and the candidate ceiling (T152) are both ruled out with evidence, and this is not page drift either:
no query resolves it, including its own name.

**That is a real disagreement between `read_page` and `find` about the same page**, and B109 declined to
guess which side is wrong — the right call, since a fix chosen on a guess is the same sin as a query chosen
to pass. One caveat on its evidence: it also read `find("textbox")` → `no-match` as a signal, but that
assumes `find` matches bare role words, which is unverified.

**Update (2026-09-12, B110) — the cause is found, and it is much bigger than this scenario.**

First, the caveat I raised is settled: **`find` does match bare role words** — measured against the real
built matcher, `matchDescription("textbox", {role:"textbox", label:"Search Wikipedia"})` → `true`. So the
earlier `find("textbox") → no-match` was **not** meaningless: it says **nothing at all resolved on that
page**, not merely that one control.

**The cause: a reproducible false negative in the live visibility re-check.** In a small, backgrounded tab
(~756×666, never brought to front), `checkVisibility()` returns **false** and `getClientRects().length` is
**0** for elements that plainly have a box — reproduced on the search input and on a second control. The
same elements measure correctly at 1400×900 in a foregrounded tab.

Only `find` re-checks live (`stillShown` / `readLiveTarget`); `read_page` trusts the collector's
snapshot-time flags. That explains **every** observation at once: why no query resolves on that page, why
the element's own exact name fails, and why waiting never helps — it is a **tab-state** condition, not a
timing race and not page content.

**And the blast radius is much wider than an acceptance scenario: an agent's tab is normally not in the
foreground.** If `find` returns nothing whenever the tab is small or backgrounded, that is the ordinary
case, not an edge one.

B110 did not write a fix: it could not get a value from **inside** the real `find` pipeline within its
window, and said so rather than fixing on strong circumstantial evidence. Correct — but the evidence is
strong enough that this now needs confirming and closing, not parking.

**REOPENED (2026-09-13, main session) — the fix does not address the condition that was measured, and
the test pins a case that does not occur.**

`hasLayoutBox` requires `getBoundingClientRect()` to report a width or height **greater than zero**
(`targets.ts:236-244`). But B110's live measurement of the failing condition was `checkVisibility() ===
false` **and `getClientRects().length === 0`** — and an element with no client rects has an all-zero
bounding rect. **So the fallback answers `false` in exactly the state it was built for**, and the element
is still rejected. B111's unit test mocked `checkVisibility: false` together with a **non-zero** box — a
combination B110's own measurement says does not arise there. Red-before-green was honoured against a
scenario that is not the real one.

This is confirmed by behaviour, not just by reading: `s4-wikipedia-typing` **reproduced identically** in the
2026-09-12 acceptance run, after the fix shipped.

**The question the next attempt must answer, and it is a different question:** `read_page` and `find` run in
the **same content script, in the same tab**. If layout were genuinely dead there, the collector would see
zeros too — yet it reports the nodes as neither hidden nor offscreen. So either the two run at different
moments in the tab's life (foregrounded for one, backgrounded for the other), or B110's Playwright-created
probe tab was not in the same state as the probe's own tab. **Measure that difference first**; the answer
decides whether anything in the visibility check needs changing at all.

**FIXED (2026-09-12, B111).** Confirmed from inside the real pipeline first: driven through
`resolveDescription`/`stillShown` exactly as `find` calls them, an element that `checkVisibility()` reports
`false` for **but which plainly has a box** was rejected — red before the fix, green after.

The reasoning is the part worth keeping: **`checkVisibility()` answers from *paint*, and a backgrounded tab
paints nothing** — which is the ordinary condition for an agent's tab. **Layout is unaffected by
backgrounding**, and `getBoundingClientRect` is the very measurement the collector already uses
successfully for `read_page`. So the fallback is to layout, and it is deliberately **not lenient**: a
missing or throwing measurement answers `false`, so it can only overturn a not-rendered verdict on
*positive* evidence.

The property the check exists for survives, pinned by two tests: a disconnected element still fails, and an
element that is both `checkVisibility: false` **and** has no box still answers `no-match`.

Unit 1258, contract 226, typecheck clean.

**CLOSED (2026-09-13, main session, B114) — measured on the attached Chrome 152, free, through the
product's own tools and a raw DevTools session; the answer to the question the reopening asked is
"neither".** `read_page` and `find` never disagreed. What differed between the passing run and the
failing ones was the **viewport width of the agent's tab**, and the page - not the tools - decides
what that width shows.

The measurement, in the order it settled things:

1. *Wide viewport (1268 px), tab in the foreground:* `read_page` lists `textbox "Search Wikipedia"`,
   `find("Search Wikipedia search box")` resolves to the same ref. *Same tab sent to the background*
   (another tab created over it): `find` still resolves.
2. *Backgrounding does not change `checkVisibility`.* Over a **raw** DevTools socket - not
   Playwright, whose `connectOverCDP` turns on focus emulation and reports a backgrounded tab as
   `visibilityState: "visible"`, which is one reason B110's probe tab did not look like the probe's
   own - a tab with `document.visibilityState === "hidden"` answers `checkVisibility() === true`,
   `getClientRects().length === 1`, box 405×32 for the search input. B111's premise ("paint, not
   layout") is false on this Chrome.
3. *Narrow viewport is the whole cause.* Vector 2022 sets `display:none` on
   `.vector-typeahead-search-container` below **~1120 CSS px** (swept 1006 → hidden, 1126 → shown).
   In that state `checkVisibility` is `false`, the rects are `0`, the box is all zeros - B110's exact
   numbers, in the **foreground** too - and `read_page` agrees with `find`: no textbox at all, a
   `link "Search"` in its place. The two failing `read_page` counts (23 and 41 nodes) are the narrow
   layout; the wide one reads ~50 at depth 15.
4. *Why this machine flips between runs.* The agent build's side panel is open in the dedicated
   profile and is ~780 DIP wide. On the 1536-DIP primary monitor that leaves **756 px** of viewport
   - B110's "~756×666" was a maximised window on that monitor, not a small backgrounded tab. On the
   2048-DIP secondary monitor, maximised, it leaves 1268 px and the box shows. Which monitor the
   window happens to sit on decides the scenario, which is what "the failure set moved between runs"
   was.
5. *B111's fallback was a regression, not a no-op.* `hasLayoutBox` overturned a `false` from
   `checkVisibility` whenever the element kept a box - and `visibility:hidden`, `opacity:0` and
   `content-visibility`-skipped controls all keep theirs. A probe test (`checkVisibility: false`,
   box 405×32) answered `true` against the shipped code: a hidden control was being offered as a
   target, against the 003/C2 rule this function exists for.

What changed:

- `content-runtime/targets.ts`: the fallback and `hasLayoutBox` are removed; `checkVisibility() ===
  false` is final again, and the comment records the measurement so the paint theory is not
  re-derived. `targets.test.ts`: B111's "boxed but not painted → resolved" test, which pinned the
  regression, is replaced by "hidden by `checkVisibility` but still boxed → `no-match`" (red on the
  shipped code, green now); the "no box either" test stays. Unit 56/56 on the two touched files.
- `scenarios/s4-wikipedia-typing.json`: Step 4 gains the step the reference's own agent takes on a
  narrow viewport - if `find` answers `no-match`, find and click the collapsed `Search` control (an
  inline toggle, `a.search-toggle`: measured, it expands and focuses the input without navigating),
  wait 1 s, then find the box by its exact name. The expectation is unchanged. Walked end to end
  through the product tools at 706 px: expand → `find("Search Wikipedia")` → one
  `combobox "Search Wikipedia"` → `type` verified, 9 characters → ten `option`s beginning
  "Ada Lovelace" in the second read.

Two things measured on the way, recorded as follow-ups rather than widened into:

- **Confirmation on a self-removing target.** The product's click on the collapsed toggle reports
  `verdict: "target-missed"` while the effect is real: the toggle removes itself as it expands the
  box, so the element at the point at confirmation time is the header. The same shape as the fixed
  "reported a thing that did not happen" family, in the other direction.
- **`ROLE_WORDS.combobox` has no "box".** Once expanded, Wikipedia's input reports `role="combobox"`,
  and "search box" then cannot name it (whole-word matching); its exact name can. An input-backed
  combobox is a text field with a popup, so the textbox words arguably apply to it - a domain-policy
  question, not this task's.

Not a product change beyond the revert; nothing here is an R1/R2 trigger. The dedicated profile was
left as found: the temporary `https://en.wikipedia.org → skip-checks` mode was removed, the probe
tabs closed, the window put back maximised on the secondary monitor.

**Environment note, and a description several briefs got wrong:** the attach-mode browser is **not** the
owner's everyday Chrome. It is a dedicated profile (`D:\chrome-agent-profile`) launched from a documented
shortcut (`tests/acceptance/probe-004/README.md`), deliberately kept away from the owner's own. It exited
during B111; relaunching it from that documented command is a safe, in-scope action, not a disruption of
the owner's session.

- [X] T164 **(Medium — REOPENED, then CLOSED 2026-09-13 B114)** `s4-wikipedia-typing`: `find()` answered **`no-match`** on the search box, so
  `type` was never reached. This scenario **passed** on 2026-09-10 with `suggestions-shown`. Measure before
  assuming: `find`'s collection bound changed (B92, 200 → 10,000) and gained a candidate ceiling that
  short-circuits to `too-broad` (T152) — but `no-match` is neither of those, so page drift is equally
  likely. Verify through `find` itself, free, no LLM

**On the other two S1 failures, B103 was careful and said so:** it checked the archived per-slice reports
and found these same ids flipping run-to-run **even alone**, so it declined to call them an interaction
finding. That restraint is right — and T163 now explains why they flip: the judgement depends on whether
any unrelated tab happened to be open.

**T143/T144/T145 closed (2026-09-13, B113).** `quickstart.md` now carries the real report paths and the
three replaced pages with their reasons; the runbook says the only owner step left is the one-time
remote-debugging shortcut, and **corrects the "owner's Chrome" wording** that made one session refuse to
relaunch a dedicated test profile; the handoff's Status and Pick-up-here are the settled 004 picture with
open items named by task number; the evidence doc points at the delivered tools; the spec's change log
records the three reference readings.

**T145's numbers, recorded in `browser-matrix.md` exactly as they came out:**
`tsc -b` and `typecheck` clean · contract **226/226** · 001/002 launched gate **en-US 19 passed**,
**zh-TW 20 passed**, 0 failed · **archive guard byte-identical — it holds**, which is the promise the whole
feature was built under · unit **1257/1258**, the one red being `relay-process.test.ts` with `spawn EPERM`
(the machine-load symptom this project has hit before, not a product failure) · attach-mode `agent-*`
**13 passed, 2 failed**.

- [X] T167 **(New, unexplained → CLOSED 2026-09-13 B115)** `agent-input.spec.ts:54` — `side-panel-text-timeout` inside the
  `setSiteMode` helper under zh-TW. It matches no recorded finding, and the locale was set correctly, so
  the usual explanation does not apply. Recorded rather than guessed at

**CLOSED (2026-09-13, main session, B115) — two causes, both measured, neither the locale.**

*Alone it does not fail.* `agent-input.spec.ts` run by itself in attach mode, zh-TW: 2/2, then
`--repeat-each 3`: 6/6. Inside the `agent-*` family the same run went 12 passed / 2 failed - and the two
were **different specs** (`agent-actions`: `triple_click` → `call-unconfirmed`; `agent-pairing`: the
pairing prompt named `claude-code`, not the test's own `Claude Code`). The failure moves; the family is
the condition.

*Cause 1 - foreign agent sessions.* `agent-pairing`'s received text said it outright: **"有代理程式要求使用
這個瀏覽器 · claude-code · 透過 stdio:local"** is the MCP `clientInfo.name` of the Claude Code CLI - a live
Claude Code session in this project whose `hallpass` server is attached to the same relay. The per-test
reset clears the pairing it had, so it asks again, ahead of the journey's own client. Two such servers were
running (`mcp-server.js` pid 73048 under this session's `claude.exe`, pid 75160 under the owner's
`--resume` session). Killing this session's own left one, and `agent-actions` then passed while
`agent-pairing` still read the foreign prompt. T145's run had the owner's session live the same way;
B103's "S1 ids flip even alone" is the same shape.

*Cause 2 - the panel's per-site list can miss a tab the agent just opened.* T167's own panel text, read
back from `report.json`: the test's session listed as holding **`about:blank`** while `agentPage()` had
already found the tab at `/hover-menu`. `tabs_create` announces the projection right after
`chrome.tabs.create` + adopt - and `chrome.tabs.create({ url })` resolves **before the document commits**
(`url: ""`, address in `pendingUrl`), so the record the site list is built from can still read
`about:blank`. Nothing refreshes it afterwards: the projection is announced by the tools, not watched on
`tabs.onUpdated` (`agent-tools/tabs.ts`'s own comment), and the journey's next call is the wait for the
site's row. Under family load the commit loses the race; alone it wins. The unit harness's fake
`tabs.create` committed synchronously, which is why no test had ever seen it.

What changed:

- `agent-tools/tabs.ts`: `tabs_create` still answers at once; when the tab was created with a url and the
  record still reads `about:blank`, `announceOnceCommitted` re-reads the record on the navigation bound
  (100 ms polls, no listener - a commit landing between the create and a listener armed after it is the
  same miss) and announces the projection again once the address is there. `agent-navigation.test.ts`:
  the fake gains `commitsLate` (Chrome's real shape), one test red-then-green for the second
  announcement, one pinning that an address committed at creation announces once. 24/24.
- `packages/test-kit/src/agent-server-processes.ts` (+ tests, 4/4): lists the `mcp-server.js` processes
  on this machine and turns a non-empty list into one refusal naming the pids. The attach-mode gate
  (`packaged-extension.ts`, once per process, before the build check) and the probe's environment check
  (`environment.ts`, a "Foreign agent servers" row in the report table, a problem that refuses the run)
  both use it. Verified live: with the owner's session still open the gate now stops with
  `foreign-agent-servers: … pid 75160 (parent 65348) …` instead of a moving red. Probe unit 80/80.

Left for the owner, and it is the only thing left in the way of a clean family run and T142: **close the
other Claude Code session open in this project** (or `claude mcp remove hallpass` there) before
running the attach-mode gate or the probe. The gate says so itself now.


- [X] T142 Run `npm run probe:004 -- --all` on the owner's Chrome 152 in **zh-TW only** (SC-028 amended); attach the final report to `specs/004-reference-parity-bridge/coverage.md` (new: which scenario proves which FR/SC, baseline source per scenario) — SC-028 **(run and attached 2026-09-13 B116: `004-2026-09-13T03-01-29Z`, verdict not-done at 17/18, the one open cell is T168)**

  **2026-09-13 (B116) — one invalid run, recorded so it is not mistaken for a product result.**
  `004-2026-09-13T02-53-33Z`: S0 5/5 and `s1-relay-killed` passed, then **every** remaining scenario
  answered `agent-error: exit 3221225794` (0xC0000142, STATUS_DLL_INIT_FAILED) - the `claude -p`
  process never started. Not the product: the probe had been launched from a Claude Code background
  shell with a 10-minute bound, was detached from that shell to outlive it (TaskStop kills the shell,
  not the child), and every console process it spawned afterwards had no live console to attach to.
  The environment table of that run is still good evidence: **Foreign agent servers: none**, pairing
  found, site modes set. Relaunched from its own hidden console (`Start-Process cmd /c …`), which
  is how the probe should be started from any non-interactive session; `coverage.md` carries the run
  that counts.

  **The run that counts: `004-2026-09-13T03-01-29Z` — 17/18, the best to date** (15/18 twice before,
  a different three each time). Foreign agent servers: none. Every S0–S3 scenario, `s4-hover-nav`,
  **`s4-wikipedia-typing`** (T164's expand-first step confirmed in a paid run), all of S5 and S6 passed.
  `coverage.md` carries the table and the environment. The one cell still open is `s4-artifact-click`,
  now T168; SC-028's "every FR closed by at least one scenario" holds for every FR the probe covers
  except that FR-064's cross-origin-frame *act* half rests on `agent-frames`/`agent-input` (green in the
  clean family) rather than on a green probe cell.

- [X] T168 **(Medium — `s4-artifact-click` `click-missed`; CLOSED 2026-09-13 B117, measured through the product's own tools)** The click on the
  YouTube embed's `Play video` answers `verdict: "target-missed", role: "div", clicks: 1`; the second
  read shows the player's controls toggled and no `Pause video`. History: 4 fails → 2 passes
  (2026-09-10 12:08, 2026-09-12 13:00) → 3 fails. Measured free right after the run, same window
  (maximised on the 2048-DIP monitor, viewport 1268 px — **not** T164's viewport condition): inside
  the frame, `document.elementFromPoint` at the centre of `button "Play video"` (72×72 at 315,161 in a
  702×394 frame) returns a **class-less `DIV`** — a transparent layer over the large play button in the
  player's cued state. So the pointer reached the frame (the controls toggled) and the confirmation's
  `target-missed` is the honest word for what was under it; the offset arithmetic is not implicated.
  What to measure next, free, before any change: whether that layer is present in the state the two
  passing runs saw (the player may be "cued" vs "unstarted" depending on how the embed loaded), and
  whether a real Playwright click at the same point plays the video — B58's original measurement said
  it did. If the layer is the page's own and a real click through it plays, the product's click is
  right and the *confirmation* is what needs to learn that a layer over a control can still deliver
  it; if not, the scenario needs a target the page keeps stable.

  **CLOSED (2026-09-13, B117).** The first guess above ("a layer over the button") was wrong and is
  kept as the record of what a stack read looked like from outside: the class-less `DIV` is the
  icon *inside* the button. The measurement that settled it ran the product's own `find` + `click`
  from a temporary attach-mode spec with `pointerdown`/`click` listeners installed in the embed
  frame: the product's click landed at **(350.8, 197.2) in frame coordinates - the button's centre
  to the pixel** - on the button's own inner `DIV`, the player went to `playing-mode`,
  `video.paused === false`, the page had been scrolled so the embed was in view (0 → 212) - and the
  tool still said `verdict: "target-missed", role: "div"`. The confirmation hit-tests the point
  **after** the click, and the click's own effect draws the player's controls over that point: the
  post-click hit was the play/pause control that replaced the cued button, not a descendant of it.
  So the arithmetic was right, the frame routing was right, and the *timing of the check* was the
  defect - the same shape as the Wikipedia search toggle in T164's notes.

  Fixed in `agent-tools/effects.ts`: the click family confirms its point **before** delivering the
  click; the check is about this worker's arithmetic and hit-testing afterwards measures the effect
  instead. `hover` keeps its post-delivery check (T150 - its purpose is to change what is under the
  pointer). Red test: `confirm` must run before any `Input.dispatchMouseEvent` for a click and after
  the move for a hover (`agent-effects.test.ts`, 42/42). The same product click on the same page now
  answers `verified`. A second guard from the first attempt stays: a ref whose element has left the
  document by confirmation time answers `stale-target`, which the worker reads as
  `target-unconfirmed`, never a miss (`content-runtime/index.ts`, `content-broker.ts`; tests in
  `content-runtime-dom.test.ts` and `content-broker.test.ts`).

  The scenario's judgement was the other half. B58's "Play video removed AND Pause video added" was
  the old `ytp` embed UI; YouTube now also serves a `ytm` UI whose cued-overlay label stays in the
  tree while playing, and YouTube auto-hides the controls a few seconds into playback - the paid S4
  run's second read, a few LLM-seconds after the click, saw "Show player controls" and no "Pause
  video" with the video playing. The judgement now reads `click-landed` for "Pause video" **or**
  "Show player controls" in `addedAfterClick` (both drawn only during playback; the toggle reads
  "Hide player controls" before), and the note carries both measurements.

  Paid confirmation: `--slice S4` `004-2026-09-13T04-36-27Z` **3/3 done**, the click `verified`. A
  final `--all` (`004-2026-09-13T04-40-39Z`) then went **16/18** with two *different* reds, both the
  caller's own slips and both admitted in its answer - `s1-three-sessions` read tabId+1000, and
  `s3-artifact-frame` opened a mistyped artifact URL (404). Every scenario has now passed at least
  once today on this build; one all-green report is not in hand, and by the standing rule it is not
  chased with another paid run - `coverage.md` says exactly this.

  Family after the change: 14 passed / 0 failed / 1 skipped. `agent-claim`'s FR-059 section went
  red twice inside the family on the way (the pairing prompt left the panel inside the twenty
  seconds, MCP "Connection closed"), then green twice alone and green in the next two family runs;
  the assertion now carries the server's stderr so the next occurrence names its cause - **T169**.
- [X] T169 **(was Low/intermittent; CLOSED 2026-09-13 B121 — root cause found, product fixed, gate proves it)** `agent-claim.spec.ts` section 7
  (FR-059, accept twenty seconds late): twice inside the family on 2026-09-13 the pairing prompt
  vanished from the panel before the accept and the `slow` server's MCP connection closed;
  2/2 alone and 14/0/1 in the two family runs after. Not T168 (pairing-level, before any click).
  The assertion at the twenty-second mark now prints the server's stderr on failure. Nothing to do
  until it recurs with that log in hand.

  **Measured further (2026-09-13, B118), still open — the mechanism is narrowed, the cause is not
  yet observable.** Six more family runs: red twice (1 in 3, never alone). The server's stderr both
  times: `dial.attached <relay A>` → `pair.requested` → `dial.detached` → `dial.attached <relay B>`
  → `pair.requested` again. The relay's own log (`%LOCALAPPDATA%/hallpass/relay.log`) around
  the second red: relay A started at 13.7 s, the `slow` server attached at 34.3 s, and at **51.2 s a
  new native host B started and superseded A** (`relay.superseded winner=B speaker=A`); B then logged
  `relay.mux.dropped unaddressed type=pair-result` - the worker had sent, on the *new* port, the
  pair-result of a request the new relay never saw. A never logged `relay.chrome.closed` before being
  superseded: its stdin was still open. So this is **not** MV3 idle eviction (17 s after the last
  frame, and the host outlived it) - it is the worker's native port firing `onDisconnect` while the
  host lives, after which the bridge does what it is designed to do: status → disconnected, the
  pending prompt cancelled, the pairing abandoned, a re-open that spawns host B.

  Chrome fires `onDisconnect` on a live native host for a frame it will not deliver (size, framing) or
  for a worker it is shutting down, and it says which in `chrome.runtime.lastError` inside the
  listener - which `agent-bridge.ts` does not record, and could not surface anyway: the agent build
  strips `reportTestDiagnostic` (`__HALLPASS_BUILD_MODE__`), so the worker's side of this has no channel
  the attach gate can read. **That channel is the next piece of work:** carry the last disconnect
  reason in the bridge status the panel projects (or a diagnostics ring the fixture reads over the
  worker socket), then run the family until it recurs. Not started; it is a designed change, not a
  wrap-up.

  What was done meanwhile, and kept: a **heartbeat alarm at Chrome's half-minute floor while the
  link is up** (`AGENT_HEARTBEAT_ALARM`, `agent-runtime.ts`), the way both reference extensions keep
  their worker alive - it closes the real hazard of MV3 evicting an idle worker during an owner's
  long read of a prompt, with a red-then-green test in `agent-runtime-sessions.test.ts`. It did
  **not** remove this failure (1 in 3 before, 1 in 3 after), which is what ruled eviction out. Unit
  1272/1272, contract 226/226, archive guard byte-identical, family 14/0/1 twice after it.

  **The channel exists now (2026-09-13, B119).** `agent-bridge.ts` reads `chrome.runtime.lastError`
  *inside* the `onDisconnect` listener (the only moment Chrome sets it) and hands the reason to the
  runtime (`disconnectReason` / `onDisconnected` deps, injectable); `agent-runtime.ts` keeps the
  last five drops as `{ at, reason? }` in `chrome.storage.session` under `agentBridgeDisconnects`
  (`AGENT_BRIDGE_DISCONNECTS_KEY`), writes serialised so two quick drops cannot lose one, and a drop
  Chrome gave no reason for carries no `reason` field rather than an invented word. Tests:
  `agent-bridge.test.ts` (reason handed through), `agent-runtime-sessions.test.ts` (recorded, most
  recent last, bounded at five). `agent-claim.spec.ts` §7 now prints that ring beside the server's
  stderr when the prompt vanishes. Unit 1274/1274, contract 226/226, archive guard byte-identical.
  The fixture also prints the ring at the end of every attach-mode test (`[bridge-disconnects]`),
  because the next test's reset wipes it and the family's reds land in different specs.

  **What the channel said (2026-09-13, runs 7-9 of the day).** In the failing test (`agent-actions`,
  `find` → `call-unconfirmed`) the worker recorded exactly one drop: **`Error when communicating with
  the native messaging host.`** - Chrome's word for a host→extension stream it could not read, on
  which it closes the port and leaves the host running. Every other drop of the run was `Native host
  has exited.` (the sessions journeys that kill the relay on purpose). The relay log puts that drop at
  **06:47:34.0**, but a *new* host (84820) had already started at **06:47:31.2** and superseded the
  live one (85932) at 31.8 while it was mid-call; the read error is what the superseded relay's
  drain-then-exit looked like from Chrome's side, i.e. a consequence. **The cause is whatever spawned
  host 84820 while this worker's port to 85932 was open.** Chrome spawns a host only for
  `connectNative`, the bridge is the only caller, and `connect()` returns at once while it holds a
  port - so the second host can only have come from a **second worker instance** (a reload, a crash
  and restart, or Chrome starting the next instance before the previous one has finished). The ring
  now carries the worker instance id and the relay pid it was greeted by, which is the one field
  that can prove or refute that.

  Read in the reference (Claude in Chrome's service worker, behaviour only): its connect has two
  guards - the port, and an "attempt in flight" flag - and it adopts a port only after a ping/pong
  handshake; on disconnect it reads `lastError` and stops retrying on "host not found / forbidden".
  Nothing in it re-opens a live port. Our `relay-started` is the handshake; the in-flight guard is
  moot for one instance (`port` is set synchronously) and does nothing across two.

  **State at the end of 2026-09-13 (B119).** The ring now has two halves in `chrome.storage.session`
  - `agentBridgeGreetings` (`{ at, worker, relay }` per `relay-started`) and `agentBridgeDisconnects`
  (`{ at, reason?, worker, relay }` per drop), each worker instance stamping its own id - and the
  attach fixture prints both at the end of every test. Fifteen family runs today: red in runs 2, 5,
  7 and 10 (`agent-claim` §7 twice, `agent-actions` twice, always a call or a prompt in flight when a
  second host superseded the live one ~4-17 s into the test), the last five green. In every green
  test the shape is one worker id per test, and `agent-sessions`' deliberate relay kills show that
  same id greeting the replacement host - the healthy shape, now on record. The next red will show
  either **two worker ids** inside one test (two instances, the fixture's close-then-wake dance being
  the prime suspect: each reset closes the worker target and wakes a new instance, and the relay log
  shows two short-lived hosts inside a second at every test start) or **one id with a drop reason**,
  and that is the fork the fix hangs on. Unit 1274/1274, contract 226/226, archive guard
  byte-identical.

  **Codex read too (2026-09-13).** Same guards as
  ours, eager connect like ours, and one thing we lack: on disconnect it **rejects every pending host
  request with a named error** at once. Neither reference ever re-opens a live port. The difference
  that makes a duplicate host fatal for us and harmless for them is R-111's single-writer relay with
  supersession: their duplicate is an idle extra process, ours takes over the one mid-call. If the
  ring shows two instances, the fix is to make supersession refuse a predecessor whose Chrome port is
  still open and serving.

  **Root cause found (2026-09-13, B120) - the gate's own reset.** With the fixture printing every
  worker target's ring after each test, a red-shaped run showed the host that superseded the live one
  had been **greeted by no worker instance at all** - an ownerless host - and it appeared at the
  bridge's re-open cadence (`AGENT_RECONNECT_BASE_MS` 5 s, then 10 s: the reds sat at +4-6 s and
  +15-17 s into a test). The sequence: the reset closes the previous test's host, that worker's
  bridge arms its 5 s re-open, the reset then `Target.closeTarget`s the worker - which detaches it
  and closes its port but **does not stop its JavaScript** - and five seconds into the next test the
  lingering instance calls `connectNative`. Chrome spawns a host for it, the host takes the relay
  record (R-111 supersession), and the host serving the new test's call is drained and closed under
  it. Both references have the same timer-driven re-open; the difference is that nothing in the
  browser ever leaves a worker's timers running after retiring it - only this gate did. Fix in
  `packaged-extension.ts`: the worker is retired by `Extensions.loadUnpacked` (a real reload, timers
  included), never by closing its target; `awaitStableBridge` additionally holds each test until the
  relay record's pid has been stable for 2 s and is the one this worker was greeted by. The product
  changes made on the way stay, each for its own reason: the heartbeat alarm (idle eviction during
  an owner's long read), the disconnect-reason and greeting rings (the evidence channel this needed
  and the next one will), the click-before-confirm (T168). Not a product defect on the bridge path.

  **Correction and the real fix (B121, same day).** Retiring the worker by reload instead of
  `closeTarget` cut the reds but did not end them: an ownerless host still appeared ten seconds
  into a test and superseded the live one. So the cause is not one particular way of retiring a
  worker; it is that **any** host Chrome spawns for a `connectNative` nobody will ever read from can
  take the single-writer record (R-111) away from the relay that is serving. The two references
  are immune by construction - their hosts are independent processes, a duplicate is an idle extra
  - and both run a handshake before treating a port as their connection. So does this bridge now:

  - **Contract** (`agentLinkFrameSchema`): `relay-ack { relayPid }`, worker → relay;
    `AGENT_LINK_PROTOCOL` 1 → 2, per the stamp's own rule.
  - **Worker** (`agent-bridge.ts`): answers `relay-started` with `relay-ack` before reporting
    connected.
  - **Relay** (`native-host.ts`, `bridge-link.ts`): listens without publishing, sends
    `relay-started`, and publishes the record - arming the supersession watch - only on the ack. A
    relay nobody acknowledges logs `relay.unowned`, closes without touching the record (which was
    never its), and exits on `RELAY_ACK_BOUND_MS` (10 s; `HALLPASS_RELAY_ACK_BOUND_MS` for its tests).
  - **Tests**: `relay-process.test.ts` "never publishes, and leaves on the bound, when nobody
    acknowledges it" (red on the shipped relay, green now; the serving relay's record and session
    untouched), the harness acking like the worker so B13's "second relay wins" test still holds;
    `agent-bridge.test.ts` ack sent; panel-port assertions updated for the extra frame.

  **Proof from the gate.** The attach fixture went back to retiring the worker with
  `Target.closeTarget` on purpose - it keeps producing the zombie condition - and three family runs
  under the ack gate went 14/0/1, 12/2/1 (both reds the T167 foreign-server refusal, tripped by the
  unit suite's own relay tests running in the foreground at the same time - the gate doing its job),
  14/0/1, while the relay log recorded **ten `relay.unowned`** hosts that were caught and left
  without superseding anyone. Unit 1276/1276, contract 226/226, archive guard byte-identical.
  **Review (code-reviewer, R1 on the contract change): no blocking finding.** Two should-fix and
  four low, all read and answered:
  1. *Should fix - a `relay-ack` landing after the bound fired still published.* The bound's close
     path takes up to 2 s to flush, stdin is read meanwhile, and `onAck` only checked `owned`. Fixed:
     a `leaving` flag set on every `published.close()` path (bound, broken framing, Chrome closed,
     publish failure) and checked in `onAck`.
  2. *Should fix - one rejected storage write poisoned the ring chain for the rest of the instance.*
     Fixed: `queueRingWrite` stores the settled chain (`next.catch(() => undefined)`) and returns the
     caller's own `next`; test "keeps recording drops after one storage write rejected".
  3. *Low - the stamp does not cover the native leg: a protocol-2 relay under a pre-T169 worker
     respawns every 10 s, loud only in `relay.log`.* Accepted as is: worker and host ship from one
     build and the attach gate refuses a stale bundle (T098b); noted in the handoff.
  4. *Low - claim scope: a retiring instance alive enough to fire its timer might be alive enough to
     ack.* Answered by the measurement, not the diff: the ownerless hosts in the relay log were
     greeted by no instance (the greetings ring stayed at one entry while they superseded), and after
     the gate `relay.unowned` was logged 18 times with no supersession of a serving relay - so in
     practice they do not ack. If one ever does, it is a live instance and superseding is right.
  5. *Low - a fresh instance that never reaches `connected` never clears a predecessor's heartbeat
     alarm.* Fixed: `start()` clears it; `connected` re-arms it.
  6. *Low - test gaps.* The ack now has an ordering assertion (`relay-ack` is on the wire by the time
     `connected` is reported); the late-ack race stays covered by reading, not a timed process test.
  Final: unit 1277/1277, contract 226/226, archive guard byte-identical, launched 001/002 gate zh-TW
  20 passed / 15 skipped, attach family 14/0/1 with `relay.unowned` at 18 in the log.
- [X] T143 [P] Update `specs/004-reference-parity-bridge/quickstart.md` with the actual report path and any replacement pages recorded during the runs; update `tests/acceptance/owner-remaining-runbook.md` so the only owner step left is the one-time remote-debugging shortcut
- [X] T144 [P] Doc sync: `CLAUDE-CODE-HANDOFF.md` Status/Pick-up-here to the 004 state; one-line pointer from `docs/design-notes.md` to the delivered tools; spec change log entries for any recorded readings
- [X] T145 Final archive guard and full suites: `npx tsc -b`, unit, contract, launched 001/002 gate en-US + zh-TW, attach-mode `agent-*` gate; record numbers in `tests/acceptance/browser-matrix.md`

---

## Dependencies & Execution Order

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: after Setup; blocks every slice (one owner of `agent-tools.ts`).
- **S0 / US1 (Phase 3)**: after Foundational; produces the "before" report and decides the baseline source. Every later slice's closing task depends on it.
- **S1 / US2 (Phase 4)**: after S0. The link inversion; everything after assumes N sessions.
- **S2 / US3 (Phase 5)**: after S1 (leases are per session; the indicator needs the agent content script, which S2 introduces and S3 extends).
- **S3 / US4 read (Phase 6)**: after S2 (content script exists).
- **S4 / US5 + US4 act (Phase 7)**: after S3 (frame rects) and S2 (leases decide attachment).
- **S5 / US6 (Phase 8)**: after S3 (per-frame registries) — independent of S4.
- **S6 / US7 (Phase 9)**: after S4.
- **Polish (Phase 10)**: after every slice.

### Within each slice

- Red test before implementation; prove red by reverting.
- Contract (Phase 2) → handler → host registration → packaged journey → probe scenarios → report attached → archive guard. A slice without its report is not done.
- Run `npx tsc -b` before the packaged journeys and the probe (they resolve `@hallpass/*` through `dist/`).

### Parallel opportunities

- Phase 1: T073–T075 parallel; Phase 2: T076/T077 parallel.
- Within a slice, every `[P]` red test runs parallel to the previous task's implementation in another file.
- S5 can run in parallel with S4 once S3 lands (different files: registry/collector vs input).

---

## Implementation Strategy

### The probe first (S0)

1. Phases 1–3. **Stop and read the report**: E1–E4 must reproduce as failures and the baseline-source
   decision must be recorded. This is the instrument every later claim is measured with.

### Then the owner's order, one slice per delivery

2. S1 (sessions) → S2 (pairing, owner's tab) → S3 (frames read) → S4 (input) → S5 (refs, capacity,
   shadow) → S6 (computer). Each ends with its probe report on the owner's Chrome 152; no slice is
   reported done on fixtures alone.

### Estimate

Autonomous-session cadence: **S0 + S1** session one (the instrument and the structural fix); **S2 +
S3** session two; **S4 + S5** session three (S5 parallel to S4); **S6 + polish** session four. Reviews
per the risk axis: S1 (link/security boundary, concurrency) code + architecture review; S4 (debugger
use) code review; others close by tests + probe.

---

## Notes

- Behaviour targets come from `docs/design-notes.md`; no reference identifier may
  enter source (Constitution II) — the T079 guard and a grep before each delivery enforce it.
- One writer at a time; the narrow build is the archive guard and is checked at every slice close.
- Probe runs cost the owner's quota: sonnet, low effort, `--max-turns`, only at slice close.
