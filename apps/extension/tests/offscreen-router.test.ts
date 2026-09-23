import { describe, expect, it } from "vitest";
import type { OverlayContext } from "../src/offscreen/overlay.js";
import {
  createRecordingStore,
  handleRecordingMessage,
  type IncomingFrame,
  type RasterizedTarget,
  type RouterDeps,
} from "../src/offscreen/router.js";

/**
 * 008/T217 — what the offscreen document answers, without an offscreen document.
 *
 * The routing used to live inside `chrome.runtime.onMessage.addListener` in `main.ts`, where the
 * only way to find out what it replies was to load the extension. It is a free function here, over
 * deps that name the two things a browser is actually needed for (rasterising a JPEG, minting a blob
 * URL), so the rules the S2 review cared about can be read off a test:
 *
 *  - it answers its own extension's worker and nothing else - never a content script (FR-121);
 *  - an export **keeps** the frames, because a download that fails has to be retryable, and the blob
 *    URL it handed back is counted until the worker revokes it (FR-103);
 *  - the counter is the frame's position in the list, not the worker's action index, so a capture
 *    that failed can never produce `6 / 5`.
 */

const EXTENSION_ID = "aaaabbbbccccddddeeeeffffgggghhhh";
const WATERMARK = "Hallpass 0.6.0";

type Harness = {
  deps: RouterDeps;
  /** Every string the overlays wrote, across every frame of the export. */
  texts: string[];
  blobUrls: string[];
  revoked: string[];
};

/** Enough of a 2D context to be drawn on, remembering only the text that was written. */
function textContext(texts: string[]): OverlayContext {
  return {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textBaseline: "top",
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    stroke: () => undefined,
    fillRect: () => undefined,
    fillText: (text: string) => {
      texts.push(text);
    },
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
}

const FRAME_WIDTH = 12;
const FRAME_HEIGHT = 8;

function harness(): Harness {
  const texts: string[] = [];
  const blobUrls: string[] = [];
  const revoked: string[] = [];
  const deps: RouterDeps = {
    extensionId: EXTENSION_ID,
    store: createRecordingStore(),
    measure: async () => ({ width: FRAME_WIDTH, height: FRAME_HEIGHT }),
    rasterize: async (): Promise<RasterizedTarget> => ({
      context: textContext(texts),
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      readPixels: () => new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4).fill(255),
    }),
    createBlobUrl: (bytes) => {
      const url = `blob:fake/${blobUrls.length}#${bytes.length}`;
      blobUrls.push(url);
      return url;
    },
    revokeBlobUrl: (url) => {
      revoked.push(url);
    },
  };
  return { deps, texts, blobUrls, revoked };
}

/** A frame as the worker sends it; `index` is the worker's action number, not the position. */
function frame(index: number): IncomingFrame {
  return {
    index,
    jpegBase64: "",
    viewportWidth: FRAME_WIDTH,
    viewportHeight: FRAME_HEIGHT,
    action: index === 0 ? null : { index, tool: "click", label: `click #${index}` },
  };
}

const FROM_WORKER = { id: EXTENSION_ID };

function ask(deps: RouterDeps, message: unknown, sender: unknown = FROM_WORKER): Promise<unknown> {
  const reply = handleRecordingMessage(
    message,
    sender as { id?: string | undefined; tab?: unknown },
    deps,
  );
  expect(reply, "the router refused a message it should have answered").toBeDefined();
  return reply as Promise<unknown>;
}

async function addFrames(deps: RouterDeps, sessionId: string, indexes: number[]): Promise<void> {
  for (const index of indexes) {
    await ask(deps, { type: "recording/add-frame", sessionId, frame: frame(index) });
  }
}

