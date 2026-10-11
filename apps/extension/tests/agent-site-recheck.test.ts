import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentBatch } from "../src/service-worker/agent-tools/batch.js";
import { createAgentEffects, type TargetRect } from "../src/service-worker/agent-tools/effects.js";
import { createStatedPlans } from "../src/service-worker/agent-tools/plans.js";
import { createAgentStopSignals } from "../src/service-worker/agent-tools/stop.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createAgentReads } from "../src/service-worker/agent-tools/reads.js";
import type { AgentInputAttachments } from "../src/service-worker/agent-tools/input.js";
import { SITE_MOVED_HINT } from "../src/service-worker/agent-tools/site-recheck.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";

/**
 * The site is checked again at the last moment before input or a picture leaves (014 change log
 * 2026-10-11).
 *
 * The site mode decides once per call, and a click then waits for the agent's cursor to glide to
 * its target before the press is sent. A page that starts moving to another site inside that wait
 * would receive a press - or be photographed - on a site the owner never decided about. Each case
 * here moves the tab to another origin at the last step before delivery and asserts that nothing
 * was delivered and the answer says so.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/recheck`;
const ELSEWHERE = "https://elsewhere.test/landing";

type Address = { url: string; pendingUrl?: string };

function fakeBrowser() {
  const address: Address = { url: PAGE_URL };
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const attachments = {
    async acquire() {
      return { ok: true as const };
    },
    async drop() {},
    async release() {},
    async releaseAll() {},
    async send(_tabId: number, method: string, params?: Record<string, unknown>) {
      sent.push({ method, ...(params === undefined ? {} : { params }) });
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      return {};
    },
    attached: () => [],
    oopifSessions: () => [],
    state: () => undefined,
    onEvent() {},
    onDetach() {},
    async attachedTabIds() {
      return [];
    },
    async detachStray() {},
  } as unknown as AgentInputAttachments;
  return { address, sent, attachments };
}

function installChrome(address: Address): void {
  const local: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
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
        return { id: AGENT_TAB, ...address };
      },
      async query() {
        return [{ id: AGENT_TAB, url: address.url, windowId: 1, active: true, groupId: 3, title: "t" }];
      },
      async sendMessage(_tabId: number, message: unknown) {
        if ((message as { type: string }).type === "content.probe") {
          return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        }
        throw new Error("unexpected frame");
      },
    },
  };
}

async function effectsHarness(
  onCursor: (address: Address) => void,
  onListTabs?: (address: Address) => void,
  onDelivered?: (callId: string) => void,
) {
  const browser = fakeBrowser();
  installChrome(browser.address);
  const siteModes = createSiteModeStore();
  await siteModes.set(SITE, { mode: "skip-checks" });
  const rect: TargetRect = { x: 100, y: 40, width: 80, height: 20 };
  const capture = vi.fn(async () => ({ data: "UE5H", cropped: false, scale: 1 }));
  const runner = createAgentEffects({
    context: testSessionContexts(),
    siteModes,
    bindings: createAgentPageBindings(),
    prompts: createAgentPromptController({ timeoutMs: 60 }),
    tabOwnership: async (_sessionId, tabId) => (tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
    attachments: browser.attachments,
    locate: async () => rect,
    confirm: async () => ({ outcome: "hit" }),
    probe: async () => ({ ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE }),
    settleMs: 0,
    ...(onDelivered === undefined ? {} : { onDelivered: (callId: string) => onDelivered(callId) }),
    // The cursor's glide is the wait the page moves during.
    cursor: async () => onCursor(browser.address),
    capture,
    listTabs: async () => {
      onListTabs?.(browser.address);
      return [{ id: AGENT_TAB, url: browser.address.url, windowId: 1, active: true, groupId: 3, title: "t" }];
    },
  });
  return { runner, browser, capture };
}

function request(tool: string, args: Record<string, unknown>): AgentNativeRequest {
  return {
    callId: `call-${tool}`,
    sessionId: "session-r1",
    tool: tool as AgentNativeRequest["tool"],
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, ...args },
  };
}

const presses = (sent: Array<{ method: string }>) => sent.filter((command) => command.method === "Input.dispatchMouseEvent");

const SITE_MOVED = {
  callId: expect.any(String),
  outcome: "stale",
  reason: "stale-context",
  hint: SITE_MOVED_HINT,
};

describe("014 re-check of the site before delivery (2026-10-11)", () => {
  beforeEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("a ref click sends nothing when a navigation to another site starts during the cursor's glide", async () => {
    const { runner, browser } = await effectsHarness((address) => {
      address.pendingUrl = ELSEWHERE;
    });

    const response = await runner.run(request("click", { target: { ref: "t_1" } }));

    expect(presses(browser.sent)).toEqual([]);
    expect(response).toEqual({ ...SITE_MOVED, callId: "call-click" });
  });

  it("a ref click sends nothing when the tab has already committed another site", async () => {
    const { runner, browser } = await effectsHarness((address) => {
      address.url = ELSEWHERE;
    });

    const response = await runner.run(request("click", { target: { ref: "t_1" } }));

    expect(presses(browser.sent)).toEqual([]);
    expect(response.outcome).toBe("stale");
  });

  it("a same-site navigation does not hold the click", async () => {
    const { runner, browser } = await effectsHarness((address) => {
      address.pendingUrl = `${SITE}/next`;
    });

    await runner.run(request("click", { target: { ref: "t_1" } }));

    expect(presses(browser.sent).length).toBeGreaterThan(0);
  });

  it("a position click from computer sends nothing when the page moves to another site during the glide", async () => {
    const { runner, browser } = await effectsHarness((address) => {
      address.pendingUrl = ELSEWHERE;
    });

    const response = await runner.run(request("computer", { action: "left_click", x: 40, y: 40 }));

    expect(presses(browser.sent)).toEqual([]);
    expect(response).toEqual({ ...SITE_MOVED, callId: "call-computer" });
  });

  /**
   * Review S1-F1: the delivery marker (014 FR-181) and the recording's ring are written only once
   * the check has let the gesture go, so an interrupt during a refused one is not told the page may
   * have been given something, and no ring is drawn for a press that never left.
   */
  it("marks no delivery for a gesture the check refused, and marks one it let go", async () => {
    for (const [tool, args] of [
      ["click", { target: { ref: "t_1" } }],
      ["hover", { target: { ref: "t_1" } }],
      ["drag", { from: { ref: "t_1" }, to: { ref: "t_2" } }],
      ["type", { target: { ref: "t_1" }, text: "a", mode: "insert" }],
      ["computer", { action: "left_click", x: 40, y: 40 }],
      ["computer", { action: "type", text: "a", x: 40, y: 40 }],
    ] as const) {
      const delivered: string[] = [];
      const moved = await effectsHarness(
        (address) => {
          address.pendingUrl = ELSEWHERE;
        },
        undefined,
        (callId) => delivered.push(callId),
      );

      const response = await moved.runner.run(request(tool, args));

      expect(response.outcome, `${tool} refused`).toBe("stale");
      expect(delivered, `${tool} marked a delivery the check refused`).toEqual([]);

      const stayed = await effectsHarness(
        () => undefined,
        undefined,
        (callId) => delivered.push(callId),
      );
      await stayed.runner.run(request(tool, args));
      // `type` marks again before its keys; the marker is a set, so once or twice is the same fact.
      expect([...new Set(delivered)], `${tool} marked nothing for a gesture that left`).toEqual([`call-${tool}`]);
    }
  });

  it("a browser_batch click step answers site-moved and sends nothing when the tab leaves during the glide", async () => {
    const { runner, browser } = await effectsHarness((address) => {
      address.pendingUrl = ELSEWHERE;
    });
    const batch = createAgentBatch({
      siteModes: createSiteModeStore(),
      plans: createStatedPlans(),
      prompts: createAgentPromptController({ timeoutMs: 60 }),
      stops: createAgentStopSignals(),
      tabOwnership: async (_sessionId, tabId) => (tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
      siteOfTab: async () => SITE,
      dispatch: (step) => runner.run(step as AgentNativeRequest),
    });

    const response = await batch.run(
      request("browser_batch", {
        steps: [
          { tool: "click", args: { target: { ref: "t_1" } } },
          { tool: "click", args: { target: { ref: "t_2" } } },
        ],
      }),
    );

    expect(presses(browser.sent)).toEqual([]);
    const results = (response.result as { results: Array<Record<string, unknown>> }).results;
    expect(results[0]).toMatchObject({ index: 0, outcome: "stale", reason: "stale-context", hint: SITE_MOVED_HINT });
    expect(results.slice(1).every((step) => step.outcome !== "ok")).toBe(true);
  });

  it("a computer screenshot captures nothing when the page has moved to another site", async () => {
    const { runner, capture } = await effectsHarness(
      () => undefined,
      (address) => {
        address.pendingUrl = ELSEWHERE;
      },
    );

    const response = await runner.run(request("computer", { action: "screenshot" }));

    expect(capture).not.toHaveBeenCalled();
    expect(response).toEqual({ ...SITE_MOVED, callId: "call-computer" });
  });

  it("the screenshot tool captures nothing when the page starts moving to another site before the capture", async () => {
    const address: Address = { url: PAGE_URL };
    installChrome(address);
    const capture = vi.fn(async () => ({ data: "UE5H", cropped: false, scale: 1 }));
    const runner = createAgentReads({
      context: testSessionContexts(),
      bindings: createAgentPageBindings(),
      tabOwnership: async (_sessionId, tabId) => (tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
      listTabs: async () => {
        address.pendingUrl = ELSEWHERE;
        return [{ id: AGENT_TAB, url: address.url, windowId: 1, active: true, groupId: 3, title: "t" }];
      },
      capture,
      tabSize: async () => ({ width: 1280, height: 720 }),
    });

    const response = await runner.run({
      callId: "call-shot",
      sessionId: "session-r1",
      tool: "screenshot",
      tabId: AGENT_TAB,
      args: { tabId: AGENT_TAB },
    });

    expect(capture).not.toHaveBeenCalled();
    expect(response).toEqual({ ...SITE_MOVED, callId: "call-shot" });
  });
});
