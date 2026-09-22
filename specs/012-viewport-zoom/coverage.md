# Coverage: Viewport Override and Zoom (feature 012)

**Branch** `feature-012-viewport-zoom` (worktree feature-008-spec, from `main` f1ab64b).
**Run**: 2026-09-21 night → 2026-09-22 morning, unattended (owner asleep; go given for T321/T322).

## Requirements → evidence

| FR | What | Unit / contract | Gate (Chromium 151 · Chrome 153) | Probe |
| --- | --- | --- | --- | --- |
| FR-156 set an emulated viewport, window untouched | `viewport set` | viewport-emulation.test (a–c), agent-navigation.test, agent-tools-012.contract | agent-viewport #1 (375×812, 2 560×1 440; window bounds/state identical) | s12: `set 390×844` ok |
| FR-157 reset | `viewport reset` | viewport-emulation.test (reset outcomes), agent-navigation.test (tab content size, never window bounds) | #3 reset → real size | s12: reset → 650×639 |
| FR-158 one coordinate frame; picture covers the emulated viewport | protocol capture under a record, `frame`, `coverage` | capture.test (path table, clip shift R-174), agent-screenshot.test (frame is the size only), computer.test (emulated tab over the attachment) | #2 (frame 2 560×1 440, `coverage: viewport`, click on `#wide-only` lands) | s12: frame `390x844` |
| FR-159 cleared without a call on release paths | `onBeforeRelease` hook; re-assert-then-clear on a borrowed attachment (R-176) | input-attachment.test (hook before detach, even for a tab the worker no longer lists), viewport-emulation.test (borrowed attachment: set+clear) | #3 release / owner take-back / session end → real size (3/3 more) | |
| FR-160 survives eviction, re-applied on the next call | record in storage.session; `onAttached` | viewport-emulation.test (e), input-attachment.test | #4 worker killed → first `screenshot` re-applies; page emulated; second set idempotent | |
| FR-161 not an effect | ownership only, no prompt | agent-navigation.test (ownership refusals) | all gate calls with no consent card | |
| FR-162 `scale` 0.1–1 | screenshot arg + answer fields | capture.test (scale maths, ≥ 1 px), contract | agent-reads "half scale" (image halves, answer says `scale 0.5`, real frame) | |
| FR-163 region at native density | crop at `region × DPR` (fixes the pre-012 image-pixel crop) | capture.test (DPR 1.25 rect), R-175 (tab size = innerWidth) | #5 emulated: 300×100 → 300×100 / 150×50; non-emulated at harness DPR 2: crop = region × derived density | |
| FR-164 region outside the frame refused | `region-outside-viewport (frame WxH)` | agent-screenshot.test (no capture call) | #5 | |
| FR-165 descriptions steer | R-172 text | agent-tools-012-descriptions.contract (3) | | s12: Sonnet chose `viewport`, never `resize_window` |
| FR-166 no new permission | manifest unchanged | snapshot / manifest contract | | |

## Success criteria

| SC | Result |
| --- | --- |
| SC-085 | gate #1: 2/2 sizes, window check 1/1 — Chromium 151 and Chrome 153 |
| SC-086 | gate #3: reset, `tabs_release`, owner take-back (panel "Give my tabs back"), session end — 4/4 on both builds |
| SC-087 | gate #4: after `Target.closeTarget` on the worker, the first call re-applies (Chromium keeps the emulation in between, Chrome 153 drops it — R-176); 1/1 on both |
| SC-088 | gate #2: click on an element laid out only at ≥ 1 900 px lands; 1/1 on both |
| SC-089 | gate #5 + reads: 300×100 / 150×50 exact, density relation on the visible-tab path, outside-frame refusal; both builds |
| SC-090 | probe s12-viewport on Chrome 153.0.8010.50, `claude` 2.1.278, model sonnet: `tabs_create → viewport set 390×844 → screenshot (frame 390x844) → viewport reset`; verdict done 1/1 (`tests/acceptance/probe-004/reports/004-2026-09-21T18-24-06Z.md`, private) |
| SC-091 | R-166, R-167, R-168 recorded before implementation; R-174, R-175, R-176 recorded as they were found (research.md) |
| SC-092 | final verification below; manifest permissions unchanged; README / zh-TW operations guide / design notes §7 updated; 32 tools |

## Gate runs

| Run | Browser | Result |
| --- | --- | --- |
| regression trio before S3 (window-restore, input, recording) | Chromium 151 | 10/10 |
| viewport + reads, run 1 | Chromium 151 | 5/7 — `frame` leaked the whole record; `dpr` float compare (both fixed, a8695f6) |
| viewport + reads, run 2 | Chromium 151 | 7/7 |
| viewport + reads, run 1 | Chrome 153.0.8010.50 | 6/7 — restart case asserted persistence, which 153 does not give (test corrected to assert the re-apply, 4f995fd) |
| viewport + reads, run 2 | Chrome 153 | 7/7 |
| viewport + reads + window-restore, after S2d | Chrome 153 | 10/10 (`gate-chrome153-final`; window restored in 29 ms / 43 ms after a worker kill) |

## Review (T313, code-reviewer, after S1+S2)

Two CONFIRMED blocking findings, both closed in S2c (1fff8d3): the release hook was skipped for a
tab the evicted worker no longer listed (record leaked, page stayed emulated); a read on an
emulated tab with no worker-side attachment failed `not-readable` instead of re-attaching. Finding
3 (clip in document coordinates) was measured (R-174) and fixed. F4 (reset answered window bounds /
`ok` after a failed clear), F5 (record kept after a tool-driven close) and F8 (screenshot
description) closed in the same slice. Not done: F7 (`viewport` not in the recording's tool list —
consistency only); a tab the **owner** closes keeps its record until the browser exits (there is no
`tabs.onRemoved` listener by design; benign, ids are unique per browser session).

## Known limits

- Chrome 153 vs Chromium 151 differ in whether an override outlives a detach (R-176); the product
  does not depend on it: release re-asserts then clears, and the next call re-applies.
- The probe ran against the owner's branded Chrome in a private profile with the agent build loaded
  unpacked (the reference extension loaded unpacked gets a different id; the runner was pointed at it).

## Final verification (T323, 2026-09-22 02:29 local, HEAD 82538f8 + this file)

| Check | Result |
| --- | --- |
| `npm run test` (unit + extension-ui) | 1218 passed / 1 skipped, 113 files + 1 skipped |
| `npm run test:contract` | 196 passed / 2 skipped, 26 files |
| `npm run snapshot:check` | 565 files, 0 forbidden paths, 0 pattern hits |
| `npm run typecheck` | clean |
| Gate, Chrome 153 (viewport, reads, window-restore) | 10/10 |
| Gate, Chromium 151 (viewport, reads) | 7/7 |
| Probe S12 | done 1/1 |

Counts at `main` before 012: unit 1178 / 1 skipped, contract 184 (+ 2 that this feature's own
documents first broke and then fixed), snapshot 549.
