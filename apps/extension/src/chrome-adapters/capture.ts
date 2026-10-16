/**
 * Photographing a tab (003/T036, FR-039; 012/T311, FR-158, FR-162, FR-163).
 *
 * `chrome.tabs.captureVisibleTab` photographs *the active tab of a window* and nothing else - there
 * is no per-tab capture in MV3 without the debugger. The agent's tabs are usually not active, so a
 * capture of an agent tab means: bring it to the front, take the picture, and put the owner's tab
 * back. That visible flicker is a real cost, so it is stated in the tool's own description rather
 * than hidden here.
 *
 * Cropping happens in the worker with `OffscreenCanvas`, which MV3 service workers have. When it is
 * not there the whole viewport is returned and the caller is told it was not cropped: a picture of
 * the wrong rectangle, silently, is the one answer that would mislead.
 *
 * **Two frames, one of them not the picture's** (012, R-166). A region is asked for in the CSS
 * pixels the page and every other tool speak, and `captureVisibleTab` answers at the *display's*
 * density - 1 484 pixels for an 1 187-pixel viewport on a DPR 1.25 screen. Cropping the region
 * straight into the image, which this adapter did until now, cuts a rectangle 25 % short of the one
 * that was asked for. So the caller hands in the frame, the density is read off it
 * (`image.width / frame.width`), and the crop happens at `region x density`.
 *
 * **And a second path.** Under an emulated viewport `captureVisibleTab` photographs the window
 * rather than the viewport (R-166 measured a 2 560-wide emulated page coming back as a 1 484-wide
 * picture of the window), so an emulated tab is photographed over the debugger attachment the
 * emulation already holds. The choice is `decideCapturePath`, which is pure so the table is a
 * test rather than a branch nobody can see.
 *
 * **And the whole viewport is in the frame's pixels** (012 change log 2026-10-17, R-280). The agent
 * reads its points off this picture and the page resolves them in CSS pixels, so a whole-viewport
 * picture is drawn at the frame's CSS size, fitted under `viewportPictureSize`'s budget, on both
 * paths. Regions keep their native density.
 */

export type CaptureRegion = { x: number; y: number; width: number; height: number };

/** A CSS size: what a page believes it is laid out at, emulated or real. */
export type CaptureFrame = { width: number; height: number };

/** A base64 PNG, without the data-url prefix, and what it turned out to be a picture of. */
export type CapturedImage = {
  data: string;
  cropped: boolean;
  /**
   * The scale that was actually applied - 1 when the worker had no canvas to apply the asked-for
   * one with. The answer says what the picture is, never what was hoped for.
   */
  scale: number;
  /** The image's own pixels, when they could be read; absent rather than guessed at. */
  width?: number;
  height?: number;
};

/** Where a picture comes from: the visible tab, or the attachment an emulated tab already has. */
export type CapturePath =
  | { kind: "visible-tab" }
  | { kind: "protocol"; clip: CaptureRegion; scale: number };

/** One protocol command over a tab's existing attachment; the caller owns the attaching. */
export type CaptureSend = (
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** What one canvas pass is asked for: a region in `frame`'s CSS pixels, and how much to keep. */
export type CropRequest = { frame?: CaptureFrame; region?: CaptureRegion; scale: number };

/** What it answers with: the base64 PNG and the size it came out at, for the agent's answer. */
export type CroppedImage = { data: string; width: number; height: number };

/** What `captureVisibleTab` answers with, so a test can hand back a picture without a browser. */
export type CaptureDeps = {
  captureVisibleTab?: (windowId: number) => Promise<string>;
  activateTab?: (tabId: number) => Promise<void>;
  crop?: (dataUrl: string, request: CropRequest) => Promise<CroppedImage | undefined>;
  /** The picture's own pixel size when nothing had to be cropped, for the answer's `width`/`height`. */
  measure?: (dataUrl: string) => Promise<CaptureFrame | undefined>;
  /** Only the protocol path uses it; a visible-tab capture attaches no debugger (012/FR-158). */
  send?: CaptureSend;
  /**
   * Resolves once the page has painted a frame since it was brought forward. Bounded and allowed to
   * fail by `captureTab`; absent, the page is asked through the path's own channel.
   */
  awaitFrame?: (tabId: number) => Promise<void>;
};

/** The longest a background tab's picture waits for its first fresh frame (2026-10-11). */
export const FRESH_FRAME_CAP_MS = 300;

/** Two animation frames: the first is scheduled before the next paint, the second after it. */
const TWO_FRAMES_SOURCE =
  "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";

function twoFramesInPage(): Promise<boolean> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
}

