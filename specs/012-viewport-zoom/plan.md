# Implementation Plan: Viewport Override and Zoom

**Branch**: `012-viewport-zoom` (git: `feature-012-viewport-zoom`) | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification; [research.md](./research.md) R-166–R-173 (three of them
measurements made before this plan); the private reference evidence for 012; the worker,
host and contract sources read on 2026-09-21/22.

## Summary

The measurements settled the shape. Under an emulated viewport the tab-level capture photographs
the window, not the emulation, while the protocol capture returns exactly the emulated viewport
(R-166); the emulation outlives a debugger detach until the tab reloads, so it must be cleared
explicitly on every release path (R-166, R-167); the one `acquire()` that makes attachments is the
place to re-apply it after worker eviction (R-167). Three slices. (1) **Viewport**: a `viewport`
tool (`set`/`reset`), a `viewport-emulation.ts` module holding one record per tab in
`chrome.storage.session`, two hooks on the shared attachment (`onAttached` re-applies,
`onBeforeRelease` clears), an activity line, a fourth attachment holder. (2) **Capture**:
`screenshot` gains `scale`, crops at native density (`region × DPR`, fixing today's 25 % crop
offset on DPR 1.25 displays), takes the protocol path when the tab is emulated, refuses regions
outside the frame, and names the scale that would fit when the frame bound is hit. (3) **Steer,
prove, document**: the two descriptions, the gate spec `agent-viewport`, version 0.4.0, README /
operations guide / design notes, the R-168 run on branded Chrome, and — with the owner's go-ahead,
paid — one `claude -p` probe for SC-090.

## Technical Context

**Language/Version**: TypeScript 5 on Node 24 (host, contracts), MV3 extension (worker, panel);
Vitest; Playwright for the packaged gate.

**Primary Dependencies**: none added. `Emulation.setDeviceMetricsOverride` /
`clearDeviceMetricsOverride` and `Page.captureScreenshot` ride on the `debugger` permission and the
per-held-tab attachment 004 already makes; **no new manifest permission** (FR-166).

**Storage**: `chrome.storage.session` key `agentViewports` (one record per emulated tab), same
lifetime rules as `agentWindowRestores`.

**Testing**: unit (record store, apply/clear decisions, attachment hooks, DPR crop + scale maths,
capture-path choice, too-large hint, contract schemas and descriptions), contract (tool count 32,
batchable list, no new permission, snapshot), packaged gate `agent-viewport.spec.ts` on Chromium in
attach mode (unattended recipe), one branded-Chrome run of the R-166 script (R-168), one paid probe.

**Target Platform**: Windows 11, Chrome / Chromium 151+.

**Project Type**: browser extension + local host.

**Constraints**: the native-messaging frame bound (700 000 base64 chars) is not raised; a picture
over it is refused with the fitting scale named (R-171). Reads keep attaching no debugger on a
non-emulated tab. The link protocol number is unchanged: the screenshot result gains optional
fields an older host ignores, and the new tool is simply absent from an older offering.

**Scale/Scope**: contracts (1 tool, 4 result fields, 1 activity kind, 1 holder, 2 descriptions),
worker (1 new module ≈ 150 lines, 2 hooks in `input.ts`, capture adapter + photograph + reads,
tabs tool dispatch, runtime composition, panel activity text + 2 locale strings), host (none beyond
the version), 1 gate spec + fixture page, 4 documents, 1 owner-run script, 1 probe.

## Constitution Check

| Principle | Status |
| --- | --- |
| I. PR as source of truth | PASS. PR-005 (windows and tabs) for the viewport, PR-006 (reads, screenshots) for scale and region; design-notes §7 already listed both as planned. |
| II. Clean-room | PASS. Behaviour read from two bundles, recorded privately; the design differs from both (clear-on-release, native-density crop without a debugger, frame-bound hint). No identifier in specs. |
| III. Traceability | PASS. FR-156..166 ↔ US1–US3 ↔ SC-085..092; tasks cite them. |
| IV. Explicit uncertainty | PASS. Three measurements recorded with versions and numbers; the branded-Chrome DPR run is owed and named (R-168); the reference reading's wrong assumption is corrected in the evidence file, not silently. |
| V. Least privilege | PASS. No new permission; the attachment the emulation holds shows Chrome's own "being debugged" bar, which is the honest signal. |
| VI. Privacy | PASS. Nothing new leaves the browser; the activity line carries a size, not page content. |
| VII. Observable | PASS. SC-085..092 are counts, sizes and one probe. |
| VIII. MV3 | PASS. Record in session storage; re-apply on the next acquire; reconciliation on wake unchanged. |
| IX. Requirements before architecture | PASS. |
| X. Dependency discipline | PASS. |
| XI. Defined failure | PASS. Range refusal, region-outside-viewport, too-large with hint, attachment refused (devtools open / restricted page) answers `input-unavailable` as every attachment user does, tab gone answers stale. |
| XII. Specification before implementation | PASS. |

