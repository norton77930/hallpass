# Research and design decisions — feature 008

Decisions R-132–R-143. Each names the source it rests on (`docs/design-notes.md`) or the measurement
that must replace a guess. Our own integration points were mapped
read-only on 2026-09-19 (paths below are the current tree).

## R-132 — Where a frame is taken: one dispatch point, not per tool

**Decision**: decorate `dispatchTool` in `apps/extension/src/service-worker/agent-runtime.ts` (the single
runner every tool call *and every batch step* already passes through — its own comment says the per-step
gate of FR-047 is "a fact about the wiring") with a post-step: if the tool is in the recording set
(`isAgentEffectTool` from `packages/contracts/src/agent-tools.ts` plus `navigate`, `screenshot`,
`file_upload`, `dialog`, `resize_window`) and the answer is not a refusal, wait ≈ 100 ms, capture, hand
the frame to the recorder.
**Rationale**: the reference hooks its two tool families by name (design-notes §2); we have one choke point
already proven by the gate tests, so FR-101 becomes a wiring fact too.
**Alternatives**: per-tool hooks (twelve places, easy to miss `dialog`/`resize_window`); a batch-only hook
(misses single calls). Rejected.

## R-133 — Frame source: CDP screenshot on the held tab's attachment, JPEG, bounded

**Decision**: a frame is `Page.captureScreenshot {format:"jpeg", quality:70}` issued on the tab's
existing debugger attachment (acquired under a new holder `"recording"` in `agent-tools/input.ts`), with
no `Page.enable` needed for a command. If the attachment cannot be made (developer tools open,
restricted page) fall back to `photographTab` (`captureVisibleTab`, PNG) and let the offscreen page
re-encode to JPEG; if both fail, skip and count (FR-101). Frames larger than 1568 px on the long side
are downscaled in the offscreen page before storage.
**Rationale**: our `captureVisibleTab` path (`chrome-adapters/capture.ts`) is full-resolution PNG (a
1080p frame is 1–3 MB; 200 of them would be 200–600 MB) and it **activates the tab** to shoot it, which
would make the owner's window flicker on every recorded action. The reference shoots through CDP,
JPEG at 75 % with a ~1 MB per-frame byte cap and a 1568 px downscale (design-notes §2) — the same budget
we adopt. A CDP *command* returns the same content a screenshot does and is not an event; the 004
invariant concerns event-bearing domains (see R-138).
**Alternatives**: always `captureVisibleTab` (flicker, PNG size); `captureVisibleTab {format:"jpeg"}`
(still activates the tab). Rejected.
**Measure, do not guess**: the 100 ms settle and the 70 quality are starting values from design-notes §2; the gate's decoded frame sizes decide whether to move them.

## R-134 — Where frames live: the offscreen document, opened per recording

**Decision**: a single offscreen document `apps/extension/src/offscreen/index.html` (new Vite entry in
`vite.config.ts` `rollupOptions.input`, agent profile only) receives each frame by `chrome.runtime`
message as it is captured, keeps `Map<sessionId, Recording>` in memory, draws overlays and encodes on
export, and answers with a blob URL. The worker keeps only `{state, frames, skipped, full}` per session
in `chrome.storage.session` (`agentRecordings`). The document is created at the first `start`
(`reasons: ["BLOBS"]`) and closed when the last recording is exported or cleared.
**Rationale**: the reference keeps frames in worker memory and loses them on eviction, compensating with
a keep-alive ping (design-notes §2); D-008-2 forbids that trade. Chrome's rule that an extension has **one**
offscreen document at a time (Chrome docs, read 2026-09-19) means the document is shared across
sessions and must be keyed by session. Offscreen documents can use **only `chrome.runtime`**, so the
worker, not the document, calls `chrome.downloads.download` with the document's blob URL — exactly the
reference's split (design-notes §2).
**Alternatives**: `chrome.storage.session` for frames (10 MB quota, too small); IndexedDB from the
worker (works, but overlay drawing still needs a canvas → the document is needed anyway); encode on the
MCP host (frames over native messaging in 1 MB slices, file lands outside the download folder —
contradicts D-008-3). Rejected.
**Uncertainty (IV)**: whether an offscreen document survives worker eviction is not stated in the docs;
the reference relies on the worker instead. Slice S2 measures it (kill the worker mid-recording, export)
before S3 builds on it; if the document is torn down with the worker, frames fall back to IndexedDB in
the document with the same message contract, and the finding goes into the evidence file.

