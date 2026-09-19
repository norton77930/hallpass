/**
 * Photographing a tab (003/T036, FR-039).
 *
 * `chrome.tabs.captureVisibleTab` photographs *the active tab of a window* and nothing else - there
 * is no per-tab capture in MV3 without the debugger, which US6 owns and this does not use. The
 * agent's tabs are usually not active, so a capture of an agent tab means: bring it to the front,
 * take the picture, and put the owner's tab back. That visible flicker is a real cost, so it is
 * stated in the tool's own description rather than hidden here.
 *
 * Cropping happens in the worker with `OffscreenCanvas`, which MV3 service workers have. When it is
 * not there the whole viewport is returned and the caller is told it was not cropped: a picture of
 * the wrong rectangle, silently, is the one answer that would mislead.
 */

export type CaptureRegion = { x: number; y: number; width: number; height: number };

/** A base64 PNG, without the data-url prefix, and whether the requested region was applied. */
export type CapturedImage = { data: string; cropped: boolean };

/** What `captureVisibleTab` answers with, so a test can hand back a picture without a browser. */
export type CaptureDeps = {
  captureVisibleTab?: (windowId: number) => Promise<string>;
  activateTab?: (tabId: number) => Promise<void>;
  crop?: (dataUrl: string, region: CaptureRegion) => Promise<string | undefined>;
};

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
 * Crops a PNG data url to a region, in the worker.
 *
 * `createImageBitmap` + `OffscreenCanvas` are both available to an MV3 service worker; when either
 * is missing the answer is `undefined`, which the caller turns into "the whole viewport, not
 * cropped" rather than into a failure. A picture is still a true picture of the tab.
 */
async function cropWithCanvas(dataUrl: string, region: CaptureRegion): Promise<string | undefined> {
  const globals = globalThis as {
    createImageBitmap?: typeof createImageBitmap;
    OffscreenCanvas?: typeof OffscreenCanvas;
  };
  if (!globals.createImageBitmap || !globals.OffscreenCanvas) {
    return undefined;
  }
  try {
    /**
     * Decoded here rather than through `fetch(dataUrl)`.
     *
     * An extension service worker's content security policy does not list `data:` in `connect-src`,
     * so fetching the capture's own data url fails silently and every crop would quietly come back
     * as the whole viewport. `atob` is not subject to that, and the bytes are the same bytes.
     */
    const binaryText = atob(base64Of(dataUrl));
    const encoded = new Uint8Array(binaryText.length);
    for (let index = 0; index < binaryText.length; index += 1) {
      encoded[index] = binaryText.charCodeAt(index);
    }
    const source = await globals.createImageBitmap(new Blob([encoded], { type: "image/png" }));
    // Clamped to the picture: a region larger than the viewport is an over-reach, not an error, and
    // the honest answer is the part of it that exists.
    const width = Math.min(region.width, Math.max(source.width - region.x, 0));
    const height = Math.min(region.height, Math.max(source.height - region.y, 0));
    if (width <= 0 || height <= 0) {
      return undefined;
    }
    const canvas = new globals.OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }
    (context as OffscreenCanvasRenderingContext2D).drawImage(
      source,
      region.x,
      region.y,
      width,
      height,
      0,
      0,
      width,
      height,
    );
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  } catch {
    return undefined;
  }
}

/**
 * Captures one tab, activating it first when it is not the one its window is showing.
 *
 * `activeTabId` is what gets the front back afterwards. It is passed in rather than looked up here
 * so this adapter never decides which tab the owner was on - the caller, which already listed the
 * window's tabs, knows.
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
  },
  deps: CaptureDeps = {},
): Promise<CapturedImage> {
  const capture = deps.captureVisibleTab ?? captureWithChrome;
  const activate = deps.activateTab ?? activateWithChrome;
  const crop = deps.crop ?? cropWithCanvas;

  if (!input.isActive) {
    await activate(input.tabId);
  }
  try {
    const dataUrl = await capture(input.windowId);
    if (!input.region) {
      return { data: base64Of(dataUrl), cropped: false };
    }
    const cropped = await crop(dataUrl, input.region);
    return cropped === undefined
      ? { data: base64Of(dataUrl), cropped: false }
      : { data: cropped, cropped: true };
  } finally {
    // Always, including after a capture that threw: the owner's window is not the agent's to leave
    // showing a tab they did not choose.
    if (!input.isActive && input.restoreTabId !== undefined) {
      await activate(input.restoreTabId).catch(() => undefined);
    }
  }
}
