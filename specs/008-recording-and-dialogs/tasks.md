---

description: "Task list for Recording, Dialogs and Window Restore"
---

# Tasks: Recording, Dialogs and Window Restore

**Input**: `/specs/008-recording-and-dialogs/spec.md`, `plan.md` (slices S1–S6), `research.md`
(R-132–R-143), `data-model.md`, `contracts/README.md`, `quickstart.md`;
evidence `docs/design-notes.md` (cited as §n).

**Tests**: TDD per slice — one focused RED then minimal GREEN; unit (`apps/extension/tests`), contract
(`tests/contract`), attach gate (`tests/e2e/packaged/agent-*.spec.ts`, `HALLPASS_CDP_ENDPOINT`), probe
(`tests/acceptance/probe-004`). Slice review by `code-reviewer` only where pre-selected (S2, S4).

**Numbering** continues from 007 (T201–T206): this feature starts at **T207**.

## Standing rules (owner, 2026-09-18 — binding for every task)

1. **Evidence before code.** Every task below names the design-notes § it rests on, or says
   "no reference — measure". Do not brief or start a task without reading that §.
2. **Two attempts, then stop.** A task that fails its second attempt is **not** tried a third time. The
   main session re-reads the reference bundle (the § names the file) or takes **one measurement on the
   gate**, writes the finding as a new § in `docs/design-notes.md`, and re-briefs the
   task with it. "Try another variant of the same guess" is the failure mode this rule exists to stop.
3. **Clean room.** Reference identifiers stay in the evidence file. Nothing is copied.
4. **One writer at a time**; each slice is one `implementer` brief; the main session owns measurements,
   evidence writing and the two reviews.

## Slice S1 — Contracts, permission, version (closes FR-100 shape, FR-121, FR-122 version) — §1

- [X] T207 [S1] `packages/contracts/src/agent-tools.ts`: add descriptors + zod arg schemas for
  `gif_recorder {action, filename?}` (filename `^[A-Za-z0-9 _.-]{1,80}$`, not leading `.`) and
  `dialog {tabId, action, promptText?}`; add `force?: boolean` to `navigate` and `tabs_close`; add
  optional `recording: {frames, full}` and `dialog: CurrentDialog` to effect/screenshot/navigate/
  file_upload/resize_window/batch-step answers; extend `agentRefusalSchema` with `blocked-by-dialog
  {dialog}`, `blocked-by-beforeunload {url}`, `no-dialog`, `page-unresponsive`, `invalid-filename`,
  `empty-recording`, `download-failed {reason}`, `refused`; export `CurrentDialog`, `RecordingState`
  types (contracts/README §1–§4). RED first: `tests/contract/agent-tools-008.contract.test.ts` asserting
  31 descriptors and the filename grammar (valid/invalid table).
  B: 31 tools (`gif_recorder`, `dialog`); `currentDialogSchema`, `recordingStateSchema`,
  `gifRecorderStatusResultSchema`, `gifRecorderExportResultSchema`, `dialogResultSchema`,
  `AGENT_RECORDING_FILENAME_PATTERN`, `AGENT_RECORDING_MAX_FRAMES`; optional `recording` + `dialog`
  spread into the effect/screenshot/navigate/file_upload/resize_window answers (a batch step's
  `result` is already `unknown`, so the step answer needed nothing); `agentWaitResultSchema` is now a
  union with `condition-unmet {waitedMs, dialog}`; 8 new refusals, of which `download-failed` spells
  its cause `downloadReason` because `reason` is the union's discriminant (as `input-unavailable`
  spells its own `unavailableReason`). Neither new tool is a `browser_batch` step: `gif_recorder`
  names no tab and a batch cannot run while a dialog is open. RED → GREEN in
  `tests/contract/agent-tools-008.contract.test.ts` (12 cases); `agent-tools`/`agent-batch-wait`
  contract tests updated where they derive from the closed list; two `agent.summary.*` strings added
  to both locales so `locales.contract.test.ts` stays green.
- [X] T208 [S1] `apps/extension/src/build-config.ts`: `AGENT_PROFILE_PERMISSIONS += "offscreen"`;
  `version: "0.1.0"` → exported `EXTENSION_VERSION = "0.2.0"` used by `createManifest()` (R-142).
  Extend `tests/contract/agent-tools-008.contract.test.ts`: agent manifest permissions = 005 set +
  `offscreen` exactly; narrow manifest byte-identical to the committed 007 fixture (add a fixture copy if
  none exists — check `tests/contract/manifest.contract.test.ts` first); `scripts/package.ts` zip name
  follows the manifest (already true — assert, do not change). §1 (manifests).
  B: `AGENT_PROFILE_PERMISSIONS` += `offscreen` (11 permissions). The version is **per profile**:
  exported `AGENT_EXTENSION_VERSION = "0.2.0"` for the agent build, while the narrow build keeps
  `0.1.0` — its manifest is the archived 001/002 artefact and `narrow-manifest-guard.test.ts` holds
  it to the byte. Contract test pins the permission list, the narrow manifest deep-equal against
  `tests/acceptance/narrow-manifest.pre-004.json`, and `SERVER_VERSION === AGENT_EXTENSION_VERSION`
  (FR-122). `release-build.contract.test.ts`'s permission list updated. Built `dist/agent/manifest.json`
  carries `"version": "0.2.0"` and `offscreen`; `dist/test/manifest.json` is unchanged.
- [X] T209 [S1] `packages/agent-host/src/mcp-server.ts`: confirm the registration loop picks up the two
  new descriptors with no code change; extend the host's existing tool-list test to expect 31 names.
  Run `npx vitest run tests/contract packages/agent-host` green. Commit "Declare the 008 tools,
  the offscreen permission and version 0.2.0".
  B: the registration loop needed no change, but the host's own test asserts that *every* descriptor
  is registered, and S1 declares two tools a slice ahead of their runners. So
  `packages/agent-host/src/tool-offering.ts` (NEW, side-effect free — `mcp-server.ts` is an entry
  point and importing it starts a server on stdio) now holds `SERVER_NAME`,
  `SERVER_VERSION = "0.2.0"`, `IMPLEMENTED_AGENT_TOOL_NAMES` and
  `PENDING_AGENT_TOOL_NAMES = {gif_recorder, dialog}` (S3 removes the first, S4 the second). The host
  still offers 28 tools; the test now goes red for a descriptor that is neither implemented nor
  pending, and also asserts the pending two are *not* offered.

## Slice S2 — Offscreen document, encoder, overlays (FR-103, FR-104, FR-105, FR-109) — §2.5, §2.6

- [X] T210 [S2] Add `gifenc@1.0.3` to `apps/extension/package.json` dependencies and `omggif@1.0.10` to
  `packages/test-kit/package.json` devDependencies (R-135); `npm install`; note both licences in the
  package README's third-party list if one exists (check `docs/` and `release/` README template in
  `scripts/package.ts`).
  B: installed with the workspace flags; `package-lock.json` gained exactly the two entries, both MIT.
  `scripts/package/README.md` has **no** third-party list, so nothing was added there — T235 can start
  one if the owner wants it. Neither library ships declarations, so `types/gif-libraries.d.ts` (NEW)
  declares both **once** and the two importers reach it by `/// <reference path>`: `tsc -p
  apps/extension` and `tsconfig.tests.json` each end up compiling both `encode.ts` and `gif-decode.ts`,
  and a second ambient declaration of the same module in one program is an error. Units verified in the
  installed sources: gifenc's `writeFrame({delay})` is **milliseconds** (it writes `delay/10`), omggif's
  `frameInfo().delay` is hundredths; `repeat: 0` is the Netscape loop-forever count and `loopCount()`
  hands that same 0 back.
