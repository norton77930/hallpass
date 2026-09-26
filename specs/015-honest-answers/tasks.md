---
description: "Task list for 015 honest answers"
---

# Tasks: Honest Answers — Link Clicks, False "Stale", Every Download, Uploads in a Batch, Withdrawn Pairing

**Input**: `specs/015-honest-answers/` — spec.md, plan.md, research.md (R-196–R-202), data-model.md,
contracts/ (press-outcomes, downloads, batch-upload, pairing-withdraw), quickstart.md.

**Tests**: TDD is required by the project (constitution VII, owner's standing practice): each
behaviour task starts with a RED test in the named file.

**Rules for this run**: (1) a thing that fails twice is not tried a third time — measure or read the
reference instead; (2) implementers run unit + contract suites only; browser gates are run by the main
session, one at a time (shared Chromium on 9222, fixture ports 18786/18787/19443–19445); (3) the
owner's branded browsers are never launched by Claude.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T395 Record the unattended attach recipe used for 015 (Playwright Chromium 151 on 9222, private LOCALAPPDATA with the host manifest copy, runner env) in specs/015-honest-answers/quickstart.md and keep `tmp\m015-launch.ps1` as the launcher

## Phase 2: Foundational (contracts shared by several stories)

- [X] T396 Add RED contract tests for the additive observation fields (`url`, `newTabs[{tabId,url,held:false}]`, `downloads[{id,filename,url,state}]`, `observedForMs`), the reason `page-not-responding`, the `pair-withdraw` control frame and optional `requestId` on `pair-request`/`pair-result`, and the batch reason `batch-upload-too-large` in tests/contract/agent-tools-015.contract.test.ts (new file)
- [X] T397 Implement those schema additions in packages/contracts/src/agent-tools.ts (strict objects stay strict; every new field optional; link protocol constant unchanged at 2) until T396 is green

**Checkpoint**: contract suite green; nothing else changed.

## Phase 3: User Story 2 — A page that did not move is not called stale (P1) — slice S0 + S1a

**Goal**: no false `stale`; a page that stops answering is reported as such.
**Independent test**: false-stale reproduction 20 runs, 0 false `stale` (SC-110).

- [X] T398 [US2] (main session, S0) Bisect `tests/e2e/packaged/zz-measure-015.spec.ts` step by step (5 runs per step, ≤ 2 unproductive rounds) to name the trigger of the 10 s page hang; record the result in specs/015-honest-answers/research.md R-197
- [X] T399 [US2] (main session) Turn the named trigger — or, if it is harness-only, the agent-only round-trip loop — into tests/e2e/packaged/agent-false-stale.spec.ts (20 rounds, asserts no `stale` on an intact page) and confirm it is RED on 611ee7f when the trigger is a product path
- [X] T400 [US2] RED unit test: a probe that hits the content deadline makes the binding answer `failed / page-not-responding` with the retry hint; tab gone stays `stale / tab-gone`; replaced document stays `stale-reference` — in apps/extension/tests/agent-page-binding.test.ts
- [X] T401 [US2] Distinguish the deadline from other probe failures in apps/extension/src/service-worker/content-broker.ts (`probeActiveTab` reports `deadline`) and map it in apps/extension/src/service-worker/agent-tools/page-binding.ts and the effect answer path in apps/extension/src/service-worker/agent-tools/effects.ts
- [X] T402 [US2] If T398 found a product trigger: RED test at the narrowest seam it names, then the fix (file named by T398); otherwise record "harness artifact" with the evidence in research.md R-197 and skip

**Checkpoint**: unit green; T399 spec green 20/20 on Chromium 151 (main session runs it).

## Phase 4: User Story 1 — The answer to a press says what the press did (P1) — slice S1b

**Goal**: every press answer names this-tab navigation (+URL), new tabs, downloads, or nothing (+window).
**Independent test**: six link variants × press tools and a batch step (SC-109).

- [X] T403 [P] [US1] Add fixtures to tests/harness/page-fixtures.ts: a page `press-outcomes` with a same-origin link, a `target="_blank"` link, a link to a file served with `Content-Disposition: attachment`, a link whose click handler calls `preventDefault()`, and a button that opens a tab with `window.open`
- [X] T404 [US1] RED unit tests in apps/extension/tests/agent-press-outcomes.test.ts: with fake `tabs.onCreated` (opener = pressed tab, inside/outside the settle window), a fake download observer `createdSince`, and a fake tab URL: `url` present only when `documentChanged`; `newTabs` with `held:false` and the tabs_claim hint; `downloads` with observer identity; `observedForMs` only when nothing happened; link target + nothing → link hint; button + nothing → no hint; several outcomes all reported; no added wait beyond the settle
- [X] T405 [US1] Add `createdSince(sessionId, sinceMs)` to apps/extension/src/service-worker/download-observer.ts (read-only; returns records created at or after `sinceMs`) with a RED test in apps/extension/tests/download-observer.test.ts
- [X] T406 [US1] Implement outcome collection around the one press path in apps/extension/src/service-worker/agent-tools/effects.ts (`deliverPointer` / `verifyDelivered` / `observationOf`) and apps/extension/src/service-worker/effect-verification.ts: arm a `tabs.onCreated` listener before dispatch, remove it after the settle, read the tab URL at settle end, ask the observer for downloads since dispatch; set the hints per contracts/press-outcomes.md — until T404 is green
- [X] T407 [US1] Verify batch pass-through in apps/extension/tests/agent-batch.test.ts (a click step's `observed.newTabs` and `hint` reach the batch step result unchanged)
- [X] T408 [US1] (main session) Gate tests/e2e/packaged/agent-press-outcomes.spec.ts: the six variants via `click` by ref, `computer left_click`, and one batch step; assert each answer against `chrome.tabs`/downloads reality (SC-109)

**Checkpoint**: unit + gate green on Chromium 151.

## Phase 5: User Story 4 — Uploads work inside a batch, under the same checks (P1, R2) — slice S3

**Goal**: batch upload steps go through the one host check before the batch runs.
**Independent test**: the upload matrix gives identical outcomes standalone and in a batch (SC-112).

- [X] T409 [P] [US4] Extract the inline standalone upload interception of packages/agent-host/src/mcp-server.ts (~1309-1481) into one function `prepareUpload(callId, tool, args)` returning `{ok:true,args}|{ok:false,response}`; `placeCall` calls it for standalone `file_upload`/`upload_image`; every existing 013/014 upload test in packages/agent-host/tests/mcp-server.test.ts and upload-policy.test.ts passes unchanged (behaviour-preserving refactor)
- [X] T410 [US4] RED host tests in packages/agent-host/tests/mcp-server.test.ts (new describe "015 uploads inside a batch", fake worker): inside roots → steps rewritten, no path crosses; outside + once / always / deny / timed-out / interrupted → same answers as standalone, reason prefixed `step <n>: `, nothing sent on refusal; always writes before step 2 and step 2 in the same directory is not asked; disk root never written; unknown / expired / oversize image → standalone refusals; same-batch screenshot id → unknown-id refusal with the later-call hint; aggregate over the cap → `batch-upload-too-large`; batch without upload steps unchanged; one question at a time
- [X] T411 [US4] Implement the batch pre-pass in packages/agent-host/src/mcp-server.ts (for `browser_batch`: sequential `prepareUpload` per upload step under the batch callId, first refusal answers the batch, aggregate bound, rewrite steps, then send) until T410 is green
- [X] T412 [US4] Contract test "one resolver" in tests/contract/agent-tools-015.contract.test.ts (the batch path reaches `prepareUpload`; no second path-resolution entry point exists in the host source), and close 013's "listed but unusable" note in specs/013-upload-image/coverage.md with a pointer to 015
- [X] T413 [US4] (main session) Gate tests/e2e/packaged/agent-batch-upload.spec.ts: a batch that types, uploads an allowed file, uploads a pre-batch screenshot, and clicks submit; a batch whose file is outside the roots (card answered once, then no); assert page state and that no step ran on refusal (SC-112)
- [X] T414 [US4] (main session) Dispatch **code-reviewer** on the S3 diff (claim: the batch path applies exactly the standalone checks, no path or unread file crosses, disk roots never remembered, refusal before any step, aggregate bound, interrupt during the question); resolve every finding with a test; re-review if a finding changes the check

**Checkpoint**: host unit + contract + gate green; review passed.

## Phase 6: User Story 3 — Every finished download is reported, once (P2) — slice S2

**Goal**: earliest-finished un-answered completion, once each, per session.
**Independent test**: B-then-A finishing order answered B then A (SC-111).

- [X] T415 [P] [US3] RED tests in apps/extension/tests/download-observer.test.ts: two downloads created A,B finishing B,A → `takeCompletion` returns B then A then undefined; failed and cancelled answered with state; never repeated; session isolation; migration of a ring with only `waitWatermark`; eviction of an unanswered item
- [X] T416 [US3] Implement `answered` ids, earliest-`endedAt` selection and read-time migration in apps/extension/src/service-worker/download-observer.ts until T415 is green; keep `downloads_context` output unchanged (existing tests)
- [X] T417 [US3] Add a two-download fixture (`/two-downloads`: starts a slow file then a fast file) to tests/harness/page-fixtures.ts
- [X] T418 [US3] (main session) Extend tests/e2e/packaged/agent-downloads.spec.ts with the two-download case (SC-111)

**Checkpoint**: unit + gate green.

## Phase 7: User Story 5 — A pairing card nobody is waiting on goes away (P2) — slice S4

**Goal**: host expiry withdraws that session's request; a late answer cannot settle a newer exchange.
**Independent test**: card gone ≤ 2 s after the only session's expiry; stays for a second session (SC-113).

- [X] T419 [US5] RED host tests in packages/agent-host/tests/mcp-server.test.ts: expiry sends `pair-withdraw {agentId, sessionId, requestId}`; close with an open exchange sends it before `stop`; `pair-request` carries a fresh `requestId`; a `pair-result` naming a withdrawn `requestId` is ignored and logged; one without `requestId` is accepted as in 0.7.0
- [X] T420 [US5] Implement in packages/agent-host/src/mcp-server.ts until T419 is green
- [X] T421 [US5] RED worker tests in apps/extension/tests/prompt-waiting.test.ts and apps/extension/tests/agent-bridge.test.ts: `pair-withdraw` for the only waiting session drops the card and clears attention; for one of two keeps the card with count 1; the worker echoes `requestId`; an unknown frame type is dropped by the decoder without error
- [X] T422 [US5] Implement decode in apps/extension/src/service-worker/agent-bridge.ts, routing to `expireWaiting` in apps/extension/src/service-worker/agent-runtime.ts, and `requestId` keeping/echo in apps/extension/src/service-worker/pairing-controller.ts until T421 is green
- [X] T423 [US5] (main session) Gate case in tests/e2e/packaged/agent-first-run.spec.ts or a new tests/e2e/packaged/agent-pairing-withdraw.spec.ts using the harness's short pairing bound (the host test env already allows lengthening/shortening the bound): single session → card gone ≤ 2 s; two sessions → card stays with count 1 (SC-113)

**Checkpoint**: unit + gate green.

## Phase 8: User Story 6 — 0.8.0, published, and seen working in Edge (P3) — slice S5

- [X] T424 [US6] Bump to 0.8.0 at the single sources (`AGENT_EXTENSION_VERSION` in apps/extension/src/build-config.ts, host self-report, package script name) following a22abed; update the version assertions in tests
- [X] T425 [P] [US6] Docs: README.md and README.zh-TW.md (press outcomes, uploads in a batch, 0.8.0), docs/zh-TW/operations-guide.md and docs/zh-TW/qa-guide.html (what the agent now says after a click; batch upload question), docs/design-notes.md (public summary, no reference identifiers), scripts/package/README.md upgrade notes 0.7.0 → 0.8.0
- [X] T426 [US6] Write owner-run scripts `scripts/owner/chrome153-015.ps1` and `scripts/owner/edge-015.ps1` (launch with private profile + debug port, then the exact runner commands) — or, if scripts/ must stay public-clean, place them in the job tmp and print them in the final report
- [X] T427 [US6] Run `npm run package` and `npm run snapshot:check`; record numbers in specs/015-honest-answers/coverage.md

## Phase 9: Polish & final verification

- [X] T428 Delete the scratch specs tests/e2e/packaged/zz-measure-015.spec.ts and zz-stale-015.spec.ts (their findings live in research.md and agent-false-stale.spec.ts)
- [X] T429 Final verification (the one planned): `npm run typecheck && npm test && npm run test:contract && npm run snapshot:check`, then every `agent-*` gate on Chromium 151 in attach mode; numbers into specs/015-honest-answers/coverage.md; spec status updated; memory updated

## Dependencies & execution order

- T396–T397 (contracts) before T400–T401, T404–T406, T410–T411, T419–T422.
- S0 (T398) runs in the main session alongside the first implementation wave.
- **Wave 1** (after T397): S3 (T409–T412, host files) ‖ S2 (T415–T417, `download-observer.ts` + fixtures) — disjoint files. Note T405 (`createdSince`) also edits `download-observer.ts`: it is done **inside S2's writer** to avoid two writers on one file.
- **Wave 2**: S1 (T400–T407; needs T398's finding for T402) ‖ nothing else on `effects.ts`/contracts.
- **Wave 3**: S4 (T419–T422) after S3 (both edit `mcp-server.ts`) and after S1 (both edit contracts).
- Gates (T399, T408, T413, T418, T423) by the main session after the relevant wave, one at a time.
- T414 review after T413. S5 after all stories. T429 last.

## Parallel examples

- Wave 1: implementer-high on T409–T412 (host) while implementer on T415–T417 + T405 (extension observer + fixtures), while the main session runs T398 against the browser.

## Implementation strategy

MVP = US2 + US1 (honest press answers and no false stale) — the defects the agent meets on every
page. Then US4 (the owner's explicit ask, reviewed), US3, US5, and the close-out.
