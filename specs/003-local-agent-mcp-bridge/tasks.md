---

description: "Task list for Local Agent MCP Bridge"
---

# Tasks: Local Agent MCP Bridge

**Input**: Design documents from `/specs/003-local-agent-mcp-bridge/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/README.md), [quickstart.md](./quickstart.md)

**Tests**: **Required.** The repository's working rule mandates a focused failing test before every
behaviour change, and constitution Article VII requires observable acceptance criteria. Every behaviour
task below is preceded by its red test. Prove red by reverting the fix, never by assertion.

**Organization**: Tasks are grouped by user story so each ships on its own. Phase order follows the
plan's "front-load the unknowns" ordering: the spine (US1 spike) resolves native messaging, MCP stdio
and tab ownership before any story is built out.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different file, no dependency on an incomplete task
- **[Story]**: US1–US7 from spec.md; Setup / Foundational / Polish carry no story label
- Every task names the exact file it touches

## Path Conventions

npm workspace. Real paths for this feature:

- `packages/agent-host/src/` — NEW native-messaging + MCP host (Node, outside the browser)
- `packages/contracts/src/agent-tools.ts` — NEW closed schemas (tool args/results, native frame, site-mode projection)
- `apps/extension/src/service-worker/` — NEW `agent-bridge.ts`, `agent-tab-manager.ts`, `site-mode-store.ts`, `pairing-controller.ts`, `agent-tools/`
- `apps/extension/src/side-panel/` — pairing, per-site mode, agent-activity views
- `apps/extension/src/build-config.ts` — NEW `agent` build profile
- `apps/extension/src/content-runtime/` — REUSED unchanged
- `tests/contract/`, `tests/e2e/packaged/`, `tests/harness/`, `apps/extension/tests/`, `packages/agent-host/tests/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: create the new package and build profile so every later task has a home; nothing here
declares behaviour.

- [X] T001 Create `packages/agent-host/` with `package.json` (name `@hallpass/agent-host`, type module, deps `@modelcontextprotocol/sdk`, `zod`; dev dep `@hallpass/contracts`), `tsconfig.json` extending the base, and add it to the root `workspaces` array in `package.json`
- [X] T002 [P] Add the `agent` build profile to `apps/extension/src/build-config.ts`: extend `BUILD_PROFILES` with `"agent"` and add its `PROFILE_PERMISSIONS` entry (`activeTab`, `scripting`, `sidePanel`, `storage`, `nativeMessaging`, `tabs`, `tabGroups`); leave `narrow` untouched
- [X] T003 [P] Add npm scripts to root `package.json`: `build:extension:agent` (agent-profile extension build), `agent-host:install` / `agent-host:uninstall` (run the host installer), `test:e2e:agent` (Playwright against `tests/e2e/packaged/agent-*.spec.ts`)
- [X] T004 [P] Add a `packages/agent-host/tests` vitest include and a `tests/e2e/packaged/agent` grouping so the new suites are discovered without touching existing projects

**Checkpoint**: `npx tsc -b` builds the empty new package; existing suites unchanged.

**Result note (2026-09-08)**: `packages/agent-host` is a workspace package (`@modelcontextprotocol/sdk`
1.30.0, `zod` 4.4.3, `@hallpass/contracts`) built by `tsc -b` into `dist/`, which the tests and the installer
both spawn. `apps/extension/src/build-config.ts` carries the second profile: `dist/agent` declares
`activeTab, scripting, sidePanel, storage, nativeMessaging, tabs, tabGroups, alarms, debugger` and
`<all_urls>` (+ `https://localhost/*` in test mode), while `dist/test`/`dist/production` stay narrow and
byte-identical — re-checked at the close of the feature by diffing `dist/test/manifest.json` against a
copy taken before the change. Root scripts: `build:extension:agent`, `agent-host:install`,
`agent-host:uninstall`, `test:e2e:agent`. No vitest config change was needed (`packages/**/*.test.ts`
already covers `packages/agent-host/tests`).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the closed contracts and the reused-runtime seam every story needs. No user-visible
behaviour yet.