- [X] T211 [P] [S2] `packages/test-kit/src/gif-decode.ts` (NEW): `decodeGif(bytes) → {width, height,
  frames: [{delayMs, rgba: Uint8ClampedArray}], loopCount}` over omggif; helper `sampleColorAt(frame,
  x, y)`; `textVisible` is **not** OCR — expose `nonBackgroundPixelsIn(rect)` so a test can assert the
  label box is drawn where expected. Unit test with a 2-frame GIF generated by gifenc in the test.
  B: `decodeGif` blits each frame into one running buffer and copies it out, so every frame handed
  back is the full canvas as a viewer sees it (a GIF frame is a rectangle over the last one, not a
  picture of its own) and `delayMs` is milliseconds. `sampleColorAt(frame, width, x, y)` and
  `nonBackgroundPixelsIn(frame, width, rect, background = white)` both take the width, since a frame
  carries pixels and no geometry; the counter clamps a rectangle that runs off the canvas and allows
  8 per channel of quantisation drift. `loopCount` is omggif's raw value — 0 forever, `null` when the
  file has no Netscape block. Exported from `packages/test-kit/src/index.ts`; RED → GREEN in
  `gif-decode.test.ts` (4 cases) against a 2-frame GIF gifenc writes inside the test.
- [X] T212 [S2] `apps/extension/src/offscreen/overlay.ts` (NEW, pure): `drawOverlays(ctx, frame, action,
  n, N, watermark)` implementing FR-105 (ring r=11·s + glow r=15·s; drag line 3·s with 15·s arrowhead and
  6·s end marks; label 14·s px system-ui on `rgba(0,0,0,.85)` rounded 6·s, padding 8·s, near the point
  or at (20·s,20·s), flipped away from edges; counter bottom-right; bar 4·s along the bottom; watermark
  bottom-left) where `s = canvas.width / frame.viewportWidth` — **never** `devicePixelRatio` (§2.6,
  R-136). Colours are ours (tokens in the file header), not the reference's. RED first:
  `apps/extension/tests/overlay.test.ts` on an `OffscreenCanvas` (jsdom lacks it — use a tiny recording
  canvas fake that logs draw calls) asserting ring centre = point × s and label clipping at 40 chars is
  *not* done here (it arrives clipped).
  B: `drawOverlays(ctx, frame, action, n, N, watermark)` over an `OverlayContext` interface — the
  thirteen members it actually uses, so the node test's recording fake can be the context. No
  `roundRect`: the box is drawn from lines and corner arcs, one drawing path rather than one for
  Chrome and an untested fallback. Colours are ours and named at the top, taken from the panel's
  `tokens.css`: `ACCENT #1f6f78` (ring, glow, bar fill), `DRAG #b3261e` (drag path and marks).
  `action === null` is the initial frame and gets only counter, bar and watermark. RED → GREEN in
  `apps/extension/tests/overlay.test.ts` (7 cases); the file was re-run with the scale forced to `1`
  and all 7 went red, which is the DPR bug R-136 names.
