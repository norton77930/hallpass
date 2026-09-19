/**
 * What the offscreen document does with a message, minus the browser (008/T217, FR-103, FR-104,
 * FR-109, FR-121).
 *
 * `main.ts` is the listener and the two browser-only capabilities the export needs - rasterising a
 * captured JPEG, and minting a blob URL over the bytes. Everything that decides anything is here, in
 * a module that imports no `chrome.*` and no canvas, because the rules the S2 review cared about are
 * rules a node test should be able to read back:
 *
 *  - **who is answered**: this extension's own worker, and never a content script. A document with a
 *    listener is a document that can be talked to, and this one holds every frame of every open
 *    recording.
 *  - **what an export leaves behind**: the frames, all of them. The download happens in the worker
 *    and can fail, and a recording that was dropped at export time is one the worker cannot retry.
 *    `recording/clear` is the only message that drops frames, and the blob URLs handed out are
 *    counted until the worker revokes them - so `recording/count` answers two numbers and the
 *    document is closed only when both are zero.
 *  - **how the frames are encoded**: measured in one cheap pass, then streamed one at a time into
 *    the encoder (FR-109). Nothing here ever holds two frames' pixels.
 *  - **what the counter says**: the frame's position in the list over the last position, never the
 *    worker's action index. A capture that failed leaves a gap in those indexes, and a gap would
 *    otherwise be shown as `6 / 5`.
 */

import { composeGif, type ComposableFrame } from "./encode.js";
import { drawOverlays, type OverlayContext, type RecordedAction } from "./overlay.js";

/** One frame as the worker sends it. The JPEG travels as base64: a message cannot carry a blob. */
export type IncomingFrame = {
  /** The worker's own action number; 0 is the initial frame, taken at `start`. Not the position. */
  index: number;
  jpegBase64: string;
  viewportWidth: number;
  viewportHeight: number;
  action: RecordedAction | null;
};

/** One decoded frame, ready to be drawn on and then read once. */
export type RasterizedTarget = {
  context: OverlayContext;
  width: number;
  height: number;
  /** The canvas as it stands, read exactly once - after the overlays are on it. */
  readPixels(): Uint8ClampedArray;
};

/** Everything the document is holding: frames per session, and blob URLs nobody has revoked. */
export type RecordingStore = {
  frames: Map<string, IncomingFrame[]>;
  blobUrls: Set<string>;
};

export function createRecordingStore(): RecordingStore {
  return { frames: new Map(), blobUrls: new Set() };
}

export type RouterDeps = {
  /** `chrome.runtime.id`: the only sender whose messages are answered. */
  extensionId: string;
  store: RecordingStore;
  /** Browser-only: the size this frame will rasterise to, without keeping its pixels. */
  measure(jpegBase64: string): Promise<{ width: number; height: number }>;
  /** Browser-only: decodes the frame onto a canvas the overlays can be drawn on. */
  rasterize(jpegBase64: string): Promise<RasterizedTarget>;
  /** Browser-only: `URL.createObjectURL` over the finished GIF. */
  createBlobUrl(bytes: Uint8Array<ArrayBuffer>): string;
  /** Browser-only: `URL.revokeObjectURL`. */
  revokeBlobUrl(blobUrl: string): void;
};

/** The part of `chrome.runtime.MessageSender` that decides whether this document answers at all. */
export type RecordingSender = {
  id?: string | undefined;
  /** Set only when the message came from a page - which is exactly when it is refused. */
  tab?: unknown;
};

export type ExportReply = {
  blobUrl: string;
  width: number;
  height: number;
  bytes: number;
  frames: number;
};

type RecordingMessage = { type: string } & Record<string, unknown>;

const PREFIX = "recording/";

function isRecordingMessage(message: unknown): message is RecordingMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const { type } = message as { type?: unknown };
  return typeof type === "string" && type.startsWith(PREFIX);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function framesOf(store: RecordingStore, sessionId: string): IncomingFrame[] {
  const existing = store.frames.get(sessionId);
  if (existing) {
    return existing;
  }
  const started: IncomingFrame[] = [];
  store.frames.set(sessionId, started);
  return started;
}

