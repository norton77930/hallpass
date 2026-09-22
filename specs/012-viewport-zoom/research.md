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
