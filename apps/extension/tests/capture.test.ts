import { describe, expect, it } from "vitest";
import {
  captureTab,
  captureThroughProtocol,
  cropRect,
  decideCapturePath,
  FRESH_FRAME_CAP_MS,
  SCREENSHOT_MAX_AREA_PX,
  SCREENSHOT_MAX_BASE64_CHARS,
  SCREENSHOT_MAX_EDGE_PX,
  viewportPictureSize,
  type CropRequest,
} from "../src/chrome-adapters/capture.js";

/**
 * 012/T310 - what the picture is of, and in whose pixels (US2, FR-158, FR-162, FR-163, R-171).
 *
 * The numbers are R-166's measurement rather than round ones: a 1 200x800 window on a DPR 1.25
 * display reports a 1 187x707 viewport and photographs 1 484x884. That ratio is the whole point -
 * a region asked for in the CSS pixels the agent can see is cropped 25 % short if it is applied to
 * the image directly, which is what this worker did until now.
 *
 * The path table is the other half. Under an emulated viewport `captureVisibleTab` photographs the
 * *window* (R-166), so the picture has to come over the attachment the emulation already holds;
 * with no emulation nothing attaches a debugger, because a read never does.
 */

/** What the page reports, in CSS pixels: the frame every region is asked in. */
const FRAME = { width: 1187, height: 707 };
/** What `captureVisibleTab` hands back for that frame at DPR 1.25. */
const IMAGE = { width: 1484, height: 884 };
const REGION = { x: 100, y: 200, width: 300, height: 100 };

