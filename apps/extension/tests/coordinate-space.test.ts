import { describe, expect, it } from "vitest";
import {
  carriesPoint,
  spaceOfPicture,
  toPicturePoint,
  toViewportArgs,
  toViewportPoint,
  toViewportRegion,
  viewportChangedReason,
} from "../src/service-worker/agent-tools/coordinate-space.js";
import { captureFrameFacts } from "../src/service-worker/agent-tools/photograph.js";
import {
  AGENT_SCREENSHOT_SPACES_KEY,
  createScreenshotSpaceStore,
} from "../src/service-worker/screenshot-space-store.js";

/**
 * The pixels an agent's coordinates are in (012 change log 2026-10-17, R-280).
 *
 * An agent reads a point off the latest whole-viewport picture of a tab, and the page resolves
 * points in its own CSS pixels. When the picture had to be fitted (a 2 560x1 440 page is handed back
 * at 1 429x804), the two differ, and the one place that converts is `toViewportPoint`: every tool
 * that takes a point goes through it once, before anything is resolved or refused.
 */

const LARGE = { frame: { width: 2560, height: 1440 }, image: { width: 1429, height: 804 } };

describe("an agent's point, in the page's pixels", () => {
  it("maps a point off a fitted picture back into the frame", () => {
    expect(toViewportPoint({ x: 715, y: 402 }, LARGE)).toEqual({
      x: Math.round((715 * 2560) / 1429),
      y: Math.round((402 * 1440) / 804),
    });
  });

  it("passes a point through when no picture of the tab was taken", () => {
    expect(toViewportPoint({ x: 715, y: 402 }, undefined)).toEqual({ x: 715, y: 402 });
  });

  it("maps every point a tool takes, and nothing else", () => {
    const x = Math.round((100 * 2560) / 1429);
    const y = Math.round((50 * 1440) / 804);

    expect(toViewportArgs("computer", { tabId: 7, action: "left_click", x: 100, y: 50 }, LARGE)).toEqual({
      tabId: 7,
      action: "left_click",
      x,
      y,
    });
    expect(toViewportArgs("click", { tabId: 7, target: { x: 100, y: 50 } }, LARGE)).toEqual({
      tabId: 7,
      target: { x, y },
    });
    expect(toViewportArgs("drag", { tabId: 7, from: { x: 100, y: 50 }, to: { ref: "t_b" } }, LARGE)).toEqual({
      tabId: 7,
      from: { x, y },
      to: { ref: "t_b" },
    });
    expect(toViewportArgs("scroll", { tabId: 7, target: { x: 100, y: 50 } }, LARGE)).toEqual({
      tabId: 7,
      target: { x, y },
    });
    expect(
      toViewportArgs("upload_image", { tabId: 7, target: { coordinate: { x: 100, y: 50 } } }, LARGE),
    ).toEqual({ tabId: 7, target: { coordinate: { x, y } } });
    // A ref is an element, not a place; it has no pixels to be in.
    expect(toViewportArgs("click", { tabId: 7, target: { ref: "t_a" } }, LARGE)).toEqual({
      tabId: 7,
      target: { ref: "t_a" },
    });
    // `x`/`y` at the top level are a point only for `computer`; `viewport set` takes a size.
    expect(toViewportArgs("viewport", { tabId: 7, action: "set", width: 800, height: 600 }, LARGE)).toEqual({
      tabId: 7,
      action: "set",
      width: 800,
      height: 600,
    });
  });

  it("maps a region off the picture into the frame, never past it by a rounded pixel", () => {
    expect(toViewportRegion({ x: 100, y: 50, width: 200, height: 100 }, LARGE)).toEqual({
      x: Math.round((100 * 2560) / 1429),
      y: Math.round((50 * 1440) / 804),
      width: Math.round((300 * 2560) / 1429) - Math.round((100 * 2560) / 1429),
      height: Math.round((150 * 1440) / 804) - Math.round((50 * 1440) / 804),
    });
    // The whole picture is the whole frame, exactly.
    expect(toViewportRegion({ x: 0, y: 0, width: 1429, height: 804 }, LARGE)).toEqual({
      x: 0,
      y: 0,
      width: 2560,
      height: 1440,
    });
    // A sliver is still at least one pixel; no space leaves the region as asked.
    expect(toViewportRegion({ x: 3, y: 3, width: 1, height: 1 }, { frame: { width: 10, height: 10 }, image: { width: 100, height: 100 } })).toMatchObject({ width: 1, height: 1 });
    expect(toViewportRegion({ x: 1, y: 2, width: 3, height: 4 }, undefined)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("maps a point the page reports back into the picture the agent aims by", () => {
    expect(toPicturePoint({ x: 2560, y: 1440 }, LARGE)).toEqual({ x: 1429, y: 804 });
    expect(toPicturePoint({ x: 40, y: 50 }, undefined)).toEqual({ x: 40, y: 50 });
  });

  it("reads a space only off a picture whose size and frame are both known", () => {
    expect(spaceOfPicture({ width: 1429, height: 804 }, { width: 2560, height: 1440 })).toEqual(LARGE);
    expect(spaceOfPicture({}, { width: 2560, height: 1440 })).toBeUndefined();
    expect(spaceOfPicture({ width: 1429, height: 804 }, undefined)).toBeUndefined();
  });
});

/**
 * A space read against a frame that has since changed width (012 change log 2026-10-17, R-282).
 *
 * The owner can resize the window or zoom the page between the picture and the click; the stored
 * ratio would then put the point somewhere else. A width more than a pixel away refuses the point;
 * height is ignored (an infobar changes only that), and nothing to compare against never refuses.
 */
describe("a point read off a picture of a frame that is no longer that wide", () => {
  it("names the change when the width moved by more than a pixel", () => {
    const reason = viewportChangedReason(LARGE, 2048);
    expect(reason).toBe(
      "viewport-changed (screenshot of a 2560 px wide page, now 2048); the window width or page zoom " +
        "changed since the last screenshot - take a new screenshot first",
    );
  });

  it("passes a pixel of rounding, no picture, and a width nobody could measure", () => {
    expect(viewportChangedReason(LARGE, 2561)).toBeUndefined();
    expect(viewportChangedReason(LARGE, 2559)).toBeUndefined();
    expect(viewportChangedReason(undefined, 900)).toBeUndefined();
    expect(viewportChangedReason(LARGE, undefined)).toBeUndefined();
  });

  it("measures the frame in CSS pixels under page zoom, where the tab's own size does not move", async () => {
    // Measured (R-282): a 1 187-wide tab reports 1 187 at 100 %, 125 % and 80 % zoom while the
    // page's innerWidth is 1 187 / 950 / 1 484 - the tab's size divided by the zoom.
    const tabSize = async () => ({ width: 1187, height: 707 });
    expect((await captureFrameFacts(7, { tabSize, tabZoom: async () => 1.25 })).frame).toEqual({ width: 950, height: 566 });
    expect((await captureFrameFacts(7, { tabSize, tabZoom: async () => 0.8 })).frame).toEqual({ width: 1484, height: 884 });
    // A zoom nobody could read is 100 %, which is what the frame meant before.
    expect((await captureFrameFacts(7, { tabSize, tabZoom: async () => undefined })).frame).toEqual({ width: 1187, height: 707 });
  });

  it("knows which calls carry a point, and which only name elements", () => {
    expect(carriesPoint("computer", { action: "left_click", x: 1, y: 2 })).toBe(true);
    expect(carriesPoint("computer", { action: "screenshot" })).toBe(false);
    expect(carriesPoint("click", { target: { x: 1, y: 2 } })).toBe(true);
    expect(carriesPoint("click", { target: { ref: "t_a" } })).toBe(false);
    expect(carriesPoint("drag", { from: { ref: "t_a" }, to: { x: 1, y: 2 } })).toBe(true);
    expect(carriesPoint("upload_image", { target: { coordinate: { x: 1, y: 2 } } })).toBe(true);
    expect(carriesPoint("type", { text: "hi" })).toBe(false);
  });
});

describe("the latest picture's space is kept per tab", () => {
  function area() {
    const items: Record<string, unknown> = {};
    return {
      items,
      async get(keys: string[]) {
        const out: Record<string, unknown> = {};
        for (const key of keys) if (key in items) out[key] = items[key];
        return out;
      },
      async set(values: Record<string, unknown>) {
        Object.assign(items, values);
      },
    };
  }

  it("survives a new worker reading the same session area, and forgets on request", async () => {
    const session = area();
    await createScreenshotSpaceStore({ session }).remember(7, LARGE);

    // A worker evicted and started again builds a new store over the same area.
    const fresh = createScreenshotSpaceStore({ session });
    expect(await fresh.get(7)).toEqual(LARGE);
    expect(await fresh.get(8)).toBeUndefined();
    expect(Object.keys(session.items)).toEqual([AGENT_SCREENSHOT_SPACES_KEY]);

    await fresh.remember(7, undefined);
    expect(await fresh.get(7)).toBeUndefined();
  });

  /**
   * Review minor (2026-10-17): the bound keeps the most *recent* tabs. Tab ids are integer-like
   * keys, which object order sorts numerically and a storage round trip does not preserve, so
   * order cannot be the clock - a newer picture of a low-numbered tab must not be the one to go.
   */
  it("evicts the least recently pictured tab, not the lowest id, across a storage round trip", async () => {
    const items: Record<string, unknown> = {};
    // What `chrome.storage.session` does to a value: serialised, and handed back a new object.
    const session = {
      async get(keys: string[]) {
        return JSON.parse(JSON.stringify(Object.fromEntries(keys.filter((k) => k in items).map((k) => [k, items[k]]))));
      },
      async set(values: Record<string, unknown>) {
        Object.assign(items, JSON.parse(JSON.stringify(values)));
      },
    };
    const store = createScreenshotSpaceStore({ session });

    await store.remember(1000, LARGE);
    for (let tabId = 1; tabId <= 64; tabId += 1) await store.remember(tabId, LARGE);

    // 65 tabs pictured; the first one pictured goes, and the lowest id - pictured after it - stays.
    const fresh = createScreenshotSpaceStore({ session });
    expect(await fresh.get(1000)).toBeUndefined();
    expect(await fresh.get(1)).toEqual(LARGE);
    expect(await fresh.get(64)).toEqual(LARGE);

    // A new picture of an old tab makes it recent again: tab 1 survives the next eviction, tab 2 does not.
    await fresh.remember(1, LARGE);
    await fresh.remember(2000, LARGE);
    expect(await fresh.get(1)).toEqual(LARGE);
    expect(await fresh.get(2)).toBeUndefined();
    expect(await fresh.get(2000)).toEqual(LARGE);
  });

  it("reads a malformed record as no space, and works with no area at all", async () => {
    const session = area();
    session.items[AGENT_SCREENSHOT_SPACES_KEY] = { "7": { frame: { width: "wide" } } };
    expect(await createScreenshotSpaceStore({ session }).get(7)).toBeUndefined();

    const none = createScreenshotSpaceStore({ session: undefined });
    await none.remember(7, LARGE);
    expect(await none.get(7)).toBeUndefined();
  });
});
