import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentEffects } from "../src/service-worker/agent-tools/effects.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createPointerInput, type AgentInputAttachments } from "../src/service-worker/agent-tools/input.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";
import type { PageExecutionOutcome } from "../src/service-worker/page-ports.js";

/**
 * 004/T120 — pointer input the page cannot tell from a person's (US5, R-113, G6, FR-064).
 *
 * The load-bearing assertion in this file is an *order*, not a count. The reference's observable
 * behaviour is that every click is preceded by a pointer move to the target, and that a hover is
 * that move alone. That is what makes the page's own hover state true at the moment of the press:
 * a menu that only exists under `:hover` is open, and a control armed on `mouseenter` is armed.
 * A click delivered without the move is a click the page can tell apart from a person's - which is
 * the defect this slice exists to remove - so a test that only asked "was a click dispatched"
 * would pass against exactly the implementation this task is replacing.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/ordinary`;
/** The box the page reports for the target; its centre is where the pointer has to land. */
const TARGET_RECT = { x: 100, y: 40, width: 80, height: 20 };
const CENTRE = { x: 140, y: 50 };

type Command = { tabId: number; method: string; params: Record<string, unknown> };
type CursorMessage = { tabId: number; message: Record<string, unknown> };

/** Just the parts of the attachment store pointer delivery uses, with the traffic recorded. */
function fakeAttachments(): {
  attachments: AgentInputAttachments;
  commands: Command[];
  acquired: Array<{ tabId: number; holder: string }>;
  refuse: { reason: "devtools-open" | "restricted-page" | undefined };
} {
  const commands: Command[] = [];
  const acquired: Array<{ tabId: number; holder: string }> = [];
  const refuse: { reason: "devtools-open" | "restricted-page" | undefined } = { reason: undefined };
  const attachments = {
    async acquire(tabId: number, holder: string) {
      acquired.push({ tabId, holder });
      return refuse.reason === undefined
        ? { ok: true as const }
        : { ok: false as const, unavailableReason: refuse.reason };
    },
    async drop() {},
    async release() {},
    async releaseAll() {},
    async send(tabId: number, method: string, params?: Record<string, unknown>) {
      commands.push({ tabId, method, params: params ?? {} });
      return {};
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
  return { attachments, commands, acquired, refuse };
}

function installChrome(): { sent: Array<{ type: string }> } {
  const local: Record<string, unknown> = {};
  const sent: Array<{ type: string }> = [];
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
        return { id: AGENT_TAB, url: PAGE_URL };
      },
      async query() {
        return [{ id: AGENT_TAB, url: PAGE_URL }];
      },
      async sendMessage(_tabId: number, message: unknown) {
        const frame = message as { type: string };
        sent.push({ type: frame.type });
        if (frame.type === "content.probe") {
          return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        }
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
  return { sent };
}

function harness(overrides: Partial<Parameters<typeof createAgentEffects>[0]> = {}) {
  const fake = fakeAttachments();
  const execute = vi.fn(
    async () => ({ ok: true, effect: "activated", clicks: 1, documentChanged: false }) as PageExecutionOutcome,
  );
  const cursor: CursorMessage[] = [];
  const siteModes = createSiteModeStore();
  const runner = createAgentEffects({
    context: testSessionContexts(),
    siteModes,
    bindings: createAgentPageBindings(),
    prompts: createAgentPromptController({ timeoutMs: 60 }),
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    attachments: fake.attachments,
    cursor: (tabId, message) => {
          cursor.push({ tabId, message: message as Record<string, unknown> });
        },
    // The rect the page reports for the ref; the frame offsets that turn a child frame's box into a
    // top-level one are T124/T125 and deliberately not here.
    locate: async () => TARGET_RECT,
    // 004/T128: correct by construction, like `locate` above - the delivered point always resolves
    // to the target it was computed from, unless a test says otherwise.
    confirm: async () => ({ outcome: "hit" }),
    execute,
    probe: async () => ({ ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE }),
    settleMs: 0,
    ...overrides,
  });
  return { runner, siteModes, execute, cursor, ...fake };
}

function request(tool: string, args: Record<string, unknown> = {}): AgentNativeRequest {
  return {
    callId: `call-${tool}`,
    sessionId: "session-p1",
    tool: tool as AgentNativeRequest["tool"],
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, target: { ref: "t_save" }, ...args },
  };
}

/** The mouse traffic only, in order, as `method/type` pairs with their point. */
function mouse(commands: Command[]): Array<{ type: string; x: number; y: number; button?: unknown; clickCount?: unknown }> {
  return commands
    .filter((command) => command.method === "Input.dispatchMouseEvent")
    .map((command) => {
      const params = command.params as Record<string, unknown>;
      return {
        type: String(params.type),
        x: Number(params.x),
        y: Number(params.y),
        ...(params.button === undefined ? {} : { button: params.button }),
        ...(params.clickCount === undefined ? {} : { clickCount: params.clickCount }),
      };
    });
}

describe("T120 pointer delivery", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  describe("the sequence itself", () => {
    it("moves to the point before it presses, and releases last", async () => {
      const fake = fakeAttachments();
      const pointer = createPointerInput({ attachments: fake.attachments });

      await pointer.click(AGENT_TAB, CENTRE, { button: "left", clickCount: 1 });

      expect(mouse(fake.commands)).toEqual([
        { type: "mouseMoved", x: 140, y: 50, button: "none", clickCount: 0 },
        { type: "mousePressed", x: 140, y: 50, button: "left", clickCount: 1 },
        { type: "mouseReleased", x: 140, y: 50, button: "left", clickCount: 1 },
      ]);
    });

    it("hovers with the move alone - no press, no release", async () => {
      const fake = fakeAttachments();
      const pointer = createPointerInput({ attachments: fake.attachments });

      await pointer.hover(AGENT_TAB, CENTRE);

      expect(mouse(fake.commands)).toEqual([
        { type: "mouseMoved", x: 140, y: 50, button: "none", clickCount: 0 },
      ]);
    });

    it("sets the button and the click count the gesture asked for", async () => {
      const fake = fakeAttachments();
      const pointer = createPointerInput({ attachments: fake.attachments });

      await pointer.click(AGENT_TAB, CENTRE, { button: "right", clickCount: 1 });
      await pointer.click(AGENT_TAB, CENTRE, { button: "left", clickCount: 2 });
      await pointer.click(AGENT_TAB, CENTRE, { button: "left", clickCount: 3 });

      const pressed = mouse(fake.commands).filter((event) => event.type === "mousePressed");
      expect(pressed).toEqual([
        { type: "mousePressed", x: 140, y: 50, button: "right", clickCount: 1 },
        { type: "mousePressed", x: 140, y: 50, button: "left", clickCount: 2 },
        { type: "mousePressed", x: 140, y: 50, button: "left", clickCount: 3 },
      ]);
    });

    it("scrolls as a wheel at the point", async () => {
      const fake = fakeAttachments();
      const pointer = createPointerInput({ attachments: fake.attachments });

      await pointer.scroll(AGENT_TAB, CENTRE, { deltaX: 0, deltaY: 300 });

      const wheel = fake.commands.at(-1)!;
      expect(wheel.method).toBe("Input.dispatchMouseEvent");
      expect(wheel.params).toMatchObject({ type: "mouseWheel", x: 140, y: 50, deltaX: 0, deltaY: 300 });
    });

    it("drags as move, press, move, release", async () => {
      const fake = fakeAttachments();
      const pointer = createPointerInput({ attachments: fake.attachments });

      await pointer.drag(AGENT_TAB, { x: 10, y: 20 }, { x: 90, y: 120 });

      expect(mouse(fake.commands)).toEqual([
        { type: "mouseMoved", x: 10, y: 20, button: "none", clickCount: 0 },
        { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 },
        { type: "mouseMoved", x: 90, y: 120, button: "left", clickCount: 0 },
        { type: "mouseReleased", x: 90, y: 120, button: "left", clickCount: 1 },
      ]);
    });

    it("sends the pointer to the point once per click, and never hides it", async () => {
      const fake = fakeAttachments();
      const cursor: CursorMessage[] = [];
      const pointer = createPointerInput({
        attachments: fake.attachments,
        cursor: (tabId, message) => {
          cursor.push({ tabId, message: message as Record<string, unknown> });
        },
      });

      await pointer.click(AGENT_TAB, CENTRE, { button: "left", clickCount: 1 });

      // The pointer persists between gestures now; it leaves with the tab's lease, not with the click.
      expect(cursor.map((entry) => entry.message)).toEqual([{ type: "cursor", x: 140, y: 50 }]);
      expect(cursor.every((entry) => entry.tabId === AGENT_TAB)).toBe(true);
    });

    it("dispatches nothing until the page says the pointer has arrived", async () => {
      const fake = fakeAttachments();
      let arrive = (): void => undefined;
      const pointer = createPointerInput({
        attachments: fake.attachments,
        cursor: () =>
          new Promise<void>((resolve) => {
            arrive = resolve;
          }),
      });

      const click = pointer.click(AGENT_TAB, CENTRE, { button: "left", clickCount: 1 });
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.commands, "the press must land where the owner watched the pointer stop").toEqual([]);

      arrive();
      await click;

      expect(mouse(fake.commands).map((event) => event.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    });

    it("proceeds after the arrival cap when the page never answers", async () => {
      vi.useFakeTimers();
      try {
        const fake = fakeAttachments();
        const pointer = createPointerInput({
          attachments: fake.attachments,
          cursor: () => new Promise<void>(() => undefined),
        });

        const click = pointer.click(AGENT_TAB, CENTRE, { button: "left", clickCount: 1 });
        await vi.advanceTimersByTimeAsync(249);
        expect(fake.commands).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        await click;

        expect(mouse(fake.commands).map((event) => event.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("walks the pointer through a drag: to the start, then to the end, with the CDP order intact", async () => {
      const fake = fakeAttachments();
      const cursor: CursorMessage[] = [];
      const pointer = createPointerInput({
        attachments: fake.attachments,
        cursor: (tabId, message) => {
          cursor.push({ tabId, message: message as Record<string, unknown> });
        },
      });

      await pointer.drag(AGENT_TAB, { x: 10, y: 20 }, { x: 90, y: 120 });

      expect(cursor.map((entry) => entry.message)).toEqual([
        { type: "cursor", x: 10, y: 20 },
        { type: "cursor", x: 90, y: 120 },
      ]);
      expect(mouse(fake.commands)).toEqual([
        { type: "mouseMoved", x: 10, y: 20, button: "none", clickCount: 0 },
        { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 },
        { type: "mouseMoved", x: 90, y: 120, button: "left", clickCount: 0 },
        { type: "mouseReleased", x: 90, y: 120, button: "left", clickCount: 1 },
      ]);
    });
  });

  describe("through the effect tools", () => {
    it("delivers a click at the target's centre, browser-level, and never through the page", async () => {
      const { runner, siteModes, commands, execute, acquired } = harness();
      await siteModes.set(SITE, { mode: "skip-checks" });

      const response = await runner.run(request("click"));

      expect(response.outcome).toBe("ok");
      expect(mouse(commands)).toEqual([
        { type: "mouseMoved", x: 140, y: 50, button: "none", clickCount: 0 },
        { type: "mousePressed", x: 140, y: 50, button: "left", clickCount: 1 },
        { type: "mouseReleased", x: 140, y: 50, button: "left", clickCount: 1 },
      ]);
      // The page-level executor is what this replaces; a fallback to it would hand the page the
      // very synthetic input the reference never produces.
      expect(execute).not.toHaveBeenCalled();
      expect(acquired).toEqual([{ tabId: AGENT_TAB, holder: "input" }]);
    });

    it("still reports only what was observed (003's verification step)", async () => {
      const { runner, siteModes } = harness();
      await siteModes.set(SITE, { mode: "skip-checks" });

      const response = await runner.run(request("click"));

      expect(response).toMatchObject({
        outcome: "ok",
        result: { observed: { effect: "activated", clicks: 1, verified: true, documentChanged: false } },
      });
    });

    it("reports the document as changed when the probe says the page moved under the click", async () => {
      const { runner, siteModes } = harness({
        probe: async () => ({ ok: true, documentEpoch: "doc-2", canonicalOrigin: SITE }),
      });
      await siteModes.set(SITE, { mode: "skip-checks" });

      const response = await runner.run(request("click"));

      expect(response).toMatchObject({
        outcome: "ok",
        result: { observed: { verified: false, verdict: "document-changed", documentChanged: true } },
      });
    });

    it("hovers by moving there and nothing else", async () => {
      const { runner, siteModes, commands } = harness();
      await siteModes.set(SITE, { mode: "skip-checks" });

      const response = await runner.run(request("hover"));

      expect(response.outcome).toBe("ok");
      expect(mouse(commands)).toEqual([
        { type: "mouseMoved", x: 140, y: 50, button: "none", clickCount: 0 },
      ]);
    });

    it("answers input-unavailable when the tab cannot be attached, with no second route", async () => {
      const { runner, siteModes, refuse, commands, execute } = harness();
      refuse.reason = "devtools-open";
      await siteModes.set(SITE, { mode: "skip-checks" });

      const response = await runner.run(request("click"));

      expect(response).toMatchObject({
        outcome: "failed",
        reason: "input-unavailable",
        refusal: { reason: "input-unavailable", unavailableReason: "devtools-open" },
      });
      expect(commands).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
