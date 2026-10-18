import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { captureTab } from "../src/chrome-adapters/capture.js";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentReads, SCREENSHOT_MAX_BASE64_CHARS } from "../src/service-worker/agent-tools/reads.js";
import { toViewportPoint, toViewportRegion } from "../src/service-worker/agent-tools/coordinate-space.js";

/**
 * 003/T035 — `screenshot` (US2, FR-039).
 *
 * The browser can only photograph the tab a window is currently showing, and an agent's tab usually
 * is not it. So the claims here are about the *displacement*: the agent's tab is brought forward
 * only when it has to be, and the owner's tab is put back afterwards even when the capture failed -
 * a window left showing a tab the owner did not choose is the agent taking something from them.
 *
 * The other two are about honesty. A region the worker could not crop comes back as the whole
 * viewport with `cropped: false`, never as a picture of the wrong rectangle. And an image too large
 * for one native-messaging frame is refused for that one call, rather than breaking the link for
 * every call after it.
 */

const AGENT_TAB = 7;
const OWNER_TAB = 1;
const WINDOW = 900;

type FakeTab = { id: number; url: string; groupId: number; active: boolean; windowId: number };

function tabs(agentActive: boolean): FakeTab[] {
  return [
    { id: OWNER_TAB, url: "https://owner.test/", groupId: -1, active: !agentActive, windowId: WINDOW },
    { id: AGENT_TAB, url: "https://fixtures.test/ordinary", groupId: 100, active: agentActive, windowId: WINDOW },
  ];
}

/**
 * The frame every answer here is in (012/T310, R-166): a 1 200x800 window on a DPR 1.25 display
 * reports this viewport, and a region is asked for in these pixels rather than the picture's.
 */
const FRAME = { width: 1187, height: 707 };

function harness(input: {
  agentActive?: boolean;
  captureDeps?: Parameters<typeof createAgentReads>[0]["captureDeps"];
  /** 012: what `viewport set` recorded for this tab, when a session set one. */
  currentViewport?: Parameters<typeof createAgentReads>[0]["currentViewport"];
  sendOverAttachment?: Parameters<typeof createAgentReads>[0]["sendOverAttachment"];
  tabSize?: Parameters<typeof createAgentReads>[0]["tabSize"];
  ensureAttached?: Parameters<typeof createAgentReads>[0]["ensureAttached"];
  screenshotSpaces?: Parameters<typeof createAgentReads>[0]["screenshotSpaces"];
}) {
  const listTabs = vi.fn(async () => tabs(input.agentActive ?? false));
  const diagnostics: string[] = [];
  const runner = createAgentReads({
    context: testSessionContexts(),
    bindings: createAgentPageBindings(),
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    listTabs: listTabs as unknown as typeof import("../src/chrome-adapters/tabs.js").queryTabSnapshots,
    capture: captureTab,
    tabSize: input.tabSize ?? (async () => FRAME),
    reportDiagnostic: (code) => void diagnostics.push(code),
    ...(input.captureDeps ? { captureDeps: input.captureDeps } : {}),
    ...(input.currentViewport ? { currentViewport: input.currentViewport } : {}),
    ...(input.sendOverAttachment ? { sendOverAttachment: input.sendOverAttachment } : {}),
    ...(input.ensureAttached ? { ensureAttached: input.ensureAttached } : {}),
    ...(input.screenshotSpaces ? { screenshotSpaces: input.screenshotSpaces } : {}),
  });
  return { runner, diagnostics };
}

