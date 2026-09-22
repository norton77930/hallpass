---

description: "Task list for Viewport Override and Zoom"
---

# Tasks: Viewport Override and Zoom

**Input**: `/specs/012-viewport-zoom/spec.md`, `plan.md` (S1–S3), `research.md` (R-166–R-173,
three measured), `data-model.md`, `contracts/viewport-and-capture.md`, `quickstart.md`.

**Tests**: TDD in S1/S2 (one focused RED per slice before the code: range + record round-trip +
clear-before-detach; crop rectangle at DPR 1.25 + scale + path table + refusals); S3 closes on the
packaged gate, one owner-run measurement on branded Chrome (R-168) and one paid probe (SC-090,
owner's go-ahead). `code-reviewer` once, after S1+S2 (attachment lifecycle across five release
paths, storage round-trips, coordinate frames).

**Numbering** continues from 011 (T282–T301): this feature starts at **T302**.

## Standing rules (owner, 2026-09-18 — binding for every task)

1. **Two attempts, then stop.** A task that fails its second attempt is not tried a third time.
2. **Clean room.** Behaviour only; no reference identifier in `specs/` or source
   (the reference evidence for 012 is private and export-ignored).
3. **One writer at a time.** Brief 1 = S1 (contracts + worker viewport); brief 2 = S2 (capture);
   brief 3 = gate spec + docs; version bump, evidence correction, probe and owner hand-off stay
   with the main session.
4. **No new permission; nothing private leaves.** `npm run snapshot:check` before the final commit.
5. **No paid run without the owner's go-ahead** (T322).

## Phase 1 — Setup

- [X] T302 Read `contracts/viewport-and-capture.md`, `data-model.md`, `research.md` R-166–R-171 and
  the sources they name; confirm at HEAD: `acquire()` is the only `chrome.debugger.attach` call
  (`agent-tools/input.ts`), the five `attachments.release` / `releaseAll` sites in
  `agent-runtime.ts` (tab released, session end, unpair, grant withdrawn, owner take-back),
  `AGENT_TOOL_NAMES` has 31 entries, `SCREENSHOT_MAX_BASE64_CHARS = 700_000` (`reads.ts`),
  `cropWithCanvas` crops in image pixels (`chrome-adapters/capture.ts`).

## Phase 2 — Foundational: contracts (blocks US1–US3)

- [X] T303 RED: `tests/contract/` case — `AGENT_TOOL_NAMES` contains `viewport` (32 names) and
  `AGENT_BATCH_STEP_TOOL_NAMES` contains it; `viewport` args accept `{tabId, action:"set",
  width:375, height:812}` and `{tabId, action:"reset"}`, reject width 319 / 4097 and a `set`
  without height; `screenshot` args accept `scale: 0.5`, reject `0.05` and `1.5`; the screenshot
  result accepts the new optional fields (`width`, `height`, `scale`, `frame`, `coverage`, `region`)
  and still accepts the old three-field shape; `agentActivityItemSchema` accepts `kind:"viewport"`
  with `outcome:"set"|"cleared"`; the manifest snapshot has no new permission.
- [X] T304 GREEN: `packages/contracts/src/agent-tools.ts` — `agentViewportShape` (discriminated on
  `action`; `AGENT_VIEWPORT_MIN_PX = 320`, `AGENT_VIEWPORT_MAX_PX = 4096`), `viewport` result
  schema `{width, height, emulated}`, `scale` on `agentScreenshotShape` (0.1..1, default 1),
  the result fields, the activity kind and outcomes, the tool in both name lists, the tool entry
  with the R-172 description and the `resize_window` description addition (FR-165).
  `AGENT_LINK_PROTOCOL` unchanged (comment: additive fields, absent tool on an older offering).

## Phase 3 — US1: the emulated viewport (P1) — FR-156, FR-157, FR-159, FR-160, FR-161, FR-166 (S1, brief 1)

