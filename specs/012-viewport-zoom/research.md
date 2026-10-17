# Research: Viewport Override and Zoom

Numbering continues from 011 (R-165). R-166, R-167 and R-168 are the **measurements** the spec
demanded before design (SC-091); they were made on 2026-09-21/22 before this plan was written.
R-169 to R-173 are the design decisions the measurements settle.

## R-166 — Picture geometry under an emulated viewport (measured)

**Method**: `.scratch/r166-viewport-capture.mjs` — Playwright launches the bundled Chromium with
the built agent extension loaded and evaluates everything inside its service worker, the only
place `chrome.tabs.captureVisibleTab` and `chrome.debugger` both exist. A local page (served over
`http://127.0.0.1`, because the extension may not script a `data:` URL) has a 768 px breakpoint
bar, an 11 px text block at (100, 200) 300×100, and a green block at (2000, 1200). Window
1 200×800; the machine's display is DPR 1.25.

**Result on Chromium 151** (`Chrome/151.0.0.0`):

| State | Page reports | `captureVisibleTab` | `Page.captureScreenshot` |
| --- | --- | --- | --- |
| no emulation | 1 187×707, DPR 1.25 | 1 484×884 (= CSS × 1.25, native density) | 1 484×884 |
| emulated 2 560×1 440 | 2 560×1 440, DPR 1; wide layout; window unchanged (1 202×802 normal) | **1 484×814 — the window's picture, not the emulated viewport** | 2 560×1 440 (default and with `captureBeyondViewport`); `clip {2000,1200,200,100}` → 200×100 |
| emulated 375×812 | 375×812; narrow layout | 469×1 015 (= 375×1.25 × 812×1.25: the tab area shrank to the emulated size, at real DPR) | 375×812 |
| after `tabs.update(url)` to another site | still 375×812 | | |
| emulated 1 200×800 at DPR 2 | | 1 500×1 000 (real DPR 1.25, ignores emulated DPR) | default 2 400×1 600; `clip 300×100 scale 1` → 600×200; `scale 0.5` → 300×100 |
| `clearDeviceMetricsOverride` | 1 187×707, DPR 1.25 | | |
| set 500×500 then **`debugger.detach`** | **still 500×500 at 0.5 s and 2.5 s; real size only after a reload** | | |

**Findings**:

1. `captureVisibleTab` is unusable under emulation: with a viewport larger than the window it
   photographs the window (the emulated page cropped to what fits), and its pixel density is the
   display's, not the emulation's. The protocol capture returns exactly the emulated viewport.
2. Without emulation, `captureVisibleTab` already returns **native density** (CSS × display DPR).
   Today's region crop (`capture.ts`, `cropWithCanvas`) applies the region in *image* pixels, so on
   a DPR 1.25 display a region asked in CSS pixels is cropped 25 % off. That is a latent defect
   FR-163 fixes on the way: crop at `region × DPR`.
3. The emulation persists across navigation within the tab (wanted, spec edge case), and — **not**
   the CDP semantics the reference reading assumed — persists after the debugger is detached until
   the tab reloads. The evidence document's §1b sentence "detaching also drops the emulation" is
   corrected in this commit. Consequence: FR-159 needs an explicit clear *before* every detach.
4. `clip.scale` works as the reference does: region × emulated DPR × scale, exact pixels.

**Decision (FR-158 wording)**: under emulation the picture covers the **whole emulated viewport**
(`coverage: "viewport"`), taken through the protocol on the attachment the emulation already has;
without emulation the picture is the window's tab area as today. Either way the answer carries
`frame` (the CSS size of what the picture shows) and the image's pixel size.

## R-167 — Where the attachment is (re)made, for the re-apply hook (read)

