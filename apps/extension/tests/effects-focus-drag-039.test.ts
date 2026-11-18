import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import {
  createAgentEffects,
  createFocusConfirmer,
  type FocusConfirmer,
  type TargetConfirmer,
  type TargetLocator,
} from "../src/service-worker/agent-tools/effects.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";
import { testInputAttachments } from "./helpers/input-attachments.js";
import { oneDocumentAnswer, oneDocumentFocus } from "./helpers/point-site.js";

/**
 * 039/T1090, T1091 - typing at a point after the placing click, and a drag inside one element.
 *
 * FR-568/569: the focus check between the placing click and the first key passes on the path the
 * click took (the confirmer says so, the page decides), refuses before any key otherwise, and when
 * the field that holds focus is not the element named the answer's hint says which one it is.
 * FR-570: a drag is refused as `same-endpoints` only when the two points it would deliver are less
 * than one CSS pixel apart - not because both ends resolve to one element.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/ordinary`;
/** The located box: centre (400, 300), away from every point named below. */
const BOX = { x: 300, y: 250, width: 200, height: 100 };
const CENTRE = { x: 400, y: 300 };

function installChrome(sameElementEverywhere: boolean): void {
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
          // One canvas under every point, or a different element under each.
          return {
            ok: true,
            outcome: "resolved",
            candidates: [
              { targetHandle: sameElementEverywhere ? "t_canvas" : `t_at_${String(frame.payload.x)}_${String(frame.payload.y)}` },
            ],
          };
        }
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
}

function harness(
  options: {
    confirmFocus?: FocusConfirmer;
    /** What the press point's confirmation answers (040 FR-572); a hit by default. */
    confirmOutcome?: "hit" | "missed" | "unconfirmed";
    /** The box a located ref has, the n-th time it is located (default: the one box, never moving). */
    box?: (ref: string, nth: number) => typeof BOX;
  } = {},
) {
  const input = testInputAttachments();
  const recorded = input.attachments.send.bind(input.attachments);
  input.attachments.send = async (tabId, method, params, sessionId) => {
    const answered = await recorded(tabId, method, params, sessionId);
    return oneDocumentAnswer(method) ?? answered;
  };
  const located: Array<{ ref: string; scroll: boolean }> = [];
  const locate: TargetLocator = async ({ ref, scroll }) => {
    located.push({ ref, scroll });
    return { ...(options.box?.(ref, located.filter((entry) => entry.ref === ref).length) ?? BOX) };
  };
  const confirmed: Array<{ ref: string; point: { x: number; y: number } }> = [];
  const confirm: TargetConfirmer = async (asked) => {
    confirmed.push({ ref: asked.ref, point: asked.point });
    return { outcome: options.confirmOutcome ?? "hit" };
  };
  const focusAsked: string[] = [];
  const confirmFocus: FocusConfirmer = async (asked) => {
    focusAsked.push(asked.ref);
    return (options.confirmFocus ?? (async () => true))(asked);
  };
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
    confirmFocus,
    onDelivered: () => {},
    execute: async () => ({ ok: true, effect: "activated", clicks: 1, documentChanged: false }),
    probe: async () => ({ ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE }),
    readFrameFocus: oneDocumentFocus,
    settleMs: 0,
  });
  return { runner, siteModes, input, located, focusAsked, confirmed };
}

function request(tool: string, args: Record<string, unknown>): AgentNativeRequest {
  return {
    callId: "call-1",
    sessionId: "session-039",
    tool: tool as AgentNativeRequest["tool"],
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, ...args },
  };
}

type Command = { method: string; params: Record<string, unknown> };

function mousePoints(commands: Command[]) {
  return commands
    .filter((command) => command.method === "Input.dispatchMouseEvent")
    .map((command) => ({ type: command.params.type, x: command.params.x, y: command.params.y }));
}

const keysSent = (commands: Command[]) =>
  commands.some((command) => command.method === "Input.insertText" || command.method === "Input.dispatchKeyEvent");

