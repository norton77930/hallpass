# Research: Honest Answers (015)

Decisions R-196 – R-202. Sources: the private reference evidence for 015 (§1–§4), the measurements
of 2026-09-25 on Playwright Chromium 151.0.7922.34 in attach mode (scratch specs
`zz-measure-015.spec.ts`, `zz-stale-015.spec.ts`, not committed), and a read of the worker, host and
contracts at 611ee7f.

## R-196 — The 014 link-click record: measure, and what it turned out to be (FR-203)

**Measured**: five variants (same-origin link by ref, the same by coordinates, a raw CDP click as
control, a cross-origin link, a link to a server redirect) all navigated and answered
`documentChanged: true`; the page saw the identical trusted pointer/mouse/click sequence for our
press and for the control. The 014 shape — `verified: true, documentChanged: false`, tab not moved —
appeared **once**, in the same run family that produces R-197's hang, and that call took 11.2 s.

**Decision**: press delivery stays unchanged (FR-203, "if it does not reproduce, delivery stays").
The 014 record is attributed to R-197 (a page that does not answer the extension for ~10 s makes
every post-press observation unreliable) until R-197's diagnosis says otherwise. The owner's
branded-Chrome repeat of the measurement is part of the close-out run (T-C153).

**Alternatives**: changing dispatch (e.g. adding a DOM `click()` fallback for anchors) — rejected:
nothing measured calls for it, and 004 removed page-level synthetic input on purpose.

## R-197 — The false `stale` (FR-204 – FR-206)

**Measured**: in the measurement spec's flow the call that answers `stale` takes **10 033 ms** — the
content operation deadline (`CONTENT_OPERATION_DEADLINE_MS = 10 000`, `content-broker.ts:124`). The
tab is `complete`, on the right URL, not discarded or frozen. So the page's frame did not answer the
extension's probe message for 10 s: `probeActiveTab` maps a deadline to `stale-context`, and
`page-binding.ts` maps every non-`unsupported-page` failure to `stale`. The same hang made the test's
own `chrome.scripting.executeScript` on that tab time out once.

**Not the trigger** (24 round trips, 0 hangs, all calls < 120 ms): `navigate` out and back; link
click out and `navigate` back; MAIN-world script on A; ISOLATED-world DOM insertion on A; MAIN-world
script on B; a raw Playwright mouse press on A; `beforeunload`/`pagehide` listeners on A.
**Trigger still unknown**; the measurement spec reproduces it in about 3 of 5 runs. It contains, in
order, three press variants on A with MAIN-world event recorders, a Playwright page-level press, a
cross-origin click, a `navigate` back, an ISOLATED DOM insertion and a coordinate press on the
inserted link.

**Decision**:
1. First task of slice S1: bisect the measurement spec (drop steps until the hang stops) — a
   red-capable loop at ~60 % per run, so each bisect step is judged on 5 runs. Stop after two
   bisection rounds that do not narrow it (the project's "two failures, then measure differently"
   rule) and record what was learned.
2. If the trigger is something only a test harness can do (a second CDP client, scripting from the
   test), record it as a harness artifact with the evidence; FR-205's product claim is then proved by
   the 20-run agent-only reproduction (SC-110).
3. Independently of the trigger, FR-206: a binding failure caused by the page not answering within
   the deadline stops being a bare `stale`. It answers `outcome: "failed"`, `reason:
   "page-not-responding"`, with a hint that the page did not answer for 10 s, is still open, and the
   call may be retried. `stale` stays for a document that was replaced (`stale-reference`) and a tab
   that is gone (`tab-gone`).

**Alternatives**: shortening the deadline — rejected before the trigger is known; a hang would then
be reported sooner but just as falsely.

**Bisection result (T398, 2026-09-26, Chromium 151.0.7922.34 attach, pre-015 extension bundle)**:
- Round 1 — same browser process across five runs of the full measurement flow, with a second raw
  CDP client probing during the hang: run 1 clean, runs 2–4 hang (the click answers `stale` after
  28.6 s), run 5 cannot even `connectOverCDP`. During a hang `Target.getTargets` lists **no new
  tab** (the `target="_blank"` press never produced one) and the pressed tab does not answer
  `Runtime.runIfWaitingForDebugger` within 3 s: its renderer main thread is blocked. That refutes
  the "harness pauses the new tab on start" hypothesis; the extension's own auto-attach uses
  `waitForDebuggerOnStart: false`.
- Round 2 — browser process relaunched before every run (same profile), five runs with the test's
  event recorder in page memory and five with it in `sessionStorage`: **0 / 10 hang**, every press
  answered `verified` in ~7.5 s.
- ~~Conclusion: harness artifact~~ — **withdrawn the same day.** Round 2's 0/10 did not reproduce
  the flow that matters; the next measurement did.
