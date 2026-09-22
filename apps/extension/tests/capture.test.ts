import { describe, expect, it } from "vitest";
import {
  captureTab,
  captureThroughProtocol,
  cropRect,
  decideCapturePath,
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

  it("scales the whole picture when no region was asked for", () => {
    expect(cropRect(FRAME, IMAGE, undefined, 0.5)).toEqual({
      x: 0,
      y: 0,
      width: 1484,
      height: 884,
      outWidth: 742,
      outHeight: 442,
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

    expect(image).toEqual({ data: "cHJvdG9jb2w=", cropped: true, scale: 0.5, width: 150, height: 50 });
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

    expect(image).toEqual({ data: "aVZCT1J3MEtHZ28=", cropped: false, scale: 1 });
  });
});