describe("039/T1090 the focus check after a placing click (FR-568, FR-569)", () => {
  beforeEach(() => installChrome(false));
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  const POINT = { x: 310, y: 260 };

  describe("createFocusConfirmer", () => {
    const context = () => testSessionContexts().forCall("session-039", "call-1");
    const binding = { tabId: AGENT_TAB, documentEpoch: "doc-1", canonicalOrigin: SITE, site: SITE };

    it("asks the page about the clicked ref, so focus on its path can answer for it", async () => {
      const asked: Array<{ targetHandle?: string }> = [];
      const confirmFocus = createFocusConfirmer(async (input) => {
        asked.push({ ...(input.targetHandle === undefined ? {} : { targetHandle: input.targetHandle }) });
        return { ok: true, outcome: "resolved", candidates: [{ targetHandle: "t_span" }] };
      });

      await confirmFocus({ context: context(), binding, ref: "t_span" });

      expect(asked).toEqual([{ targetHandle: "t_span" }]);
    });

    it("is true when the page answers with the ref, and false on a miss that says what holds focus", async () => {
      const hit = createFocusConfirmer(async () => ({
        ok: true,
        outcome: "resolved",
        candidates: [{ targetHandle: "t_span" }],
      }));
      const miss = createFocusConfirmer(async () => ({ ok: true, outcome: "missed", role: "textbox", label: "Coupon" }));

      expect(await hit({ context: context(), binding, ref: "t_span" })).toBe(true);
      expect(await miss({ context: context(), binding, ref: "t_span" })).toBe(false);
    });

    it("carries the receiving field's role and label when focus is on another element than the ref", async () => {
      const confirmFocus = createFocusConfirmer(async () => ({
        ok: true,
        outcome: "resolved",
        candidates: [{ targetHandle: "t_label_text" }],
        receivedBy: { role: "textbox", label: "Full name" },
      }));

      expect(await confirmFocus({ context: context(), binding, ref: "t_label_text" })).toEqual({
        retained: true,
        receivedBy: { role: "textbox", label: "Full name" },
      });
    });
  });

  it("types after a placing click whose focus is on the editing host, and names the field that took the text", async () => {
    const { runner, siteModes, input, focusAsked } = harness({
      confirmFocus: async () => ({ retained: true, receivedBy: { role: "textbox", label: "Full name" } }),
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("type", { target: POINT, text: "hello", mode: "insert" }));

    expect(response.outcome).toBe("ok");
    expect(response.result).toMatchObject({
      observed: { effect: "text-entered", charactersChanged: 5, verified: true, verdict: "verified" },
    });
    expect(keysSent(input.commands)).toBe(true);
    // The focus check asked about the ref the placing click was aimed at.
    expect(focusAsked[0]).toBe("t_at_310_260");
    expect(response.hint).toContain("textbox");
    expect(response.hint).toContain("Full name");
  });

  it("gives no hint when focus is on the element named itself", async () => {
    const { runner, siteModes } = harness({ confirmFocus: async () => true });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("type", { target: POINT, text: "hello", mode: "insert" }));

    expect(response.result).toMatchObject({ observed: { verified: true } });
    expect(response.hint).toBeUndefined();
  });

  it("bounds the receiving field's label in the hint the way a find label is", async () => {
    const long = "x".repeat(300);
    const { runner, siteModes } = harness({
      confirmFocus: async () => ({ retained: true, receivedBy: { role: "textbox", label: long } }),
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("type", { target: POINT, text: "a", mode: "insert" }));

    expect(response.hint?.length).toBeLessThanOrEqual(400);
    expect(response.hint).not.toContain("x".repeat(81));
  });

  it("refuses focus-lost before any key when focus went to an unrelated field, and says nothing of it as a receiver", async () => {
    const { runner, siteModes, input } = harness({ confirmFocus: async () => false });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("type", { target: POINT, text: "secret", mode: "replace" }));

    expect(response.result).toMatchObject({
      observed: { effect: "text-entered", charactersChanged: 0, verified: false, verdict: "focus-lost" },
    });
    expect(keysSent(input.commands)).toBe(false);
    expect(response.hint).toBeUndefined();
  });

  it("does not type at all when the focus check could not run: the answer stays what it was (T161)", async () => {
    const { runner, siteModes } = harness({ confirmFocus: async () => undefined });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("type", { target: POINT, text: "a", mode: "insert" }));

    expect(response.outcome).toBe("ok");
    expect(response.hint).toBeUndefined();
  });

  it("checks key with a target against the clicked ref too, and names the receiving field", async () => {
    const { runner, siteModes, focusAsked } = harness({
      confirmFocus: async () => ({ retained: true, receivedBy: { role: "textbox", label: "Full name" } }),
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("key", { target: POINT, key: "Enter" }));

    expect(response.result).toMatchObject({ observed: { effect: "key-pressed", verified: true, verdict: "verified" } });
    expect(focusAsked[0]).toBe("t_at_310_260");
    expect(response.hint).toContain("Full name");
  });

  it("checks focus once before typing, never again after the text (004/T159)", async () => {
    const { runner, siteModes, focusAsked } = harness({ confirmFocus: async () => true });
    await siteModes.set(SITE, { mode: "skip-checks" });

    await runner.run(request("type", { target: POINT, text: "abc", mode: "insert" }));

    expect(focusAsked).toHaveLength(1);
  });
});

