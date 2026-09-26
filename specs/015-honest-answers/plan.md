# Implementation Plan: Honest Answers — Link Clicks, False "Stale", Every Download, Uploads in a Batch, Withdrawn Pairing

**Branch**: `015-honest-answers` (git: `feature-015-honest-answers`) | **Date**: 2026-09-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification; [research.md](./research.md) R-196–R-202; the private reference
evidence for 015 §1–§4; the measurements of 2026-09-25 on Chromium 151 in attach mode; the worker,
host and contracts sources at 611ee7f.

## Summary

Five honesty fixes, all inside link protocol 2 (additive fields and one additive frame).
**False stale** (R-197): a page that does not answer the extension for the 10 s content deadline is
reported as `failed / page-not-responding` with a retry hint instead of a bare `stale`; the trigger
of the hang is bisected first from the measurement spec, and fixed if it is in the product.
**Press outcomes** (R-198): the one press path collects, during its existing 400 ms settle, the
committed URL, tabs opened with the pressed tab as opener, and downloads the session's observer
recorded, and reports them as optional observation fields; a link press with no outcome carries a
hint. **Downloads** (R-199): the per-session ring answers the earliest-finished un-answered completion,
tracking answered ids instead of one watermark. **Uploads in a batch** (R-200, authorization
boundary): the standalone upload interception becomes one `prepareUpload` function; a batch pre-pass
calls it per upload step, in order, under the batch's call id, before anything is sent; an aggregate
size bound protects the single link frame. **Pairing withdrawal** (R-201): an additive
`pair-withdraw` frame on host expiry, and a `requestId` echo so a late answer cannot settle a newer
exchange. **Close-out** (R-202): 0.8.0, snapshot, owner-run Chrome 153 and Edge scripts.

## Technical Context

**Language/Version**: TypeScript 5 on Node 24 (host, contracts), MV3 extension (worker, panel
React); Vitest; Playwright for the packaged gate.

**Primary Dependencies**: none added. New-tab detection uses `chrome.tabs.onCreated` (the `tabs`
permission is already held); downloads use the existing observer. **No new manifest permission.**

**Storage**: `chrome.storage.session["agentDownloads"]` ring gains `answered: number[]` (migrated
from `waitWatermark` on read). Nothing else persisted changes.

**Testing**: unit (binding failure reasons; press outcome collection with fake tab/download events
and the settle window; link hint; ring selection and migration; `prepareUpload` extracted with the
existing 013/014 host tests unchanged; batch pre-pass matrix with a fake link; aggregate bound;
`pair-withdraw` and `requestId` on both sides), contract (observation fields optional and strict;
new reason `page-not-responding`; `pair-withdraw` frame; `requestId` optional; one upload resolver),
packaged gate on Chromium 151 in attach mode with the unattended recipe (new
`agent-press-outcomes.spec.ts`, `agent-batch-upload.spec.ts`; downloads and pairing cases folded
into `agent-downloads.spec.ts` / `agent-first-run.spec.ts` or new specs), the false-stale 20-run
reproduction, owner-run Chrome 153 and Edge scripts.

**Target Platform**: Windows 11, Chrome / Chromium 151+, Edge (live check only).

**Project Type**: browser extension + local host.

**Constraints**: link protocol number unchanged (2); new frame and fields optional, old side ignores
them; no added press latency (FR-202); a batch's upload content ≤ `AGENT_UPLOAD_MAX_BASE64_CHARS`
in total; the upload check exists once (FR-211).

**Scale/Scope**: contracts (+4 optional observation fields, +1 reason, +1 control frame, +1 optional
field on two frames, batch refusal reason); worker (`effects.ts`/`effect-verification.ts` outcome
collection ≈ 120 lines, `page-binding.ts`/`content-broker.ts` reason ≈ 30, `download-observer.ts`
≈ 40, bridge + runtime `pair-withdraw` ≈ 30); host (`mcp-server.ts` extraction ≈ 170 moved + batch
pre-pass ≈ 80 + withdraw/requestId ≈ 30); 2–3 gate specs + fixtures (target=_blank link, download
link, prevented link, two-download page), docs, version.