## Project Structure

### Documentation (this feature)

```text
specs/012-viewport-zoom/
├── spec.md · plan.md · research.md · data-model.md · quickstart.md
├── contracts/viewport-and-capture.md   # the tool, the screenshot result, the activity kind, the descriptions
├── checklists/requirements.md
└── tasks.md                             # /speckit-tasks
(private reference evidence for 012)       # export-ignored; its §1b corrected by R-166
docs/design-notes.md §7                  # public summary
```

### Source Code (repository root)

```text
packages/contracts/src/agent-tools.ts             # `viewport` tool + shapes; screenshot `scale` + result fields; activity kind `viewport`; batchable list; descriptions
apps/extension/src/
├── service-worker/viewport-emulation.ts          # NEW: record store (storage.session), apply/clear over the attachment, decisions (pure), hooks
├── service-worker/agent-tools/input.ts           # holder "viewport"; onAttached / onBeforeRelease hooks (one place each)
├── service-worker/agent-tools/tabs.ts            # `viewport` dispatch beside `resize_window`
├── chrome-adapters/capture.ts                    # DPR-aware crop + scale (canvas); protocol capture variant (clip, scale)
├── service-worker/agent-tools/photograph.ts      # chooses the path: emulated → protocol, else captureVisibleTab; frame lookup
├── service-worker/agent-tools/reads.ts           # scale arg, region-outside-viewport, too-large hint, result fields
├── service-worker/agent-runtime.ts               # composes the module; registers the two hooks; activity line
├── side-panel/agent/SessionCard.tsx + locales    # activity text for kind `viewport`
└── build-config.ts                               # 0.4.0
packages/agent-host/src/tool-offering.ts          # SERVER_VERSION 0.4.0
tests/e2e/packaged/agent-viewport.spec.ts         # NEW gate spec + fixture page (breakpoint bar, 11 px text, far block)
tests/e2e/packaged/agent-reads.spec.ts            # + scale on a plain screenshot
README.md · docs/zh-TW/operations-guide.md · docs/design-notes.md
.scratch/r166-viewport-capture.mjs                # the measurement script (kept out of git as the 011 one was)
```

**Structure Decision**: one new module, shaped like `window-restore.ts` (pure decision function +
store + a composer), because it is the same kind of thing: a change to the owner's tab made for the
agent's convenience, owed back on release. The capture change stays inside the existing adapter and
its two callers; no second capture module.

## Slice ordering

| Slice | Content | Closes | Writer | Evidence |
| --- | --- | --- | --- | --- |
| **S1** | contracts (tool, holder, activity kind, batchable); `viewport-emulation.ts` (store, `decideApply`/`clear`, hooks); `input.ts` hooks + holder; `tabs.ts` dispatch; runtime composition + activity; panel text + locales; unit (RED first on: range refusal, record survives a store round-trip, clear sent before detach on each release path, re-apply on acquire) + contract | FR-156, FR-157, FR-159, FR-160, FR-161, FR-166 | implementer | unit + contract |
| **S2** | `capture.ts` DPR crop + scale + protocol variant; `photograph.ts` path choice + frame; `reads.ts` scale, refusal, hint, result fields; unit (RED first on: crop rectangle at DPR 1.25, scale maths, path choice table, outside-frame refusal, hint factor) | FR-158, FR-162, FR-163, FR-164 | implementer | unit, then **code-reviewer** over S1+S2 (attachment lifecycle across five release paths, storage round-trips, coordinate frames — invisible to a live run) |
| **S3** | descriptions (R-172) + contract test; version 0.4.0 (R-173); gate spec `agent-viewport` (set 375 / 2 560 → page size + layout + window unchanged; screenshot coverage + click on an emulated-only element; reset; release; owner take-back; worker kill → re-apply; region × DPR at forced DPR 2; outside-frame refusal; scale on plain screenshot); docs (README, ops guide, design notes §7); `coverage.md`; **owner**: R-168 script on branded Chrome; **probe** `claude -p` "show me this page at a phone width" after the owner says go | FR-165; SC-085..092 | implementer (gate spec, docs), main session (version, evidence correction, probe, owner hand-off) | gate + contract + probe |

S1 → S2 → S3. The review after S2 is the one review of the feature (risk axis: lifecycle and
cross-module state; nothing else here is invisible to the gate).

## Complexity Tracking

No constitution violation.
