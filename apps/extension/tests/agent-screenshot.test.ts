import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { captureTab } from "../src/chrome-adapters/capture.js";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentReads, SCREENSHOT_MAX_BASE64_CHARS } from "../src/service-worker/agent-tools/reads.js";

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
  });
  return { runner, diagnostics };
}

function request(args: Record<string, unknown>): AgentNativeRequest {
  return { callId: "call-1", sessionId: "session-h1", tool: "screenshot", tabId: AGENT_TAB, args };
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("T035 agent screenshot", () => {
  beforeEach(() => {
    (globalThis as { chrome?: unknown }).chrome = {};
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