describe("039/T1091 a drag is refused only when it would not move (FR-570)", () => {
  beforeEach(() => installChrome(true));
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  const FROM = { x: 310, y: 260 };
  const TO = { x: 480, y: 330 };

  it("delivers a drag between two points inside one element, at the named points", async () => {
    const { runner, siteModes, input } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("drag", { from: FROM, to: TO }));

    expect(response.outcome).toBe("ok");
    const events = mousePoints(input.commands);
    expect(events.find((event) => event.type === "mousePressed")).toMatchObject(FROM);
    expect(events.find((event) => event.type === "mouseReleased")).toMatchObject(TO);
  });

  it("refuses two identical points as same-endpoints, with nothing sent to the page", async () => {
    const { runner, siteModes, input } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("drag", { from: FROM, to: { ...FROM } }));

    expect(response).toMatchObject({ outcome: "failed", reason: "same-endpoints" });
    expect(mousePoints(input.commands)).toEqual([]);
  });

  it("refuses points less than one pixel apart, and delivers at one pixel", async () => {
    const near = harness();
    await near.siteModes.set(SITE, { mode: "skip-checks" });
    const refused = await near.runner.run(request("drag", { from: FROM, to: { x: FROM.x + 0.6, y: FROM.y + 0.6 } }));
    expect(refused).toMatchObject({ outcome: "failed", reason: "same-endpoints" });
    expect(mousePoints(near.input.commands)).toEqual([]);

    const apart = harness();
    await apart.siteModes.set(SITE, { mode: "skip-checks" });
    const delivered = await apart.runner.run(request("drag", { from: FROM, to: { x: FROM.x + 1, y: FROM.y } }));
    expect(delivered.outcome).toBe("ok");
  });

  it("still refuses a drag between two identical refs, as the tool's own argument rule always has", async () => {
    const { runner, siteModes, input } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("drag", { from: { ref: "t_card" }, to: { ref: "t_card" } }));

    // Two refs the same are refused before dispatch (`agentDragArgsSchema`), unchanged by 039.
    expect(response).toMatchObject({ outcome: "failed", reason: "invalid-arguments" });
    expect(mousePoints(input.commands)).toEqual([]);
  });

  it("delivers a drag between a ref and a point inside that ref's element when the point is not its centre", async () => {
    const { runner, siteModes, input } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    // The point resolves to `t_canvas`, the same ref named as the other end.
    const response = await runner.run(request("drag", { from: { ref: "t_canvas" }, to: FROM }));

    expect(response.outcome).toBe("ok");
    const events = mousePoints(input.commands);
    expect(events.find((event) => event.type === "mousePressed")).toMatchObject(CENTRE);
    expect(events.find((event) => event.type === "mouseReleased")).toMatchObject(FROM);
  });

  it("refuses a drag from a ref to a point at that ref's own centre: it would not move", async () => {
    const { runner, siteModes, input } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("drag", { from: { ref: "t_canvas" }, to: { ...CENTRE } }));

    expect(response).toMatchObject({ outcome: "failed", reason: "same-endpoints" });
    expect(mousePoints(input.commands)).toEqual([]);
  });
});