/**
 * Draws and yields one frame at a time.
 *
 * The rasterised canvas is reachable only from this loop, so once the encoder has written the frame
 * and asked for the next, the one before it is collectable - which is the whole point of pulling
 * rather than building a list (FR-109).
 */
async function* composableFrames(
  frames: readonly IncomingFrame[],
  watermark: string,
  deps: RouterDeps,
): AsyncGenerator<ComposableFrame> {
  const lastStep = Math.max(frames.length - 1, 0);
  for (const [position, frame] of frames.entries()) {
    const target = await deps.rasterize(frame.jpegBase64);
    drawOverlays(
      target.context,
      { width: target.width, height: target.height, viewportWidth: frame.viewportWidth },
      frame.action,
      position,
      lastStep,
      watermark,
    );
    yield { rgba: target.readPixels(), width: target.width, height: target.height };
  }
}

/**
 * Encodes one session's frames and hands back a blob URL, keeping the frames where they are.
 *
 * Two passes over the list: the first asks each frame how big it will be, so the canvas is the
 * largest of them (FR-104) before a single frame's pixels are held; the second draws and encodes.
 */
async function exportRecording(
  sessionId: string,
  watermark: string,
  deps: RouterDeps,
): Promise<ExportReply> {
  const frames = deps.store.frames.get(sessionId) ?? [];
  let width = 0;
  let height = 0;
  for (const frame of frames) {
    const size = await deps.measure(frame.jpegBase64);
    width = Math.max(width, size.width);
    height = Math.max(height, size.height);
  }

  const bytes = await composeGif(
    { width, height, frameCount: frames.length },
    composableFrames(frames, watermark, deps),
  );
  const blobUrl = deps.createBlobUrl(bytes);
  // Counted, not forgotten: the worker revokes it once the download is written, and the document
  // stays open until it has.
  deps.store.blobUrls.add(blobUrl);
  return { blobUrl, width, height, bytes: bytes.length, frames: frames.length };
}

async function answer(message: RecordingMessage, deps: RouterDeps): Promise<unknown> {
  switch (message.type) {
    case "recording/add-frame": {
      const frames = framesOf(deps.store, message["sessionId"] as string);
      frames.push(message["frame"] as IncomingFrame);
      return { frames: frames.length };
    }
    case "recording/export":
      return exportRecording(message["sessionId"] as string, message["watermark"] as string, deps);
    case "recording/clear": {
      const sessionId = message["sessionId"] as string;
      const cleared = deps.store.frames.get(sessionId)?.length ?? 0;
      deps.store.frames.delete(sessionId);
      return { cleared };
    }
    case "recording/revoke": {
      const blobUrl = message["blobUrl"] as string;
      deps.revokeBlobUrl(blobUrl);
      deps.store.blobUrls.delete(blobUrl);
      return {};
    }
    case "recording/count":
      return { sessions: deps.store.frames.size, pendingBlobUrls: deps.store.blobUrls.size };
    default:
      // A `recording/` message this document does not know is the worker and the document being out
      // of step, which is worth saying rather than timing out.
      return { error: `unknown message ${message.type}` };
  }
}

/**
 * Answers one message, or does not answer it at all.
 *
 * `undefined` means "not mine": every other listener in the extension gets its own messages, and
 * answering one here would steal the reply channel from whoever the message was actually for. The
 * promise never rejects - a failure becomes `{error}`, because a listener that never replies is a
 * tool call that hangs, and the worker is the one that turns it into a refusal (`download-failed`).
 */
export function handleRecordingMessage(
  message: unknown,
  sender: RecordingSender,
  deps: RouterDeps,
): Promise<unknown> | undefined {
  // Not this extension's message, whoever it says it is - and never a page's: a content script
  // carries a tab, and nothing in a page may ask this document for a session's frames.
  if (sender.id !== deps.extensionId || sender.tab !== undefined) {
    return undefined;
  }
  if (!isRecordingMessage(message)) {
    return undefined;
  }
  return answer(message, deps).catch((error: unknown) => ({ error: messageOf(error) }));
}
