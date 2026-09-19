import { measureViewport } from "../agent-tools/computer.js";
import type { AgentInputAttachments } from "../agent-tools/input.js";
import { photographTab } from "../agent-tools/photograph.js";

/**
 * One frame of a recording (008/T218, FR-101, R-133, design-notes §2).
 *
 * A frame is a screenshot, and which screenshot path it takes is the whole of this file. The
 * primary one is `Page.captureScreenshot` on the debugger attachment the tab already has for its
 * input: JPEG at a bounded quality, because 200 full-resolution PNGs are hundreds of megabytes, and
 * because `captureVisibleTab` *activates* the tab to shoot it - the owner's window would flicker on
 * every recorded action.
 *
 * **The holder is `"recording"`, and it enables no domain.** The invariant `agent-tools/input.ts`
 * states - no domain whose events we consume, and nothing carrying page content, is enabled outside
 * the owner's diagnostics grant - holds here unchanged: `Page.captureScreenshot` and
 * `Page.getLayoutMetrics` are *commands*, answered once to the caller that sent them; neither is an
 * `enable`, so nothing is subscribed to and nothing is buffered. The holder exists only so that the
 * attachment a recording made is let go of when the recording is done with it, rather than riding
 * on `input`'s claim and outliving it.
 *
 * The fallback is `photographTab` (`captureVisibleTab`, PNG) for the tab whose attachment Chrome
 * refuses - developer tools are open on it, or it is a page no extension may touch. The offscreen
 * document re-encodes it, so a fallback frame costs a re-encode and the owner one flicker rather
 * than a hole in the recording.
 *
 * The viewport is measured through the attachment and never from `devicePixelRatio` (R-136): the
 * offscreen page scales its overlays by canvas ÷ viewport, so this number is what puts the ring
 * where the click was. The fallback path has no attachment to measure through and uses the last
 * size measured for that tab; with no such size it refuses the frame rather than guessing one,
 * because an overlay at a guessed scale is a ring drawn somewhere the agent did not click.
 */

/** The reference's own budget for a recorded frame (design-notes §2): legible, and a fraction of a PNG. */
export const RECORDING_JPEG_QUALITY = 70;

export type FrameCaptureDeps = {
  attachments: Pick<AgentInputAttachments, "acquire" | "drop" | "send">;
  /** Injected by tests; the real one is `photographTab`. */
  photograph?: typeof photographTab;
  /** The last viewport measured for this tab, for the path that cannot measure one. */
  lastViewport?: { width: number; height: number };
};

export type FrameCapture =
  | {
      ok: true;
      /** The image as the offscreen document takes it: base64, no data-url prefix. */
      jpegBase64: string;
      viewportWidth: number;
      viewportHeight: number;
      /** True when this is a `captureVisibleTab` PNG rather than a CDP JPEG. */
      fallback: boolean;
    }
  | { ok: false; reason: "capture-failed" | "no-viewport" };

export async function captureFrame(tabId: number, deps: FrameCaptureDeps): Promise<FrameCapture> {
  const photograph = deps.photograph ?? photographTab;
  let viewport = deps.lastViewport;
  const acquired = await deps.attachments.acquire(tabId, "recording");
  try {
    if (acquired.ok) {
      const measured = await measureViewport(tabId, (id, method, params) =>
        deps.attachments.send(id, method, params),
      );
      if (measured) viewport = measured;
      try {
        const shot = await deps.attachments.send(tabId, "Page.captureScreenshot", {
          format: "jpeg",
          quality: RECORDING_JPEG_QUALITY,
        });
        const data = shot["data"];
        if (typeof data === "string" && data.length > 0 && viewport) {
          return {
            ok: true,
            jpegBase64: data,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            fallback: false,
          };
        }
      } catch {
        // The tab went away mid-shot, or the attachment did. Both are worth one attempt at the
        // other path before the frame is given up on.
      }
    }
  } finally {
    // Dropped on every path, including the one that never got the attachment: `drop` on a tab with
    // no record is a no-op, and a claim left behind would keep a debugger on a tab nothing is
    // recording through any more.
    await deps.attachments.drop(tabId, "recording");
  }
  if (!viewport) return { ok: false, reason: "no-viewport" };
  const photographed = await photograph({ tabId });
  if (!photographed.ok) return { ok: false, reason: "capture-failed" };
  return {
    ok: true,
    jpegBase64: photographed.image.data,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    fallback: true,
  };
}