describe("040/T1101 a drag inside one element is verified by its press point (FR-572, D-040-1)", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  const FROM = { x: 310, y: 260 };
  const TO = { x: 480, y: 330 };
  /** The observed verdict of an `ok` answer. */
  const verdictOf = (response: { result?: unknown }) => (response.result as { observed?: { verdict?: string } }).observed?.verdict;

  it("answers verified for two points on one element when the press point resolves to it, though nothing moved", async () => {
    installChrome(true);
    const { runner, siteModes, confirmed } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("drag", { from: FROM, to: TO }));

    expect(response.outcome).toBe("ok");
    expect(verdictOf(response)).toBe("verified");
    // Asked at the point the press lands on, about the element both ends resolved to.
    expect(confirmed).toEqual([{ ref: "t_canvas", point: FROM }]);
  });

  it("answers verified for a ref and a point inside that ref's element, asking at the ref's own centre", async () => {
    installChrome(true);
    const { runner, siteModes, confirmed } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("drag", { from: { ref: "t_canvas" }, to: FROM }));

    expect(verdictOf(response)).toBe("verified");
    expect(confirmed).toEqual([{ ref: "t_canvas", point: CENTRE }]);
  });

  it("answers verified for a point and a ref whose element it is, asking at the named point", async () => {
    installChrome(true);
    const { runner, siteModes, confirmed } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("drag", { from: FROM, to: { ref: "t_canvas" } }));

    expect(verdictOf(response)).toBe("verified");
    expect(confirmed).toEqual([{ ref: "t_canvas", point: FROM }]);
  });

  it("answers target-missed when the press point resolves to something else, and target-unconfirmed when it could not be asked", async () => {
    installChrome(true);
    const missed = harness({ confirmOutcome: "missed" });
    await missed.siteModes.set(SITE, { mode: "skip-checks" });
    expect(verdictOf(await missed.runner.run(request("drag", { from: FROM, to: TO })))).toBe("target-missed");

    const unconfirmed = harness({ confirmOutcome: "unconfirmed" });
    await unconfirmed.siteModes.set(SITE, { mode: "skip-checks" });
    expect(verdictOf(await unconfirmed.runner.run(request("drag", { from: FROM, to: TO })))).toBe("target-unconfirmed");
  });

  it("keeps the moved-box rule for two different elements: no confirmation is asked, an unmoved box is not-moved", async () => {
    installChrome(false);
    const { runner, siteModes, confirmed } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("drag", { from: FROM, to: TO }));

    expect(verdictOf(response)).toBe("not-moved");
    expect(confirmed).toEqual([]);
  });

  it("keeps the moved-box rule for two different elements: a box that moved is verified", async () => {
    installChrome(false);
    // The dragged element's box, located again after the gesture, is somewhere else.
    const { runner, siteModes, confirmed } = harness({
      box: (_ref, nth) => (nth === 1 ? BOX : { ...BOX, x: BOX.x + 170, y: BOX.y + 70 }),
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request("drag", { from: FROM, to: TO }));

    expect(verdictOf(response)).toBe("verified");
    expect(confirmed).toEqual([]);
  });
});