- Round 3 (T408 gate with SC-109's cross-origin and redirect variants added): deterministic 3/3 on a
  fresh browser. The press on the `window.open` button after the tab's cross-origin round trip
  answers `timed-out / no-answer` after 30 s; during the hang no new tab target exists and the
  pressed tab's renderer does not answer `Runtime.evaluate` (same signature as rounds 1–2).
- Round 4 — **no Playwright connection at all** (extension loaded by one raw
  `Extensions.loadUnpacked`, driven only through the MCP client, scratch `zz-nopw-015.spec.ts`):
  `tabs_create` → cross-origin out (by `click` *or* by `navigate`) → `navigate` back → `click` on
  the `window.open` button hangs 30 s, 3/3. The same press without the cross-origin round trip
  answers in ~0.5 s with `newTabs`. After the hang every press on that tab takes ~5.4 s and does
  nothing (links do not navigate) while answering "nothing happened".
- Conclusion of round 4: the hang is **on the product's path** (it reaches the agent with no
  harness involved), not a harness artifact. Trigger: the first opener-keeping popup
  (`window.open`) pressed on a tab after that tab's document crossed origins and came back (a
  `target="_blank"` link, which implies `noopener`, does not trigger it). SC-110's 20-round gate
  passes only because it presses no popup-opening control.
- Round 5 — discriminating the layers. (a) With this product's `Target.setAutoAttach` removed from
  the attachment (measurement-only build): still 2/2 hangs, so auto-attach is not it. (b) **No
  extension loaded at all**, one raw CDP client: `Target.createTarget` A, `Page.navigate` to B and
  back to A, then `Input.dispatchMouseEvent` pressed/released on the `window.open` button: the
  release does not return within 15 s and the page stops answering `Runtime.evaluate` (the control
  without the round trip: 33 ms, popup opened). A second identical run in the same browser did not
  hang.
- **Root cause (T402)**: Chromium itself (151.0.7922.34) can block a renderer on the first
  opener-keeping `window.open` pressed through CDP input after that tab's cross-origin round trip.
  The product cannot prevent it; what it controls is the answer. The press path awaits
  `Input.dispatchMouseEvent` with no bound (the private evidence shows the reference bounds every
  CDP command), so the agent waits 30 s for `no-answer`. **Decision**: bound the CDP input dispatch
  of a press at the content deadline (10 s) and answer `failed / page-not-responding` with the
  FR-206 hint. Gate: a fixture control that blocks its own renderer (a busy handler) makes the bound
  deterministic; the Chromium trigger is recorded here, not gated, because it fires once per
  browser. Whether branded Chrome 153 shows the same block is part of the owner-run check (T426).

## R-198 — What a press reports (FR-200 – FR-202)

**Current**: one path for every press — `deliverPointer` → `verifyDelivered` → `verifyPageEffect`
(re-probe after `DEFAULT_SETTLE_MS = 400`) → `observationOf`; batch steps pass the same observation
through (`batch.ts:227-235`). The observation schema is strict, has no URL, and nothing listens to
`chrome.tabs.onCreated`; a tab opened by a press does not join the session (`tabs_create` is the only
door, `tabs.ts:38-43`). Downloads are attributed to sessions by time at `onCreated`.

**Decision**:
- The observation gains optional fields (all additive): `url` (the tab's committed URL at the end of
  the settle wait, when `documentChanged`), `newTabs: [{ tabId, url, held: false }]` (tabs whose
  `openerTabId` is the pressed tab, created between the press and the end of the settle wait),
  `downloads: [{ id, filename, url, state }]` (downloads the session's observer recorded in the same
  interval), and `observedForMs` (the settle wait, present when nothing of the three was observed).
- The observation window is the existing settle wait (400 ms): **no added latency** (FR-202). Events
  are collected by listeners armed just before dispatch and removed after the settle.
- When the pressed target is a link with an address (known from the ref's role or the pre-press hit
  test) and none of the three outcomes happened, the answer carries a `hint`: "The link was pressed
  but nothing navigated, opened or downloaded within 400 ms; the page may handle it itself —
  read the page or wait before assuming it did nothing."
- A new tab is reported with `held: false` and a hint naming `tabs_claim`: this feature reports, it
  does not change ownership (spec assumption).

**Alternatives**: waiting for `load` after a press (the reference's CX shape uses separate tools for
this; our `wait`/`navigate` already cover it) — rejected; `webNavigation` permission — rejected, no
new permission (as in 014).

## R-199 — Every download, once (FR-207 – FR-209)

**Current**: `takeCompletion` (`download-observer.ts:181-194`) looks only at `items[0]` and keeps one
`waitWatermark`; `wait` polls it (`wait.ts:180-203`).