**Goal**: `viewport set/reset` on a held tab; cleared on every release path; re-applied after
worker eviction; an activity line.

**Independent Test**: unit table in T305 plus gate T318 steps 1, 3, 4.

- [X] T305 RED: `apps/extension/tests/viewport-emulation.test.ts` — (a) `decideClear(record,
  attached)` table: attached → `send-clear`; not attached → `attach-clear-detach`; (b) the store
  round-trips one record per tab through a fake `chrome.storage.session` and a second `set`
  replaces the first; (c) composed on a fake attachment: `set` sends
  `Emulation.setDeviceMetricsOverride {width, height, deviceScaleFactor:1, mobile:false}` after
  acquiring holder `"viewport"`; `reset` sends `clearDeviceMetricsOverride`, drops the record and
  the holder; (d) `onBeforeRelease(tabId)` sends the clear **before** the fake's `detach` is
  called, for a record that exists, and nothing for a tab without one; (e) `onAttached(tabId)`
  re-sends the override when a record exists (the eviction path). Also in
  `apps/extension/tests/input-attachment.test.ts`: holder `"viewport"` enables no domain;
  `onAttached` fires after `Target.setAutoAttach` + `Page.enable`; `onBeforeRelease` runs before
  `detach` in both `release` and `releaseAll`.
- [X] T306 GREEN: `apps/extension/src/service-worker/viewport-emulation.ts` (NEW) — the record
  store (`AGENT_VIEWPORTS_KEY = "agentViewports"`, shaped like `window-restore.ts`), `decideClear`
  (pure), `createViewportEmulation({ store, attachments, onActivity, reportDiagnostic })` with
  `set(sessionId, tabId, size)`, `reset(sessionId, tabId)`, `current(tabId)`, and the two hooks;
  diagnostics `agent.viewport.apply-failed` / `agent.viewport.clear-failed`. `agent-tools/input.ts`
  — holder `"viewport"`, `onAttached` (after the per-attachment setup in `acquire`) and
  `onBeforeRelease` (before `detach` in `release` and `releaseAll`), both awaited, failures reported
  not thrown.
- [X] T307 `apps/extension/src/service-worker/agent-tools/tabs.ts` — dispatch `viewport` beside
  `resize_window`: ownership check as every tab tool; `set` → `viewportEmulation.set` and answer
  `{width, height, emulated:true}`; `reset` → answer the page's real size (`innerWidth/innerHeight`
  through the existing page binding, or the tab's window size when the page is not readable) with
  `emulated:false`; attachment refused → `inputUnavailable(callId, reason)`; tab gone → `stale`.
  Unit case in `apps/extension/tests/agent-tabs.test.ts` (or the file that tests
  `resize_window`) for the three answers.
- [X] T308 `apps/extension/src/service-worker/agent-runtime.ts` — compose the module next to
  `windowRestorer`, register both hooks on `attachments`, `noteActivity(sessionId, {kind:"viewport",
  outcome:"set", message:"WxH"})` / `outcome:"cleared"`; nothing else changes on the five release
  paths (the hook does the work). `apps/extension/src/side-panel/agent/SessionCard.tsx` +
  `_locales/en` + `_locales/zh_TW`: `agent.activity.viewportSet` ("Viewport set to {size}" /
  「視窗模擬為 {size}」) and `agent.activity.viewportCleared`. Unit: `activityText` for both.
- [X] T309 Run `npm run test:unit` and `npm run test:contract`; tick T303–T308; commit
  "Feature 012 S1: the viewport tool, its record, and the two attachment hooks".

**Checkpoint**: US1 complete at unit level; the gate proof waits for S3.

## Phase 4 — US2: native-density capture with scale (P2) — FR-158, FR-162, FR-163, FR-164 (S2, brief 2)

**Goal**: `screenshot` crops at `region × DPR`, applies `scale`, takes the protocol path on an
emulated tab, refuses a region outside the frame, and names the fitting scale when over the
frame bound.