**⚠️ CRITICAL**: no story work begins until this phase is complete.

- [X] T005 [P] Contract test in `tests/contract/agent-tools.contract.test.ts`: the native-frame request/response schemas round-trip and reject unknown fields; the `ToolCall` outcome enum is closed (`ok`/`denied`/`stale`/`busy`/`not-readable`/`not-actionable`/`stopped`/`timed-out`/`failed`)
- [X] T006 Define the closed schemas in `packages/contracts/src/agent-tools.ts` (native frame, outcome enum, site-mode projection, per-tool arg/result stubs) and export them from `packages/contracts/src/index.ts` (make T005 green)
- [X] T007 [P] Unit test in `packages/agent-host/tests/native-frame.test.ts`: length-prefixed framing encodes/decodes a message and rejects a truncated or oversized frame
- [X] T008 Implement `packages/agent-host/src/native-frame.ts` (make T007 green)
- [X] T009 [P] Unit test in `apps/extension/tests/agent-runtime-seam.test.ts`: a fake agent request produces the same internal content-runtime call shape (`content.collect-page`, `content.resolve-target`, `content.evaluate-condition`, executor call) the remote path produces, proving R-103's shared seam
- [X] T010 Extract the caller-agnostic dispatch seam the remote `control-port` already uses into a reusable helper the agent bridge can call, without changing remote behaviour, in `apps/extension/src/service-worker/` (make T009 green; remote unit/contract suites stay green)

**Checkpoint**: contracts and the shared seam exist and are typed; `npm run test:contract` green.

**Result note (2026-09-08)**: the closed shapes live in `packages/contracts/src/agent-tools.ts` — the
outcome enum, `AGENT_TOOL_NAMES`, the strict native request/response frames, the control frames
(`pair-request`, `pair-result`, `unpair`, `stop`, `hello`, `bridge-unavailable`), the site-mode record
and, as later slices landed, every per-tool arg/result schema plus the panel port's projection and
commands. Framing is `packages/agent-host/src/native-frame.ts` (4-byte little-endian length prefix,
1 MiB bound, streaming decoder). The shared runtime seam is *not* a new dispatcher: the three
active-tab functions in `service-worker/content-broker.ts` gained an optional `tab?: number`, so the
agent binds a tab explicitly and every existing check after that runs unchanged; `control-port.ts` never
passes it, which is why the remote path is untouched.

---

## Phase 3: User Story 1 — Pair a coding agent with the browser once (Priority: P1) 🎯 MVP spine

**Goal**: a paired Claude Code session runs one trivial tool (`tabs_context`) end to end; this phase
resolves R-101 (Windows native messaging), R-102 (MCP stdio), R-104 (tab ownership) in code.

**Independent Test**: install the host, configure Claude Code, run `tabs_context` — the pairing prompt
appears once, the call returns the session's tabs, a second session needs no prompt, unpairing makes the
next call fail with a clear "not paired".

### Spike (resolves the unknowns; do first)

- [X] T011 [US1] Native-messaging host manifest + Windows HKCU registry writer/remover in `packages/agent-host/src/install/` with a Node-launcher shim; manual note in quickstart on how it was verified (Chrome spawns the host)
- [X] T012 [US1] Minimal `packages/agent-host/src/mcp-server.ts`: `McpServer` + `StdioServerTransport`, one `registerTool("tabs_context")` that forwards a native frame and returns its result as text; resolves the R-102 process-ordering question and records the answer inline
- [X] T013 [US1] `connectNative` bridge skeleton in `apps/extension/src/service-worker/agent-bridge.ts`: open the port, parse frames, answer `tabs_context` from a stubbed tab manager

### Tests then implementation

