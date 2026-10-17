import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { captureTab, SCREENSHOT_MAX_BASE64_CHARS } from "../src/chrome-adapters/capture.js";
import { createAgentEffects } from "../src/service-worker/agent-tools/effects.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import type { AgentInputAttachments } from "../src/service-worker/agent-tools/input.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";
import { createScreenshotSpaceStore } from "../src/service-worker/screenshot-space-store.js";

/**
 * 004/T138 — acting by position (US7, FR-069, FR-070, R-120).
 *
 * Two things are load-bearing here and neither is "an event was dispatched". The first is *which
 * delivery* carries the action: every assertion below reads the traffic S4's pointer and keyboard
 * put on the attachment, so an implementation that grew a second dispatcher of its own would fail
 * them rather than quietly pass. The second is the refusal: a point past the edge of the viewport
 * is refused *with the size*, never moved to the edge - and a test that only checked a click had
 * been delivered somewhere would pass against exactly the clamping implementation this forbids.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/canvas`;
const VIEWPORT = { width: 1280, height: 720 };

type Command = { tabId: number; method: string; params: Record<string, unknown> };

function fakeAttachments(): { attachments: AgentInputAttachments; commands: Command[] } {
  const commands: Command[] = [];
  const attachments = {
    async acquire() {
      return { ok: true as const };
    },
    async drop() {},
    async release() {},
    async releaseAll() {},
    async send(tabId: number, method: string, params?: Record<string, unknown>) {
      commands.push({ tabId, method, params: params ?? {} });
      // The one geometry query the position tool makes: the tab's own viewport, which is what a
      // refusal has to be able to name.
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: VIEWPORT.width, clientHeight: VIEWPORT.height } };
      }
      // 012/T311: the picture of an emulated tab comes over this attachment, not off the window.
      return method === "Page.captureScreenshot" ? { data: "cHJvdG9jb2w=" } : {};
    },
    attached: () => [],
    state: () => undefined,
    onEvent() {},
    onDetach() {},
    async attachedTabIds() {
      return [];
    },
    async detachStray() {},
  } as unknown as AgentInputAttachments;
  return { attachments, commands };
}

function installChrome(): void {
  const local: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string[]) {
          const out: Record<string, unknown> = {};
          for (const key of keys) if (key in local) out[key] = local[key];
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
        },
      },
    },
    scripting: { async executeScript() {} },
    tabs: {
      async get(tabId: number) {
        if (tabId !== AGENT_TAB) throw new Error("No tab with id");
        return { id: AGENT_TAB, url: PAGE_URL, windowId: 1, active: true };
      },
      async query() {
        return [{ id: AGENT_TAB, url: PAGE_URL, windowId: 1, active: true }];
      },
      async sendMessage(_tabId: number, message: unknown) {
        const frame = message as { type: string };
        if (frame.type === "content.probe") {
          return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        }
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
}

function harness(overrides: Partial<Parameters<typeof createAgentEffects>[0]> = {}) {
  const fake = fakeAttachments();
  const siteModes = createSiteModeStore();
  const capture = vi.fn(async () => ({ data: "UE5H", mimeType: "image/png" as const, cropped: true, scale: 1 }));
  const runner = createAgentEffects({
    context: testSessionContexts(),
    siteModes,
    bindings: createAgentPageBindings(),
    prompts: createAgentPromptController({ timeoutMs: 60 }),
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    attachments: fake.attachments,
    capture,
    probe: async () => ({ ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE }),
    settleMs: 0,
    ...overrides,
  });
  return { runner, siteModes, capture, ...fake };
}

function request(args: Record<string, unknown>): AgentNativeRequest {
  return {
    callId: "call-computer",
    sessionId: "session-c1",
    tool: "computer" as AgentNativeRequest["tool"],
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, ...args },
  };
}

function mouse(commands: Command[]): Array<Record<string, unknown>> {
  return commands
    .filter((command) => command.method === "Input.dispatchMouseEvent")
    .map((command) => command.params);
}

async function allowed(siteModes: ReturnType<typeof createSiteModeStore>): Promise<void> {
  await siteModes.set(SITE, { mode: "skip-checks" });
}

describe("T138 acting by position", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("delivers a left click at the point through S4's pointer, move first", async () => {
    const { runner, siteModes, commands } = harness();
    await allowed(siteModes);

    const response = await runner.run(request({ action: "left_click", x: 400, y: 300 }));

    expect(response.outcome).toBe("ok");
    // Exactly the three commands `pointer-delivery.test.ts` pins for a targeted click, at the
    // point this call named instead of at an element's centre.
    expect(mouse(commands)).toEqual([
      { type: "mouseMoved", x: 400, y: 300, button: "none", clickCount: 0 },
      { type: "mousePressed", x: 400, y: 300, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 400, y: 300, button: "left", clickCount: 1 },
    ]);
  });

  it("sets the button and click count each of the four clicks asks for", async () => {
    for (const [action, button, clickCount] of [
      ["right_click", "right", 1],
      ["double_click", "left", 2],
      ["triple_click", "left", 3],
    ] as const) {
      const { runner, siteModes, commands } = harness();
      await allowed(siteModes);

      await runner.run(request({ action, x: 10, y: 20 }));

      expect(mouse(commands).filter((event) => event.type === "mousePressed")).toEqual([
        { type: "mousePressed", x: 10, y: 20, button, clickCount },
      ]);
    }
  });

  it("scrolls as a wheel at the point - the coordinate wheel, not `bring this into view`", async () => {
    const { runner, siteModes, commands } = harness();
    await allowed(siteModes);

    await runner.run(request({ action: "scroll", x: 40, y: 60, amount: 3 }));

    const wheel = mouse(commands).find((event) => event.type === "mouseWheel");
    expect(wheel).toMatchObject({ type: "mouseWheel", x: 40, y: 60, deltaX: 0, deltaY: 300 });
  });

  it("types at the point one keystroke per character, after clicking it", async () => {
    const { runner, siteModes, commands } = harness();
    await allowed(siteModes);

    await runner.run(request({ action: "type", text: "hi", x: 12, y: 34 }));

    // The click that puts the caret there, then the keys - S4's keyboard, not a value assignment.
    expect(mouse(commands).some((event) => event.type === "mousePressed" && event.x === 12)).toBe(true);
    const keys = commands.filter((command) => command.method === "Input.dispatchKeyEvent");
    // S4's own pair per character - the key down carries the character, the key up carries none -
    // which is what `key-delivery.test.ts` pins for a targeted `type`.
    expect(keys.map((command) => command.params.text)).toEqual(["h", undefined, "i", undefined]);
  });

  it("presses a named key through S4's keyboard", async () => {
    const { runner, siteModes, commands } = harness();
    await allowed(siteModes);

    await runner.run(request({ action: "key", key: "Enter" }));

    const keys = commands.filter((command) => command.method === "Input.dispatchKeyEvent");
    expect(keys.map((command) => command.params.key)).toEqual(["Enter", "Enter"]);
  });

  it("refuses a point outside the viewport, naming the size, and delivers nothing", async () => {
    const { runner, siteModes, commands } = harness();
    await allowed(siteModes);

    const response = await runner.run(request({ action: "left_click", x: 1400, y: 300 }));

    expect(response.outcome).toBe("failed");
    expect(response.reason).toBe("outside-viewport");
    // The size is the whole use of this refusal: it is what lets the agent aim the next attempt.
    expect((response as { refusal?: unknown }).refusal).toEqual({
      reason: "outside-viewport",
      width: 1280,
      height: 720,
    });
    // Never clamped to the edge. A click delivered at 1279 would be a click the agent did not ask
    // for, on whatever happens to be painted at the border.
    expect(mouse(commands)).toEqual([]);
  });

  it("photographs the tab in the shape the screenshot tool answers with", async () => {
    const { runner, siteModes } = harness();
    await allowed(siteModes);

    const response = await runner.run(request({ action: "screenshot" }));

    expect(response.outcome).toBe("ok");
    expect(response.result).toEqual({
      mimeType: "image/png",
      data: "UE5H",
      cropped: false,
      // 012/FR-158: the same fields the `screenshot` tool answers with, so an agent that took a
      // picture either way reads one answer. The frame is absent here because this fake tab has no
      // size Chrome will report.
      scale: 1,
      coverage: "viewport",
    });
  });

  it("refuses a picture still too large to send, in the screenshot tool's own words", async () => {
    // R-281: the lowest JPEG quality can still be over the frame budget; the `screenshot` tool's
    // refusal, scale hint included, is the one answer - never a frame that breaks the link.
    const huge = "A".repeat(SCREENSHOT_MAX_BASE64_CHARS * 2);
    const { runner, siteModes } = harness({
      capture: vi.fn(async () => ({ data: huge, mimeType: "image/jpeg" as const, cropped: false, scale: 0.5 })),
    });
    await allowed(siteModes);

    const response = await runner.run(request({ action: "screenshot" }));

    expect(response).toEqual({
      callId: "call-computer",
      outcome: "failed",
      reason: "screenshot-too-large; retry with scale ≤ 0.3",
    });
  });

  it("photographs an emulated tab over its attachment rather than off the window", async () => {
    const visibleTab = vi.fn(async () => "data:image/png;base64,UE5H");
    const { runner, siteModes, commands } = harness({
      capture: captureTab,
      captureDeps: {
        captureVisibleTab: visibleTab,
        activateTab: async () => undefined,
        measure: async () => ({ width: 2560, height: 1440 }),
      },
      currentViewport: async () => ({ width: 2560, height: 1440 }),
    });
    await allowed(siteModes);

    const response = await runner.run(request({ action: "screenshot" }));

    // R-166: under emulation `captureVisibleTab` photographs the *window* - the emulated page
    // cropped to what fits, at the display's density - so this action has to take the same
    // protocol path the `screenshot` tool takes, or the two tools answer different pictures.
    expect(commands.filter((command) => command.method === "Page.captureScreenshot")).toEqual([
      {
        tabId: AGENT_TAB,
        method: "Page.captureScreenshot",
        params: {
          format: "png",
          fromSurface: true,
          // 2026-10-17 (R-280): the whole viewport is asked for fitted under the size budget,
          // 1 429 pixels wide, rather than at the emulated 2 560.
          clip: { x: 0, y: 0, width: 2560, height: 1440, scale: 1429 / 2560 },
        },
      },
    ]);
    expect(visibleTab).not.toHaveBeenCalled();
    expect(response.result).toEqual({
      mimeType: "image/png",
      data: "cHJvdG9jb2w=",
      cropped: false,
      scale: 1,
      width: 2560,
      height: 1440,
      frame: { width: 2560, height: 1440 },
      coverage: "viewport",
    });
  });

  /**
   * 008/FR-112 (S4 review): what the chaining rule may be told about.
   *
   * The record exists to say "the owner approved something *on this page* a moment ago", so a
   * dialog that opened because of it is part of that decision. A screenshot and a wait change
   * nothing on the page and can cause no dialog at all, so a record written for them would hand a
   * timer's confirm a free accept that nobody consented to.
   */
  it("records an approval only for an action that reaches the page", async () => {
    const approvals: Array<{ tabId: number; tool: string }> = [];
    const { runner, siteModes } = harness({ onApproved: (tabId, tool) => approvals.push({ tabId, tool }) });
    await allowed(siteModes);

    expect((await runner.run(request({ action: "screenshot" }))).outcome).toBe("ok");
    expect((await runner.run(request({ action: "wait", ms: 1 }))).outcome).toBe("ok");
    expect(approvals).toEqual([]);

    expect((await runner.run(request({ action: "left_click", x: 400, y: 300 }))).outcome).toBe("ok");
    expect(approvals).toEqual([{ tabId: AGENT_TAB, tool: "computer" }]);
  });

  /**
   * 014/T369 review F5 — every action that reaches the page marks its delivery (FR-181).
   *
   * The interrupt's two sentences are chosen by this marker alone: "nothing was delivered" or "it
   * may have taken effect and was not verified". `computer` wrote none, so an interrupt landing
   * after a click had gone out at a coordinate told the agent nothing had happened. The same two
   * actions that record no approval record no delivery either, and for the same reason: one
   * photographs the tab and the other sleeps.
   */
  it("marks a delivery for every action that reaches the page, and for neither that does not", async () => {
    const delivered: string[] = [];
    const { runner, siteModes } = harness({ onDelivered: (callId: string) => delivered.push(callId) });
    await allowed(siteModes);

    expect((await runner.run(request({ action: "screenshot" }))).outcome).toBe("ok");
    expect((await runner.run(request({ action: "wait", ms: 1 }))).outcome).toBe("ok");
    expect(delivered, "an action that touches nothing said it had delivered something").toEqual([]);

    for (const args of [
      { action: "left_click", x: 400, y: 300 },
      { action: "right_click", x: 400, y: 300 },
      { action: "double_click", x: 400, y: 300 },
      { action: "triple_click", x: 400, y: 300 },
      { action: "scroll", x: 400, y: 300, amount: 3 },
      { action: "type", text: "hello" },
      { action: "key", key: "Enter" },
    ]) {
      delivered.length = 0;

      const response = await runner.run(request(args));

      expect(response.outcome, String(args.action)).toBe("ok");
      expect(delivered, String(args.action)).toEqual(["call-computer"]);
    }
  });

  it("waits the length the call stated, and 003's bound is the ceiling", async () => {
    const slept: number[] = [];
    const { runner, siteModes } = harness({ sleep: async (ms: number) => void slept.push(ms) });
    await allowed(siteModes);

    const response = await runner.run(request({ action: "wait", ms: 500 }));

    expect(response.outcome).toBe("ok");
    expect(slept).toEqual([500]);
  });

  it("shows the owner a crop of the page around the point, not a bare coordinate", async () => {
    // The site has no decision on it, so this call is the one an `ask` raises a question about.
    // `onChange` is how the panel learns a question is up, and it is how this test waits for one
    // without polling a promise that has several awaits still to go.
    let raised: () => void = () => {};
    const shown = new Promise<void>((resolve) => {
      raised = resolve;
    });
    const prompts = createAgentPromptController({ timeoutMs: 500, onChange: () => raised() });
    const { runner, commands } = harness({ prompts });

    const pending = runner.run(request({ action: "left_click", x: 400, y: 300 }));
    await shown;

    const prompt = prompts.current();
    expect(prompt?.tool).toBe("computer");
    // A pair of numbers is not something an owner can decide about; the picture of the place is.
    // 200 CSS pixels of the tab centred on the point, and the rectangle it was taken from.
    expect(prompt?.targetCrop).toEqual({
      mimeType: "image/png",
      data: "UE5H",
      x: 300,
      y: 200,
      width: 200,
      height: 200,
    });

    // The owner's answer arrives the way the panel gives it, and a denial delivers nothing at all.
    expect(prompts.decide(prompt!.promptId, false)).toBe(true);
    expect((await pending).outcome).toBe("denied");
    expect(mouse(commands)).toEqual([]);
  });
});