describe("T310 capture geometry", () => {
  it("crops a region at the picture's own density", () => {
    expect(cropRect(FRAME, IMAGE, REGION, 1)).toEqual({
      x: 125,
      y: 250,
      width: 375,
      height: 125,
      outWidth: 375,
      outHeight: 125,
    });
  });

  it("applies the scale in the same pass, and never below one pixel", () => {
    const rect = cropRect(FRAME, IMAGE, REGION, 0.5);

    expect({ outWidth: rect.outWidth, outHeight: rect.outHeight }).toEqual({ outWidth: 188, outHeight: 63 });
    // A region small enough that a tenth of it rounds to nothing is still a picture of something.
    expect(cropRect(FRAME, IMAGE, { x: 0, y: 0, width: 1, height: 1 }, 0.1).outWidth).toBe(1);
  });

  it("scales the whole picture when no region was asked for, from the frame's own pixels", () => {
    // 2026-10-17: a whole-viewport picture is drawn out at the frame's CSS size before the scale
    // applies, so half of it is half of 1 187x707 - not half of the display's 1 484x884.
    expect(cropRect(FRAME, IMAGE, undefined, 0.5)).toEqual({
      x: 0,
      y: 0,
      width: 1484,
      height: 884,
      outWidth: 593,
      outHeight: 353,
    });
  });

  it("takes the protocol path for an emulated tab and the visible tab for every other", () => {
    const record = { width: 2560, height: 1440 };

    expect(decideCapturePath(record, undefined, 1)).toEqual({
      kind: "protocol",
      clip: { x: 0, y: 0, width: 2560, height: 1440 },
      scale: 1,
    });
    expect(decideCapturePath(record, REGION, 0.5)).toEqual({ kind: "protocol", clip: REGION, scale: 0.5 });
    expect(decideCapturePath(undefined, REGION, 0.5)).toEqual({ kind: "visible-tab" });
  });

  it("sends one clipped capture over the attachment", async () => {
    const sent: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> = [];

    const data = await captureThroughProtocol({
      send: async (tabId, method, params) => {
        sent.push({ tabId, method, ...(params === undefined ? {} : { params }) });
        return { data: "cHJvdG9jb2w=" };
      },
      tabId: 7,
      clip: REGION,
      scale: 0.5,
    });

    expect(sent).toEqual([
      // Where the viewport sits in the document has to be asked for first (R-174): a clip is in
      // document coordinates, and the page tells nobody it scrolled.
      { tabId: 7, method: "Page.getLayoutMetrics" },
      {
        tabId: 7,
        method: "Page.captureScreenshot",
        // `fromSurface` because the tab was only just brought to the front; the composited
        // surface is what the emulated viewport was laid out on.
        params: { format: "png", fromSurface: true, clip: { x: 100, y: 200, width: 300, height: 100, scale: 0.5 } },
      },
    ]);
    expect(data).toBe("cHJvdG9jb2w=");
  });

  /**
   * 012/S2c F3, measured as R-174: a CDP `clip` is in **document** coordinates, not viewport ones.
   *
   * On a page scrolled a thousand pixels down, a clip at y 0 photographs the top of the document -
   * blank, usually - and the agent is handed a picture of somewhere it is not looking. Every other
   * coordinate this product speaks is viewport-relative (a region, a click, a ref's box), so the
   * shift belongs here, once, where the clip is built.
   */
  it("shifts the clip by where the viewport sits in the document", async () => {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];

    await captureThroughProtocol({
      send: async (_tabId, method, params) => {
        sent.push({ method, ...(params === undefined ? {} : { params }) });
        return method === "Page.getLayoutMetrics"
          ? { cssVisualViewport: { pageX: 0, pageY: 1000 } }
          : { data: "cHJvdG9jb2w=" };
      },
      tabId: 7,
      clip: REGION,
      scale: 1,
    });

    expect(sent.at(-1)).toEqual({
      method: "Page.captureScreenshot",
      params: { format: "png", fromSurface: true, clip: { x: 100, y: 1200, width: 300, height: 100, scale: 1 } },
    });
  });

  it("photographs the viewport's own top-left when the page cannot be measured", async () => {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];

    await captureThroughProtocol({
      send: async (_tabId, method, params) => {
        if (method === "Page.getLayoutMetrics") throw new Error("the page went away mid-shot");
        sent.push({ method, ...(params === undefined ? {} : { params }) });
        return { data: "cHJvdG9jb2w=" };
      },
      tabId: 7,
      clip: REGION,
      scale: 1,
    });

    // A failed measurement is not a failed picture: an unshifted clip is right for every page that
    // has not been scrolled, which is most of them, and it is the honest thing to send.
    expect(sent).toEqual([
      {
        method: "Page.captureScreenshot",
        params: { format: "png", fromSurface: true, clip: { x: 100, y: 200, width: 300, height: 100, scale: 1 } },
      },
    ]);
  });

  it("photographs an emulated tab over the attachment, and still puts the owner's tab back", async () => {
    const activated: number[] = [];

    const image = await captureTab(
      {
        tabId: 7,
        windowId: 9,
        isActive: false,
        restoreTabId: 1,
        region: REGION,
        frame: { width: 2560, height: 1440 },
        scale: 0.5,
        path: decideCapturePath({ width: 2560, height: 1440 }, REGION, 0.5),
      },
      {
        captureVisibleTab: async () => {
          throw new Error("under emulation this photographs the window, not the viewport");
        },
        activateTab: async (tabId) => void activated.push(tabId),
        send: async () => ({ data: "cHJvdG9jb2w=" }),
        measure: async () => ({ width: 150, height: 50 }),
      },
    );

    expect(image).toEqual({ data: "cHJvdG9jb2w=", mimeType: "image/png", cropped: true, scale: 0.5, width: 150, height: 50 });
    expect(activated).toEqual([7, 1]);
  });

  it("hands back the whole picture, unscaled and saying so, when the worker cannot crop", async () => {
    const image = await captureTab(
      { tabId: 7, windowId: 9, isActive: true, region: REGION, frame: FRAME, scale: 0.5 },
      {
        captureVisibleTab: async () => "data:image/png;base64,aVZCT1J3MEtHZ28=",
        activateTab: async () => undefined,
        // What a worker without `OffscreenCanvas` answers: a picture of the whole viewport, at the
        // size it was taken, rather than a picture of the wrong rectangle.
        crop: async () => undefined,
      },
    );

    expect(image).toEqual({ data: "aVZCT1J3MEtHZ28=", mimeType: "image/png", cropped: false, scale: 1 });
  });
});

/**
 * A background tab brought forward is photographed after one fresh frame (2026-10-11). Right after
 * activation the surface may still be the one the tab was last painted with, so the capture waits -
 * at most `FRESH_FRAME_CAP_MS` - for the page to paint; a tab already in front does not wait.
 */