**Source**: `apps/extension/src/service-worker/agent-tools/input.ts` `acquire()` (the one place
`chrome.debugger.attach` is called; it already performs per-attachment setup — `Target.setAutoAttach`
and `Page.enable` — right after a successful attach), the five `attachments.release(tabId)` /
`releaseAll()` call sites in `agent-runtime.ts` (tab released 593, session ends 1070, unpair 1216,
grant withdrawn 1488, owner take-back 1547), and `attachedTabIds()` / `detachStray()` (003/C1
reconciliation on wake, because Chrome keeps an extension's debugger attachments while the worker
is evicted and the worker's map is what is lost).

**Decision**:

- **Re-apply** goes into `acquire()` right after the existing per-attachment setup, as a hook the
  runtime registers (`onAttached(tabId)`): the viewport module looks up its record for the tab and
  sends `Emulation.setDeviceMetricsOverride`. Every call that needs the debugger passes through
  `acquire`, so no second place has to remember.
- **Clear** goes into a new `onBeforeRelease(tabId)` hook in the same module, run before
  `detach`, because R-166 showed detach does not clear. Five call sites become one hook.
- **Eviction**: the record lives in `chrome.storage.session` (as `window-restore.ts` does) and the
  emulation itself survives in Chrome (R-166 row "after detach"), so after a worker restart the
  tab is still emulated and the record still says so; the re-apply on the next `acquire` is
  idempotent. The stray-attachment reconciliation on wake is unchanged. SC-087 proves this on the
  gate with the existing worker-kill recipe (`agent-panel-multi.spec.ts`).
- A `set` on a tab with no attachment yet acquires one as holder `"viewport"` (a fourth
  `AttachmentHolder`, enabling no domain, like `"recording"`), so the attachment — and Chrome's
  "is being debugged" bar — lasts while the emulation does. This is the honest signal that the tab
  is being altered.

## R-168 — Native-density region capture at DPR 2 (measured on Chromium, owed on branded Chrome)

**Measured** (R-166 table, DPR-2 row): a protocol `clip` capture returns region × 2 (× scale).
On the real DPR 1.25 display, `captureVisibleTab` returns native density too, which is the path
non-emulated tabs keep. **Owed**: one run of the same script on the owner's branded Chrome 153 in
attach mode (the script's `chrome` argument cannot load an unpacked extension on branded builds;
use the attach recipe) before the gate is declared final — recorded as a task with the owner.

## R-169 — The `viewport` tool

**Decision**: one tool, `viewport`, with `tabId` and `action: "set" | "reset"`; `set` takes
`width` and `height` (integers, 320 to 4 096, FR-156); answers `{ width, height, emulated }` —
after `reset`, the page's real size with `emulated: false`. It joins the batchable list (it is about
one tab, like `resize_window`). Not an effect: no consent, governed by ownership only (FR-161).

**Alternatives**: two tools (`set_viewport`, `reset_viewport`) — more names for one thing;
folding it into `resize_window` with a mode flag — conflates the two the descriptions must keep
apart (D-012-2).

## R-170 — Storage and lifecycle of the emulation

**Decision**: `chrome.storage.session` key `agentViewports`: `{ [tabId]: { sessionId, width,
height, setAt } }`, one per tab (a second `set` replaces it). Dropped on reset, on every release
path (through `onBeforeRelease`), and when the tab closes (nothing to clear; Chrome dropped it).
The activity list gets a `viewport` kind with outcomes `set` and `cleared` (FR-159).

## R-171 — Capture path and the `scale` argument

**Decision**:

- `screenshot` gains `scale` (0.1 to 1, default 1) and keeps `region`.
- **Not emulated**: `captureVisibleTab` as today; the crop is applied at `region × DPR` where DPR
  is `image.width / frame.width` and `frame` is the page's `innerWidth/innerHeight` read through
  the existing page binding (`read_page` already asks the page for its viewport); `scale` is applied
  in the same canvas pass. Reads keep attaching no debugger.
- **Emulated** (a viewport record exists): `Page.captureScreenshot` over the attachment, `clip` for
  a region, `scale` as `clip.scale` (or a whole-viewport `clip` with the scale), `fromSurface`. The
  tab is still brought to the front for the capture as today (a background tab's surface may be
  stale), and put back.
- A region outside `frame` is refused `region-outside-viewport` naming the frame (FR-164); today's
  silent clamp goes.
- The answer adds `width`, `height` (image pixels), `scale`, `frame { width, height }`,
  `coverage: "viewport" | "region"`, and echoes `region`. `cropped` stays for older hosts.
- **Frame bound**: the native-messaging frame keeps its 700 000-character ceiling. A picture over
  it is still refused, but the reason now says what would fit: `screenshot-too-large; retry with
  scale ≤ 0.5` (the factor from the byte ratio, rounded down to one decimal). An emulated 2 560×1 440
  page will hit this; the hint is what makes `scale` discoverable.

## R-172 — Descriptions (FR-165)

`viewport`: "Gives one of your tabs an emulated viewport of `width`×`height` CSS pixels for
viewing a page at a size — phone, tablet, wide desktop — without changing the browser window.
Screenshots, reads and clicks then use that size. Prefer this over `resize_window` for any layout
or breakpoint check. `reset` puts the page back to the window's real size; the emulation is also
cleared when you release the tab, so reset before finishing unless the owner asked to keep it. The
two tools are independent: resizing the window does not change an emulated viewport."