function request(args: Record<string, unknown>): AgentNativeRequest {
  return { callId: "call-1", sessionId: "session-h1", tool: "screenshot", tabId: AGENT_TAB, args };
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("T035 agent screenshot", () => {
  beforeEach(() => {
    (globalThis as { chrome?: unknown }).chrome = { tabs: { getZoom: async () => 1 } };
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("brings the agent's tab forward, captures, and puts the owner's tab back", async () => {
    const activated: number[] = [];
    const { runner } = harness({
      captureDeps: {
        captureVisibleTab: async () => PNG,
        activateTab: async (tabId) => void activated.push(tabId),
      },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB }));

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
        cropped: false,
        // 012/FR-158: the CSS size the picture is of, and which of it the picture covers. Without
        // the pair an agent measuring the image has no way to know which pixels its numbers are in.
        scale: 1,
        frame: FRAME,
        coverage: "viewport",
      },
    });
    // Forward, then back. The owner's window is not the agent's to leave rearranged.
    expect(activated).toEqual([AGENT_TAB, OWNER_TAB]);
  });

  it("names the type the bytes are: a whole viewport as a JPEG, a region as a PNG (R-281)", async () => {
    const { runner } = harness({
      captureDeps: {
        captureVisibleTab: async () => PNG,
        activateTab: async () => undefined,
        measure: async () => FRAME,
        crop: async () => ({ data: "cmVnaW9u", width: 125, height: 63 }),
        encodeJpeg: async () => "/9j/4AAQ",
      },
    });

    const whole = await runner.run(request({ tabId: AGENT_TAB }));
    const region = await runner.run(request({ tabId: AGENT_TAB, region: { x: 4, y: 8, width: 100, height: 50 } }));

    expect(whole.result).toMatchObject({ mimeType: "image/jpeg", data: "/9j/4AAQ" });
    expect(region.result).toMatchObject({ mimeType: "image/png", data: "cmVnaW9u" });
  });

  it("leaves the window alone when the agent's tab is already the one on screen", async () => {
    const activated: number[] = [];
    const { runner } = harness({
      agentActive: true,
      captureDeps: {
        captureVisibleTab: async () => PNG,
        activateTab: async (tabId) => void activated.push(tabId),
      },
    });

    await runner.run(request({ tabId: AGENT_TAB }));

    expect(activated).toEqual([]);
  });

  it("puts the owner's tab back even when the capture failed", async () => {
    const activated: number[] = [];
    const { runner } = harness({
      captureDeps: {
        captureVisibleTab: async () => {
          throw new Error("Cannot access contents of the page");
        },
        activateTab: async (tabId) => void activated.push(tabId),
      },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB }));

    // FR-039: the pages Chrome refuses to photograph are exactly the ones a read calls not-readable.
    expect(response).toEqual({ callId: "call-1", outcome: "not-readable", reason: "capture-refused" });
    expect(activated).toEqual([AGENT_TAB, OWNER_TAB]);
  });

  it("crops in the worker when a region is asked for", async () => {
    const requests: unknown[] = [];
    const { runner } = harness({
      captureDeps: {
        captureVisibleTab: async () => PNG,
        activateTab: async () => undefined,
        crop: async (_dataUrl, cropRequest) => {
          requests.push(cropRequest);
          return { data: "Y3JvcHBlZA==", width: 125, height: 63 };
        },
      },
    });

    const response = await runner.run(
      request({ tabId: AGENT_TAB, region: { x: 4, y: 8, width: 100, height: 50 }, scale: 0.5 }),
    );

    expect(response.result).toEqual({
      mimeType: "image/png",
      data: "Y3JvcHBlZA==",
      cropped: true,
      width: 125,
      height: 63,
      scale: 0.5,
      frame: FRAME,
      coverage: "region",
      region: { x: 4, y: 8, width: 100, height: 50 },
    });
    // The canvas pass is handed the frame as well as the region (012/FR-163): the density it crops
    // at is the picture's own, `image.width / frame.width`, and only the frame says what that is.
    expect(requests).toEqual([{ frame: FRAME, region: { x: 4, y: 8, width: 100, height: 50 }, scale: 0.5 }]);
  });

  it("refuses a region that is not inside the frame, before it photographs anything", async () => {
    const captured: number[] = [];
    const { runner } = harness({
      captureDeps: {
        captureVisibleTab: async (windowId) => {
          captured.push(windowId);
          return PNG;
        },
        activateTab: async () => undefined,
      },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB, region: { x: 1100, y: 0, width: 200, height: 100 } }));

    // 012/FR-164: the silent clamp is gone. A rectangle the viewport does not contain is a question
    // about somewhere the agent cannot see, and the frame is what the next attempt is aimed with.
    expect(response).toEqual({
      callId: "call-1",
      outcome: "failed",
      reason: "region-outside-viewport (frame 1187x707)",
    });
    expect(captured).toEqual([]);
  });

  it("returns the whole viewport, and says so, when it could not crop", async () => {
    const { runner } = harness({
      captureDeps: {
        captureVisibleTab: async () => PNG,
        activateTab: async () => undefined,
        // What a worker without `OffscreenCanvas` answers. A picture of the wrong rectangle,
        // silently, is the one answer that would mislead.
        crop: async () => undefined,
      },
    });

    const response = await runner.run(
      request({ tabId: AGENT_TAB, region: { x: 0, y: 0, width: 10, height: 10 }, scale: 0.5 }),
    );

    // And the scale it could not apply is reported as the 1 it actually is, rather than as the 0.5
    // that was asked for: the picture is the size it is.
    expect(response.result).toEqual({
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
      cropped: false,
      scale: 1,
      frame: FRAME,
      coverage: "viewport",
      region: { x: 0, y: 0, width: 10, height: 10 },
    });
  });

  it("refuses one image too large for a native-messaging frame, and names the scale that fits", async () => {
    const huge = "A".repeat(SCREENSHOT_MAX_BASE64_CHARS * 2);
    const { runner } = harness({
      captureDeps: {
        captureVisibleTab: async () => `data:image/png;base64,${huge}`,
        activateTab: async () => undefined,
      },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB }));

    // 012/FR-162: still refused for this one call, but the refusal now says what would fit. The
    // hint is what makes `scale` discoverable at all.
    expect(response).toEqual({
      callId: "call-1",
      outcome: "failed",
      reason: "screenshot-too-large; retry with scale ≤ 0.7",
    });
  });

  /**
   * 012 change log 2026-10-17 (R-280): the scale multiplies the size the picture already came out
   * at, so a picture still too large at 0.5 needs less than 0.5 - the hint is relative to the
   * scale that was used, not to 1.
   */
  it("names a scale below the one that was already too large", async () => {
    const huge = "A".repeat(SCREENSHOT_MAX_BASE64_CHARS * 2);
    const { runner } = harness({
      captureDeps: {
        captureVisibleTab: async () => `data:image/png;base64,${huge}`,
        activateTab: async () => undefined,
        crop: async () => ({ data: huge, width: 593, height: 353 }),
      },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB, scale: 0.5 }));

    expect(response.reason).toBe("screenshot-too-large; retry with scale ≤ 0.3");
  });

  it("photographs an emulated tab over its attachment and answers in the emulated frame", async () => {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const { runner } = harness({
      // The record as storage hands it back - session, tab and time included. Only the size may
      // reach the answer (012 gate run 1 leaked the whole record as `frame`).
      currentViewport: async () =>
        ({ width: 2560, height: 1440, sessionId: "session-a", tabId: AGENT_TAB, setAt: 1 }) as never,
      sendOverAttachment: async (_tabId, method, params) => {
        sent.push({ method, ...(params === undefined ? {} : { params }) });
        return { data: "cHJvdG9jb2w=" };
      },
      captureDeps: {
        // R-166: under emulation this photographs the *window*, so the visible-tab path would hand
        // back a picture of something other than what the agent asked to see.
        captureVisibleTab: async () => {
          throw new Error("captureVisibleTab must not be used under emulation");
        },
        activateTab: async () => undefined,
        measure: async () => ({ width: 150, height: 50 }),
      },
    });

    const response = await runner.run(
      request({ tabId: AGENT_TAB, region: { x: 100, y: 200, width: 300, height: 100 }, scale: 0.5 }),
    );

    expect(response.result).toEqual({
      mimeType: "image/png",
      data: "cHJvdG9jb2w=",
      cropped: true,
      width: 150,
      height: 50,
      scale: 0.5,
      frame: { width: 2560, height: 1440 },
      coverage: "region",
      region: { x: 100, y: 200, width: 300, height: 100 },
    });
    expect(sent).toEqual([
      // The tab was brought forward, so one fresh frame is waited for first (2026-10-11).
      { method: "Runtime.evaluate", params: expect.objectContaining({ awaitPromise: true }) },
      // R-174: the clip is in document coordinates, so where the viewport sits is asked for first.
      { method: "Page.getLayoutMetrics" },
      {
        method: "Page.captureScreenshot",
        params: {
          format: "png",
          fromSurface: true,
          clip: { x: 100, y: 200, width: 300, height: 100, scale: 0.5 },
        },
      },
    ]);
  });

  /**
   * 012/S2c F2 - the eviction case again, from the picture's side.
   *
   * The record outlives the worker, so a screenshot taken after an eviction knows the tab is
   * emulated and this worker holds no attachment to photograph it over. The attachment is made for
   * the picture - as the viewport's own holder, which is the one the emulation is entitled to -
   * rather than the call failing with a word about the *page* not being readable.
   */
  it("attaches for the picture when the emulated tab's attachment was lost", async () => {
    const attachedFor: number[] = [];
    const sent: string[] = [];
    const { runner } = harness({
      currentViewport: async () => ({ width: 2560, height: 1440 }),
      ensureAttached: async (tabId) => {
        attachedFor.push(tabId);
        return { ok: true as const };
      },
      sendOverAttachment: async (_tabId, method) => {
        sent.push(method);
        return { data: "cHJvdG9jb2w=" };
      },
      captureDeps: {
        captureVisibleTab: async () => {
          throw new Error("captureVisibleTab must not be used under emulation");
        },
        activateTab: async () => undefined,
      },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB }));

    expect(attachedFor).toEqual([AGENT_TAB]);
    expect(sent).toContain("Page.captureScreenshot");
    expect(response.outcome).toBe("ok");
  });

  it("says why when Chrome will not attach for an emulated tab's picture", async () => {
    const sent: string[] = [];
    const { runner } = harness({
      currentViewport: async () => ({ width: 2560, height: 1440 }),
      ensureAttached: async () => ({ ok: false as const, unavailableReason: "devtools-open" as const }),
      sendOverAttachment: async (_tabId, method) => {
        sent.push(method);
        return { data: "cHJvdG9jb2w=" };
      },
      captureDeps: {
        captureVisibleTab: async () => {
          throw new Error("captureVisibleTab must not be used under emulation");
        },
        activateTab: async () => undefined,
      },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB }));

    // The attachment's own refusal, in the attachment's own words: `not-readable` would say the
    // page cannot be photographed, when what happened is that the owner has devtools open on it.
    expect(response).toEqual({
      callId: "call-1",
      outcome: "failed",
      reason: "input-unavailable",
      refusal: { reason: "input-unavailable", unavailableReason: "devtools-open" },
    });
    expect(sent).toEqual([]);
  });

  it("refuses a tab the session does not own", async () => {
    const captured: number[] = [];
    const { runner } = harness({
      captureDeps: {
        captureVisibleTab: async (windowId) => {
          captured.push(windowId);
          return PNG;
        },
        activateTab: async () => undefined,
      },
    });

    const response = await runner.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "screenshot",
      tabId: OWNER_TAB,
      args: { tabId: OWNER_TAB },
    });

    expect(response).toEqual({ callId: "call-1", outcome: "denied", reason: "not-yours", refusal: { reason: "not-yours" } });
    expect(captured).toEqual([]);
  });
});