## Constitution Check

| Principle | Status |
| --- | --- |
| I. PR as source of truth | PASS. PR-020 (local agent drives the owner's browser); the owner's decisions D-015-1..5 of 2026-09-25. |
| II. Clean-room | PASS. Reference behaviour recorded privately; own field names, own frame, own wording; the reference's "any question aborts the batch" rule was considered and not adopted (D-015-5). |
| III. Traceability | PASS. FR-200..222 ↔ US1–US6 ↔ SC-109..115; spec traceability table; tasks cite FRs. |
| IV. Explicit uncertainty | PASS. The hang's trigger is unknown and stated as such (R-197), with a bisection budget and a fallback (harness artifact recorded with evidence). The 014 record's cause is attributed provisionally, not asserted. |
| V. Least privilege | PASS. No new permission. Uploads in a batch pass the same allow-list, question and disk-root rule as standalone, through one function; content only crosses the link. |
| VI. Privacy | PASS. New observation fields carry URLs and download file names the agent could already read through `tabs_context` / `downloads_context`; nothing new is persisted about pages. |
| VII. Observable | PASS. SC-109..115 are counts on fixtures, a 20-run reproduction and recorded live runs. |
| VIII. MV3 | PASS. Press listeners live for one call; the ring stays in session storage. |
| IX. Requirements before architecture | PASS. |
| X. Dependency discipline | PASS. |
| XI. Defined failure | PASS. Page not answering; tab gone; new tab after the window; download after the window; evicted completion; declined / timed-out / interrupted upload question in a batch; oversize batch; same-batch screenshot; late or raced pairing answer; old worker / old host. |
| XII. Specification before implementation | PASS. Spec approved by the owner 2026-09-25 (611ee7f). |

## Project Structure

### Documentation (this feature)

```text
specs/015-honest-answers/
├── spec.md · plan.md · research.md · data-model.md · quickstart.md
├── contracts/press-outcomes.md          # observation fields, link hint, binding failure reason
├── contracts/downloads.md               # ring shape, selection rule, migration
├── contracts/batch-upload.md            # prepareUpload, pre-pass, refusals, aggregate bound
├── contracts/pairing-withdraw.md        # pair-withdraw frame, requestId echo, compat
├── checklists/requirements.md
└── tasks.md                             # /speckit-tasks
(the private reference evidence for 015, export-ignored, already written)
```

### Source Code (repository root)

```text
packages/contracts/src/agent-tools.ts        # observation fields, reason, pair-withdraw, requestId
apps/extension/src/service-worker/
├── agent-tools/effects.ts                   # press outcome collection + link hint
├── effect-verification.ts                   # settle window end → URL
├── agent-tools/page-binding.ts              # page-not-responding reason
├── content-broker.ts                        # distinguish deadline from other probe failures
├── download-observer.ts                     # answered ids, earliest-first, created-since query
├── agent-bridge.ts · agent-runtime.ts       # pair-withdraw → expireWaiting; requestId echo
└── pairing-controller.ts                    # requestId kept per waiting session
packages/agent-host/src/
├── mcp-server.ts                            # prepareUpload extraction, batch pre-pass, withdraw
└── upload-policy.ts                         # (unchanged API; reused)
tests/e2e/packaged/agent-press-outcomes.spec.ts · agent-batch-upload.spec.ts (new)
tests/harness/page-fixtures.ts               # new-tab link, download link, prevented link, two downloads
```

**Structure Decision**: every change lands in the one place that already owns it — the press path,
the binding, the observer, the host's interception, the pairing controller. No new module except
what the extraction names.

## Slice ordering

| Slice | Content | Closes | Writer | Evidence |
| --- | --- | --- | --- | --- |
| **S0 stale diagnosis** | Bisect `zz-measure-015` until the hang's trigger is named (≤ 2 unproductive rounds); record in research R-197; turn the trigger (or the agent-only loop) into `agent-false-stale` reproduction | FR-204 | main session (diagnosis stays with main) | measured |
| **S1 honest binding + press outcomes** | contracts (fields, reason); `page-not-responding` in binding (RED: deadline → reason + hint; tab gone → stale/tab-gone; replaced → stale-reference); the product fix for the trigger if S0 finds one; press outcome collection (RED: URL, new tab with opener, download in window, nothing + window, link hint; batch step passes through); fixtures + `agent-press-outcomes.spec.ts` (SC-109) + 20-run reproduction (SC-110) | FR-200..206 | implementer-high | unit + gate |
| **S2 downloads** | ring `answered`, earliest-first, migration (RED: B-then-A order, once each, failed/cancelled, two sessions, migration from watermark); gate two-download case (SC-111) | FR-207..209 | implementer | unit + gate |
| **S3 uploads in a batch (R2)** | extract `prepareUpload` (existing 013/014 host tests unchanged = RED-free refactor proof); pre-pass (RED: matrix — inside roots, outside once/remember/no, disk root, unknown/expired/oversize image, same-batch screenshot hint, aggregate bound, interrupt during question, remember-from-step-1 covers step 2, first refusal names step, nothing sent on refusal); contract test "one resolver"; 013 coverage note closed; gate `agent-batch-upload.spec.ts` (SC-112) | FR-210..215 | implementer-high, then **code-reviewer** | unit + contract + gate + review |
| **S4 pairing withdrawal** | contracts frame + `requestId`; host send on expire and close, ignore late mismatched result (RED); worker decode → `expireWaiting`, echo `requestId` (RED); old-side compat tests; gate case (SC-113) | FR-216..219 | implementer | unit + gate |
| **S5 close-out** | 0.8.0 (R-202); docs (README ×2, zh-TW guides, design notes); coverage.md; full regression on Chromium 151; owner-run scripts for Chrome 153 (gates + FR-203 repeat) and Edge (FR-222); snapshot check; artifact refresh | FR-220..222, SC-114/115 | main session | full suite + scripts |

**Order and parallelism**: S0 (main, read/measure only) runs alongside **S2 ‖ S3** (disjoint files:
`download-observer.ts` + its tests vs `mcp-server.ts` + host tests; neither touches contracts except
S3's batch refusal reason, which S2 does not touch). **S1** follows S0 (needs its finding) and owns
`agent-tools.ts` observation region; **S4** follows S3 (both edit `mcp-server.ts`) and S1 (both edit
`agent-tools.ts`). Browser gates run one at a time by the main session (shared Chromium on 9222 and
fixture ports); implementers run unit and contract suites only.

## Completion Contract

- **Scope**: FR-200..222; non-goals per spec Out of Scope.
- **Claims and evidence**: press outcomes (unit + gate SC-109); false stale (20-run reproduction
  SC-110 + unit); downloads (unit + gate SC-111); uploads in a batch (unit + contract + gate SC-112 +
  code review); pairing withdrawal (unit + gate SC-113); close-out (full suite SC-114, recorded Edge
  run SC-115 when the owner runs it).
- **Pre-selected roles**: implementer-high for S1 and S3, implementer for S2 and S4; code-reviewer
  after S3 (R2, owner's condition). No architecture review: frames and fields are additive and no
  boundary moves.
- **Final verification (one)**: `npm run typecheck && npm test && npm run test:contract &&
  npm run snapshot:check` green, then every `agent-*` gate on Chromium 151 in attach mode, numbers
  into `coverage.md`; the Chrome 153 and Edge runs are owner-run and recorded when done.

## Complexity Tracking

No constitution violation.
