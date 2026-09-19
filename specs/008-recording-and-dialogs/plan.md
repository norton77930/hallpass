# Implementation Plan: Recording, Dialogs and Window Restore

**Branch**: `008-recording-and-dialogs` (git: `worktree-feature-008-spec`) | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-recording-and-dialogs/spec.md`; research in
[research.md](./research.md) (R-132–R-143); reference evidence in
`docs/design-notes.md`, read **before** the spec per the owner's 2026-09-18 rule.

## Summary

Three additions to the local-agent path and one permission. (1) **Recording** — a `gif_recorder` tool;
one decorator on the runtime's single dispatch point takes a JPEG frame through the tab's debugger
attachment after every page-changing action and hands it to a new **offscreen document**, which holds
frames per session, draws the owner-approved overlays, encodes with a bundled MIT encoder, and returns a
blob URL the worker downloads into the browser's download folder under an agent-chosen file name
(R-132–R-137). (2) **Dialogs** — the attachment enables the page-events domain as a second stated
exception, two dialog events reach a new `dialogs.ts`, the dispatch point answers `blocked-by-dialog`
while one is open, a `dialog` tool accepts or dismisses under the site mode with the chained-accept
exemption, `beforeunload` defaults to *stay* with `force` as a gated effect, and a bounded liveness
probe follows every answer (R-138–R-140). (3) **Window restore** — `resize_window` records the prior
state; two session hooks restore it through a pure edge-case function (R-141). (4) `offscreen` joins
the agent profile's permissions; version becomes 0.2.0 from its single literal; an upgrade spec proves
0.1.0 → 0.2.0 keeps pairing and site modes (R-142–R-143). Verification is the 004 standard plus decoding
the exported GIF in the gate; two slices are pre-selected for `code-reviewer` (D-008-5/FR-117 and
FR-103/FR-121).

## Technical Context

**Language/Version**: TypeScript 5.9 on Node 24, strict, unchanged.
**Primary Dependencies**: `gifenc` 1.0.3 (MIT, zero deps) in `apps/extension` — bundled into the
offscreen entry only; `omggif` 1.0.10 (MIT, zero deps) as a devDependency of the test kit for the gate's
decoder. Nothing else (R-135).
**Storage**: `chrome.storage.session` gains `agentRecordings` (per-session state summary) and
`agentWindowRestores` (list of restore records); frames live only in the offscreen document's memory
(R-134). Nothing in `storage.local`.
**Permissions**: `offscreen` added to `AGENT_PROFILE_PERMISSIONS` (`apps/extension/src/build-config.ts`)
only; the narrow manifest is unchanged (FR-121).
**Testing**: vitest unit (`apps/extension/tests`), contract (`tests/contract`), packaged attach gate
(`tests/e2e/packaged/agent-*.spec.ts`, `HALLPASS_CDP_ENDPOINT=http://127.0.0.1:9222`), probe-004 harness with
new scenarios `s9-recording.json`, `s10-dialogs.json`, `s11-window-restore.json`; a dialog fixture page in
`tests/harness/page-fixtures.ts`.
**Target Platform**: branded Chrome 152, MV3; `chrome.offscreen.hasDocument()` is available (Chrome 150+).
**Constraints**: one offscreen document per extension, `chrome.runtime` its only extension API (Chrome
docs); frames ≤ ~1 MB each after JPEG + 1568 px downscale; every tool answer while a dialog is open
returns in < 500 ms; the archived remote path and the narrow manifest byte-identical (004 FR-070).
**Performance Goals**: export of 200 frames at 1280×800 in < 15 s on the owner's machine (measured on the
gate, SC-054 timing recorded in the report); frame capture adds ≤ 150 ms to a recorded action.
**Scale/Scope**: 2 new tools (31 total), 1 new offscreen entry, ~10 touched worker files, 3 panel
components, 3 probe scenarios, 1 upgrade spec.

## Constitution Check

*GATE: evaluated before implementation. Result: PASS, with one traced permission (V) and two
dependencies (X) justified below.*