**Decision**: the ring keeps `answered: number[]` (download ids already answered to this session,
bounded by the ring's 20 items — ids that leave the ring leave the list). `takeCompletion` picks,
among terminal items not in `answered`, the one with the smallest `endedAt` (ties: smaller id),
records it and returns it. Migration inside `storage.session`: a ring read without `answered`
treats every terminal item whose `endedAt ≤ waitWatermark` as answered, then drops the watermark.
Attribution per session is unchanged.

## R-200 — Uploads inside a batch (FR-210 – FR-215; authorization boundary)

**Current**: the whole standalone upload flow is inline in `placeCall`
(`mcp-server.ts:1309-1481`); only `resolveUploadFiles` (`upload-policy.ts:149`),
`splitRememberableDirectories`, `uploadNotRecordedHint` and `askUploadConsent` are functions. The host
never special-cases `browser_batch`; the worker parses every step with the same strict schemas as a
standalone call (`upload.ts:167`, `:229`), so a step rewritten exactly like a standalone call is
accepted unchanged.

**Decision**:
1. Extract the inline blocks into **one** function, `prepareUpload(callId, tool, args)` →
   `{ ok: true, args } | { ok: false, response }`, containing everything from path resolution to
   the rewrite (directory question, remember, disk-root rule, bytes, screenshot lookup, refusals).
   `placeCall` calls it for a standalone `file_upload` / `upload_image` — behaviour byte-identical,
   proved by the existing 014/013 host tests passing unchanged.
2. For `browser_batch`, a pre-pass calls the same `prepareUpload` for each upload step **in step
   order, sequentially**, under the batch's `callId` (so interrupt, stop and the waiting ticks work
   exactly as for a standalone upload — one question at a time, one `uploadConsents` slot). The first
   refusal answers the whole batch with that response, its reason prefixed by the step index
   (`step 3: upload-declined`), and nothing is sent to the worker. On success the steps' args are
   replaced and the batch is sent.
3. "Remember" answered for step 1 is written before step 2 is resolved, so step 2 in the same
   directory is not asked again (spec edge case). This is the owner's own decision taking effect,
   not a widening the owner did not see.
4. **Aggregate bound**: a batch's upload content travels in one link frame, and the per-call cap
   (`AGENT_UPLOAD_MAX_BASE64_CHARS = 700 000`) exists because of that frame. The pre-pass refuses a
   batch whose upload content sums above that cap: `batch-upload-too-large`, hint "split the uploads
   across calls". No per-batch cap existed before (nothing could reach it).
5. A same-batch screenshot (`upload_image` naming an id the host has not issued yet) is refused by
   the lookup as an unknown id; the refusal's hint adds "a screenshot taken inside this batch can be
   uploaded in a later call" (FR-210).
6. A contract test pins that the standalone path and the batch path call the one function
   (FR-211): the host module exposes no second resolver, and a spy on `prepareUpload` sees both.

**Alternatives**: mid-batch asking (B) and "any question refuses the batch" (the reference's rule) —
decided against by the owner (D-015-5).

## R-201 — Pairing withdrawal (FR-216 – FR-219)

**Current**: host `expire()` (`mcp-server.ts:595-611`) only clears local state; the worker mirrors
the bound with its own timer and `expireWaiting(agentId, sessionId)` (`pairing-controller.ts:450`)
already removes one session from a card. `stop{sessionId}` is a full session teardown, too broad.
A late `pair-result` is taken by whatever exchange is open.

**Decision**:
- New optional control frame host → worker: `pair-withdraw { agentId, sessionId, requestId? }`,
  sent from `expire()` and before a session's `stop` on close. The worker calls `expireWaiting`.
  An old worker drops the unknown frame (verified in the bridge's decode path as part of the task;
  014's additive-frame rule) and keeps its own mirrored timer.
- `pair-request` gains optional `requestId` (host-minted per exchange) and `pair-result` echoes it.
  The host ignores a `pair-result` whose `requestId` names an exchange it already withdrew; a result
  without `requestId` (old worker) is handled as today.
- Link protocol stays 2.

## R-202 — Close-out (FR-220 – FR-222)

- Version 0.8.0 at the single source (`AGENT_EXTENSION_VERSION`, build-config) plus the host's
  self-report and package name, as in 0.7.0 (a22abed).
- Public snapshot: the snapshot check runs; push/tag/release/visibility wait for the owner.
- Edge: host registration exists since 010. Claude cannot launch a branded browser with debugging
  flags (refused by the permission classifier, 014/T390), so the Edge run and the Chrome 153 run are
  prepared as owner-run scripts with the exact commands, and recorded when the owner runs them.