/** The visible-tab path attaches no debugger (012/FR-158), so the page is asked by script. */
async function awaitFrameWithScripting(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: twoFramesInPage });
}

/**
 * Waits - at most `FRESH_FRAME_CAP_MS` - for the brought-forward tab to paint. Never refuses: no
 * frame in time, or no way to ask, is the picture this adapter took before the wait existed.
 */
async function waitForFreshFrame(wait: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(wait),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FRESH_FRAME_CAP_MS);
      }),
    ]);
  } catch {
    // Proceeds with the capture.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

async function captureWithChrome(windowId: number): Promise<string> {
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

async function activateWithChrome(tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
}

/**
 * Which capture answers the question honestly, given what the tab is laid out at (012, R-171).
 *
 * Pure, and over the record rather than over a tab id, because the fact that decides it is one
 * fact: a session gave this tab a viewport of its own, so the only picture of *that* viewport is
 * the protocol's. A whole-viewport shot is a `clip` of the frame rather than no clip at all, so
 * that the scale travels the same way in both cases and the picture is exactly the emulated size.
 */
export function decideCapturePath(
  record: CaptureFrame | undefined,
  region: CaptureRegion | undefined,
  scale: number,
): CapturePath {
  if (!record) return { kind: "visible-tab" };
  return {
    kind: "protocol",
    clip: region ?? { x: 0, y: 0, width: record.width, height: record.height },
    scale,
  };
}

/**
 * The longest edge, and the most pixels, a whole-viewport picture is handed back at (012 change
 * log 2026-10-17, R-280).
 *
 * A model client shrinks any image past roughly these sizes before the model sees it, and a picture
 * shrunk somewhere the worker cannot see is a picture whose pixels no longer say where anything is.
 * Fitting it here means the size in the answer is the size the agent looked at, which is the size
 * its coordinates come back in.
 */
export const SCREENSHOT_MAX_EDGE_PX = 1568;
export const SCREENSHOT_MAX_AREA_PX = 1_150_000;

/**
 * The size a whole-viewport picture of `base` is handed back at (012 change log 2026-10-17, R-280).
 *
 * `base` is the frame's CSS size - the pixels every coordinate is resolved in - or, when nobody
 * could say what the frame is, the image's own. It is fitted under the edge and area budget with its
 * shape kept, and the agent's `scale` (FR-162) applies on top. Rounded down whenever it shrinks, so
 * the budget is a ceiling rather than a target that rounding can step over.
 */
export function viewportPictureSize(base: CaptureFrame, scale: number): CaptureFrame {
  const fit = Math.min(
    1,
    SCREENSHOT_MAX_EDGE_PX / Math.max(base.width, base.height, 1),
    Math.sqrt(SCREENSHOT_MAX_AREA_PX / Math.max(base.width * base.height, 1)),
  );
  const factor = fit * scale;
  if (factor >= 1) return { width: base.width, height: base.height };
  return {
    width: Math.max(Math.floor(base.width * factor), 1),
    height: Math.max(Math.floor(base.height * factor), 1),
  };
}

/** Within a rounded pixel: a picture that close to its size is not worth re-encoding. */
function sameSize(a: CaptureFrame, b: CaptureFrame): boolean {
  return Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
}

/** The source rectangle of one crop, in image pixels, and the size it is drawn out at. */
export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  outWidth: number;
  outHeight: number;
};

/**
 * The rectangle to cut, in the picture's own pixels (012/FR-163).
 *
 * `frame` is the CSS size the region was asked in; the density is what the picture has more of.
 * Absent, the density is 1 - the honest reading of "nobody could tell me what this is a picture of"
 * is the old behaviour, not a guess at 2.
 *
 * The rectangle is clamped into the picture because a region the frame contains can still run past
 * the image by a rounded pixel; a region the *frame* does not contain is refused a layer up, where
 * the agent can be told the frame it should have aimed at.
 *
 * With no region the whole picture is the source and it is drawn out at `viewportPictureSize`: the
 * frame's CSS size (the image's own when the frame is unknown), fitted and scaled (2026-10-17). A
 * region keeps 012's native density.
 */
export function cropRect(
  frame: CaptureFrame | undefined,
  image: CaptureFrame,
  region: CaptureRegion | undefined,
  scale: number,
): CropRect {
  const density = frame && frame.width > 0 ? image.width / frame.width : 1;
  const asked = region
    ? {
        x: Math.round(region.x * density),
        y: Math.round(region.y * density),
        width: Math.round(region.width * density),
        height: Math.round(region.height * density),
      }
    : { x: 0, y: 0, width: image.width, height: image.height };
  const x = Math.min(Math.max(asked.x, 0), image.width);
  const y = Math.min(Math.max(asked.y, 0), image.height);
  const width = Math.max(Math.min(asked.width, image.width - x), 0);
  const height = Math.max(Math.min(asked.height, image.height - y), 0);
  if (!region) {
    const out = viewportPictureSize(frame && frame.width > 0 && frame.height > 0 ? frame : image, scale);
    return { x, y, width, height, outWidth: out.width, outHeight: out.height };
  }
  return {
    x,
    y,
    width,
    height,
    // At the smallest scale a thin strip rounds to nothing; one pixel of it is still a picture,
    // and a zero-sized canvas is not something to hand back.
    outWidth: width <= 0 ? 0 : Math.max(Math.round(width * scale), 1),
    outHeight: height <= 0 ? 0 : Math.max(Math.round(height * scale), 1),
  };
}

/**
 * The picture's bytes as a bitmap.
 *
 * Decoded here rather than through `fetch(dataUrl)`: an extension service worker's content security
 * policy does not list `data:` in `connect-src`, so fetching the capture's own data url fails
 * silently and every crop would quietly come back as the whole viewport. `atob` is not subject to
 * that, and the bytes are the same bytes.
 */
async function decodeImage(dataUrl: string): Promise<ImageBitmap | undefined> {
  const globals = globalThis as { createImageBitmap?: typeof createImageBitmap };
  if (!globals.createImageBitmap) return undefined;
  const binaryText = atob(base64Of(dataUrl));
  const encoded = new Uint8Array(binaryText.length);
  for (let index = 0; index < binaryText.length; index += 1) {
    encoded[index] = binaryText.charCodeAt(index);
  }
  return globals.createImageBitmap(new Blob([encoded], { type: "image/png" }));
}

/** How big the picture is, when that can be read without re-encoding it. */
async function measureWithCanvas(dataUrl: string): Promise<CaptureFrame | undefined> {
  try {
    const source = await decodeImage(dataUrl);
    if (!source) return undefined;
    const size = { width: source.width, height: source.height };
    source.close();
    return size;
  } catch {
    return undefined;
  }
}

/**
 * Crops and scales a PNG data url in one canvas pass, in the worker.
 *
 * `createImageBitmap` + `OffscreenCanvas` are both available to an MV3 service worker; when either
 * is missing the answer is `undefined`, which the caller turns into "the whole viewport, not
 * cropped" rather than into a failure. A picture is still a true picture of the tab.
 */
async function cropWithCanvas(dataUrl: string, request: CropRequest): Promise<CroppedImage | undefined> {
  const globals = globalThis as { OffscreenCanvas?: typeof OffscreenCanvas };
  if (!globals.OffscreenCanvas) {
    return undefined;
  }
  try {
    const source = await decodeImage(dataUrl);
    if (!source) return undefined;
    const rect = cropRect(
      request.frame,
      { width: source.width, height: source.height },
      request.region,
      request.scale,
    );
    if (rect.width <= 0 || rect.height <= 0) {
      return undefined;
    }
    const canvas = new globals.OffscreenCanvas(rect.outWidth, rect.outHeight);
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }
    (context as OffscreenCanvasRenderingContext2D).drawImage(
      source,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.outWidth,
      rect.outHeight,
    );
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { data: btoa(binary), width: rect.outWidth, height: rect.outHeight };
  } catch {
    return undefined;
  }
}