- [X] T213 [S2] `apps/extension/src/offscreen/encode.ts` (NEW): `encodeRecording(frames, opts) → Blob`:
  decode each JPEG to a canvas, downscale so the long side ≤ 1568 px, pad to the max width/height with
  white on the right/bottom **after** overlays (§2.5), quantize + encode with gifenc, delay 800 ms, last
  frame 2800 ms, loop forever. RED first: `apps/extension/tests/encode.test.ts` encodes 3 synthetic
  frames of two sizes and decodes back with `gif-decode.ts`: 3 frames, delays [800, 800, 2800], canvas =
  max size, padded region white.
  B: split in two so the arithmetic is testable where there is no canvas. `encode.ts` is pure —
  `composeGif(frames, {delayMs = 800, lastExtraMs = 2000}) → Uint8Array`: canvas = max width × max
  height, a smaller frame padded right/bottom with opaque white, its own 256-colour palette per frame,
  `repeat: 0`, and it throws on an empty list rather than writing a file nobody can open (the worker
  answers `empty-recording` first). `rasterize.ts` (NEW) holds the browser half —
  `rasterizeFrame(jpeg, maxLongSide = 1568)` over `createImageBitmap` + `OffscreenCanvas`, returning
  the canvas *and* its context so overlays are drawn before `readPixels`, plus `jpegBlobFromBase64`
  (`atob`, never `fetch` — a `data:` url is not in this document's `connect-src`). RED → GREEN in
  `apps/extension/tests/encode.test.ts` (7 cases), every number read back through `gif-decode.ts`.
  `rasterize.ts` has no unit test by design; T223 covers it on the gate.
- [X] T214 [S2] `apps/extension/src/offscreen/index.html` + `main.ts` (NEW): message loop for
  `recording/add-frame | export | clear | revoke | count` (data-model §"Offscreen protocol"); frames per
  sessionId in memory; `export` runs overlays + encode and answers `{blobUrl, width, height, bytes,
  frames}`; the document imports nothing but its two siblings and gifenc, calls nothing under `chrome.*`
  except `chrome.runtime.onMessage`, and never fetches (FR-121). `apps/extension/vite.config.ts`: add the
  `offscreen` entry for the agent profile only; confirm `dist/agent/offscreen/index.html` exists after
  `npm run build:extension:agent`.
  B: the document lands at **`dist/agent/offscreen.html`**, not `offscreen/index.html`, because that is
  the url `chrome.offscreen.createDocument` is given and Chrome resolves it against the extension root
  — so `write-manifest.ts`'s `placeSidePanelHtml` became `placeEmittedDocument` + `placeDocuments`,
  which moves both documents before the emitted `src` tree is removed and only moves the offscreen one
  for the agent profile. Frames live in a `Map<sessionId, frame[]>`; export drops the session's frames
  the moment the bytes exist (FR-109). The listener answers only messages whose `type` starts
  `recording/` **and** whose `sender.id` is this extension, returns `false` otherwise so it never
  steals another listener's reply channel, and reports a failure as `{error}` rather than hanging.
  Imports are its two siblings and `gifenc`; the only `chrome.*` it touches is `runtime.onMessage`.
  Contract: `tests/contract/agent-tools-008.contract.test.ts` now also pins that `dist/agent` has
  `offscreen.html` + `offscreen.js` and `dist/test` has neither (skipped when unbuilt) — confirmed by
  running both builds.
- [X] T215 [S2] `apps/extension/src/chrome-adapters/offscreen.ts` (NEW): `ensureOpen()` (hasDocument →
  createDocument `{url, reasons:["BLOBS"], justification:"Encode session recordings into GIF files"}`),
  `close()`, `send<T>(message)` typed over `chrome.runtime.sendMessage`; unit test with a fake
  `chrome.offscreen` covering the "already open" and "create races" paths (R-134).
  B: `createOffscreenAdapter(api = chrome.offscreen, runtime = chrome.runtime)` guards the race twice,
  because either guard alone still loses it: concurrent callers share one in-flight creation (cleared
  as it settles, so a later caller reopens a document that has since been closed), and Chrome's "only
  a single offscreen document may be created" is read as success while any other error is re-thrown —
  a recording with nowhere to put its frames must not look fine. Justification reads "Encode this
  session's recorded frames into a GIF file"; reason `BLOBS` only, and explicitly not a keep-alive
  (D-008-2). RED → GREEN in `apps/extension/tests/offscreen-adapter.test.ts` (7 cases) against a
  hand-rolled fake whose `createDocument` is held open on a gate so two callers genuinely overlap.
- [X] T216 [S2] **Measurement (main session, gate, before S3 starts)**: with the built extension loaded
  in attach mode, open the offscreen document, add 3 frames, kill the worker (`chrome://serviceworker-
  internals` stop, or the gate's existing worker-kill helper from `agent-panel-*.spec.ts`), wake it with
  a tool call, ask `recording/count`. Record the answer (document survived / did not) as **our own
  measurement** with the exact steps. If it did not survive: switch T214's frame store to IndexedDB inside the
  document (same protocol) and re-run before S3 — no reference — measure (R-134).
  B: measured 2026-09-19 on launched Chromium: the offscreen document is its own target,
  survives `Target.closeTarget` of the worker, and still answers `recording/count → {sessions:1}` with
  all 3 frames after the worker is woken. No IndexedDB fallback needed; S3 proceeds on R-134 as written.
- [X] T217 [S2] **Review** (`code-reviewer`, fresh context): claim = "the offscreen document is
  runtime-only, receives frames and returns bytes, makes no network request, exposes no page content,
  and is closed when idle; the overlay maths uses canvas ÷ viewport, never DPR." Files: `src/offscreen/*`,
  `chrome-adapters/offscreen.ts`, `vite.config.ts`, `build-config.ts`. Fix findings, then commit
  "Add the offscreen encoder and overlay drawing".
  B: reviewed 2026-09-19; the claim holds (the built `dist/agent/offscreen.js` touches
  `chrome.runtime.id` and `chrome.runtime.onMessage` and nothing else), and six findings were fixed
  here. (1) HIGH — the export built a list of decoded RGBA frames before encoding any of them, which
  is ~200 × 1568² × 4 bytes at the cap; `composeGif(canvas, frames, options)` now takes the canvas
  (`{width, height, frameCount}`, measured by a first pass that decodes, reads the size and closes
  the bitmap) plus a pulled source, and quantizes, writes and `release()`s one frame before asking
  for the next — pinned by a source that counts live frames (`encode.test.ts`). `rasterizeFrame` no
  longer returns pixels nobody read; `readPixels` is called once, after the overlays. (2) MEDIUM —
  `recording/export` **no longer deletes the recording** (this supersedes T214's B note): a failed
  download has to be retryable, so `recording/clear` is the only drop, handed-out blob URLs are held
  in a `Set`, `recording/revoke` removes one and `recording/count` answers `{sessions,
  pendingBlobUrls}` — the worker (T219) closes the document only at `{0, 0}`. (3) LOW — the counter
  read the worker's `frame.index`, so a failed capture would render `6 / 5`; it is the frame's
  position over `length - 1` now, and a one-frame recording gets no counter at all (documented in
  `overlay.ts`). (4) LOW — the listener now also refuses any sender carrying a `tab`, so nothing in a
  page can ask for a session's frames. (5) LOW — on Chrome's "single offscreen document" error the
  adapter checks `chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]})` and rejects with
  the other document's url when the one that exists is not `offscreen.html` (skipped when the API is
  absent, as in a fake); its header now says every future offscreen use must route through it.
  (6) LOW — the message loop moved to `src/offscreen/router.ts`, a chrome-free
  `handleRecordingMessage(message, sender, deps)` over deps that name the browser-only parts
  (measure, rasterize, create/revoke blob url); `main.ts` is the listener and those deps. New
  `apps/extension/tests/offscreen-router.test.ts` (6 cases) covers the prefix filter, the sender
  check, the unknown type, the error reply, the keep-frames/count shape and the counter positions.
  Verified: typecheck, unit+ui 1488 passed / 1 skipped, contract 252 passed (the 4 pre-existing
  `dist/production` ENOENT failures unchanged), `npm run build:extension:agent`.

## Slice S3 — Recorder, frame capture, `gif_recorder`, export (FR-100–FR-102, FR-106–FR-108; US1, US2) — §2.1–2.4, §2.7, §5

- [X] T218 [US1] `apps/extension/src/service-worker/recording/frame-capture.ts` (NEW): `captureFrame(tabId)`
  → acquire the attachment under holder `"recording"` (add the holder to `AttachmentHolder` in
  `agent-tools/input.ts`, no domain enable), `Page.captureScreenshot {format:"jpeg", quality:70}` (a
  command, not an event — R-133); on `input-unavailable` fall back to `photographTab` and mark
  `fallback:true`; on both failing return `{ok:false}`; read `viewportWidth/Height` from the existing
  frame-geometry path (`frames.ts`), never from `devicePixelRatio`. RED first:
  `apps/extension/tests/frame-capture.test.ts` with a fake debugger covering attached / refused / both
  failing. §2.3.
  B: `captureFrame(tabId, deps)` acquires under the new `"recording"` holder and drops it in a
  `finally` on **every** path, including the one the attachment was refused on (`drop` on a tab with
  no record is a no-op), so a refusal leaves no claim behind. The holder enables nothing: both
  commands it sends (`Page.captureScreenshot`, `Page.getLayoutMetrics` through `computer.ts`'s
  `measureViewport`) are answered once to their caller, and `input-attachment.test.ts`'s invariant
  stayed green untouched. The fallback has no attachment to measure the viewport through, so it
  takes the **last viewport measured for that tab** (the recorder keeps it per session) and answers
  `{ok:false, reason:"no-viewport"}` when there is none - a frame at a guessed scale would draw the
  ring somewhere the agent did not click (R-136), which is worse than a skipped frame.
  RED → GREEN in `apps/extension/tests/frame-capture.test.ts` (6 cases).
- [X] T219 [US1] `apps/extension/src/service-worker/recording/recorder.ts` (NEW): per-session
  `RecordingState` in `chrome.storage.session["agentRecordings"]`; `start` (initial frame, no-op with
  `alreadyRecording` when open), `stop`, `clear`, `noteAction(session, tabId, action)` (settle 100 ms →
  capture → `recording/add-frame`; skipped++ on failure; cap 200 → `full`, state `stopped`),
  `export(session, filename?)` (grammar, default name local `yyyyMMdd-HHmmss`, `empty-recording`, ask
  the document, `chrome.downloads.download {url, filename, saveAs:false, conflictAction:"uniquify"}`,
  on `complete|interrupted` → `recording/revoke`, clear state, `recording/count` → close document at
  0). RED first: `apps/extension/tests/recorder.test.ts` — cap at exactly 200 with frame 0 = initial;
  second start is a no-op; export clears; invalid names refused; download failure keeps frames. §2.1,
  §2.4, §2.7, D-008-2/3.
  B: the export sequence follows the S2 review's protocol note, not the line above it: encode →
  `downloads.download` → **the browser says complete** → `recording/revoke` → `recording/clear` →
  `recording/count` → `close()` only when the reply has `sessions === 0` *and* `pendingBlobUrls === 0`
  (`?? 0` until the document fix lands). An `interrupted`/`failed` download revokes the URL only and
  keeps the frames *and* the state, so the agent may ask again. The waiter for a download id is armed
  **before** `download` is awaited: a small file can be written before that promise resolves. The
  record is not deleted on a successful export but zeroed and stamped `lastExport`, because the card's
  last line names the file after the recording itself is gone (FR-108). `chrome.downloads.download`
  needed a new adapter member - see T221's note on the FR-076 invariant. No export timeout: a blob
  URL the document minted always terminates, and the host's per-call backstop covers the rest.
  RED → GREEN in `apps/extension/tests/recorder.test.ts` (15 cases), including a fresh recorder over
  the same fake storage seeing an evicted worker's state.
- [X] T220 [US2] Action label + masking in the worker: `recording/action-label.ts` (NEW):
  `describeAction(tool, args, target) → Action` — `label` `"<tool> <target label or text>"` cut at 40 with
  `…`; `redacted` from 005's field-state predicate (`content-runtime/field-state.ts` — export the
  predicate or its result on the bound target) → label `type "••••"`; `point` for click family / hover /
  form_input / scroll (ref → centre of the resolved box), `from/to` for drag. Unit test table (FR-105,
  FR-106). §2.3 (the reference draws typed text verbatim — we do not).
  B: `describeAction({tool, args, target?, point?, from?, to?})` is pure and returns the action
  *without* its index (the recorder stamps that). 005's predicate is **imported**, not mirrored:
  `isRedactedField` is pure over an element-shaped value, so the worker asks it about the facts the
  last read reported (`type`, `autocomplete`) rather than about a DOM node it does not have. The rule
  is deliberately one-sided and this is the decision the brief did not cover: a read reports `type`
  and the page's own `redacted`, but **no read reports `autocomplete`**, and an agent may type at a
  ref nothing was ever read about - so text is shown only when the facts are in hand *and* say the
  field is ordinary, and an unknown target's text is masked. A `••••` over a search box is a worse
  picture; a spelled-out one-time code is a leak. RED → GREEN in
  `apps/extension/tests/action-label.test.ts` (15 cases).
- [X] T221 [US1] `apps/extension/src/service-worker/agent-runtime.ts`: decorate `dispatchTool` — after a
  non-refusal answer for a tool in the recording set (`isAgentEffectTool` ∪ `navigate`, `screenshot`,
  `file_upload`, `dialog`, `resize_window`) and only when that session records, call
  `recorder.noteAction`; attach `recording: {frames, full}` to the answer; batch steps come through the
  same function (R-132). `agent-tools/recording.ts` (NEW): `gif_recorder` runner wired into the dispatch
  switch. In `releaseSession` (`agent-runtime.ts:630`) call `recorder.exportIfFrames(sessionId)` **before**
  `tabs.endSession` so the download is still attributed (R-137, FR-108). Unit test: dispatch decorator
  counts frames per step of a 3-step batch; auto-export order.
  B: `dispatchTool` is now `recordAfter(request, await runTool(request))`; the old body is `runTool`,
  so a batch's steps pass through the decorator exactly as a single call does. The recording state
  rides back on every answer of a recorded tool while a recording exists at all - which is what puts
  `full: true` on the answers *after* the cap (FR-102) - and `noteAction` runs only while the state
  is `recording` and the answer is `ok`. Two facts the dispatch point cannot know were given seams
  of their own (`recording/action-context.ts`, bounded and dropped with the tab): the **point** an
  effect landed at, published by `effects.ts`'s `deliverPointer` (`onDelivered`, the one place
  `centreOf(rect)` exists), and the **facts about a ref**, published by `read_page` (`onNodesRead`).
  `find`'s own matches are not fed in yet - a follow-up, not a blocker: a label then falls back to
  the tool name and a typed text to `••••`. `form_input`/`scroll` get no ring: their point is never
  measured today and measuring one would be an extra page round trip per action.
  **FR-076 widened, deliberately**: `chrome-adapters/downloads.ts` gained `downloadFile` and its
  `ChromeDownloads` type gained `download`, because FR-107 writes the GIF through the browser's own
  download facility (R-137). `download-observer.test.ts`'s source scan - the test that pins "this
  extension only *observes* downloads" - now allows exactly `onCreated`, `onChanged` and one
  `download` call, and still refuses `open`/`show`/`cancel`/`erase`/`search` and the rest anywhere
  under the worker or the adapters. RED → GREEN in `apps/extension/tests/recording-wiring.test.ts`
  (5 cases, incl. the export running while the session still holds its lease, on both
  `releaseSession` and `releaseSessionTabs`); `packages/agent-host/src/tool-offering.ts` moved
  `gif_recorder` to the implemented list and both host tests were updated with it.
