import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentEffects, type TargetConfirmer, type TargetLocator } from "../src/service-worker/agent-tools/effects.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";
import { testInputAttachments } from "./helpers/input-attachments.js";
import { oneDocumentAnswer, oneDocumentFocus } from "./helpers/point-site.js";

/**
 * 038/T1081 - a point target is delivered where the agent named it (FR-563, FR-564, R-545).
 *
 * The element found at a point is located only for what it decides - its frame, the landing check,
 * the link flag, the box the pill steps aside from - and never scrolled into view: the pointer
 * events, the delivery marker, the re-check before dispatch and the hit confirmation all use the
 * named point. The box `locate` answers here deliberately has its centre far from every named
 * point, so a delivery at the box centre cannot pass for one at the point. A ref target keeps its
 * centre-of-box delivery and its scroll (004/T128).
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/ordinary`;
/** The located box: centre (400, 300), away from every point named below. */
const BOX = { x: 300, y: 250, width: 200, height: 100 };
const CENTRE = { x: 400, y: 300 };
/** `t_beta` sits elsewhere: a drag between two refs at one centre would not move (039 FR-570). */
const BETA_BOX = { x: 600, y: 250, width: 200, height: 100 };

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
        return { id: AGENT_TAB, url: PAGE_URL };
      },
      async query() {
        return [{ id: AGENT_TAB, url: PAGE_URL }];
      },
      async sendMessage(_tabId: number, message: unknown) {
        const frame = message as { type: string; payload: Record<string, unknown> };
        if (frame.type === "content.probe") return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        if (frame.type === "content.resolve-point") {
          // A bare point mints a ref of its own per point, as the page's registry would for two
          // different elements, so a drag between two points has two endpoints.
          return {
            ok: true,
            outcome: "resolved",
            candidates: [{ targetHandle: `t_at_${String(frame.payload.x)}_${String(frame.payload.y)}` }],
          };
        }
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
}

function harness() {
  const input = testInputAttachments();
  const recorded = input.attachments.send.bind(input.attachments);
  input.attachments.send = async (tabId, method, params, sessionId) => {
    const answered = await recorded(tabId, method, params, sessionId);
    return oneDocumentAnswer(method) ?? answered;
  };
  const located: Array<{ ref: string; scroll: boolean }> = [];
  const locate: TargetLocator = async ({ ref, scroll }) => {
    located.push({ ref, scroll });
    return { ...(ref === "t_beta" ? BETA_BOX : BOX) };
  };
  const confirmed: Array<{ ref: string; point: { x: number; y: number }; frameId?: number }> = [];
  const confirm: TargetConfirmer = async ({ ref, point, frameId }) => {
    confirmed.push({ ref, point, ...(frameId === undefined ? {} : { frameId }) });
    return { outcome: "hit" };
  };
  const delivered: Array<Record<string, unknown>> = [];
  const siteModes = createSiteModeStore();
  const runner = createAgentEffects({
    context: testSessionContexts(),
    siteModes,
    bindings: createAgentPageBindings(),
    prompts: createAgentPromptController({ timeoutMs: 60 }),
    tabOwnership: async (_sessionId, tabId) => (tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
    attachments: input.attachments,
    cursor: () => {},
    locate,
    confirm,
    confirmFocus: async () => true,
    onDelivered: (_callId, delivery) => delivered.push(delivery as Record<string, unknown>),
    execute: async () => ({ ok: true, effect: "activated", clicks: 1, documentChanged: false }),
    probe: async () => ({ ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE }),
    readFrameFocus: oneDocumentFocus,
    settleMs: 0,
  });
  return { runner, siteModes, input, located, confirmed, delivered };
}

function request(tool: string, args: Record<string, unknown>): AgentNativeRequest {
  return {
    callId: "call-1",
    sessionId: "session-038",
    tool: tool as AgentNativeRequest["tool"],
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, ...args },
  };
}

/** Every mouse event's point, in order. */
function mousePoints(commands: Array<{ method: string; params: Record<string, unknown> }>) {
  return commands
    .filter((command) => command.method === "Input.dispatchMouseEvent")
    .map((command) => ({ type: command.params.type, x: command.params.x, y: command.params.y }));
}

/** Where the coordinate walk was asked - before the gate (030 R-442) and again before dispatch (R-446). */
function walkedAt(commands: Array<{ method: string; params: Record<string, unknown> }>) {
  return commands
    .filter((command) => command.method === "DOM.getNodeForLocation")
    .map((command) => ({ x: command.params.x, y: command.params.y }));
}

