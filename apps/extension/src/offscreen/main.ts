/**
 * The offscreen document: where a session's frames live and where they become a GIF (008/T214,
 * FR-103, FR-104, FR-109, FR-121, R-134).
 *
 * The worker cannot hold the frames. It is evicted between tool calls, and the reference's answer to
 * that - a keep-alive ping that keeps the worker awake for the whole recording - is the trade D-008-2
 * rules out. So the frames are handed here as they are captured, and this document holds them in
 * memory, keyed by session, until a `recording/clear` takes them away.
 *
 * What this process may do is deliberately tiny, and FR-121 is the claim:
 *
 *  - it imports its siblings and `gifenc`, and nothing else;
 *  - it touches no `chrome.*` API but `chrome.runtime.onMessage`;
 *  - it never fetches, and never opens a connection of any kind;
 *  - it never speaks first - every message here is an answer to one the worker sent;
 *  - it holds frames and hands back bytes; it does not know what a tab, a page or a site is.
 *
 * This file is only the wiring: the listener, and the three things that genuinely need a browser -
 * decoding a JPEG, reading a canvas, minting a blob URL. What each message *means* is in
 * `router.ts`, where a node test can read it back.
 *
 * The download itself stays in the worker (design-notes §2): an offscreen document has no
 * `chrome.downloads`, and the blob URL it answers with is the whole of the hand-off.
 */

import { jpegBlobFromBase64, measureFrame, rasterizeFrame, readPixels } from "./rasterize.js";
import {
  createRecordingStore,
  handleRecordingMessage,
  type RasterizedTarget,
  type RouterDeps,
} from "./router.js";

const deps: RouterDeps = {
  extensionId: chrome.runtime.id,
  store: createRecordingStore(),
  measure: async (jpegBase64: string) => measureFrame(jpegBlobFromBase64(jpegBase64)),
  rasterize: async (jpegBase64: string): Promise<RasterizedTarget> => {
    const raster = await rasterizeFrame(jpegBlobFromBase64(jpegBase64));
    return {
      context: raster.context,
      width: raster.width,
      height: raster.height,
      readPixels: () => readPixels(raster.context, raster.width, raster.height),
    };
  },
  createBlobUrl: (bytes) => URL.createObjectURL(new Blob([bytes], { type: "image/gif" })),
  revokeBlobUrl: (blobUrl) => URL.revokeObjectURL(blobUrl),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const reply = handleRecordingMessage(message, sender, deps);
  if (!reply) {
    // Not a recording message, or not from this extension's worker: left for whoever it was for.
    return false;
  }
  void reply.then((value) => {
    sendResponse(value);
  });
  return true;
});