`resize_window` gains: "For viewing a page at a size, use `viewport` instead — it does not disturb
the owner's window. Use this only when the real window must change (another program will look at
it, or the site measures the window). It does not change an emulated viewport."

## R-173 — Version 0.4.0 and the documents

`AGENT_EXTENSION_VERSION` (`build-config.ts`), `SERVER_VERSION` (`tool-offering.ts`), the three
watermark strings in tests, README (tool table + count 31 → 32, a 0.4.0 note), the zh-TW operations
guide (count and a line for the two capabilities), `docs/design-notes.md` §7 (viewport and zoom
move from "planned" to a short paragraph; `upload_image` stays planned for 013). The QA guide's
screenshots are unaffected (no panel change beyond one activity line).

## R-174 — Is the protocol capture's `clip` in document or viewport coordinates? (measured, review finding 3)

**Method**: `.scratch/r174-clip-coords.mjs` (same harness as R-166): a 3 000 px tall page with a
red block at document (0, 0) and a blue block at document (0, 1 000); emulated 1 200×800; the page
scrolled to y = 1 000; then `clip {0,0,50,50}`, `clip {0,1000,50,50}` and a whole capture, each
sampled at pixel (5, 5).

**Result on Chromium 151**: `clip {0,1000}` → blue (the block at document y = 1 000, which is at
the top of the viewport); `clip {0,0}` → white (outside what the surface rendered); whole capture
top-left → blue. So `clip` is **document** coordinates, and a clip outside the visible viewport is
blank rather than an error.

**Decision**: the protocol path reads `Page.getLayoutMetrics` first and adds
`cssVisualViewport.pageX/pageY` to the clip; a failed measurement sends the unshifted clip (a
failed measurement is not a failed picture). Regions are already refused when outside the frame
(FR-164), so the "blank outside the viewport" case cannot be reached from the tool. Implemented in
S2c (commit 1fff8d3) with unit cases.

## R-175 — Is the tab's reported size the page's viewport? (measured, gate run 1)

**Why**: the non-emulated path derives the picture's density as `image.width / frame.width` with
`frame` from `chrome.tabs.get` (the page binding cannot be used before a read, S2 discrepancy 2),
and a classic scrollbar could make the two differ.

**Method**: `.scratch/r175-tab-size.mjs` — a short page (no scrollbar) and a 5 000 px page (vertical
scrollbar), window 1 200×800 on the DPR 1.25 display; compare `tab.width/height` with
`innerWidth/innerHeight` and `documentElement.clientWidth`.

**Result on Chromium 151**: both pages report `tab 1 187×707 = inner 1 187×707`; `clientWidth` is
1 172 with the scrollbar. `innerWidth` includes the scrollbar, and so does the capture (R-166:
1 484 = 1 187 × 1.25), so the density is exact and a CSS region maps to the right pixels. The gate's
DPR-2 case forces a `deviceScaleFactor` override through the harness, under which `tab.width`
reports something else (625 for a 1 200 px page); that is a harness artefact, not a product path,
which is why gate step 5 asserts the crop as a relation to the derived density.

## R-176 — What happens to an emulation the worker is no longer holding (measured on branded Chrome 153)

**Why**: the release path after a worker eviction borrows a fresh attachment to clear (R-167);
whether that clear reaches an override set by an earlier, now-detached attachment was never
measured, and the gate on Chrome 153 showed the page *un-emulated* right after a worker kill while
Chromium 151 kept it.

**Method**: `.scratch/r168b-branded.mjs` and `.scratch/r176-reattach-clear.mjs`, attach mode on
the owner's Chrome 153.0.8010.50 (private profile, agent build loaded unpacked).

**Result**:

| Step | run A (`r168b`) | run B (`r176`) |
| --- | --- | --- |
| set 500×500, explicit detach, wait | still 500×500 at 2.5 s | real size at 1.5 s |
| fresh attachment, plain clear | still 500×500 at 0.6 s | (already real) |
| fresh attachment, set 640×480 then clear | — | real size |
| gate: worker killed (`Target.closeTarget`) | | real size before any call (both runs) |

So on Chrome 153 an override may or may not outlive a detach, and a fresh attachment's **plain
clear is not proven to remove one that did**; a fresh attachment that first *sets* an override and
then clears it always ends un-emulated. Chromium 151 kept the override past every detach (R-166).

