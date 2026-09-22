import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { captureTab } from "../src/chrome-adapters/capture.js";
import { createAgentEffects } from "../src/service-worker/agent-tools/effects.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import type { AgentInputAttachments } from "../src/service-worker/agent-tools/input.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";

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
  const capture = vi.fn(async () => ({ data: "UE5H", cropped: true, scale: 1 }));
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
          clip: { x: 0, y: 0, width: 2560, height: 1440, scale: 1 },
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