describe("routing the worker's recording messages inside the offscreen document (008/T217)", () => {
  it("answers this extension's worker and no one else", async () => {
    const { deps } = harness();
    const count = { type: "recording/count" };

    expect(handleRecordingMessage(count, { id: "some-other-extension" }, deps)).toBeUndefined();
    // A content script carries a tab; nothing in a page may ask this document anything.
    expect(
      handleRecordingMessage(count, { id: EXTENSION_ID, tab: { id: 7 } }, deps),
    ).toBeUndefined();
    expect(handleRecordingMessage(count, {}, deps)).toBeUndefined();

    await expect(ask(deps, count)).resolves.toEqual({ sessions: 0, pendingBlobUrls: 0 });
  });

  it("leaves every message that is not a recording message to whoever it was for", () => {
    const { deps } = harness();

    expect(handleRecordingMessage({ type: "agent/ping" }, FROM_WORKER, deps)).toBeUndefined();
    expect(handleRecordingMessage("recording/count", FROM_WORKER, deps)).toBeUndefined();
    expect(handleRecordingMessage(null, FROM_WORKER, deps)).toBeUndefined();
    expect(handleRecordingMessage({ type: 7 }, FROM_WORKER, deps)).toBeUndefined();
  });

  it("takes frames and says how many it holds", async () => {
    const { deps } = harness();

    await expect(
      ask(deps, { type: "recording/add-frame", sessionId: "s1", frame: frame(0) }),
    ).resolves.toEqual({ frames: 1 });
    await expect(
      ask(deps, { type: "recording/add-frame", sessionId: "s1", frame: frame(1) }),
    ).resolves.toEqual({ frames: 2 });
  });

  it("keeps the frames after an export and counts the blob URL it handed back", async () => {
    const { deps, blobUrls, revoked } = harness();
    await addFrames(deps, "s1", [0, 1]);

    const exported = (await ask(deps, {
      type: "recording/export",
      sessionId: "s1",
      watermark: WATERMARK,
    })) as { blobUrl: string; width: number; height: number; bytes: number; frames: number };

    expect(exported.blobUrl).toBe(blobUrls[0]);
    expect(exported.width).toBe(FRAME_WIDTH);
    expect(exported.height).toBe(FRAME_HEIGHT);
    expect(exported.frames).toBe(2);
    expect(exported.bytes).toBeGreaterThan(0);
    // The download has not happened yet, so the frames are still here to export a second time.
    await expect(ask(deps, { type: "recording/count" })).resolves.toEqual({
      sessions: 1,
      pendingBlobUrls: 1,
    });

    const again = (await ask(deps, {
      type: "recording/export",
      sessionId: "s1",
      watermark: WATERMARK,
    })) as { blobUrl: string; frames: number };
    expect(again.frames).toBe(2);
    expect(again.blobUrl).not.toBe(exported.blobUrl);
    await expect(ask(deps, { type: "recording/count" })).resolves.toEqual({
      sessions: 1,
      pendingBlobUrls: 2,
    });

    await expect(
      ask(deps, { type: "recording/revoke", blobUrl: exported.blobUrl }),
    ).resolves.toEqual({});
    await expect(
      ask(deps, { type: "recording/revoke", blobUrl: again.blobUrl }),
    ).resolves.toEqual({});
    expect(revoked).toEqual([exported.blobUrl, again.blobUrl]);

    await expect(ask(deps, { type: "recording/clear", sessionId: "s1" })).resolves.toEqual({
      cleared: 2,
    });
    await expect(ask(deps, { type: "recording/count" })).resolves.toEqual({
      sessions: 0,
      pendingBlobUrls: 0,
    });
  });

  it("numbers the counter by the frame's position, never by the worker's action index", async () => {
    const { deps, texts } = harness();
    // The worker skipped a capture, so its own indexes jump: 0, 3, 7.
    await addFrames(deps, "s1", [0, 3, 7]);

    await ask(deps, { type: "recording/export", sessionId: "s1", watermark: WATERMARK });

    const counters = texts.filter((text) => /^\d+ \/ \d+$/.test(text));
    expect(counters).toEqual(["0 / 2", "1 / 2", "2 / 2"]);
    // The action's own number is still what the label shows (FR-105).
    expect(texts).toContain("#7 click #7");
  });

  it("replies with an error rather than leaving the worker waiting", async () => {
    const { deps } = harness();

    await expect(ask(deps, { type: "recording/thump" })).resolves.toEqual({
      error: expect.stringMatching(/unknown message recording\/thump/),
    });
    // Nothing was ever added under this session, so there is nothing to encode.
    await expect(
      ask(deps, { type: "recording/export", sessionId: "gone", watermark: WATERMARK }),
    ).resolves.toEqual({ error: expect.stringMatching(/no frames/i) });
  });
});