**Independent Test**: unit tables in T310 plus gate T318 steps 2, 5, 6.

- [X] T310 RED: `apps/extension/tests/capture.test.ts` — (a) crop maths: frame 1187×707, image
  1484×884 (DPR 1.25), region {100,200,300,100} → source rect {125,250,375,125}; with scale 0.5 →
  output 188×63 (rounded, ≥ 1); (b) `scale` alone on a whole image halves width and height;
  (c) `decideCapturePath(record?)` table: record → `protocol` with `clip` = region or whole frame
  and `scale`; none → `visible-tab`; (d) region outside frame ({1100,0,200,100} on 1187 wide) →
  refusal `region-outside-viewport (frame 1187x707)` and no capture call; (e) fitting-scale hint:
  a 1 400 000-char image → `screenshot-too-large; retry with scale ≤ 0.7` (factor
  `floor(sqrt(700000/len)*10)/10`); (f) the protocol variant sends `Page.captureScreenshot {format:
  "png", fromSurface:true, clip:{x,y,width,height,scale}}` over `attachments.send`. In
  `apps/extension/tests/agent-reads.test.ts`: the answer carries `width, height, scale, frame,
  coverage, region`.
- [X] T311 GREEN: `apps/extension/src/chrome-adapters/capture.ts` — `frame` input (CSS size),
  DPR derived as `image.width / frame.width`, crop at `region × DPR`, `scale` in the same canvas
  pass, a pure `cropRect()` exported for the test, and `captureThroughProtocol({send, tabId,
  clip, scale})`; `agent-tools/photograph.ts` — asks `viewportEmulation.current(tabId)` (injected
  dep), reads the frame through the page binding (fallback: `chrome.tabs.get` width/height when
  the page is not readable), chooses the path, keeps the activate/restore dance for both;
  `agent-tools/reads.ts` — `scale` arg, the outside-frame refusal before any capture, the hint on
  too-large, the result fields; `cropped` kept.
- [X] T312 Run `npm run test:unit`; tick T310–T311; commit "Feature 012 S2: native-density
  region capture, scale, and the protocol path under emulation".

**Checkpoint**: US1 + US2 complete at unit level.

## Phase 5 — Review gate

- [X] T313 Dispatch `code-reviewer` (read-only) over the S1+S2 diff with the claim: "the
  emulation is cleared before every detach on all five release paths and after worker eviction the
  next acquire re-applies it; the screenshot's coordinate frame is the emulated viewport when a
  record exists and the real one otherwise; the region crop is correct at DPR ≠ 1". Fix findings
  in a fourth brief if any; record them in `coverage.md`.

## Phase 6 — US3 + proof + documents (P3) — FR-165; SC-085..092 (S3, brief 3 + main session)

**Goal**: the agent reaches for `viewport` first; the gate proves US1–US2 live; 0.4.0 ships.

**Independent Test**: contract test on the descriptions; gate spec green; probe transcript.

- [X] T314 [P] Contract test `tests/contract/` — `viewport`'s description contains "without
  changing the browser window", "Prefer this over `resize_window`" and "reset"; `resize_window`'s
  contains "use `viewport` instead"; both say the two are independent (FR-165).
- [X] T315 [P] Version 0.4.0 (R-173): `apps/extension/src/build-config.ts`
  `AGENT_EXTENSION_VERSION`, `packages/agent-host/src/tool-offering.ts` `SERVER_VERSION`, the three
  watermark strings in `apps/extension/tests/{offscreen-router,overlay,recorder}.test.ts`; the
  offering snapshot test if it pins the version. (main session)
- [X] T316 [P] Gate fixture `tests/e2e/fixtures/viewport.html` — a bar that switches colour at a
  768 px breakpoint, an element (`#menu`) laid out only below 768 px and one (`#wide-only`) only
  above 1 900 px, 11 px text at (100, 200) 300×100 with a known reference PNG, a block at
  (2000, 1200). Served by the existing fixture server.