- [X] T014 [P] [US1] Unit test `apps/extension/tests/pairing-controller.test.ts`: reducer goes absent → pending (first connection) → paired (accept) / absent (decline); a second `agentId` is independent; unpair returns to absent
- [X] T015 [US1] Implement `apps/extension/src/service-worker/pairing-controller.ts` backed by `chrome.storage.local` (make T014 green)
- [X] T016 [P] [US1] Unit test `apps/extension/tests/agent-tab-manager.test.ts`: a session owns a tab group; `tabs_context` lists only that group; a tab the owner closed reports "gone"; a tab outside the group is refused
- [X] T017 [US1] Implement `apps/extension/src/service-worker/agent-tab-manager.ts` (tab-group ownership, marking, reconciliation) over new `chrome-adapters` tabs/tabGroups adapters (make T016 green)
- [X] T018 [US1] Wire the bridge to the pairing controller: a first connection raises a pairing request; no tool runs before accept; `tabs_context` answers from the real tab manager once paired, in `apps/extension/src/service-worker/agent-bridge.ts`
- [X] T019 [P] [US1] Pairing UI in `apps/extension/src/side-panel/`: show the pairing request (agent name, origin, the one-sentence forwarding disclosure), Accept/Decline, and a paired-agents list with Unpair
- [X] T020 [P] [US1] Headless host harness `tests/harness/mcp-client.ts`: drive the host over stdio without a browser, for host-side journeys
- [X] T021 [US1] Packaged attach-mode journey `tests/e2e/packaged/agent-pairing.spec.ts`: pair, `tabs_context`, second session no prompt, unpair → refused (SC-020, SC-026)

**Checkpoint**: US1 works end to end from Claude Code; the three unknowns are resolved. **MVP spine.**

**Result note (2026-09-08)**: two processes and one loopback link (R-102). `mcp-server.ts` is what the
agent spawns over stdio; it listens on `127.0.0.1:0` and publishes `{port, token, pid, startedAt}` to
`%LOCALAPPDATA%\hallpass\bridge.json`. `native-host.ts` is what Chrome spawns; it reads that file,
presents the token and pumps frames, originating only `bridge-unavailable`. The installer writes
`native-host.cmd`, `com.hallpass.host.json` and both `HKCU\...\NativeMessagingHosts` keys (Google Chrome
and Chromium — the bundled Chromium every gate runs against reads the second), and is idempotent.
Pairing is a reducer over `chrome.storage.local`; the session's tabs are a marked tab group. The panel
got its own port (`hallpass-panel`), never the archived control port. `tests/harness/mcp-client.ts`
drives the real built server over stdio and `fake-agent-worker.ts` stands in for Chrome, so
`packages/agent-host/tests/mcp-server.test.ts` proves the ordering with no browser at all.

---

## Phase 4: User Story 3 — Act on the page under a per-site mode (Priority: P1)

**Goal**: the consent model (`ask` / `follow-a-plan` / `skip-checks`) and the effect tools. Placed
before US2 because the per-site gate is the spine of the feature and every later effect depends on it.

**Independent Test**: on a fixture in `skip-checks`, each action changes the page as the fixture
defines; in `ask`, one action prompts and nothing happens until answered.