describe("a background tab's picture waits for a paint", () => {
  it("waits for a frame between bringing the tab forward and taking the picture", async () => {
    const steps: string[] = [];
    await captureTab(
      { tabId: 7, windowId: 9, isActive: false, restoreTabId: 1 },
      {
        activateTab: async (tabId) => void steps.push(`activate ${tabId}`),
        awaitFrame: async (tabId) => void steps.push(`frame ${tabId}`),
        captureVisibleTab: async () => (steps.push("capture"), "data:image/png;base64,QUJD"),
        measure: async () => undefined,
      },
    );
    expect(steps).toEqual(["activate 7", "frame 7", "capture", "activate 1"]);
  });

  it("does not wait for a tab already in front", async () => {
    const steps: string[] = [];
    await captureTab(
      { tabId: 7, windowId: 9, isActive: true },
      {
        activateTab: async (tabId) => void steps.push(`activate ${tabId}`),
        awaitFrame: async (tabId) => void steps.push(`frame ${tabId}`),
        captureVisibleTab: async () => (steps.push("capture"), "data:image/png;base64,QUJD"),
        measure: async () => undefined,
      },
    );
    expect(steps).toEqual(["capture"]);
  });

  it("takes the picture anyway when no frame comes, or the wait fails", async () => {
    for (const awaitFrame of [() => new Promise<void>(() => undefined), async () => Promise.reject(new Error("no page"))]) {
      const started = Date.now();
      const image = await captureTab(
        { tabId: 7, windowId: 9, isActive: false },
        {
          activateTab: async () => undefined,
          awaitFrame,
          captureVisibleTab: async () => "data:image/png;base64,QUJD",
          measure: async () => undefined,
        },
      );
      expect(image.data).toBe("QUJD");
      expect(Date.now() - started).toBeLessThan(FRESH_FRAME_CAP_MS + 500);
    }
  });

  it("asks the page for its frame over the attachment on the protocol path", async () => {
    const sent: string[] = [];
    await captureTab(
      { tabId: 7, windowId: 9, isActive: false, path: decideCapturePath(FRAME, undefined, 1) },
      {
        activateTab: async () => void sent.push("activate"),
        send: async (_tabId, method, params) => {
          sent.push(method);
          if (method === "Runtime.evaluate") {
            expect(params).toMatchObject({ awaitPromise: true });
            expect(String(params?.["expression"])).toContain("requestAnimationFrame");
          }
          return method === "Page.captureScreenshot" ? { data: "QUJD" } : {};
        },
        measure: async () => undefined,
      },
    );
    expect(sent).toEqual(["activate", "Runtime.evaluate", "Page.getLayoutMetrics", "Page.captureScreenshot"]);
  });
});

/**
 * A whole-viewport picture is in the page's own pixels (012 change log 2026-10-17, R-280).
 *
 * Every coordinate an agent sends back is read off a picture, and the page resolves it in CSS
 * pixels. A picture at the display's density (1 484 wide for an 1 187-wide page at DPR 1.25) put
 * every click 25 % right of and below where it was aimed. So the whole viewport comes back at the
 * frame's CSS size, fitted under the size a model is shown without being shrunk again, and the
 * agent's coordinates are mapped back from whatever size it ended up at.
 */