- [X] T317 Gate spec `tests/e2e/packaged/agent-viewport.spec.ts` (Chromium attach recipe, 011):
  1. `viewport set 375×812` → page `innerWidth/innerHeight` 375×812, bar narrow colour, window
     bounds and state unchanged before/after (SC-085);
  2. `set 2560×1440` → 2560×1440, bar wide colour; `screenshot` answers `coverage:"viewport"`,
     `frame 2560×1440`, image 2560×1440 or the too-large hint (assert one of the two and then
     retry with the named scale → an image at that scale); `read_page` + `click` on `#wide-only`
     lands (page records the click) (SC-088);
  3. `reset` → real size; `set` + `tabs_release` → real size; `set` + owner take-back through the
     panel page → real size; `set` + session end (close the MCP client) → real size (SC-086, 4/4);
  4. `set`, kill the worker (the `agent-panel-multi` recipe), next `tabs_context` → page still
     emulated and `viewport set` again is idempotent (SC-087);
  5. forced DPR 2 (`Emulation.setDeviceMetricsOverride` with `deviceScaleFactor:2` through the
     harness's own CDP on the fixture tab, then `viewport set 1200×800`): region {100,200,300,100}
     → 600×200 and the 11 px reference matches within tolerance; `scale 0.5` → 300×100; region
     {1100,700,300,200} → `region-outside-viewport (frame 1200x800)` (SC-089);
  6. `agent-reads.spec.ts`: plain screenshot `scale 0.5` → half size, answer `scale 0.5`,
     `frame` real (SC-089).
- [X] T318 Run the gate: `npx playwright test tests/e2e/packaged/agent-viewport.spec.ts
  tests/e2e/packaged/agent-reads.spec.ts` and the regression trio in `quickstart.md` §5; record
  numbers in `coverage.md`.
- [X] T319 [P] Documents: `README.md` (tool table row for `viewport`, `screenshot` row mentions
  `scale`, count 32, a 0.4.0 note), `docs/zh-TW/operations-guide.md` (count, one paragraph for
  the two capabilities and the "cleared on release" rule), `docs/design-notes.md` §7 (viewport
  and zoom leave "planned"; `upload_image` stays for 013; one line on why emulation, not resize,
  and on clear-before-detach). No reference identifier.
- [X] T320 `coverage.md` — FR-156..166 ↔ tests/gate steps ↔ SC-085..092, the review findings,
  the R-166 numbers, what the owner still owes (T321, T322).
- [X] T321 **Owner**: run `node .scratch/r166-viewport-capture.mjs` against the branded Chrome
  153 through the attach recipe (or the equivalent steps by hand) and paste the numbers into
  `research.md` R-168; main session records the result and the Chrome version.
- [X] T322 **Probe (paid, owner's go-ahead)**: `claude -p --model sonnet` with the fixture
  served: "show me how this page looks at a phone width"; assert a `viewport` call and no
  `resize_window` in the transcript; record model and outcome in `coverage.md` (SC-090).
- [X] T323 Final verification (the one planned): `npm run test`, `npm run test:contract`,
  `npm run snapshot:check`, `npm run typecheck`; tick everything; commit "Close feature 012
  implementation: coverage, final verification green". (main session)

## Not scheduled

- Emulating DPR, touch, user-agent (spec Out of Scope).
- `upload_image` (013).

## Dependencies

T302 → T303/T304 → S1 (T305 → T306 → T307 → T308 → T309) → S2 (T310 → T311 → T312) → T313 →
S3: T314, T315, T316, T319 in parallel; T317 after T316; T318 after T317 and T315; T320 after
T318; T321 and T322 owner-gated, any time after T318; T323 last.

## Implementation strategy

S1 alone is a usable increment (viewport without the capture fix is still a working breakpoint
test through `read_page`); S2 makes the screenshot honest under it; S3 is proof and shipping.
Stop after T313 if the review finds a lifecycle hole; do not proceed to the gate with a known one.