/**
 * Where the viewport sits in the document, in CSS pixels (012/S2c F3, measured as R-174).
 *
 * Zero for a page that has not been scrolled, which is why the defect this fixes was invisible for
 * a whole slice. A measurement that fails is answered as zero rather than refused: an unshifted
 * clip is the right clip for most pages, and no picture at all is worse than the picture the agent
 * would have got anyway.
 */
async function viewportOffset(send: CaptureSend, tabId: number): Promise<{ x: number; y: number }> {
  try {
    const metrics = await send(tabId, "Page.getLayoutMetrics");
    const visual = (metrics as { cssVisualViewport?: { pageX?: unknown; pageY?: unknown } }).cssVisualViewport;
    return {
      x: typeof visual?.pageX === "number" ? visual.pageX : 0,
      y: typeof visual?.pageY === "number" ? visual.pageY : 0,
    };
  } catch {
    return { x: 0, y: 0 };
  }
}

/**
 * One picture of an emulated viewport, over the attachment that emulation holds (012, R-171).
 *
 * `fromSurface` because the tab has only just been brought to the front and the composited surface
 * is what the emulated viewport was laid out on. The clip carries the scale, so the browser does
 * the shrinking and the worker never decodes a 2 560x1 440 PNG to throw most of it away.
 *
 * The clip is shifted by the scroll position (R-174): CDP measures a clip from the top-left of the
 * *document*, while every coordinate this product speaks - a region, a click, a ref's box - is
 * measured from the top-left of the viewport. Without the shift a screenshot of a scrolled page is
 * a picture of somewhere the agent is not looking, and usually of nothing at all.
 *
 * An answer with no data throws rather than falling back to the visible tab: under emulation that
 * fallback is a picture of the window, which is not what was asked about.
 */