| Article | Assessment |
| --- | --- |
| I. Product requirements | PASS. FR-100–FR-109 → PR-013/PR-020; FR-110–FR-117 → PR-008/PR-006/PR-020; FR-118–FR-120 → PR-005; FR-121–FR-123 → V/PR-020. Owner decisions D-008-1–8 precede this plan. |
| II. Clean-room | PASS. Reference identifiers stay in `docs/design-notes.md`; every behaviour adopted is named in its table with what we deliberately do differently (cap, persistence, masking, dialog consent, liveness). No reference code, asset or watermark is used (the watermark is our manifest name). |
| III. Traceability | PASS. Spec table; every FR cites a design-notes section or "no reference"; every research decision names its §. |
| IV. Explicit uncertainty | PASS. Three named unknowns with a measurement each: offscreen survival across worker eviction (R-134, S2 measures before S3), frame settle/quality (R-133), chained window (R-139). |
| V. Least privilege | PASS by tracing (D-003-1). One new permission, `offscreen`, agent build only, traced to FR-103/FR-104; the document loads only bundled scripts, speaks only `chrome.runtime`, is closed when idle (FR-121); a contract test pins the permission set and the narrow manifest. The `Page` domain exception is stated, three-count justified, and pinned by the extended invariant test (R-138). |
| VI. Privacy, consent, data minimisation | PASS. Frames are of held tabs only (the lease is required to act); typed secrets are masked in the worker before a frame's label leaves it (R-136); dialog accept is an effect under the site mode with the owner-chosen exemption; dialog text is on-screen content (D-008-5); recordings are cleared on export and the document closed. |
| VII. Observable and testable | PASS. SC-054–SC-062 are decoded-file counts, timings and run ratios on named pages. |
| VIII. MV3 | PASS. Offscreen API is the MV3 way to reach a canvas; the worker re-reads its two session-storage keys after eviction; nothing relies on the worker staying alive (D-008-2). |
| IX. Requirements before architecture | PASS. Spec → this plan → tasks. |
| X. Dependency discipline | PASS with justification: `gifenc` (runtime, offscreen bundle only) — a GIF encoder is what the feature *is*; `omggif` (dev only) — the gate must read the file back (D-008-7). Both MIT, zero transitive deps, pinned. |
| XI. Defined failure behaviour | PASS. `invalid-filename`, `empty-recording`, `download-failed`, `recording: full`, skipped-frame count, `blocked-by-dialog`, `blocked-by-beforeunload`, `no-dialog`, `page-unresponsive`, `refused`; restore edge cases enumerated. |
| XII. Specification before implementation | PASS. |

## Project Structure

### Documentation (this feature)

```text
specs/008-recording-and-dialogs/
├── spec.md
├── plan.md              # this file
├── research.md          # R-132–R-143
├── data-model.md
├── quickstart.md
├── contracts/README.md  # gif_recorder, dialog, changed answers, panel messages, offscreen protocol
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
docs/design-notes.md                       # public summary
```

### Source Code (repository root)

```text
packages/contracts/src/agent-tools.ts                 +gif_recorder, +dialog descriptors/schemas; force on navigate/tabs_close;
                                                       +recording/+dialog fields on answers; +blocked reasons
packages/agent-host/src/mcp-server.ts                  no change (registers from AGENT_TOOL_DESCRIPTORS)
apps/extension/src/build-config.ts                     AGENT_PROFILE_PERMISSIONS += "offscreen"; version "0.2.0" → EXTENSION_VERSION
apps/extension/vite.config.ts                          + "offscreen" entry (agent profile)
apps/extension/src/offscreen/index.html                NEW  static document
apps/extension/src/offscreen/main.ts                   NEW  message loop: add-frame / export / clear / revoke
apps/extension/src/offscreen/overlay.ts                NEW  pure drawing on a canvas (ring, drag path, label, counter, bar, watermark)
apps/extension/src/offscreen/encode.ts                 NEW  gifenc wrapper: pad to max size, delays, quantize, encode → Blob
apps/extension/src/service-worker/recording/recorder.ts NEW  per-session state, cap, filename grammar, offscreen client, export
apps/extension/src/service-worker/recording/frame-capture.ts NEW CDP jpeg capture with photographTab fallback (R-133)
apps/extension/src/service-worker/agent-tools/recording.ts NEW  gif_recorder runner
apps/extension/src/service-worker/agent-tools/dialogs.ts   NEW  current-dialog map, chaining, dialog runner, beforeunload policy, liveness
apps/extension/src/service-worker/agent-tools/input.ts     Page.enable on attach; holder "recording"
apps/extension/src/service-worker/agent-tools/effects.ts   record last approved effect per tab (chaining); attach dialog to answer
apps/extension/src/service-worker/agent-tools/tabs.ts      resize_window writes restore record; navigate/tabs_close force
apps/extension/src/service-worker/agent-tools/batch.ts     stop at dialog step (existing rule, new reason)
apps/extension/src/service-worker/agent-tools/wait.ts      condition-unmet {dialog}
apps/extension/src/service-worker/agent-runtime.ts         dispatchTool decorator (frame + dialog block); onEvent Page.* filter;
                                                           releaseSession: auto-export then restore; onTabLeft: restore
apps/extension/src/service-worker/window-restore.ts        NEW  decideRestore() pure + storage
apps/extension/src/chrome-adapters/windows.ts              resizeWindow returns priorState
apps/extension/src/chrome-adapters/offscreen.ts            NEW  create/has/close + typed messaging
apps/extension/src/service-worker/agent-panel-port.ts      +activity items, +notice card, +recording state
apps/extension/src/side-panel/agent-panel-keys.ts          message types
apps/extension/src/side-panel/agent/SessionCard.tsx        recording state line, activity list (20)
apps/extension/src/side-panel/agent/PromptCard.tsx         dialog consent wording; NoticeCard (non-blocking)
apps/extension/src/locales/{en-US,zh-TW}.ts                strings
apps/extension/tests/*.test.ts                             recorder, frame-capture, overlay (canvas mock), encode (decode back),
                                                           dialogs (chained boundary), window-restore, input-attachment (Page exception)
tests/contract/agent-tools-008.contract.test.ts            NEW  schemas, permission set, narrow manifest, version=zip=watermark
tests/harness/page-fixtures.ts                             + dialogs fixture page (alert/confirm/prompt/chained/timer/beforeunload)
packages/test-kit/src/gif-decode.ts                        NEW  omggif wrapper: frames, delays, size, pixel sampling
tests/e2e/packaged/agent-recording.spec.ts                 NEW  record→export→decode; worker-kill survival; cap
tests/e2e/packaged/agent-dialogs.spec.ts                   NEW  every US3 scenario on the fixture
tests/e2e/packaged/agent-window-restore.spec.ts            NEW  maximize→resize→release
tests/e2e/packaged/agent-upgrade.spec.ts                   NEW  0.1.0 → 0.2.0
tests/acceptance/probe-004/scenarios/s9-recording.json, s10-dialogs.json, s11-window-restore.json
docs/qa-guide.html, docs/operations-guide.md               two new sections; tool list + permission
```