## R-135 — Encoder and decoder

**Decision**: production encoder `gifenc` 1.0.3 (MIT, zero dependencies, synchronous quantize +
encode, no worker script) bundled into the offscreen entry only; test-kit decoder `omggif` 1.0.10 (MIT,
zero dependencies) as a devDependency for the gate's frame checks. Neither is imported by the worker,
the side panel or the host.
**Rationale**: Constitution X allows a dependency the task clearly requires; a GIF encoder is one, and
writing LZW + median-cut ourselves is the "simpler alternative" that is not simpler. The reference bundles
gif.js with a worker script (design-notes §2); a worker adds a second script file and a `WORKERS` reason
for no gain at ≤ 200 frames.
**Alternatives**: gif.js (worker-based), modern-gif (pulls a palette package), vendoring source by hand
(no provenance). Rejected.

## R-136 — Overlays are drawn in the offscreen page from frame metadata, scaled by canvas ÷ viewport

**Decision**: every frame carries `{viewportWidth, viewportHeight}` at capture and the action
`{index, tool, label, redacted, point?, from?, to?}` in page CSS pixels; the drawing code computes
`scale = canvas.width / viewportWidth` and never reads `devicePixelRatio`. Geometry and colours follow
FR-105 and the owner's approved column C; the label is cut at 40 characters *before* it leaves the worker
(the offscreen page never sees the full text), and a redacted action arrives with `label: 'type "••••"'`
already masked.
**Rationale**: design-notes §2 records the reference's explicit comment that CDP screenshots are resized so
DPR is the wrong factor — this is the exact class of coordinate bug that cost three briefs in 004.
Masking in the worker keeps the rule in one place (005's `field-state` predicate, FR-106) and keeps
secrets out of a second process.

## R-137 — Export, attribution and naming

**Decision**: the worker validates the filename (FR-100 grammar), asks the document to encode, then
calls `chrome.downloads.download({url: blobUrl, filename, saveAs:false, conflictAction:"uniquify"})`.
The download is attributed like any other by `download-observer.ts` (holders at `onCreated` time), so it
appears in `downloads_context`; on `complete|interrupted` the worker tells the document to revoke the URL
and clears the recording. Default name `agent-recording-<yyyyMMdd-HHmmss>.gif` (local time).
**Rationale**: design-notes §2; 005's observer needs no special case as long as the exporting session
still holds a tab when `onCreated` fires — for the auto-export at session end (FR-108) the export runs
**before** `tabs.endSession` inside `releaseSession`, so the holder is still present.
**Alternative**: returning bytes to the agent (token cost, no file for QA). Rejected (owner Q4).

## R-138 — Hearing dialogs: `Page` domain as the second stated exception

**Decision**: the attachment module enables `Page` on every attachment (like `DOM` today) and
`agent-runtime.ts`'s `onEvent` fan-out forwards **only** `Page.javascriptDialogOpening` and
`Page.javascriptDialogClosed` to a new `dialogs.ts`; every other `Page.*` event is dropped at that
switch. `input-attachment.test.ts` is extended to assert (a) `Page.enable` is issued, (b) no `Page.*`
event other than the two dialog events reaches any consumer, (c) no tool answer contains anything from
a `Page.*` event but the dialog object. The dialog's `message` and `defaultPrompt` are exposed without
the diagnostics grant (D-008-5).
**Rationale**: the reference enables `Page` unconditionally (design-notes §3). The three counts of the
DOM exception hold: not a diagnostics domain; only two named events are consumed, and the test pins the
drop of the rest; what those events carry is on-screen content.
**Alternative**: enable `Page` only for the `"diagnostics"` holder (owner declined, D-008-5).

## R-139 — Dialog state, blocking, and the chained-accept rule

**Decision**: `dialogs.ts` keeps `currentDialog: Map<tabId, CurrentDialog>`; `dispatchTool` checks it
**before** routing: a tool on that tab that is not in the pass-through set (`dialog`, `tabs_context`,
`downloads_context`, `wait`) answers `{outcome:"busy", refusal:{reason:"blocked-by-dialog", dialog}}` (the contract has no `blocked` outcome; `busy` is the one hosts do not auto-retry on a foreign reason code) without
touching the page. The action that caused the dialog gets its own answer with `dialog` attached because
the event arrives during the effect's verify step (`effects.ts` `verifyDelivered`), which already waits
briefly for the page. Chaining: `effects.ts` records `{tabId, approvedAt, tool}` of the last **gate-
admitted or owner-approved** effect per tab; a dialog whose `openedAt − approvedAt ≤ 1000 ms` on that tab
gets `chainedTo`. `dialog {accept}` on a `confirm|prompt` with `chainedTo` set bypasses the gate and
posts a notice; without it, it goes through `decideGate` like a click.
**Rationale**: both references time out generically (design-notes §3); the owner asked for an
immediate answer. The 1000 ms value is a start; the gate's chained fixture opens its confirm at 300 ms
and the unchained one by timer at 3 s, so the boundary is exercised, and a real-page measurement in the
probe decides whether to move it (spec Assumptions).

## R-140 — `beforeunload` and the liveness check

**Decision**: per tab a `beforeunloadPolicy: "stay" | "leave"` defaulting to `stay`; on
`javascriptDialogOpening {type:"beforeunload"}` the worker answers `Page.handleJavaScriptDialog
{accept: policy === "leave"}` at once and records the outcome. `navigate` / `tabs_close` set `leave` only
when called with `force:true` (gated as an effect), then wait ≤ 300 ms for the outcome or the top-frame
navigation, answering `blocked-by-beforeunload {url}` when stayed. After any `handleJavaScriptDialog`
the tool issues one bounded `Runtime.evaluate("1")` on the attachment (a command, no `Runtime.enable`;
the same pattern `effects.ts` already uses for the OOPIF nonce) within 300 ms; no answer →
`page-unresponsive`.
**Rationale**: design-notes §3 — the reference's default-stay, `force`, 300 ms event-driven wait; the
liveness check is our addition because the reference has none and a frozen page after accept looks
like a slow one.

## R-141 — Window restore record and hooks

**Decision**: `chrome-adapters/windows.ts` `resizeWindow` returns the prior state; `tabs.ts`'s
`resize_window` runner writes `{windowId, priorState, sessionId, setSize}` to `chrome.storage.session`
(`agentWindowRestores`, list). Restore runs from two hooks in `agent-runtime.ts`: `onTabLeft` (when it
was the session's last tab in that window) and `releaseSession`; the four edge cases of FR-119 are a
pure function `decideRestore(record, currentWindow | undefined, otherHolders)` with its own unit test.
**Rationale**: no reference (design-notes §5); the 2026-09-16 design; the pure function makes the edge cases
testable without Chrome.

## R-142 — Version from one literal, contract-pinned

**Decision**: `build-config.ts` `createManifest()` `version: "0.1.0"` → `"0.2.0"`, exported as
`EXTENSION_VERSION` and read by the offscreen watermark through `chrome.runtime.getManifest()`; the
zip name already follows the built manifest (`scripts/package.ts` `readExtensionVersion`). The three
`package.json` files stay `0.0.0` (they are workspace-private). A contract test pins manifest version =
zip name = watermark string source.
**Rationale**: the recon found the literal is the only source today; adding a second one would create
the drift the spec forbids (FR-122).

## R-143 — Upgrade proof

**Decision**: a Playwright spec in `tests/e2e/packaged/` installs the 0.1.0 zip from `release/` into a
scratch profile dir, pairs, sets two site modes through the panel, runs `install.ps1` from the new zip
over it, and asserts pairing + modes survive and `gif_recorder` is listed. Storage survival is expected
because the extension ID is fixed and `chrome.storage.local` is keyed by ID; the test proves it rather
than assuming it.
**Rationale**: FR-122, SC-061; 007 never exercised an upgrade.

## Process rule carried into tasks

Every task in `tasks.md` names its evidence section. **A task that fails its second attempt is not
retried**: the main session re-reads the reference or takes one measurement on the gate, writes the
answer into the behaviour analysis (private archive; new section), and re-briefs with it. The two places
this is most likely to bite are R-133 (frame timing/size) and R-139 (the chained window), both of which
already have a measurement named.