describe("038/T1081 a point target is delivered at the named point", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  const POINT = { x: 310, y: 260 };

  it.each(["click", "double_click", "right_click", "triple_click", "hover"])(
    "%s at a point: every mouse event, the marker, the re-check and the confirmation use the named point, and nothing scrolls",
    async (tool) => {
      const { runner, siteModes, input, located, confirmed, delivered } = harness();
      await siteModes.set(SITE, { mode: "skip-checks" });

      const response = await runner.run(request(tool, { target: POINT }));

      expect(response.outcome).toBe("ok");
      const events = mousePoints(input.commands);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.x === POINT.x && event.y === POINT.y)).toBe(true);
      expect(located).toEqual([{ ref: "t_at_310_260", scroll: false }]);
      expect(confirmed).toEqual([{ ref: "t_at_310_260", point: POINT }]);
      expect(delivered).toEqual([{ point: POINT }]);
      // The walk before the gate and the re-check before dispatch are both at the named point.
      expect(walkedAt(input.commands)).toEqual([POINT, POINT]);
    },
  );

  it.each(["click", "hover"])("%s at a ref keeps the box centre and scrolls it into view (004/T128)", async (tool) => {
    const { runner, siteModes, input, located, confirmed, delivered } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request(tool, { target: { ref: "t_save" } }));

    expect(response.outcome).toBe("ok");
    const events = mousePoints(input.commands);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.x === CENTRE.x && event.y === CENTRE.y)).toBe(true);
    expect(located).toEqual([{ ref: "t_save", scroll: true }]);
    expect(confirmed).toEqual([{ ref: "t_save", point: CENTRE }]);
    expect(delivered).toEqual([{ point: CENTRE }]);
  });

  it("drags between two points at the named points, scrolling for neither, and still re-measures", async () => {
    const { runner, siteModes, input, located, delivered } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });
    const from = { x: 310, y: 260 };
    const to = { x: 700, y: 500 };

    const response = await runner.run(request("drag", { from, to }));

    expect(response.outcome).toBe("ok");
    const events = mousePoints(input.commands);
    expect(events.find((event) => event.type === "mousePressed")).toMatchObject(from);
    expect(events.find((event) => event.type === "mouseReleased")).toMatchObject(to);
    expect(delivered).toEqual([{ from, to }]);
    expect(located).toEqual([
      { ref: "t_at_310_260", scroll: false },
      { ref: "t_at_700_500", scroll: false },
      // The "moved" re-measure of the start element (004/T128, B70) is unchanged.
      { ref: "t_at_310_260", scroll: false },
    ]);
    expect(walkedAt(input.commands)).toEqual([from, to, from, to]);
  });

  it("drags from a point to a ref: the point end at its point, the ref end at its centre", async () => {
    const { runner, siteModes, input, located } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });
    const from = { x: 310, y: 260 };

    const response = await runner.run(request("drag", { from, to: { ref: "t_drop" } }));

    expect(response.outcome).toBe("ok");
    const events = mousePoints(input.commands);
    expect(events.find((event) => event.type === "mousePressed")).toMatchObject(from);
    expect(events.find((event) => event.type === "mouseReleased")).toMatchObject(CENTRE);
    expect(located.slice(0, 2)).toEqual([
      { ref: "t_at_310_260", scroll: false },
      { ref: "t_drop", scroll: false },
    ]);
  });

  it("drags from a ref to a point without scrolling the ref into view, which would move the page under the point", async () => {
    const { runner, siteModes, input, located } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });
    const to = { x: 700, y: 500 };

    const response = await runner.run(request("drag", { from: { ref: "t_card" }, to }));

    expect(response.outcome).toBe("ok");
    const events = mousePoints(input.commands);
    expect(events.find((event) => event.type === "mousePressed")).toMatchObject(CENTRE);
    expect(events.find((event) => event.type === "mouseReleased")).toMatchObject(to);
    expect(located.slice(0, 2)).toEqual([
      { ref: "t_card", scroll: false },
      { ref: "t_at_700_500", scroll: false },
    ]);
  });

  it("drags between two refs as before: the first locate scrolls, both ends at their centres", async () => {
    const { runner, siteModes, input, located } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("drag", { from: { ref: "t_alpha" }, to: { ref: "t_beta" } }));

    expect(response.outcome).toBe("ok");
    const events = mousePoints(input.commands);
    expect(events.find((event) => event.type === "mousePressed")).toMatchObject(CENTRE);
    expect(located.slice(0, 2)).toEqual([
      { ref: "t_alpha", scroll: true },
      { ref: "t_beta", scroll: false },
    ]);
  });

  it("types at a point: the placing click lands on the named point and nothing scrolls", async () => {
    const { runner, siteModes, input, located } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("type", { target: POINT, text: "x" }));

    expect(response.outcome).toBe("ok");
    const events = mousePoints(input.commands);
    expect(events.find((event) => event.type === "mousePressed")).toMatchObject(POINT);
    expect(events.every((event) => event.x === POINT.x && event.y === POINT.y)).toBe(true);
    expect(located).toEqual([{ ref: "t_at_310_260", scroll: false }]);
    expect(walkedAt(input.commands)).toEqual([POINT, POINT]);
  });

  it("types at a ref as before: the placing click at the box centre, scrolled into view", async () => {
    const { runner, siteModes, input, located } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("type", { target: { ref: "t_field" }, text: "x" }));

    expect(response.outcome).toBe("ok");
    expect(mousePoints(input.commands).find((event) => event.type === "mousePressed")).toMatchObject(CENTRE);
    expect(located).toEqual([{ ref: "t_field", scroll: true }]);
  });
});