describe("a whole-viewport picture comes back in the frame's pixels", () => {
  /** A crop that does the arithmetic the real canvas pass does, for a picture of `source`'s size. */
  function cropOf(source: { width: number; height: number }) {
    return async (_dataUrl: string, request: CropRequest) => {
      const rect = cropRect(request.frame, source, request.region, request.scale);
      return { data: "UkVTSVpFRA==", width: rect.outWidth, height: rect.outHeight };
    };
  }

  it("returns a DPR 1.25 capture of an 1 187x707 frame at 1 187x707", async () => {
    const image = await captureTab(
      { tabId: 7, windowId: 9, isActive: true, frame: FRAME },
      { captureVisibleTab: async () => "data:image/png;base64,QUJD", measure: async () => IMAGE, crop: cropOf(IMAGE) },
    );

    expect(image).toEqual({ data: "UkVTSVpFRA==", mimeType: "image/png", cropped: false, scale: 1, width: 1187, height: 707 });
    // The whole picture is the source, drawn out at the frame's size.
    expect(cropRect(FRAME, IMAGE, undefined, 1)).toEqual({
      x: 0,
      y: 0,
      width: 1484,
      height: 884,
      outWidth: 1187,
      outHeight: 707,
    });
  });

  it("keeps a picture that is already the frame's size exactly as it was taken", async () => {
    let cropped = false;
    const image = await captureTab(
      { tabId: 7, windowId: 9, isActive: true, frame: FRAME },
      {
        captureVisibleTab: async () => "data:image/png;base64,QUJD",
        measure: async () => FRAME,
        crop: async () => ((cropped = true), undefined),
      },
    );

    expect(image).toEqual({ data: "QUJD", mimeType: "image/png", cropped: false, scale: 1, width: 1187, height: 707 });
    expect(cropped).toBe(false);
  });

  it("fits a 2 560x1 440 frame under the long-edge and area budget, keeping its shape", () => {
    const size = viewportPictureSize({ width: 2560, height: 1440 }, 1);

    expect(size).toEqual({ width: 1429, height: 804 });
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(SCREENSHOT_MAX_EDGE_PX);
    expect(size.width * size.height).toBeLessThanOrEqual(SCREENSHOT_MAX_AREA_PX);
    expect(Math.abs(size.width / size.height - 2560 / 1440)).toBeLessThan(0.01);
    // A frame that already fits is left at its own size; the scale still applies on top.
    expect(viewportPictureSize(FRAME, 1)).toEqual(FRAME);
    expect(viewportPictureSize(FRAME, 0.5)).toEqual({ width: 593, height: 353 });
  });

  it("fits a large DPR 1 capture the same way", async () => {
    const large = { width: 2560, height: 1440 };
    const image = await captureTab(
      { tabId: 7, windowId: 9, isActive: true, frame: large },
      { captureVisibleTab: async () => "data:image/png;base64,QUJD", measure: async () => large, crop: cropOf(large) },
    );

    expect(image).toMatchObject({ cropped: false, scale: 1, width: 1429, height: 804 });
  });

  it("caps the image's own pixels when nobody could say what frame it is of", () => {
    const rect = cropRect(undefined, { width: 3000, height: 2000 }, undefined, 1);

    expect({ outWidth: rect.outWidth, outHeight: rect.outHeight }).toEqual({ outWidth: 1313, outHeight: 875 });
    // A small picture with no frame is the old behaviour: its own pixels, untouched.
    expect(cropRect(undefined, FRAME, undefined, 1)).toMatchObject({ outWidth: 1187, outHeight: 707 });
  });

  it("asks the protocol for a fitted picture of a large emulated viewport", async () => {
    const sent: Array<Record<string, unknown> | undefined> = [];
    const image = await captureTab(
      {
        tabId: 7,
        windowId: 9,
        isActive: true,
        frame: { width: 2560, height: 1440 },
        path: decideCapturePath({ width: 2560, height: 1440 }, undefined, 1),
      },
      {
        send: async (_tabId, method, params) => {
          if (method === "Page.captureScreenshot") sent.push(params);
          return method === "Page.captureScreenshot" ? { data: "QUJD" } : {};
        },
        measure: async () => ({ width: 1430, height: 804 }),
      },
    );

    const clip = (sent[0]?.["clip"] ?? {}) as { width: number; height: number; scale: number };
    expect({ width: clip.width, height: clip.height }).toEqual({ width: 2560, height: 1440 });
    expect(Math.round(clip.width * clip.scale)).toBeLessThanOrEqual(1430);
    expect(Math.round(clip.height * clip.scale)).toBeLessThanOrEqual(805);
    // The answer says the scale the agent asked for, and the size the picture actually is.
    expect(image).toEqual({ data: "QUJD", mimeType: "image/png", cropped: false, scale: 1, width: 1430, height: 804 });
  });

  /** Review minors: the two other branches of a fitted protocol picture. */
  const EMULATED_LARGE = { width: 2560, height: 1440 };

  function protocolCapture(deps: Pick<NonNullable<Parameters<typeof captureTab>[1]>, "measure" | "crop">) {
    return captureTab(
      {
        tabId: 7,
        windowId: 9,
        isActive: true,
        frame: EMULATED_LARGE,
        path: decideCapturePath(EMULATED_LARGE, undefined, 1),
      },
      { send: async (_tabId, method) => (method === "Page.captureScreenshot" ? { data: "QUJD" } : {}), ...deps },
    );
  }

  it("answers the size it asked the browser for when the picture cannot be measured", async () => {
    // A fitted clip was asked for; an unmeasured answer is still that picture, and leaving the size
    // out would leave the agent's later points unmapped against a picture that was shrunk.
    const image = await protocolCapture({ measure: async () => undefined });

    expect(image).toEqual({ data: "QUJD", mimeType: "image/png", cropped: false, scale: 1, width: 1429, height: 804 });
  });

  it("brings a surface that came back larger than asked down to the fitted size", async () => {
    const requests: CropRequest[] = [];
    const image = await protocolCapture({
      measure: async () => ({ width: 2560, height: 1440 }),
      crop: async (dataUrl, request) => {
        expect(dataUrl).toBe("data:image/png;base64,QUJD");
        requests.push(request);
        return { data: "Zml0dGVk", width: 1429, height: 804 };
      },
    });

    expect(requests).toEqual([{ frame: EMULATED_LARGE, scale: 1 }]);
    expect(image).toEqual({ data: "Zml0dGVk", mimeType: "image/png", cropped: false, scale: 1, width: 1429, height: 804 });
  });
});

/**
 * A whole-viewport picture leaves as a JPEG (012 change log 2026-10-17, R-281).
 *
 * Quality 0.75 first; while the base64 is over the frame budget it is encoded again, from the same
 * lossless picture, 0.05 lower each time down to 0.10. The pixel size never moves, so the space the
 * agent's points are mapped through is the same one a PNG would have set. A region stays a PNG.
 */
