import { describe, expect, it } from "vitest";
import { captureFrame, type FrameCaptureDeps } from "../src/service-worker/recording/frame-capture.js";

/**
 * 008/T218 — one frame of a recording (FR-101, R-133, design-notes §2).
 *
 * A frame is a screenshot taken the cheap way: `Page.captureScreenshot` on the attachment the tab
 * already has, as JPEG, which is a *command* and enables no domain. The fallback matters as much as
 * the primary path - a tab with developer tools open refuses the attachment, and a recording that
 * silently stopped at that tab would be worse than one frame in PNG - and so does what happens when
 * both fail: the frame is skipped and counted, never invented.
 *
 * The viewport is measured through the same attachment, because the offscreen page scales its
 * overlays by canvas ÷ viewport (R-136). The fallback has no attachment to measure through, so it
 * uses the last size this tab was measured at and refuses the frame when there is none: an overlay
 * drawn at a guessed scale is a ring in the wrong place, which is a lie about where the agent
 * clicked.
 */

type Sent = { method: string; params?: Record<string, unknown> };

type Fake = FrameCaptureDeps & {
  sent: Sent[];
  holders: string[];
};

function fakeDeps(options: {
  attach?: boolean;
  screenshot?: string | Error;
  viewport?: { width: number; height: number };
  photograph?: "ok" | "refused";
  lastViewport?: { width: number; height: number };
}): Fake {
  const sent: Sent[] = [];
  const holders: string[] = [];
  return {
    sent,
    holders,
    attachments: {
      acquire: async (_tabId, holder) => {
        holders.push(`acquire:${holder}`);
        return options.attach === false
          ? { ok: false, unavailableReason: "devtools-open" as const }
          : { ok: true };
      },
      drop: async (_tabId, holder) => {
        holders.push(`drop:${holder}`);
      },
      send: async (_tabId, method, params) => {
        sent.push({ method, ...(params === undefined ? {} : { params }) });
        if (method === "Page.getLayoutMetrics") {
          if (!options.viewport) throw new Error("no metrics");
          return { cssLayoutViewport: { clientWidth: options.viewport.width, clientHeight: options.viewport.height } };
        }
        if (method === "Page.captureScreenshot") {
          if (options.screenshot instanceof Error) throw options.screenshot;
          return { data: options.screenshot ?? "jpeg-bytes" };
        }
        return {};
      },
    },
    photograph: async () =>
      options.photograph === "ok"
        ? { ok: true, image: { data: "png-bytes", cropped: false } }
        : { ok: false, reason: "capture-refused" as const },
    ...(options.lastViewport === undefined ? {} : { lastViewport: options.lastViewport }),
  };
}

describe("captureFrame", () => {
  it("shoots JPEG through the attachment and measures the viewport there", async () => {
    const deps = fakeDeps({ viewport: { width: 1024, height: 768 }, screenshot: "jpeg-bytes" });

    const frame = await captureFrame(7, deps);

    expect(frame).toEqual({
      ok: true,
      jpegBase64: "jpeg-bytes",
      viewportWidth: 1024,
      viewportHeight: 768,
      fallback: false,
    });
    expect(deps.sent.map((call) => call.method)).toContain("Page.captureScreenshot");
    expect(deps.sent.find((call) => call.method === "Page.captureScreenshot")?.params).toEqual({
      format: "jpeg",
      quality: 70,
    });
  });

  it("holds the attachment under its own holder and lets it go again", async () => {
    const deps = fakeDeps({ viewport: { width: 800, height: 600 } });

    await captureFrame(7, deps);

    expect(deps.holders).toEqual(["acquire:recording", "drop:recording"]);
  });

  it("falls back to the tab photograph when the attachment is refused", async () => {
    const deps = fakeDeps({ attach: false, photograph: "ok", lastViewport: { width: 640, height: 480 } });

    const frame = await captureFrame(7, deps);

    expect(frame).toEqual({
      ok: true,
      jpegBase64: "png-bytes",
      viewportWidth: 640,
      viewportHeight: 480,
      fallback: true,
    });
    // Nothing was asked of a tab that refused the attachment.
    expect(deps.sent).toEqual([]);
    // The holder is dropped even on the path that never got it, so a refusal leaves no claim behind.
    expect(deps.holders).toEqual(["acquire:recording", "drop:recording"]);
  });

  it("falls back when the screenshot command itself fails", async () => {
    const deps = fakeDeps({
      viewport: { width: 1024, height: 768 },
      screenshot: new Error("target closed"),
      photograph: "ok",
    });

    const frame = await captureFrame(7, deps);

    expect(frame).toEqual({
      ok: true,
      jpegBase64: "png-bytes",
      viewportWidth: 1024,
      viewportHeight: 768,
      fallback: true,
    });
  });

  it("refuses the fallback when no viewport was ever measured for the tab", async () => {
    const deps = fakeDeps({ attach: false, photograph: "ok" });

    expect(await captureFrame(7, deps)).toEqual({ ok: false, reason: "no-viewport" });
  });

  it("answers not-ok when the attachment and the photograph both fail", async () => {
    const deps = fakeDeps({ attach: false, photograph: "refused", lastViewport: { width: 640, height: 480 } });

    expect(await captureFrame(7, deps)).toEqual({ ok: false, reason: "capture-failed" });
  });
});