- [X] T222 [US1] Panel: `agent-panel-port.ts` + `side-panel/agent-panel-keys.ts` add `recording-state`;
  `SessionCard.tsx` shows "錄製中 · 12 幀" / "錄製已滿 200 幀" / last export file name; strings in
  `locales/en-US.ts`, `locales/zh-TW.ts` (contract `locales.contract.test.ts` stays green).
  B: **not** a second message. The panel holds one picture and re-renders it, so the recording rides
  on the projection as `sessions[].recording` (`recordingStateSchema` + optional `lastExport`,
  `agent-tools.ts`), published by the `notify()` the decorator already calls after each frame; a
  `recording-state` message beside `worker.agent.state` would have been a second source of truth
  about the same session for one line of text. `SessionCard.tsx` exports `recordingLine`: full wins
  over a count (the owner can act on "waiting for export"), then the count, then the exported file
  name, and a session that never recorded shows no line at all. Three keys in both locales
  (`agent.session.recording`, `…recordingFull`, `…recordingExported`); RED → GREEN in
  `apps/extension/tests/session-card.test.tsx` (one case covering all four states).
- [X] T223 [US1] Gate `tests/e2e/packaged/agent-recording.spec.ts` (NEW): on the form fixture — start,
  12 actions incl. one 3-step batch + 1 screenshot, export `TC-1234` → decode with `gif-decode.ts`:
  14 frames, delays, last 2800, label box present on frames 5 and 12, ring centre within 3 px of the
  scaled click, watermark box bottom-left; `downloads_context` lists `TC-1234.gif` complete; worker-kill
  after frame 6 → 11 frames (uses T216's finding); 205 actions → 200 frames, answers 201–205
  `recording.full === true`; invalid filename refused. Run attached; commit "Record a session as a GIF".
  B: written and collected (4 tests: the 14-frame journey with the overlay samples and
  `downloads_context`, the worker-kill, the 200-frame cap, and one `test.skip` for `download-failed`
  — "awaits offscreen fix (S2 review #2)"; causing the browser to refuse a blob URL it minted itself
  has no honest route from this gate). **Not executed.** It is attach-mode only like every sibling
  `agent-*` journey - the launched fixture loads `dist/test`, which carries no agent profile and no
  `gif_recorder` - and this machine had no browser on a CDP endpoint; the launched run also cannot
  start its own web server here (`.test-pki/leaf.pfx` missing, `npm run test:certs:install` is an
  owner-only elevated step). So the gate's measured numbers - frame count off the file, byte size,
  export duration, per-action overhead - are **still owed** and the spec prints them (`[T223] …`) on
  its first attached run. The journey's frame arithmetic is stated in the spec: 1 initial + 10 single
  recorded calls + 3 batch steps = 14.
  B2 (main session, 2026-09-19 03:50, attach mode on Playwright Chromium 151 via the private-LOCALAPPDATA recipe):
  3 passed / 1 skipped after three test-authoring fixes (batch steps carry no tabId; the batch answer is
  `results`; the grammar refusal text is capitalised) and one worker fix (`gif_recorder` calls now `notify()`
  the panel). Measured: 14 frames, 1,049,659 bytes, export 1,652 ms, per recorded action 650 ms mean
  (217–695 ms; one 1,878 ms outlier on the navigate step), canvas 752×754. Owner's branded Chrome 152 run
  still owed for the 004 standard.

## Slice S4 — Dialogs (FR-110–FR-117; US3) — §3.1, §3.2, §5

- [X] T224 [US3] `apps/extension/src/service-worker/agent-tools/input.ts`: issue `Page.enable` on every
  attachment beside `DOM` (second stated exception — extend the header comment with the three counts,
  D-008-5). `agent-runtime.ts` `onEvent` fan-out: forward **only** `Page.javascriptDialogOpening` and
  `Page.javascriptDialogClosed` to `dialogs.ts`; drop every other `Page.*` event at the switch (R-138).
  RED first: extend `apps/extension/tests/input-attachment.test.ts` — `Page.enable` issued; a fake
  `Page.frameNavigated` reaches no consumer; a fake `javascriptDialogOpening` reaches only `dialogs`.
  B: `Page.enable` goes out on every `acquire`, beside `Target.setAutoAttach`, and the module header
  states it as the **third** exception with the three counts (the OOPIF nonce was the second). The
  fan-out lives in `dialogs.ts`'s own `onDebuggerEvent` switch and `agent-runtime.ts` wires it in one
  line, so "exactly two events are consumed" is a testable property of one function rather than a
  promise spread over the runtime. One change this forced: `input.ts`'s `onEvent`/`onDetach` now
  *remember* their listeners and register one fan-out when the adapter is first needed - subscribing
  at composition reached for `chrome.debugger` and made the whole runtime unbuildable where the
  permission is absent (16 runtime tests went red on it). `input-attachment.test.ts` +1 test (11).
- [X] T225 [US3] `apps/extension/src/service-worker/agent-tools/dialogs.ts` (NEW): current-dialog map
  (data-model), `chainedTo` from `LastApprovedEffect` (≤ 1000 ms, same tab), `beforeunload` policy
  (default stay → immediate `Page.handleJavaScriptDialog {accept:false}`, outcome recorded; `leave`
  only during a gated `force` call), `dialog` runner: dismiss/alert ungated; accept on confirm/prompt →
  chained ? notice : `decideGate` like a click (refuse → dismiss + `refused`); `promptText`; after any
  handle → bounded `Runtime.evaluate("1")` within 300 ms else `page-unresponsive` (R-140); `no-dialog`.
  RED first: `apps/extension/tests/dialogs.test.ts` — boundary 999 → notice, 1001 → card, other tab →
  card; alert never gated; policy reset after force; liveness timeout. §3.1, §3.2.
  B: `dialogs.test.ts`, 13 cases. `requiresGate` gained `dialog`, `navigate` and `tabs_close` -
  `decideGate` refuses anything it does not govern, so the tool could not be gated "like a click"
  without being in that list; only a `force` call reaches the gate for the two tab tools. The site a
  dialog is decided under comes from the browser's record of the tab (`siteOfTab`), never from a page
  binding: a tab with a dialog open answers no content message at all. Liveness treats an *error* as
  an answer - only silence is unresponsiveness - and is not run on the refuse path, so the owner's no
  keeps its word. `LastApprovedEffect` lives here (write-only seam `noteApprovedEffect`, called by
  `effects.ts`), as the data model has it: read by the chaining rule alone.
- [X] T226 [US3] Wire the block and the cause: `agent-runtime.ts` `dispatchTool` checks the current
  dialog **before** routing and answers `blocked-by-dialog {dialog}` for every tool except `dialog`,
  `tabs_context`, `downloads_context`, `wait` (FR-111); `agent-tools/effects.ts` records
  `LastApprovedEffect {tool, approvedAt}` on gate `admit` or owner allow and attaches `dialog` to the
  answer when one opened during `verifyDelivered`; `batch.ts` stops at that step; `wait.ts` ends
  `condition-unmet {dialog}`; `tabs.ts` `navigate`/`tabs_close` gain `force` (gated) and answer
  `blocked-by-beforeunload {url}` after ≤ 300 ms when stayed (§3.1: event-driven wait — dismiss resolves
  immediately, accept on top-frame navigation). Unit tests for each path.
  B: `blocked-by-dialog` answers with outcome **`busy`** - the contract's outcome list has no
  "blocked", and `busy` is its existing word for a tab that is occupied now and will not be in a
  moment; `blocked-by-beforeunload` answers `failed`. Two measured findings forced more than the
  brief foresaw: (1) `Input.dispatchMouseEvent` does not return while a handler's `alert` is up, so
  the *delivery* is raced against the dialog too, not only `verifyDelivered`; (2) a verification on a
  modal page never returns at all, so both verify paths race it. When the dialog wins, the answer is
  `ok` with `observed.verdict = "target-unconfirmed"`, `verified: false` and the dialog attached -
  the delivery is a fact, the verification is not, and `failed` would send an agent to repeat a click
  that already landed. Unit tests: `agent-effects` +1, `agent-batch` +1, `agent-wait` +1,
  `agent-navigation` +3 (stay, forced-and-allowed, forced-and-refused).
- [X] T227 [US3] Panel: `agent-panel-port.ts`/`agent-panel-keys.ts` add `activity` and `notice`; consent
  prompt gains `kind: "dialog-accept" | "beforeunload-force"` + `dialogText`; `SessionCard.tsx` activity
  list (last 20, newest first: "{site} 說:{message}" + outcome); `PromptCard.tsx` dialog wording
  ("{agent} 想按下網頁確認框的「確定」" + quoted text; force: "放棄未儲存的變更並前往 {site}") and a
  non-blocking `NoticeCard` ("網頁跳出確認框 · 已按 確定 · 承接你剛允許的 {action}") per the owner's
  mockup (artifact HG9bPNBneSbeqsuTWJ6aRN); strings en-US/zh-TW; a11y roles as 006.
  B: the projection carries the *pieces* - `{at, kind, outcome, site?, message?}` and
  `{at, kind, dialogText, action}` - and the panel writes every sentence from its own tables, so no
  worker English reaches the owner; `ACTIVITY_OUTCOME_KEYS` is keyed off the contract's closed
  outcome set the way `TOOL_SUMMARY_KEYS` is off the tool list. `NoticeCard` is `role="status"`,
  takes no focus, dismisses locally and auto-hides after 8 s; it renders *below* `PromptCard`, so a
  real question is never displaced by a notice. The force card reads "Discard unsaved changes on
  {site} and leave" / 「放棄 {site} 上未儲存的變更並離開」 rather than the brief's "…並前往 {site}":
  the prompt carries one site and it is the page being left, so naming the destination there would
  have been the one word on the card that is not true. 20 keys per locale; `prompt-card` +3,
  `session-card` +1.
- [X] T228 [P] [US3] `tests/harness/page-fixtures.ts`: add `/dialogs` page — buttons for alert, confirm,
  prompt (default value), "chained" (confirm 300 ms after click), "timer" (confirm 3 s after load, no
  click), and a form that arms `beforeunload` once edited; each records the outcome into a visible `<p
  id="result">`.
  B: the timer confirm is armed by its own `#timer` button or by loading `/dialogs?timer=1`, never by
  simply being on the page - armed on load unconditionally it fired in the middle of every other
  scenario. `beforeunload` arms only after a real edit, because a browser ignores it on a page nobody
  has interacted with, so the gate types into the field rather than scripting it.
- [X] T229 [US3] Gate `tests/e2e/packaged/agent-dialogs.spec.ts` (NEW): every US3 scenario 1–11 on the
  fixture in `ask`, `follow-a-plan`, `skip-checks`; `click` during an open dialog answers
  `blocked-by-dialog` < 500 ms; chained → notice, unchained → card (panel checked through its CDP
  session as in 006); owner closes by hand → `no-dialog`. Run attached.
  B: 3 tests, **3 passed** attached (Chromium 151, private LOCALAPPDATA). Measured: `blocked-by-dialog`
  in **6 ms**; the chained confirm observed **483 ms** after the click (the fixture opens it at 300 ms;
  the rest is the poll that detects it); `blocked-by-beforeunload` in **77 ms** (91 ms on an earlier
  run) against FR-115's 300 ms budget. Two harness findings, both written into the spec's comments:
  Playwright dismisses every dialog by itself unless the page has a `dialog` listener, so the journey
  registers a no-op one - without it the runner answered every confirm before the worker heard it; and
  a dialog left open wedges the whole browser (the next `connectOverCDP` hangs), so every test tidies
  up in `finally`. Left for T237's probe: `follow-a-plan` mode (the other two are covered), and
  `no-dialog` after the *owner* closes a dialog by hand, which no scripted runner can produce without
  answering the dialog itself. `agent-recording.spec.ts` and `agent-tabs.spec.ts` re-run green.
- [X] T230 [US3] **Review** (`code-reviewer`, fresh context): claim = "dialog text reaches the agent
  only from the two dialog events; no other Page event is consumed or exposed; accept is gated exactly
  as a click except the chained exemption, whose boundary is pinned; dismiss/alert never ask;
  beforeunload defaults to stay; force is gated." Files: `input.ts`, `agent-runtime.ts` (event filter,
  dispatch block), `dialogs.ts`, `effects.ts`, `tabs.ts`, `input-attachment.test.ts`, `dialogs.test.ts`.
  Fix findings; commit "Hear and answer the page's dialogs".
  B: 8 findings applied, each RED first. **H1** (FR-115's last sentence was violated): every
  `beforeunload` was answered by policy, whoever raised it - so the owner pressing a link on a held
  tab had their own browser's question answered by the extension. Now answered only while a
  `navigate` / `tabs_close` has a waiter armed for that tab; gate case added (`#leave` button on the
  `/dialogs` fixture, pressed through Playwright, not through a tool) and proven red→green on the
  attach gate. **M1**: dialog state is forgotten at a session's end, at `releaseSessionTabs`, and on
  `attachments.onDetach` - a leak that met the *next* session as an unanswerable dialog.
  **M2**: `Page.handleJavaScriptDialog` rejections ("No dialog is showing") answer `no-dialog`
  instead of throwing. **M3**: `dialog-wiring.test.ts` (NEW) drives a composed runtime over a fake
  `chrome.debugger` - the fan-out's subscriber count (2: 003's diagnostics, 008's dialogs, no third)
  and the dropped page events are asserted where they are actually wired, not where a test wired
  them; `listenerCount()` added to `input.ts` for it. **L1**: a chained accept consumes the approval
  (one approval, one dialog) and `computer` screenshot/wait write no approval record. **L2**:
  `follow-a-plan` admits an accept on the plan's site without spending a step. **L3**: the
  pass-through set gains `tabs_release`, `tabs_create`, `gif_recorder`. **L4**: the card's activity
  key includes the index. Verified: typecheck clean, unit 1541 + 1 skipped, contract 252 (the 4
  pre-existing `dist/production` ENOENT failures unchanged), gate `agent-dialogs` 4/4 and
  `agent-tabs` 1/1 attached. Placement note: M3's runtime-composed variant lives in the new
  `dialog-wiring.test.ts` rather than in `input-attachment.test.ts`, which has no runtime fixture.

## Slice S5 — Window restore (FR-118–FR-120; US4) — no reference — measure (§4)

- [X] T231 [US4] `apps/extension/src/chrome-adapters/windows.ts`: `resizeWindow` returns `{size,
  priorState}`; `apps/extension/src/service-worker/window-restore.ts` (NEW): pure
  `decideRestore(record, window | undefined, othersForWindow) → "restore" | "drop" | "leave-to-other"`
  (FR-119 order: gone → drop; state already prior → drop; others → leave; size ≠ setSize → drop; else
  restore) + `chrome.storage.session["agentWindowRestores"]` list helpers. RED first:
  `apps/extension/tests/window-restore.test.ts` — the four edge cases + happy path + FR-120 first-seen.
  B: `resizeWindow` answers `{size, priorState}` - the state read *before* any update, which is the
  only moment it can be read honestly - and the result the tool reports is `size`, so the answer's
  strict schema is untouched. Two adapter members came with it: `getWindowFacts` (a window Chrome no
  longer has is `undefined`, not a throw) and `setWindowState`. `decideRestore` is the spec's order
  exactly, plus one case the spec does not name: a window Chrome reports *without* bounds is dropped
  rather than restored - the promise is "we only undo what we can still see we did".
  `createWindowRestoreStore(area)` over `agentWindowRestores` (list) with
  `remember`/`forSession`/`othersForWindow`/`forget`; `sessionWindowRestoreStore()` is the real one
  and re-reads `chrome.storage.session` on every call, as the recorder's store does, because the
  worker that resized is usually not the worker that restores. RED → GREEN in
  `apps/extension/tests/window-restore.test.ts` (11 cases) plus 4 updated in
  `chrome-adapters-windows.test.ts`.
- [X] T232 [US4] `agent-tools/tabs.ts` `resize_window`: write/update the record when `priorState !==
  "normal"`; `agent-runtime.ts`: on `onTabLeft` (last tab of that session in that window) and in
  `releaseSession` (after auto-export) run the restore for the session's records; panel activity item
  "window restored to {state}". Unit test the two hooks with a fake tab manager.
  B: one decision, two hooks, in `createWindowRestorer` (same file): `onTabLeft(sessionId)` restores
  every record whose window the session no longer holds a tab in - asked of the *leases* plus a tab
  snapshot each, since a lease carries no `windowId` and `context()` drops the tab before the hook
  could ask about it - and `restoreFor(sessionId)` in `releaseSession`, after the recording export
  and before `endSession`, awaited so the records are gone before `endSession`'s own `onTabLeft`
  fan-out asks about a session that no longer exists. **One deliberate divergence from the brief**:
  the record is forgotten on `leave-to-other` too. Kept, it would count itself in the other
  session's "does anybody else still hold this", both would wait for each other and the window would
  never go back to anyone - dropping it is what makes US4 scenario 5 ("the last one to let go
  restores it") true. `tabs.ts` gained one optional write-only dep (`windowRestores.remember`) and
  six lines in the `resize_window` branch. The panel needed a change the brief did not foresee:
  `SessionCard.tsx` rendered *every* activity item with the dialog template, so a restore read
  " says: maximized"; `activityText(item, t)` now picks a template per kind and the worker sends the
  state word only (`WINDOW_STATE_KEYS`, 3 keys per locale). RED → GREEN in
  `apps/extension/tests/window-restore-wiring.test.ts` (8 cases over the composed runtime, a fake
  `chrome.windows` that reproduces "bounds land only on a normal window") + 1 in `session-card`.
- [X] T233 [US4] Gate `tests/e2e/packaged/agent-window-restore.spec.ts` (NEW): maximize → `resize_window
  1024×768` → answer is the real size → release → `chrome.windows.get` state `maximized`; owner
  re-maximised before release → no `windows.update` call (spy through the gate's CDP session); worker
  kill between resize and release → still restored. Run attached; commit "Give the window back the way
  it was".
  B: 3 tests, **3 passed** attached (Chromium 151, private LOCALAPPDATA), first run. Measured:
  restored **54 ms** after `tabs_release`, and **45 ms** after a release that followed a
  `Target.closeTarget` of the worker - the record came back out of `chrome.storage.session` exactly
  as the recording's does. The owner's hand is played through `chrome.windows.update` from the
  worker rather than CDP's `Browser.setWindowBounds`: the window under test is the one the runner is
  attached to, and the browser API names it by the id the journey already holds. "No
  `windows.update` was needed" is asserted as "the card shows no restore line", since the line is
  written only where the update is made. `agent-tabs.spec.ts` re-run green.

## Slice S6 — Package 0.2.0, upgrade proof, guides, probes (FR-122, FR-123; US5) — §1

- [X] T234 [US5] `tests/e2e/packaged/agent-upgrade.spec.ts` (NEW): unzip `release/hallpass-
  0.1.0.zip` (kept from 007; if absent, build it from tag/commit `b452d25` into a temp dir) into a scratch
  profile, load, pair, set two site modes; run the 0.2.0 `install.ps1` over it; assert pairing record +
  modes + diagnostics grants unchanged in `chrome.storage.local` and `gif_recorder` in the first tool
  list (R-143, SC-061).
  B: split in two, because neither half fits the gate. (a) **extension side, DONE**:
  `tests/acceptance/upgrade-proof.mjs` (NEW) — not a spec in `tests/e2e/packaged/`, since every spec
  there is attach-only and this proof needs a browser that *starts* on the old bundle. Per old zip it
  launches its own headless Chromium on a fresh profile with `--load-extension=<scratch>`, writes
  `agentPairings` + two `agentSiteModes` (`https://httpbin.org` skip-checks + diagnostics,
  `https://www.wikipedia.org` follow-a-plan) through the worker, replaces the scratch folder with the
  0.2.0 `extension/` and reloads **in place** with `Extensions.loadUnpacked` (the id comes back
  unchanged, so storage is the same store). Asserted after the reload: both records byte-for-byte
  (key order compared stably — `chrome.storage` hands objects back in its own order), manifest
  `0.2.0`, `offscreen` in `permissions`, `offscreen.html` served, and the running `service-worker.js`
  naming `gif_recorder` and `dialog` — the honest stand-in for "the tool table knows it", since a
  worker `evaluate` cannot import the contract's list. **1/1 for both zips QA may hold**:
  `[T234] hallpass-0.1.1.zip → 0.2.0: pairing kept, modes kept, manifest 0.2.0` and the same
  for `0.1.0.zip`. (b) **host side, WRITTEN, NOT RUN**:
  `tests/acceptance/upgrade-host-proof.ps1` (NEW) installs 0.1.1 then 0.2.0 from the two zips under a
  scratch `LOCALAPPDATA`, with the two HKCU `NativeMessagingHosts` values captured up front and
  written back in a `finally`; it asserts exit 0 twice, the launcher pointing at the new
  `host\native-host.js`, `.bak` holding the 0.1.x one, and a `config.json` the tester edited between
  the installs surviving the second. It could not be executed from this session: the worktree guard
  refuses to run `powershell` from the shell at all ("this command runs powershell in a plain
  command … Refusing to run it"), for every form tried. One command in a PowerShell session closes
  it: `powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\acceptance\upgrade-host-proof.ps1
  -OldZip "<main checkout>\release\hallpass-0.1.1.zip"`.
  B2 (main session, 2026-09-19 05:05): (b) run from a PowerShell session after one fix (compare against long
  paths; %TEMP% is the 8.3 form): `[T234] host upgrade: manifest -> ...\hallpass-upgrade
ew\host
ative-host.js,
  config.json preserved: True, registry restored: True`, exit 0; both HKCU values re-read as the owner's
  dev registration afterwards. T234 is therefore fully proven: (a) both zips 1/1, (b) 0.1.1 → 0.2.0 host.
- [X] T235 [US5] `npm run package` → `release/hallpass-0.2.0.zip`; `tests/contract/qa-package.
  contract.test.ts` expects the new name and `offscreen/index.html` inside the extension folder;
  `README.md` template in `scripts/package.ts` mentions the new permission prompt on upgrade.
  B: `release/hallpass-0.2.0.zip`, **702 473 bytes**, root entries unchanged from 007. Two
  corrections to the brief: the off-screen document is built flat as `extension/offscreen.html` +
  `extension/offscreen.js`, not `offscreen/index.html`; and the README is a copied asset
  (`scripts/package/README.md`), not a template inside `scripts/package.ts`. RED first — the new
  assertions run against a 0.1.1 zip renamed to the 0.2.0 name and fail on both the missing
  `offscreen.html` and `VERSION` 0.1.1 — then green on the real build. The zip under test is named
  from `AGENT_EXTENSION_VERSION` rather than picked off `release/`, which is a working folder that may
  still hold QA's older zips; version is read back from three places that must agree (zip name,
  `VERSION`, packed manifest), which is FR-122's "one literal" as a test. `readZipEntry` added beside
  `listZip` in `scripts/package.ts` so the test reads a zip member through the same `tar.exe`.
  README gained §2.1 (upgrade: replace the folder, re-run `install.ps1`, reload, Chrome asks once
  about `offscreen`, pairing + site modes + `config.json` kept, the two new tools) and §9
  第三方元件 for `gifenc` (MIT) — the list T210 said did not exist yet.
- [X] T236 [P] [US5] `docs/qa-guide.html`: sections "錄製 GIF" (how to ask, where the file lands, what
  each overlay means, the 200-frame limit and `recording.full`, file naming) and "對話框" (what the
  tester sees in each mode, what 拒絕 does, the "leave site?" default and `force`), each with a screenshot
  taken from the real panel via its CDP session (006 gotcha); `docs/operations-guide.md`: 31 tools, the
  `offscreen` permission and its limits, the process rule. Republish the QA guide artifact
  (`46f324ff…`, see memory) with the same URL.
  B: both guide sections written (`#record`, `#dialogs`, in the TOC), plus the 0.1.x → 0.2.0 upgrade
  callout that says what `scripts/package/README.md` §2.1 says, and the lede at 0.2.0. The two pictures
  are real-panel PNGs embedded as data URIs like the 006 ones: `recording-card.png` **39 323 B** (the
  card's 「已匯出 TC-1234.gif」 line over the activity list) and `dialog-card.png` **47 727 B** (the
  `ask`-mode consent card quoting the page). They are taken by
  `tests/e2e/packaged/agent-guide-shots.spec.ts` (NEW, skipped unless `HALLPASS_PANEL_SHOTS=1`, 006/T199's
  shape), which writes them to `specs/008-recording-and-dialogs/screenshots/`. Two things the brief
  could not foresee: the panel takes its language from the **browser** and this gate's browser is
  en-US, so the journey replaces `chrome.i18n.getUILanguage` in the panel document before the shell
  mounts and drives the panel in zh-TW (the guide's language); and Playwright renames every download
  of a browser it attached to, so the run first gives the browser its own download behaviour back -
  without it the card would have shown a GUID instead of `TC-1234.gif`. `docs/operations-guide.md`
  gained §9 (the two tools, the `offscreen` permission and its limits, the export lifecycle), §10
  (the two new gate specs, probes S9/S10, the private-`LOCALAPPDATA` recipe) and §11 (the two-attempts
  rule), and its header now reads 0.2.0 / 31 tools. **Not done**: republishing the QA artifact
  (`46f324ff…`) - this session has no docs tool; the file is ready to publish as it stands.
- [X] T237 [US5] Probe scenarios `tests/acceptance/probe-004/scenarios/s9-recording.json` (record the
  form flow, export a named file, answer the file name as `downloads_context` reports it),
  `s10-dialogs.json` (the fixture's chained + unchained confirm in `ask` mode, answer both outcomes),
  `s11-window-restore.json`; run each with `claude -p --model sonnet` on the owner's Chrome; SC-054 needs
  3/3. **Measurement**: in s10 also open `https://www.w3schools.com/js/tryit.asp?filename=tryjs_confirm`
  (or another public page whose confirm follows a click) and record click→dialog latency; if real pages
  exceed 1000 ms, write the numbers directly and raise the chained window in `dialogs.ts` with
  the owner's nod — no reference — measure (R-139).
  B (main session, 2026-09-19 06:15): s9-recording and s10-dialogs written and run with `claude -p --model sonnet`
  on the attach-mode Chromium (private LOCALAPPDATA; harness gained S9/S10, the worktree host path and the
  foreign-server allowance in 4b1b3fb). S10 done 1/1 first run. S9 needed two product fixes the probe found
  (screenshot reply carried no text block; export named the requested file, not the uniquified one — 2cc72f6)
  and two prompt clarifications, then done 1/1 with the .gif on disk. s11 (window restore) was not written: an
  agent cannot observe the window state, so the gate (T233, 3/3, 54 ms) is the proof. One open observation
  (type answered focus-lost twice on httpbin while recording; the gate cannot reproduce it) is recorded in
  measured 2026-09-19 with the next measurement named. Chained-window measurement: the fixture's 300 ms confirm was
  detected 447–483 ms after the click (T229), well inside 1000 ms; no public-page measurement taken — noted.
- [X] T238 [US5] `specs/008-recording-and-dialogs/coverage.md` (NEW, 005 shape): FR → test/gate/probe
  map with run timestamps; mark spec Status complete; update `docs/design-notes.md`
  with any divergence discovered; final `npx tsc -b && npx vitest run && npm run test:e2e:agent`
  green; commit "Finish feature 008 and package 0.2.0".
  B: `coverage.md` written (FR-100…FR-123 → unit/contract, gate scenario, probe, SC), with every
  measured number and an explicit "what is still owed": the whole feature is proven on **Chromium 151
  in attach mode only** - the 004 standard's branded Chrome 152 run is a re-run the owner still has to
  make - plus one unreproduced `focus-lost` observation and one honest divergence (FR-113
  says exports join the activity list; the panel puts the file name on the card's *recording* line and
  `kind: "export"` is never written). Spec Status → "Complete 2026-09-19 on Chromium 151 (attach
  mode); owner's Chrome 152 run owed", with Change Log rows for 2cc72f6 and for this closing. Evidence
  §5 needed no change: nothing diverged from the reference reading; the divergences found are ours
  and are in `coverage.md`.
  The skipped gate case became a real one: `Browser.setDownloadBehavior {behavior:"deny"}` makes the
  browser refuse the file, so "keeps the frames when the browser refuses the file" now runs - the
  answer is `download-failed`, the four frames survive, and the retry writes them. The same lever
  fixed a red the probe fix of 2cc72f6 had left behind: the recorder now reports the name the *browser*
  saved, and Playwright renames every download of an attached browser to a GUID, so `agent-recording`
  had been asserting a name the harness itself had taken away. `pairedSession` now gives the browser
  its own download behaviour back, and the two name assertions tolerate `uniquify` (`TC-1234 (1).gif`),
  which is the behaviour FR-107 promises.
  Final verification, all from this worktree (2026-09-19 07:40-07:55): `npm run typecheck` clean ·
  `npm test` **1542 passed / 1 skipped** (143 files) · `npm run test:contract` **255 passed / 4 failed**
  (only the pre-existing `dist/production` ENOENT four) · `npm run build:extension:agent` clean ·
  gate `agent-recording` + `agent-dialogs` + `agent-window-restore` + `agent-tabs` + `agent-downloads`
  **14 passed / 0 failed** in 5.8 min (5/4/3/1/1). Re-measured on that run: 14 frames 1 043 488 bytes,
  export 1 776 ms, 632 ms mean per recorded action; `blocked-by-dialog` 7 ms; chained confirm 451 ms;
  `blocked-by-beforeunload` 114 ms; window restored 64 ms, 52 ms after a worker kill.
  B2 (main session, 2026-09-19 09:05): owner decided 1 merge / 2 branded run / 3 QA after 2 / 4 accept FR-113 /
  5 keep attribution. Branded Chrome (153.0.8010.50 at run time) run done by the main session: gate 13/13 after
  the export-bound fix (2481860; 200-frame export 31.5 s), probes S9 + S10 done 1/1. Merge and the QA hand-off
  are the owner's.

## Dependencies

S1 → S2 → (T216 measurement) → S3; S1 → S4; S1 → S5; S3 + S4 + S5 → S6. T211, T228, T236 are
parallel-safe with their slice neighbours (different files). One writer at a time: default order is
T207 → T238.

## Independent test per story

- US1 record/export: T223 (decode 14 frames, cap, worker-kill, naming).
- US2 overlays: T212/T213 unit decode + T223 sampled frames.
- US3 dialogs: T229 on the fixture across the three modes + T225 boundary tests.
- US4 restore: T233 + T231 edge cases.
- US5 upgrade/package: T234 + T235.

## MVP

S1 + S2 + S3 (US1/US2): a tester gets a labelled GIF of a run. S4 is the second increment QA will
notice; S5 and S6 close the feature.