describe("a whole-viewport picture is a JPEG, stepped down under the frame budget", () => {
  function encoder(overUntil: number) {
    const qualities: number[] = [];
    const encodeJpeg = async (_png: string, quality: number) => {
      qualities.push(quality);
      return quality > overUntil ? "J".repeat(SCREENSHOT_MAX_BASE64_CHARS + 1) : `jpeg-${quality}`;
    };
    return { qualities, encodeJpeg };
  }

  it("encodes once at 0.75 when that fits", async () => {
    const { qualities, encodeJpeg } = encoder(1);
    const image = await captureTab(
      { tabId: 7, windowId: 9, isActive: true, frame: FRAME },
      { captureVisibleTab: async () => "data:image/png;base64,QUJD", measure: async () => FRAME, encodeJpeg },
    );

    expect(qualities).toEqual([0.75]);
    expect(image).toEqual({
      data: "jpeg-0.75",
      mimeType: "image/jpeg",
      cropped: false,
      scale: 1,
      width: 1187,
      height: 707,
    });
  });

  it("re-encodes 0.05 lower while over the budget, keeping the pixel size", async () => {
    const { qualities, encodeJpeg } = encoder(0.5);
    const image = await captureTab(
      { tabId: 7, windowId: 9, isActive: true, frame: FRAME },
      { captureVisibleTab: async () => "data:image/png;base64,QUJD", measure: async () => FRAME, encodeJpeg },
    );

    expect(qualities).toEqual([0.75, 0.7, 0.65, 0.6, 0.55, 0.5]);
    expect(image).toMatchObject({ data: "jpeg-0.5", mimeType: "image/jpeg", width: 1187, height: 707 });
  });

  it("stops at 0.10 and hands back that picture, still over, for the caller to refuse", async () => {
    const { qualities, encodeJpeg } = encoder(0);
    const image = await captureTab(
      { tabId: 7, windowId: 9, isActive: true, frame: FRAME },
      { captureVisibleTab: async () => "data:image/png;base64,QUJD", measure: async () => FRAME, encodeJpeg },
    );

    expect(qualities).toHaveLength(14);
    expect(qualities.at(-1)).toBe(0.1);
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.data.length).toBeGreaterThan(SCREENSHOT_MAX_BASE64_CHARS);
  });

  it("encodes the fitted protocol picture too", async () => {
    const { qualities, encodeJpeg } = encoder(1);
    const image = await captureTab(
      { tabId: 7, windowId: 9, isActive: true, frame: FRAME, path: decideCapturePath(FRAME, undefined, 1) },
      {
        send: async (_tabId, method) => (method === "Page.captureScreenshot" ? { data: "QUJD" } : {}),
        measure: async () => FRAME,
        encodeJpeg,
      },
    );

    expect(qualities).toEqual([0.75]);
    expect(image).toMatchObject({ data: "jpeg-0.75", mimeType: "image/jpeg", width: 1187, height: 707 });
  });

  it("keeps a region a PNG and never encodes it", async () => {
    const { qualities, encodeJpeg } = encoder(1);
    const image = await captureTab(
      { tabId: 7, windowId: 9, isActive: true, region: REGION, frame: FRAME },
      {
        captureVisibleTab: async () => "data:image/png;base64,QUJD",
        crop: async () => ({ data: "cmVnaW9u", width: 375, height: 125 }),
        encodeJpeg,
      },
    );

    expect(qualities).toEqual([]);
    expect(image).toMatchObject({ data: "cmVnaW9u", mimeType: "image/png", cropped: true });
  });

  it("says PNG when the worker has no canvas to encode with", async () => {
    const image = await captureTab(
      { tabId: 7, windowId: 9, isActive: true, frame: FRAME },
      {
        captureVisibleTab: async () => "data:image/png;base64,QUJD",
        measure: async () => FRAME,
        encodeJpeg: async () => undefined,
      },
    );

    expect(image).toMatchObject({ data: "QUJD", mimeType: "image/png" });
  });

  it("leaves a lossless picture as the PNG it is, for a caller that encodes it itself", async () => {
    const { qualities, encodeJpeg } = encoder(1);
    const image = await captureTab(
      { tabId: 7, windowId: 9, isActive: true, frame: FRAME, lossless: true },
      { captureVisibleTab: async () => "data:image/png;base64,QUJD", measure: async () => FRAME, encodeJpeg },
    );

    expect(qualities).toEqual([]);
    expect(image).toMatchObject({ data: "QUJD", mimeType: "image/png" });
  });
});