- [X] T022 [P] [US3] Unit test `apps/extension/tests/site-mode-store.test.ts`: default is `ask`; set/get per site (scheme+host); diagnostics flag; durable in `chrome.storage.local`
- [X] T023 [US3] Implement `apps/extension/src/service-worker/site-mode-store.ts` (make T022 green)
- [X] T024 [P] [US3] Unit test `apps/extension/tests/site-mode-gate.test.ts`: `skip-checks` admits; `ask` prompts and denies on no/no-answer (timeout); `follow-a-plan` admits an approved step and treats an unplanned step as `ask`; reads/tab-management skip the gate
- [X] T025 [US3] Implement the gate in `apps/extension/src/service-worker/agent-tools/gate.ts` (StatedPlan admission reuses 002's plan-admission shape, session+site local) (make T024 green)
- [X] T026 [P] [US3] Contract test `tests/contract/agent-effect-tools.contract.test.ts`: arg/result schemas for click/right/double/triple click, hover, drag, type, key (modifiers+repeat), scroll, form_input
- [X] T027 [US3] Define those tool schemas in `packages/contracts/src/agent-tools.ts` (make T026 green)
- [X] T028 [US3] Effect tool handlers in `apps/extension/src/service-worker/agent-tools/effects.ts`: each maps to the existing content-runtime executor (002 gestures/keys/drag reused), passes through the gate, and returns the observed outcome (never an unobserved effect)
- [X] T029 [US3] Register the effect tools in `packages/agent-host/src/mcp-server.ts` and route them through the bridge
- [X] T030 [P] [US3] Side-panel per-site mode view: show and set each site's mode, set mode from within an `ask` prompt, show the live `ask` prompt with site/target/action
- [X] T031 [US3] Packaged attach-mode journey `tests/e2e/packaged/agent-actions.spec.ts`: `skip-checks` runs each action; `ask` prompts and blocks; a `no` runs nothing (SC-023); a stale ref and a busy tab are refused

**Checkpoint**: US1 + US3 — a paired agent can act under the owner's per-site consent.

**Result note (2026-09-08)**: the per-site decision is one store (`site-mode-store.ts`, scheme+host, default
`ask`, durable) and one pure function (`agent-tools/gate.ts`): `skip-checks` admits, `ask` prompts and
denies on no or no answer, `follow-a-plan` admits an approved step and treats an unplanned one as `ask`.
Reads and tab management never reach it. The effect handlers (`agent-tools/effects.ts`) map onto 002's
existing executor and return *observed* evidence plus the post-effect verification verdict — including
`documentChanged` when only the verification saw the page move (B2). The panel shows each site's mode, the
live `ask` prompt and the plan prompt; every sentence comes from the locale tables.

---

## Phase 5: User Story 2 — Read and understand the current page (Priority: P1)

**Goal**: the read tools, ungated.

**Independent Test**: each read tool returns the fixture's known content; restricted pages answer
"not readable".

- [X] T032 [P] [US2] Contract test `tests/contract/agent-read-tools.contract.test.ts`: arg/result schemas for `get_page_text`, `read_page` (filter/depth/ref), `find` (`no-match`/`too-broad`), `screenshot` (region)
- [X] T033 [US2] Define the read-tool schemas in `packages/contracts/src/agent-tools.ts` (make T032 green)
- [X] T034 [US2] Read handlers in `apps/extension/src/service-worker/agent-tools/reads.ts`: `get_page_text`/`read_page` via the collector, `find` via `resolveDescription`, minting refs from `TargetRegistry`; all ungated (make schemas exercise green)
- [X] T035 [P] [US2] Unit test `apps/extension/tests/agent-screenshot.test.ts`: `screenshot` returns a PNG image block for the agent tab; `zoom` crops in-worker; a restricted page answers "not readable"
- [X] T036 [US2] Implement `screenshot`/`zoom` via `chrome.tabs.captureVisibleTab` + in-worker crop in a new `chrome-adapters/capture.ts` (make T035 green)
- [X] T037 [US2] Register the read tools in `packages/agent-host/src/mcp-server.ts`
- [X] T038 [US2] Packaged attach-mode journey `tests/e2e/packaged/agent-reads.spec.ts`: each read tool on the `ordinary` fixture; each restricted-page kind answers "not readable" (SC-027); reading never prompts

**Checkpoint**: US1 + US2 + US3 — the agent can read and act. Reference-tool parity begins to show.

**Result note (2026-09-08)**: `agent-tools/reads.ts` answers `get_page_text`, `read_page` (interactive/all
filter, depth, ref-rooted) and `screenshot` through the same collector the remote path uses, asking it for
the agent's own minting policy (`all-controls`, B1) and — from M7/C2 — for each node's visibility, so the
working list leaves out what nobody can see while `all` still names it. `find` reuses 002's
`resolveDescription`. Nothing here consults a site mode or raises a prompt; the tab still has to be the
session's. `chrome-adapters/capture.ts` does `captureVisibleTab` plus an in-worker crop, and refuses a
payload the 1 MiB frame could not carry.

---

## Phase 6: User Story 4 — Navigate and manage tabs (Priority: P2)

**Goal**: create/close/navigate/history/resize, with the session group visibly the agent's.

**Independent Test**: create a tab, navigate to two fixtures, go back, list tabs (only the group's),
close it; a tab outside the group is refused.

- [X] T039 [P] [US4] Contract test `tests/contract/agent-tab-tools.contract.test.ts`: schemas for `tabs_create`, `tabs_close`, `navigate` (url/back/forward), `resize_window`
- [X] T040 [US4] Define the tab-tool schemas in `packages/contracts/src/agent-tools.ts` (make T039 green)
- [X] T041 [P] [US4] Unit test `apps/extension/tests/agent-navigation.test.ts`: navigate reports the final URL or an explicit failure; a hand-closed tab answers "gone"; navigation never prompts; the destination site's mode applies afterwards
- [X] T042 [US4] Tab-tool handlers in `apps/extension/src/service-worker/agent-tools/tabs.ts` over the tab manager (make T041 green)
- [X] T043 [US4] Register the tab tools in `packages/agent-host/src/mcp-server.ts`
- [X] T044 [US4] Packaged attach-mode journey `tests/e2e/packaged/agent-tabs.spec.ts`: create/navigate/back/list/close; a tab outside the group is refused (SC-024)

**Checkpoint**: the agent controls its own tabs; automated tests can start from a URL.

**Result note (2026-09-08)**: `agent-tools/tabs.ts` over `chrome-adapters/tabs.ts` and `tab-groups.ts`.
A navigation is settled by watching `chrome.tabs.onUpdated` for a `complete` that belongs to *this*
navigation (a `loading` observed after the action, or a url that actually changed — B4), bounded at 25 s,
strictly under the host's 30 s call timeout. A tab the owner closed by hand answers `stale`/`tab-gone`
rather than a handler error (B7). Navigation never prompts; the destination site's mode governs whatever
comes next, and (from M7/C1) the diagnostics attachment is re-checked whenever the tab moves at all.

---

## Phase 7: User Story 5 — Batch and wait (Priority: P2)

**Goal**: one round trip for a sequence; wait for a page condition.

**Independent Test**: the five-step login runs as one batch under the 10-second budget; a batch that
fails mid-way stops with later steps not run; a wait ends at its condition or its bound.

- [X] T045 [P] [US5] Contract test `tests/contract/agent-batch-wait.contract.test.ts`: `browser_batch` (ordered steps, per-step outcome, stop-on-first-failure) and `wait` (fixed ms; condition present/absent/enabled/visible-text-changed with a bound) schemas
- [X] T046 [US5] Define the batch/wait schemas in `packages/contracts/src/agent-tools.ts` (make T045 green)
- [X] T047 [P] [US5] Unit test `apps/extension/tests/agent-batch.test.ts`: batch runs in order, stops at first failure with remaining steps reported not-run, applies the gate to each effect as if sent alone; a mid-batch navigation switches the governing site mode
- [X] T048 [US5] Batch runner in `apps/extension/src/service-worker/agent-tools/batch.ts` (sequential, one-in-flight-per-tab, gate per step) (make T047 green)
- [X] T049 [P] [US5] Unit test `apps/extension/tests/agent-wait.test.ts`: wait ends at the condition via the existing `evaluateCondition`, or at the bound with "condition not met"; Stop ends it at once
- [X] T050 [US5] Wait handler in `apps/extension/src/service-worker/agent-tools/wait.ts` over the existing condition evaluator (make T049 green)
- [X] T051 [US5] Register `browser_batch` and `wait` in `packages/agent-host/src/mcp-server.ts`
- [X] T052 [US5] Packaged attach-mode journey `tests/e2e/packaged/agent-batch-wait.spec.ts`: five-step login as one batch under 10 s (SC-021); a failing third step stops the batch; a wait bound is reported

**Checkpoint**: automated login/flow tests run in one call — the headline outcome of the feature.

**Result note (2026-09-08)**: `agent-tools/batch.ts` walks the steps in order through the *same*
`dispatchTool` a lone call takes, so the per-step gate of FR-047 is a fact about the wiring rather than a
promise; the first failure stops the batch and the remaining steps are reported `not-run`. On a
`follow-a-plan` site the whole batch is one question in the panel and the owner's approval becomes the
session's StatedPlan. `agent-tools/wait.ts` ends at the condition through 002's existing condition
evaluator, at its bound (`failed`/`bound-reached`), or at the owner's Stop. Measured in the journey: the
five-step login lands well inside the ten-second budget of SC-021.

---

## Phase 8: User Story 6 — Diagnostics behind an explicit grant (Priority: P3)

**Goal**: console, network and evaluate, gated by a per-site diagnostics grant.

**Independent Test**: with the grant, `read_console` returns a logged message; without it, a
diagnostics tool is refused.

- [X] T053 [US6] Add `debugger` (and downloads/file access for US7) to the `agent` profile in `apps/extension/src/build-config.ts`, each traced to its FR in a comment
- [X] T054 [P] [US6] Contract test `tests/contract/agent-diagnostics.contract.test.ts`: `read_console`, `read_network`, `evaluate` schemas; the diagnostics-not-granted refusal is a distinct outcome
- [X] T055 [US6] Define the diagnostics schemas in `packages/contracts/src/agent-tools.ts` (make T054 green)
- [X] T056 [P] [US6] Unit test `apps/extension/tests/agent-diagnostics-gate.test.ts`: the three tools are refused without the grant; a script's visible effects are still governed by the site mode
- [X] T057 [US6] Diagnostics handlers in `apps/extension/src/service-worker/agent-tools/diagnostics.ts` over a new debugger adapter, gated by the site-mode store's diagnostics flag (make T056 green)
- [X] T058 [US6] Register the diagnostics tools; add the diagnostics grant/revoke control to the side-panel per-site view
- [X] T059 [US6] Packaged attach-mode journey `tests/e2e/packaged/agent-diagnostics.spec.ts`: grant then read a logged message; without the grant, refused; the browser's debugger warning names this extension

**Checkpoint**: tests can assert on console/network/page state under an explicit grant.

**Result note (2026-09-08)**: two consents, and they are not the same one. The per-site *grant* (set from
the panel, `ui.agent.set-diagnostics`) decides whether the three tools run at all; the site *mode* still
decides `evaluate`, because a script does what a click does. The debugger attaches lazily on the first
granted call and lets go on revoke, tab close, session end, a site change — and, from M7/C1, on any
navigation Chrome reports for an attached tab, with a reconcile against `chrome.debugger.getTargets()`
at worker start for attachments that outlived an evicted worker. Buffers hold levels, texts, times,
methods, urls, statuses and kinds; headers, cookies and bodies are dropped where the event arrives.
M7/C3 bounded the filter: a nested-quantifier `pattern` is `failed`/`invalid-pattern` and matching only
ever sees the first 512 characters of a line. M7/C5 bounded the pending-request map.

---

## Phase 9: User Story 7 — Upload a file into a page (Priority: P3)

**Goal**: put owner-allowed files into a page's file input.

**Independent Test**: upload a small allowed file; the page reports its name and size; a disallowed path
is refused.

- [X] T060 [P] [US7] Contract test `tests/contract/agent-upload.contract.test.ts`: `file_upload` schema and the size/path-refusal outcome
- [X] T061 [US7] Define the upload schema in `packages/contracts/src/agent-tools.ts` (make T060 green)
- [X] T062 [P] [US7] Unit test `apps/extension/tests/agent-upload.test.ts`: an allowed small file sets the input; a disallowed path or oversize file is refused with nothing read from disk
- [X] T063 [US7] `file_upload` handler in `apps/extension/src/service-worker/agent-tools/upload.ts` (gate + allowed-path rule) and register it (make T062 green)
- [X] T064 [US7] Packaged attach-mode journey `tests/e2e/packaged/agent-upload.spec.ts`: allowed upload observed; disallowed path refused

**Checkpoint**: all seven stories independently functional.

**Result note (2026-09-08)**: the file system is the *host's* business alone. `upload-policy.ts` resolves
every path through `fs.realpath` and checks it against the owner's `uploadRoots` in
`%LOCALAPPDATA%\hallpass\config.json` **before opening anything**; a path outside every root, a
symlink escaping one, more than ten files, or more than the frame can carry is `denied`/`upload-not-allowed`
with a stable code and never a path in the log. From M7/C4 the size bound is measured as the *base64* the
worker will check (`sum(ceil(bytes/3)*4) ≤ 700_000`), so the host cannot read files the extension would then
refuse. The worker receives bytes and no path at all; `content.set-files` builds the `File` objects, and
(M7/C4) refuses more files than a single-file input takes and a kind its `accept` excludes, as
`not-actionable`. The answer is what the input is holding afterwards, read from the element. No new
permission was needed for US7.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: privacy evidence, the archived-path guarantee, and the doc/gate sweep. No new behaviour.

- [X] T065 [P] Privacy journey `tests/e2e/packaged/agent-privacy.spec.ts`: run the read/act/tab/batch journeys with the redacting proxy fronting the unused remote service; assert it saw no page content (SC-025)
- [X] T066 [P] Regression guard: confirm the archived remote-service modules still compile (`npx tsc -b`) and their 001/002 unit + contract suites stay green; record the numbers in `quickstart.md`
- [X] T067 [P] Host redaction unit test `packages/agent-host/tests/host-logging.test.ts`: the host logs only stable codes, never page-derived content (mirrors the proxy redaction rule)
- [X] T068 [P] Locale coverage: the pairing prompt, the `ask` prompt, and the per-site mode view carry both `en-US` and `zh-TW` strings; extend `tests/contract/locales.contract.test.ts` to walk the new keys
- [X] T069 [P] SC coverage check: every tool in `contracts/README.md` §1 appears in at least one passing `agent-*` journey (SC-022); record the mapping in `quickstart.md` — the map is its own file, `coverage.md`, linked from `quickstart.md`; `right_click` and `triple_click` had no journey and got one
- [X] T070 Run the full attach-mode agent gate in both locales on branded Chrome 152 and record results in `tests/acceptance/browser-matrix.md` — done on **bundled Chromium 151** in both locales (8 passed each, reports below); the **branded Chrome 152** cells stay the owner's, because 152 refuses command-line sideloading and the extension has to be loaded by hand (runbook step 2b), and are recorded "owner, not yet run"
- [X] T071 [P] Doc sync: update `CLAUDE-CODE-HANDOFF.md` Status/Pick-up-here to the 003 state and add a one-line pointer from `docs/design-notes.md` to the delivered tool surface

**Checkpoint**: feature 003 complete, archived path intact, evidence recorded.

**Result note (2026-09-08)**: the M6 review's findings were folded in first (C1 detach on any navigation
plus a start-time reconcile, C2 visibility in the collection, C3 bounded pattern matching, C4 base64 and
`accept`/`multiple` bounds on uploads, C5 the pending-request map, C6 the upload journey restoring the
owner's config from a `finally` it always reaches, C7 the missing unit cases), each with its own red test.
Then the polish itself: `agent-privacy.spec.ts` (T065) runs reads, effects, tab work and a batch while the
redacting proxy in front of the unused remote service records **no request at all**, and greps the
fixture's own strings out of `relay.log` and the server's stderr; `host-logging.test.ts` (T067) pins the
same rule as a unit test on both host processes; the panel's message keys became an exported list
(`side-panel/agent-panel-keys.ts`) that `locales.contract.test.ts` walks in both locales, and the tool
summaries the owner reads in a prompt became reviewed copy (`agent.summary.<tool>`) instead of the
worker's English (T068); `coverage.md` (T069) maps every tool and every SC to a passing journey — the two
gestures that had none, `right_click` and `triple_click`, gained a witness in the `gestures` fixture and a
case in `agent-actions.spec.ts`.

Final numbers, all on one build:

    npx tsc -b / tsc -p apps/extension --noEmit / tsc -p tsconfig.tests.json --noEmit   exit 0
    npm test                                          83 files / 898 tests passed
    npm run test:contract                             18 files / 210 tests passed
    npm run build:extension:test                      narrow manifest byte-identical
    npm run build:extension:agent                     agent manifest with <all_urls> + debugger
    launched packaged gate  en-US  19 passed / 9 skipped   zh-TW  20 passed / 8 skipped
    probe agent gate (Chromium 151, attached)  en-US  8 passed   zh-TW  8 passed

Reports: `test-results/packaged-core-en-US-2026-09-08T06-56-33-588Z`,
`packaged-core-zh-TW-2026-09-08T07-02-07-897Z`, `packaged-core-en-US-2026-09-08T07-07-57-766Z`,
`packaged-core-zh-TW-2026-09-08T07-10-35-043Z` (each `/report.json`). Branded Chrome 152 remains the
owner's, in both locales, per runbook step 2b.

---

## Dependencies & Execution Order

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: after Setup; blocks every story (contracts + shared seam).
- **US1 (Phase 3)**: after Foundational; the spine — resolves the unknowns; every other story needs the
  bridge, the tab manager and pairing it establishes.
- **US3 (Phase 4)**: after US1; the per-site gate every effect and every later effect-bearing story uses.
- **US2 (Phase 5)**: after US1 (reads are ungated; independent of US3).
- **US4 (Phase 6)**: after US1.
- **US5 (Phase 7)**: after US3 (batch is effects) and US4 (navigation mid-batch).
- **US6 (Phase 8)**: after US3 (a script's effects are gated).
- **US7 (Phase 9)**: after US3.
- **Polish (Phase 10)**: after the stories it measures.

### Within each story

- The red test precedes its implementation; prove red by reverting, not by assertion.
- Schema (contract) before handler; handler before host registration; host registration before the
  packaged journey.
- Run `npx tsc -b` before the packaged journeys (they resolve `@hallpass/*` through `dist/`).

### Parallel opportunities

- Phase 1 T002–T004 are parallel.
- Within a story, the `[P]` red tests and the side-panel view run parallel to the handler work in
  different files.
- Once US1 lands, US2 and US4 can proceed in parallel with US3; US5/US6/US7 wait on US3.

---

## Implementation Strategy

### MVP spine first (US1)

1. Phase 1 Setup → Phase 2 Foundational → Phase 3 US1.
2. **Stop and validate**: a paired Claude Code session runs `tabs_context` on branded Chrome 152. This
   proves native messaging, MCP stdio and tab ownership — the whole risk of the feature — before any
   breadth is built.

### Then breadth, one shippable story at a time

3. US3 (act under a mode) → US2 (read) → US4 (tabs): after these, an agent can open, read and act. This
   is the first genuinely useful automated-testing surface and the visible start of reference parity.
4. US5 (batch + wait): the headline — automated flows in one call.
5. US6 (diagnostics), US7 (upload): additive, behind their own grants.

### Estimate

Grouped for the autonomous-session cadence: **spine** (Phases 1–3) is session one and carries the
unknowns; **act+read+tabs** (Phases 4–6) session two; **batch+wait plus diagnostics/upload** (Phases
7–9) session three; **polish** (Phase 10) folds into the last. 3–4 sessions to the full feature, MVP
spine demonstrable at the end of session one.

---

## Notes

- `[P]` = different file, no dependency on an incomplete task.
- Every story is independently testable via its packaged attach-mode journey.
- The content runtime, domain policies and existing contracts are reused, not forked; do not modify the
  remote-service modules — 003 archives them by not reaching them, and Phase 10 T066 guards that they
  still compile and pass.
- One writer at a time; run the three typecheck stages separately; run the packaged gate only on a
  final build, in attach mode against branded Chrome 152.
