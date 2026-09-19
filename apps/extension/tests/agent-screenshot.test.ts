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

function harness(input: {
  agentActive?: boolean;
  captureDeps?: Parameters<typeof createAgentReads>[0]["captureDeps"];
}) {
  const listTabs = vi.fn(async () => tabs(input.agentActive ?? false));
  const runner = createAgentReads({
    context: testSessionContexts(),
    bindings: createAgentPageBindings(),
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    listTabs: listTabs as unknown as typeof import("../src/chrome-adapters/tabs.js").queryTabSnapshots,
    capture: captureTab,
    ...(input.captureDeps ? { captureDeps: input.captureDeps } : {}),
  });
  return { runner };
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
      result: { mimeType: "image/png", data: "iVBORw0KGgo=", cropped: false },
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
    const regions: unknown[] = [];
    const { runner } = harness({
      captureDeps: {
        captureVisibleTab: async () => PNG,
        activateTab: async () => undefined,
        crop: async (_dataUrl, region) => {
          regions.push(region);
          return "Y3JvcHBlZA==";
        },
      },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB, region: { x: 4, y: 8, width: 100, height: 50 } }));

    expect(response.result).toEqual({ mimeType: "image/png", data: "Y3JvcHBlZA==", cropped: true });
    expect(regions).toEqual([{ x: 4, y: 8, width: 100, height: 50 }]);
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

    const response = await runner.run(request({ tabId: AGENT_TAB, region: { x: 0, y: 0, width: 10, height: 10 } }));

    expect(response.result).toEqual({ mimeType: "image/png", data: "iVBORw0KGgo=", cropped: false });
  });

  it("refuses one image too large for a native-messaging frame, rather than breaking the link", async () => {
    const huge = "A".repeat(SCREENSHOT_MAX_BASE64_CHARS + 1);
    const { runner } = harness({
      captureDeps: {
        captureVisibleTab: async () => `data:image/png;base64,${huge}`,
        activateTab: async () => undefined,
      },
    });

    const response = await runner.run(request({ tabId: AGENT_TAB }));

    expect(response).toEqual({ callId: "call-1", outcome: "failed", reason: "screenshot-too-large" });
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