**Decision (S2d)**: on the borrowed-attachment branch of the clear (`attach-clear-detach`), send
`setDeviceMetricsOverride` with the record's size immediately followed by
`clearDeviceMetricsOverride`, then detach. The held-attachment branch stays a plain clear
(measured to work on both builds). The gate's restart case asserts the product's promise — the
first call that needs the attachment re-applies the emulation — rather than either build's
behaviour in between.

**Also measured on 153** (R-168 closed): emulated 2 560×1 440 → page 2 560×1 440, window
untouched, `captureVisibleTab` 813×799 (window at display DPR), protocol capture 2 560×1 440;
DPR 2 clip 300×100 → 600×200, scale 0.5 → 300×100; R-174 reproduced (clip at document y = 1 000 is
what the scrolled viewport shows). Gate on 153: 7/7 (`gate-chrome153-run2`).

## R-280 — The pixels a point is read in (2026-10-17, defect fix)

**Observed**: on the owner's display (device pixel ratio 1.25, large monitor) an agent that read a
point off a whole-viewport `screenshot` and clicked it (`computer`, or a point target) missed, while
ref-based clicks landed. The visible-tab path returned the whole viewport exactly as captured — at
the display's density, 1 484×884 for an 1 187×707 page — and points are resolved by
`elementFromPoint` in CSS pixels; the `computer` description even said the two were the same. A
model client also shrinks an image past about 1 568 pixels on its long edge or 1.15 million pixels
in all before the model sees it, so a large viewport put the agent's pixels in a third space.

**Decision**:

- Size: a whole-viewport picture is drawn at `viewportPictureSize(frame, scale)` — the frame's CSS
  size times `min(1, 1568 / long edge, sqrt(1 150 000 / area))`, times `scale`, rounded down when it
  shrinks. Visible-tab: one canvas pass from the captured image (none when it is already within a
  pixel of that size). Emulated: the whole-viewport `clip` carries the fitted factor as its scale,
  and a surface that still comes back larger is resized in the worker. Unknown frame: the image's
  own pixels are fitted. Regions keep R-171's native density.
- Space: after each whole-viewport picture the agent receives, the tab's `{ frame, image }` is
  written to `chrome.storage.session` (`agentScreenshotSpaces`, bounded to the 64 most recently
  pictured tabs by a counter stored on each entry, since key order sorts tab ids numerically and is
  not kept by storage; tab ids are not reused in a browser run). An emulated whole-viewport picture
  that cannot be measured answers the fitted size its clip asked for. A picture whose frame is unknown clears it. A region,
  or a picture refused as too large, leaves it.
- Mapping: one function (`toViewportPoint`) maps `round(point × frame / image)` per axis, applied
  once when a call starts — to `computer`'s `x`/`y`, every `target` point, `drag`'s `from`/`to`
  and `upload_image`'s `coordinate` — before resolution and the viewport check. No stored space
  passes the point through. A refusal names the picture's size when a space exists.
- `scale` multiplies on top of the fit, and points are read in the picture as returned; the
  too-large hint is computed relative to the scale used.

**Follow-up (same day)**:

- Region: `toViewportRegion` maps the region's top-left and far corner through `toViewportPoint`
  and takes the size as their difference (minimum 1), so a region ending on the picture's edge ends
  on the frame's rather than one rounded pixel past it. It is mapped before the outside check
  (refused as `region-outside-viewport (screenshot WxH)` when a space exists) and before the crop;
  the answer echoes the region as asked; a region shot still does not write the space.
- Invalidation: the viewport emulation reports `onFrameChanged(tabId)` after a successful set and
  after any clear that removed an emulation (reset and every release path); the runtime forgets
  that tab's space. `resize_window` forgets the space of every tab in the resized window.
- `upload_image`'s result `point` is mapped back with the inverse (`toPicturePoint`), so the answer
  speaks the agent's space.

**Alternatives**: (a) keep device pixels and tell the agent the ratio — every agent would have to do
arithmetic it has already shown it does not do; (b) map on the host — the host does not know the
frame, and the batch path never passes through a host-side point; (c) keep pictures in CSS pixels
without fitting — fixes the DPR case but not the client-side shrink on large viewports.

**Behaviour this matches**: the observable behaviour of the reference extension (whole-viewport
picture normalised to CSS size then fitted; a later point scaled by viewport over picture size;
no stored size passes it through), described here in our own words and implemented independently.

## R-281 — A whole-viewport picture as a JPEG, stepped down under the frame budget (2026-10-17)