**Structure Decision**: existing layout; the only new *area* is `apps/extension/src/offscreen/` (a third
Vite entry beside the worker and the side panel, agent profile only) and a `recording/` folder in the
worker because recorder + frame capture are shared by the tool runner and the dispatch decorator.

## Slice ordering

Each slice is one `implementer` brief (TDD: one focused RED, minimal GREEN), closes on its named
evidence, and ends with the tests it lists. Review is pre-selected for S4 and S2 only (risk axis: consent
boundary; permission/process boundary). Everything else closes on tests + the attach gate.

| Slice | Content | Closes | Evidence | Review |
| --- | --- | --- | --- | --- |
| **S1** | Contracts: `gif_recorder`, `dialog`, `force`, answer fields, blocked reasons; `offscreen` permission; version 0.2.0 + `EXTENSION_VERSION`; contract test 008 (permission set, narrow manifest unchanged, version = zip = watermark source) | FR-100 shape, FR-121, FR-122 (version) | §1 | tests |
| **S2** | Offscreen document: Vite entry, adapter (create/has/close, typed messages), frame store per session, `encode.ts` with gifenc, `overlay.ts` pure drawing, unit tests that **decode back** with omggif; **measurement**: does the document survive worker eviction (R-134) — measured directly | FR-103, FR-104, FR-105, FR-109 | design-notes §2 | **code-reviewer** (offscreen boundary: runtime-only, no network, closed when idle) |
| **S3** | Recorder + frame capture + `gif_recorder` runner + dispatch decorator + masking + export/download/attribution + auto-export on session end + panel recording line; gate `agent-recording.spec.ts` (decode: 14 frames, delays, labels, ring position; worker-kill; cap 200) | FR-100–FR-102, FR-106–FR-108; US1, US2; SC-054–SC-057 | §2.1–2.4, §2.7, §5 | tests + gate |
| **S4** | Dialogs: `Page.enable` + event filter + extended invariant test; `dialogs.ts` (current dialog, chaining, gate, notice, beforeunload policy, liveness); dispatch block; effects/batch/wait/navigate/tabs_close changes; panel activity list + notice card + consent wording; fixture page; gate `agent-dialogs.spec.ts`; unit boundary 999/1001 ms | FR-110–FR-117; US3; SC-058, SC-059 | §3.1, §3.2, §5 | **code-reviewer** (D-008-5 exception, consent gate, chained exemption) |
| **S5** | Window restore: adapter prior state, record, `decideRestore` pure + tests, two hooks, panel activity item; gate `agent-window-restore.spec.ts` | FR-118–FR-120; US4; SC-060 | §4 (no reference — measure) | tests + gate |
| **S6** | Package 0.2.0, upgrade spec (0.1.0 zip → 0.2.0 over a scratch profile), QA guide two sections with real-panel screenshots, operations guide, probe scenarios s9–s11 run on the owner's Chrome, coverage.md | FR-122, FR-123; US5; SC-061, SC-062; probe reports | §1 | tests + gate + probe |

Dependencies: S1 → S2 → S3; S1 → S4; S1 → S5; S3+S4+S5 → S6. S4 and S5 can run after S1 in either
order; one active writer at a time (policy), so the default order is S1, S2, S3, S4, S5, S6.

**Process rule (owner, 2026-09-18), binding for every slice**: a task that fails its second attempt is
not tried a third time; the main session re-reads the reference or takes one measurement on the gate,
writes the answer into the evidence file, and re-briefs.

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| Third Vite entry (offscreen document) | The worker has no canvas; overlays and GIF encoding need one; Chrome's only MV3 route is an offscreen document | Encoding in the side panel fails when the panel is closed; encoding on the MCP host moves the file out of the download folder (contradicts D-008-3) |
| Two npm packages (`gifenc`, `omggif`) | A GIF encoder is the deliverable; the gate must read the file back | Hand-written LZW/quantiser is more code and less proven; a worker-based encoder adds a script and a permission reason |
| `Page` domain on every attachment | Dialog events are only delivered with the domain enabled; the reference does the same | Enabling per holder would make dialogs inaudible exactly on the sites QA uses (no diagnostics grant) — owner declined (D-008-5) |