export async function captureThroughProtocol(input: {
  send: CaptureSend;
  tabId: number;
  clip: CaptureRegion;
  scale: number;
}): Promise<string> {
  const offset = await viewportOffset(input.send, input.tabId);
  const shot = await input.send(input.tabId, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    clip: {
      x: input.clip.x + offset.x,
      y: input.clip.y + offset.y,
      width: input.clip.width,
      height: input.clip.height,
      scale: input.scale,
    },
  });
  const data = shot["data"];
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("the protocol capture answered no image");
  }
  return data;
}

/**
 * Captures one tab, activating it first when it is not the one its window is showing.
 *
 * `activeTabId` is what gets the front back afterwards. It is passed in rather than looked up here
 * so this adapter never decides which tab the owner was on - the caller, which already listed the
 * window's tabs, knows. The displacement happens on both paths: a background tab's surface may be
 * stale, and a picture of a stale surface is a picture of what the page used to say.
 */
export async function captureTab(
  input: {
    tabId: number;
    windowId: number;
    /** Whether the tab is already the active one of its window; if not, it is brought forward. */
    isActive: boolean;
    /** The tab to put back afterwards, when one was displaced. */
    restoreTabId?: number;
    region?: CaptureRegion;
    /** The CSS size the region is asked in, and that the picture is of (012/FR-163). */
    frame?: CaptureFrame;
    /** How much of the picture's own pixels to keep, 0.1 to 1 (012/FR-162). */
    scale?: number;
    /** Which capture to take; the default is the one that needs no debugger. */
    path?: CapturePath;
  },
  deps: CaptureDeps = {},
): Promise<CapturedImage> {
  const capture = deps.captureVisibleTab ?? captureWithChrome;
  const activate = deps.activateTab ?? activateWithChrome;
  const crop = deps.crop ?? cropWithCanvas;
  const measure = deps.measure ?? measureWithCanvas;
  const scale = input.scale ?? 1;
  // Without a `send` there is nothing to take a protocol picture over, so the tab is photographed
  // the way every other tab is: honest about the path, rather than failing the call.
  const path = input.path?.kind === "protocol" && deps.send ? input.path : { kind: "visible-tab" as const };

  if (!input.isActive) {
    await activate(input.tabId);
  }
  try {
    if (!input.isActive) {
      // Right after activation the surface may still be the one the tab was last painted with
      // (2026-10-11): one fresh frame first, through the channel the path already uses.
      const send = path.kind === "protocol" ? deps.send : undefined;
      const awaitFrame =
        deps.awaitFrame ??
        (send
          ? async (tabId: number) => {
              await send(tabId, "Runtime.evaluate", { expression: TWO_FRAMES_SOURCE, awaitPromise: true });
            }
          : awaitFrameWithScripting);
      await waitForFreshFrame(() => awaitFrame(input.tabId));
    }
    if (path.kind === "protocol" && deps.send) {
      // A whole viewport is asked for at its fitted size, so the browser does the shrinking
      // (2026-10-17); a region keeps the scale it was asked at (012 native density).
      const clipFrame = { width: path.clip.width, height: path.clip.height };
      const target = input.region ? undefined : viewportPictureSize(clipFrame, path.scale);
      const data = await captureThroughProtocol({
        send: deps.send,
        tabId: input.tabId,
        clip: path.clip,
        scale: target ? target.width / Math.max(clipFrame.width, 1) : path.scale,
      });
      const size = await measure(data);
      if (target && size && !sameSize(size, target)) {
        // A surface at a density the emulation did not state: brought to the fitted size here.
        const resized = await crop(`data:image/png;base64,${data}`, { frame: clipFrame, scale: path.scale });
        if (resized) {
          return { data: resized.data, cropped: false, scale: path.scale, width: resized.width, height: resized.height };
        }
      }
      // A whole viewport that could not be measured is the size the clip asked for (review minor,
      // R-280): the browser draws a clip at exactly that, and an absent size would leave the
      // agent's points unmapped against a picture that was shrunk. A region keeps saying nothing.
      const answered = size ?? target;
      return {
        data,
        // The clip *is* the region, applied by the browser: there is no partial answer here.
        cropped: input.region !== undefined,
        scale: path.scale,
        ...(answered === undefined ? {} : { width: answered.width, height: answered.height }),
      };
    }
    const dataUrl = await capture(input.windowId);
    let measured: CaptureFrame | undefined;
    if (!input.region) {
      // The whole viewport, in the frame's CSS pixels and under the size budget (2026-10-17). A
      // picture that already is that size - a DPR 1 display, an ordinary window - goes back as it
      // was taken rather than through a canvas that would only re-encode it.
      measured = await measure(dataUrl);
      const base = input.frame ?? measured;
      const target = base === undefined ? undefined : viewportPictureSize(base, scale);
      if (measured && target && sameSize(measured, target)) {
        return {
          data: base64Of(dataUrl),
          cropped: false,
          scale,
          width: measured.width,
          height: measured.height,
        };
      }
    }
    const cropped = await crop(dataUrl, {
      ...(input.frame === undefined ? {} : { frame: input.frame }),
      ...(input.region === undefined ? {} : { region: input.region }),
      scale,
    });
    return cropped === undefined
      ? // No canvas: the whole viewport, at the size it was taken, and both facts said out loud.
        {
          data: base64Of(dataUrl),
          cropped: false,
          scale: 1,
          ...(measured === undefined ? {} : { width: measured.width, height: measured.height }),
        }
      : {
          data: cropped.data,
          cropped: input.region !== undefined,
          scale,
          width: cropped.width,
          height: cropped.height,
        };
  } finally {
    // Always, including after a capture that threw: the owner's window is not the agent's to leave
    // showing a tab they did not choose.
    if (!input.isActive && input.restoreTabId !== undefined) {
      await activate(input.restoreTabId).catch(() => undefined);
    }
  }
}