**Observed**: after R-280 a whole-viewport picture is at most 1 568 pixels on the long edge, but a
busy page as a PNG of that size can still exceed the 700 000-character frame budget, and the answer
was a refusal the agent had to act on with a smaller `scale` - a second call, and a smaller picture
than it needed.

**Decision**:

- Seam: `captureTab` (capture adapter). Every path first produces the lossless picture at the size
  R-280 settled (as captured, one canvas pass, or the protocol's fitted clip). For a whole viewport
  that picture is then encoded once more in the worker (`OffscreenCanvas.convertToBlob`,
  `image/jpeg`) at its own pixel size: quality 0.75, then - while the base64 is over the budget -
  0.70, 0.65 … 0.10, each time from the same lossless source rather than from the previous JPEG,
  so a low quality is one loss. The encode runs after the owner's tab is put back.
- The last step is handed back even when still over; the decision to refuse is one function
  (`screenshotTooLarge`) used by the `screenshot` tool and `computer`'s `screenshot`, so both refuse
  with the same reason and hint. Before this, `computer`'s `screenshot` had no size check at all.
- No canvas (no `OffscreenCanvas`) leaves the PNG and the answer says `image/png`.
- Regions and the owner's crop stay PNG: they are small, and the agent reads detail off them. The
  GIF recorder keeps its own protocol JPEG; its `captureVisibleTab` fallback asks for the picture
  `lossless` and still receives the PNG, because the offscreen document encodes the frame at the
  recording's own quality and the agent's frame budget would only degrade it (and cost up to
  fourteen encodes) on a page busy enough to exceed it.
- `upload_image`: the schema no longer defaults `filename`; the host, which holds the bytes and
  their type, names an unnamed picture `screenshot.jpg` or `screenshot.png`.

**Alternatives**: (a) ask `captureVisibleTab` / `Page.captureScreenshot` for JPEG directly - the
visible-tab picture usually still needs a canvas pass for R-280's size, and stepping down would
mean capturing again (another flicker of the owner's window) or re-encoding a JPEG; (b) keep PNG
and only refuse - the status quo the owner chose to leave.

**Behaviour this matches**: the observable behaviour of the reference extension (whole-viewport
pictures as JPEG at 0.75, stepped down by 0.05 to 0.10 while over a size cap and never refused;
crops as PNG), described here in our own words and implemented independently. Ours still refuses
past 0.10, because a frame over the native-messaging limit breaks the link for every later call.

## R-282 — Refusing a point whose picture is of a page of another width (2026-10-17)

**Why**: R-280's per-tab space is dropped when our own tools change the frame, but not when the
owner resizes the window or zooms the page; a point read off the old picture is then mapped through
a ratio that no longer holds.

**Measured** (scratch extension in Playwright Chromium, window 1 200×800 on the DPR 1.25 display,
5 000 px page): `chrome.tabs.get().width` stayed 1 187 at page zoom 100 %, 125 % and 80 %, while
`innerWidth` was 1 187 / 950 / 1 484 and `documentElement.clientWidth` 1 172 / 938 / 1 465. So the
tab's size does not follow page zoom; the page's CSS width is the tab's size over
`chrome.tabs.getZoom` (1 187 / 1.25 = 949.6 → 950; 1 187 / 0.8 = 1 483.75 → 1 484).

**Decision**:

- One measurement for both ends: `captureFrameFacts` - the emulation record when a session set a
  viewport, else the tab's size divided by its zoom (unknown zoom is 100 %). The picture's frame is
  this (so it now holds under page zoom, which R-280's tab-size frame did not), and the check at
  action time is this. No page round trip: both are extension API reads. `computer`'s own
  `Page.getLayoutMetrics` is not reused: its `clientWidth` leaves out a classic scrollbar (1 172 vs
  1 187) and would refuse every point on a scrolling page.
- `viewportChangedReason(space, width)`: refuse when |width − frame.width| > 1; never when there is
  no space or no width. Height is ignored.
- Where: the effect runner checks right after it reads the space and before preflight, the gate
  and any prompt, for calls that carry a point (`carriesPoint`, the same places `toViewportArgs`
  maps); `upload_image` checks after binding and before its gate; the `screenshot` tool checks a
  `region` against the frame it measures anyway. Outcome `failed`, reason
  `viewport-changed (screenshot of a W px wide page, now N); …`.

**Alternatives**: (a) drop the space silently on a change - the agent's next point would be read as
CSS pixels while it is still looking at a shrunk picture; (b) compare `tab.width` alone - misses page
zoom entirely; (c) measure `innerWidth` with a script per action - a page round trip on every point.