/**
 * The whole-viewport picture is the one the agent aims by (012 change log 2026-10-17, R-280).
 *
 * At DPR 1.25 the display hands back 1 484x884 for this 1 187x707 page; the answer is 1 187x707,
 * and the tab remembers that size against the frame so a point read off it is mapped back. A region
 * is a close-up and changes nothing; a picture the agent never received changes nothing either.
 */
describe("a whole-viewport picture sets the tab's coordinate space", () => {
  const DEVICE = { width: 1484, height: 884 };

  beforeEach(() => {
    (globalThis as { chrome?: unknown }).chrome = { tabs: { getZoom: async () => 1 } };
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  function spaces() {
    const remembered: Array<{ tabId: number; space: unknown }> = [];
    return {
      remembered,
      store: {
        get: async () => undefined,
        remember: async (tabId: number, space: unknown) => void remembered.push({ tabId, space }),
      } as NonNullable<Parameters<typeof createAgentReads>[0]["screenshotSpaces"]>,
    };
  }

  it("answers a DPR 1.25 capture at the frame's size and remembers it", async () => {
    const { remembered, store } = spaces();
    const { runner } = harness({
      screenshotSpaces: store,
      captureDeps: {
        captureVisibleTab: async () => PNG,
        activateTab: async () => undefined,
        measure: async () => DEVICE,
        crop: async (_url, cropRequest) => {
          expect(cropRequest).toEqual({ frame: FRAME, scale: 1 });
          return { data: "Y3NzLXNpemVk", width: 1187, height: 707 };
        },
      },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB }));

    expect(response.result).toMatchObject({ width: 1187, height: 707, frame: FRAME, coverage: "viewport" });
    expect(remembered).toEqual([{ tabId: AGENT_TAB, space: { frame: FRAME, image: { width: 1187, height: 707 } } }]);
  });

  it("takes a picture with no frame, and keeps no space, when the page's zoom cannot be read (2026-10-18)", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      tabs: {
        getZoom: async () => {
          throw new Error("No tab with id");
        },
      },
    };
    const { remembered, store } = spaces();
    const { runner, diagnostics } = harness({
      screenshotSpaces: store,
      captureDeps: { captureVisibleTab: async () => PNG, activateTab: async () => undefined, measure: async () => DEVICE },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB }));

    expect(response.outcome).toBe("ok");
    expect(response.result).not.toHaveProperty("frame");
    // Nothing new is stored, and what was stored is forgotten: a ratio from another moment is not kept.
    expect(remembered).toEqual([{ tabId: AGENT_TAB, space: undefined }]);
    expect(diagnostics).toContain("agent.screenshot.frame-unknown");
  });

  it("aims an emulated tab's clip in CSS pixels under page zoom, and refuses when the zoom is unreadable", async () => {
    const clips: unknown[] = [];
    const { remembered, store } = spaces();
    const build = () =>
      harness({
        screenshotSpaces: store,
        currentViewport: async () => ({ width: 500, height: 800 }) as never,
        sendOverAttachment: async (_tabId, method, params) => {
          // Scrolled to 400 CSS pixels, which is 500 in the override's units at 125 %.
          if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 400 } };
          if (method === "Page.captureScreenshot") clips.push((params as { clip: unknown }).clip);
          return { data: "cHJvdG9jb2w=" };
        },
        captureDeps: {
          captureVisibleTab: async () => {
            throw new Error("captureVisibleTab must not be used under emulation");
          },
          activateTab: async () => undefined,
          measure: async () => ({ width: 500, height: 800 }),
        },
      });
    (globalThis as { chrome?: unknown }).chrome = { tabs: { getZoom: async () => 1.25 } };

    const zoomed = await build().runner.run(request({ tabId: AGENT_TAB }));

    // Measured 2026-10-18: a 500x800 override at 125 % lays out 400x640 CSS pixels, and a CDP clip
    // is in the override's own units - a 400x640 clip shows only the top-left 80 % of the page.
    expect(zoomed.result).toMatchObject({ frame: { width: 400, height: 640 }, width: 500, height: 800 });
    expect(clips).toEqual([expect.objectContaining({ y: 500, width: 500, height: 800 })]);
    // The stored ratio is the real one: the picture's centre (250, 400) is CSS (200, 320).
    expect(remembered).toEqual([
      { tabId: AGENT_TAB, space: { frame: { width: 400, height: 640 }, image: { width: 500, height: 800 } } },
    ]);
    const space = remembered[0]!.space as Parameters<typeof toViewportPoint>[1];
    expect(toViewportPoint({ x: 250, y: 400 }, space)).toEqual({ x: 200, y: 320 });

    // A region is asked in CSS pixels and clipped in the override's units: 80 px at 125 % is 100.
    await build().runner.run(request({ tabId: AGENT_TAB, region: { x: 80, y: 40, width: 80, height: 160 } }));
    expect(clips.at(-1)).toEqual(expect.objectContaining({ x: 100, y: 550, width: 100, height: 200 }));

    (globalThis as { chrome?: unknown }).chrome = {
      tabs: {
        getZoom: async () => {
          throw new Error("No tab with id");
        },
      },
    };
    const refused = await build().runner.run(request({ tabId: AGENT_TAB }));
    expect(refused).toEqual({ callId: "call-1", outcome: "not-readable", reason: "capture-refused" });
  });

  it("refuses a region once the page is no longer as wide as the picture's, before photographing (R-282)", async () => {
    const space = { frame: { width: 2560, height: 1440 }, image: { width: 1429, height: 804 } };
    const captured: number[] = [];
    const { runner } = harness({
      tabSize: async () => ({ width: 2048, height: 1440 }),
      screenshotSpaces: { get: async () => space, remember: async () => undefined },
      captureDeps: {
        captureVisibleTab: async (windowId) => (captured.push(windowId), PNG),
        activateTab: async () => undefined,
      },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB, region: { x: 10, y: 10, width: 100, height: 100 } }));

    expect(response).toEqual({
      callId: "call-1",
      outcome: "failed",
      reason:
        "viewport-changed (screenshot of a 2560 px wide page, now 2048); the window width or page zoom " +
        "changed since the last screenshot - take a new screenshot first",
    });
    expect(captured).toEqual([]);
    // A whole screenshot is how the agent gets a new space: never refused for the old one.
    expect((await runner.run(request({ tabId: AGENT_TAB }))).outcome).toBe("ok");
  });

  /**
   * 2026-10-17 follow-up: a region is read off the same picture a point is, so it is mapped into
   * the frame before it is checked and cropped; a region off the picture is refused naming the
   * picture's size. The answer echoes the region as the agent asked it.
   */
  it("crops a region read off a fitted picture at the matching place in the frame", async () => {
    const large = { width: 2560, height: 1440 };
    const space = { frame: large, image: { width: 1429, height: 804 } };
    const requests: unknown[] = [];
    const captured: number[] = [];
    const { runner } = harness({
      tabSize: async () => large,
      screenshotSpaces: { get: async () => space, remember: async () => undefined },
      captureDeps: {
        captureVisibleTab: async (windowId) => (captured.push(windowId), PNG),
        activateTab: async () => undefined,
        crop: async (_url, cropRequest) => {
          requests.push(cropRequest);
          return { data: "cmVnaW9u", width: 358, height: 179 };
        },
      },
    });
    const asked = { x: 100, y: 50, width: 200, height: 100 };

    const response = await runner.run(request({ tabId: AGENT_TAB, region: asked }));

    expect(requests).toEqual([{ frame: large, region: toViewportRegion(asked, space), scale: 1 }]);
    expect(response.result).toMatchObject({ coverage: "region", region: asked });

    const outside = await runner.run(request({ tabId: AGENT_TAB, region: { x: 1400, y: 0, width: 100, height: 100 } }));
    expect(outside).toEqual({
      callId: "call-1",
      outcome: "failed",
      reason: "region-outside-viewport (screenshot 1429x804)",
    });
    expect(captured).toHaveLength(1);
  });

  it("leaves the space alone for a region, and for a picture too large to send", async () => {
    const { remembered, store } = spaces();
    const huge = "A".repeat(SCREENSHOT_MAX_BASE64_CHARS * 2);
    const { runner } = harness({
      screenshotSpaces: store,
      captureDeps: {
        captureVisibleTab: async () => `data:image/png;base64,${huge}`,
        activateTab: async () => undefined,
        measure: async () => FRAME,
        crop: async () => ({ data: "cmVnaW9u", width: 125, height: 63 }),
      },
    });

    expect(
      (await runner.run(request({ tabId: AGENT_TAB, region: { x: 4, y: 8, width: 100, height: 50 } }))).outcome,
    ).toBe("ok");
    expect((await runner.run(request({ tabId: AGENT_TAB }))).reason).toMatch(/^screenshot-too-large/);
    expect(remembered).toEqual([]);
  });
});