/**
 * A point read off the latest picture lands where it was read (012 change log 2026-10-17, R-280).
 *
 * A 2 560x1 440 viewport is handed back fitted (1 429x804 here), so a point the agent reads off it
 * is in the picture's pixels; the click must land at that point scaled back into the frame, through
 * the one mapping every point-taking tool shares.
 */
describe("computer aims in the latest picture's pixels", () => {
  const FITTED = { width: 1429, height: 804 };
  const EMULATED = { width: 2560, height: 1440 };

  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  function spaced(currentViewport: () => Promise<{ width: number; height: number } | undefined> = async () => EMULATED) {
    const items: Record<string, unknown> = {};
    const screenshotSpaces = createScreenshotSpaceStore({
      session: {
        async get(keys: string[]) {
          return Object.fromEntries(keys.filter((key) => key in items).map((key) => [key, items[key]]));
        },
        async set(values: Record<string, unknown>) {
          Object.assign(items, values);
        },
      },
    });
    return harness({
      capture: captureTab,
      captureDeps: { activateTab: async () => undefined, measure: async () => FITTED },
      currentViewport,
      screenshotSpaces,
    });
  }

  /**
   * 012 change log 2026-10-17 (R-282): the frame the picture was of is no longer the frame the
   * point would land in - the window was resized or the page zoomed - so the point is refused before
   * anything is asked or delivered, and the next whole screenshot is what lets it through again.
   */
  describe("a frame whose width changed since the picture", () => {
    const CHANGED =
      "viewport-changed (screenshot of a 2560 px wide page, now 2048); the window width or page zoom " +
      "changed since the last screenshot - take a new screenshot first";

    it("refuses a computer point and a point target, and delivers nothing", async () => {
      let frame = EMULATED;
      const { runner, siteModes, commands } = spaced(async () => frame);
      await allowed(siteModes);
      await runner.run(request({ action: "screenshot" }));
      frame = { width: 2048, height: 1440 };

      const computed = await runner.run(request({ action: "left_click", x: 500, y: 300 }));
      const clicked = await runner.run({
        callId: "call-click",
        sessionId: "session-c1",
        tool: "click",
        tabId: AGENT_TAB,
        args: { tabId: AGENT_TAB, target: { x: 500, y: 300 } },
      });

      expect(computed).toEqual({ callId: "call-computer", outcome: "failed", reason: CHANGED });
      expect(clicked).toEqual({ callId: "call-click", outcome: "failed", reason: CHANGED });
      expect(mouse(commands)).toEqual([]);
    });

    it("lets the point through once a new whole screenshot is taken", async () => {
      let frame = EMULATED;
      const { runner, siteModes, commands } = spaced(async () => frame);
      await allowed(siteModes);
      await runner.run(request({ action: "screenshot" }));
      frame = { width: 2048, height: 1440 };
      await runner.run(request({ action: "screenshot" }));

      const response = await runner.run(request({ action: "left_click", x: 500, y: 300 }));

      expect(response.outcome).toBe("ok");
      expect(mouse(commands).some((event) => event.type === "mousePressed")).toBe(true);
    });

    it("ignores a height change, and a width nobody could measure", async () => {
      let frame: { width: number; height: number } | undefined = EMULATED;
      const { runner, siteModes } = spaced(async () => frame);
      await allowed(siteModes);
      await runner.run(request({ action: "screenshot" }));

      frame = { width: 2560, height: 1400 };
      expect((await runner.run(request({ action: "left_click", x: 500, y: 300 }))).outcome).toBe("ok");
      // No emulation record and a tab Chrome will not size: 0.12.2's behaviour, not a refusal.
      frame = undefined;
      expect((await runner.run(request({ action: "left_click", x: 500, y: 300 }))).outcome).toBe("ok");
    });
  });

  it("clicks at the picture's point scaled back into the frame", async () => {
    const { runner, siteModes, commands } = spaced();
    await allowed(siteModes);

    const shot = await runner.run(request({ action: "screenshot" }));
    expect(shot.result).toMatchObject({ width: 1429, height: 804, frame: EMULATED });
    await runner.run(request({ action: "left_click", x: 500, y: 300 }));

    const x = Math.round((500 * 2560) / 1429);
    const y = Math.round((300 * 1440) / 804);
    expect(mouse(commands).find((event) => event.type === "mousePressed")).toMatchObject({ x, y });
  });

  it("refuses a point off the picture naming the picture's size", async () => {
    const { runner, siteModes, commands } = spaced();
    await allowed(siteModes);

    await runner.run(request({ action: "screenshot" }));
    const response = await runner.run(request({ action: "left_click", x: 1500, y: 100 }));

    expect((response as { refusal?: unknown }).refusal).toEqual({ reason: "outside-viewport", ...FITTED });
    expect(mouse(commands)).toEqual([]);
  });

  it("leaves a point alone when the tab has no picture yet", async () => {
    const { runner, siteModes, commands } = spaced();
    await allowed(siteModes);

    await runner.run(request({ action: "scroll", x: 40, y: 60, amount: 1 }));

    expect(mouse(commands).find((event) => event.type === "mouseWheel")).toMatchObject({ x: 40, y: 60 });
  });
});
