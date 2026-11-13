import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";

/**
 * 033/T983 - who sends the caption step (FR-499, FR-510, R-491, D-033-4).
 *
 * The claim is the sender's: every call that names a tab the session holds, top-level or a step of
 * a `browser_batch`, tells that tab's top frame one `pointer-step` before the runner acts - and the
 * send is a mark, not part of the call: a page that rejects it, or never answers, costs the call
 * nothing.
 */

type FakePort = AgentPortLike & { sent: unknown[]; emit(message: unknown): void };

function fakePort(): FakePort {
  const listeners: Array<(message: unknown) => void> = [];
  return {
    sent: [],
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    disconnect() {},
    onMessage: { addListener: (cb: (message: unknown) => void) => void listeners.push(cb) },
    onDisconnect: { addListener: () => undefined },
    emit(message: unknown) {
      for (const listener of listeners) listener(message);
    },
  };
}

const SESSION = "session-t983";
const HELD = 7;
const UNHELD = 8;
const SITE = "https://a.test";
const HELLO = { type: "hello", sessionId: SESSION, agentId: "agent-1", displayName: "Claude Code" };
const PAIR_REQUEST = {
  type: "pair-request",
  agentId: "agent-1",
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId: SESSION,
};

type SentMessage = { tabId: number; message: { type?: string }; options?: { frameId?: number } };

/** A browser with two tabs and a recorder of everything sent to a page, in order. */
function installChrome(language: string): {
  sent: SentMessage[];
  rejectSteps: { on: boolean };
  /** Steps and the one thing a navigation does, in the order they happened. */
  events: string[];
  /** What a navigation does when it runs; replaced by a test that needs more of it. */
  navigation: { run: () => Promise<void> };
} {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const sent: SentMessage[] = [];
  const rejectSteps = { on: false };
  const events: string[] = [];
  const navigation = {
    run: async (): Promise<void> => {
      // Refused after it began: the call finishes at once, which is all the ordering needs (the
      // document may have been replaced either way).
      events.push("navigate-ran");
      throw new Error("fake: the navigation is not run");
    },
  };
  const tabs = [
    { id: HELD, url: `${SITE}/one`, title: "A one", groupId: -1, active: true, windowId: 900 },
    { id: UNHELD, url: `${SITE}/two`, title: "A two", groupId: -1, active: false, windowId: 900 },
  ];
  const area = (store: Record<string, unknown>) => ({
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store, values);
    },
  });
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: area(local), session: area(session) },
    alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
    runtime: { id: "extension-1", onMessage: { addListener() {} } },
    i18n: { getUILanguage: () => language },
    scripting: { async executeScript() {} },
    tabs: {
      async sendMessage(tabId: number, message: { type?: string }, options?: { frameId?: number }) {
        sent.push({ tabId, message, ...(options === undefined ? {} : { options }) });
        if (message.type === "pointer-step") events.push(`step:${(message as { words?: string }).words}`);
        if (message.type === "pointer-step" && rejectSteps.on) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return { documentEpoch: "doc-1", canonicalOrigin: SITE };
      },
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return tabs;
      },
      async update() {
        await navigation.run();
      },
      async ungroup() {},
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        const target = groupId ?? 100;
        for (const tabId of tabIds) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = target;
        }
        return target;
      },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    tabGroups: { async update(groupId: number) { return { id: groupId }; } },
    downloads: { onCreated: { addListener: () => undefined }, onChanged: { addListener: () => undefined } },
    debugger: {
      async getTargets() {
        return [];
      },
      async attach() {},
      async detach() {},
      async sendCommand() {
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return { sent, rejectSteps, events, navigation };
}

async function pairedRuntime(
  options: Parameters<typeof composeAgentRuntime>[0] = {},
): Promise<{ port: FakePort; runtime: ReturnType<typeof composeAgentRuntime> }> {
  const port = fakePort();
  const runtime = composeAgentRuntime({ connectNative: () => port, ...options });
  runtime.start();
  port.emit(HELLO);
  port.emit(PAIR_REQUEST);
  await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
  await runtime.pairing.decide("agent-1", true);
  await vi.waitFor(() => expect(port.sent).toHaveLength(1));
  await runtime.tabs.adopt(SESSION, HELD);
  return { port, runtime };
}

function answered(port: FakePort, callId: string): boolean {
  return port.sent.some((frame) => (frame as { callId?: string; outcome?: string }).callId === callId && "outcome" in (frame as object));
}

function steps(fake: { sent: SentMessage[] }): SentMessage[] {
  return fake.sent.filter((entry) => entry.message.type === "pointer-step");
}

describe("T983 the caption step's sender", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome("en-US");
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("tells the held tab's top frame what a top-level find is doing, before the runner touches the page", async () => {
    const { port } = await pairedRuntime();

    port.emit({ callId: "call-find", sessionId: SESSION, tool: "find", args: { tabId: HELD, query: "Sign in" } });

    await vi.waitFor(() => expect(answered(port, "call-find")).toBe(true));
    expect(steps(fake)).toEqual([
      {
        tabId: HELD,
        message: { type: "pointer-step", words: "Finding “Sign in”", mode: "stay" },
        options: { frameId: 0 },
      },
    ]);
    // The runner's own questions to the page (the probe, the collector) all come after the step.
    const at = fake.sent.findIndex((entry) => entry.message.type === "pointer-step");
    const runnerTraffic = fake.sent.findIndex(
      (entry, index) => index !== at && !["indicator", "pointer-step"].includes(entry.message.type ?? ""),
    );
    if (runnerTraffic !== -1) expect(at).toBeLessThan(runnerTraffic);
  });

  it("uses the owner's locale, the one the indicator uses", async () => {
    delete (globalThis as { chrome?: unknown }).chrome;
    fake = installChrome("zh-TW");
    const { port } = await pairedRuntime();

    port.emit({ callId: "call-find", sessionId: SESSION, tool: "find", args: { tabId: HELD, query: "登入" } });

    await vi.waitFor(() => expect(steps(fake)).toHaveLength(1));
    expect(steps(fake)[0]?.message).toEqual({ type: "pointer-step", words: "尋找「登入」", mode: "stay" });
  });

  it("sends each step of a browser_batch its own step, in order, as the step starts", async () => {
    const { port } = await pairedRuntime();

    port.emit({
      callId: "call-batch",
      sessionId: SESSION,
      tool: "browser_batch",
      args: {
        tabId: HELD,
        steps: [
          // A wait always succeeds here, so the batch reaches its second step (it stops at the first
          // step that does not end ok, and the page under test is a fake).
          { tool: "wait", args: { forMs: 100 } },
          { tool: "find", args: { query: "Buy" } },
        ],
      },
    });

    await vi.waitFor(() => expect(answered(port, "call-batch")).toBe(true));
    expect(steps(fake).map((entry) => [entry.tabId, entry.message, entry.options])).toEqual([
      [HELD, { type: "pointer-step", words: "Waiting 0.1 seconds", mode: "stay" }, { frameId: 0 }],
      [HELD, { type: "pointer-step", words: "Finding “Buy”", mode: "stay" }, { frameId: 0 }],
    ]);
  });

  it("sends nothing for a tool with no caption", async () => {
    const { port } = await pairedRuntime();

    port.emit({ callId: "call-shot", sessionId: SESSION, tool: "screenshot", args: { tabId: HELD } });

    await vi.waitFor(() => expect(answered(port, "call-shot")).toBe(true));
    expect(steps(fake)).toEqual([]);
  });

  it("sends nothing to a tab the session does not hold", async () => {
    const { port } = await pairedRuntime();

    port.emit({ callId: "call-other", sessionId: SESSION, tool: "get_page_text", args: { tabId: UNHELD } });

    await vi.waitFor(() => expect(answered(port, "call-other")).toBe(true));
    expect(steps(fake)).toEqual([]);
  });

  it("answers the call as it would have when the page rejects the step", async () => {
    fake.rejectSteps.on = true;
    const { port } = await pairedRuntime();

    port.emit({ callId: "call-find", sessionId: SESSION, tool: "find", args: { tabId: HELD, query: "x" } });

    await vi.waitFor(() => expect(answered(port, "call-find")).toBe(true));
    expect(steps(fake)).toHaveLength(1);
  });

  it("does not wait for a page that never answers the step", async () => {
    const delivered: Array<{ tabId: number; step: unknown }> = [];
    const { port } = await pairedRuntime({
      sendPointerStep: (tabId, step) => {
        delivered.push({ tabId, step });
        return new Promise<void>(() => undefined);
      },
    });

    port.emit({ callId: "call-find", sessionId: SESSION, tool: "find", args: { tabId: HELD, query: "x" } });

    await vi.waitFor(() => expect(answered(port, "call-find")).toBe(true));
    expect(delivered).toEqual([{ tabId: HELD, step: { type: "pointer-step", words: "Finding “x”", mode: "stay" } }]);
    // The injected sender replaced the browser's: the page got no step through chrome.tabs.
    expect(steps(fake)).toEqual([]);
  });

  it("swallows an injected sender that throws or rejects", async () => {
    const { port } = await pairedRuntime({
      sendPointerStep: () => {
        throw new Error("boom");
      },
    });

    port.emit({ callId: "call-find", sessionId: SESSION, tool: "find", args: { tabId: HELD, query: "x" } });

    await vi.waitFor(() => expect(answered(port, "call-find")).toBe(true));
  });

  // 033 live run 2026-11-13: the rest step before a navigation reaches the document being left.
  const NAVIGATE = { tabId: HELD, url: "https://b.test/x" };
  const REST = { type: "pointer-step", words: "Opening b.test", mode: "rest" };

  it("tells the document a navigate leaves behind it the rest step again, once the call has run", async () => {
    const { port } = await pairedRuntime();

    port.emit({ callId: "call-nav", sessionId: SESSION, tool: "navigate", args: NAVIGATE });

    await vi.waitFor(() => expect(answered(port, "call-nav")).toBe(true));
    expect(fake.events).toEqual(["step:Opening b.test", "navigate-ran", "step:Opening b.test"]);
    expect(steps(fake).map((entry) => [entry.tabId, entry.message, entry.options])).toEqual([
      [HELD, REST, { frameId: 0 }],
      [HELD, REST, { frameId: 0 }],
    ]);
  });

  it("does not send a step that is not a rest step again after its call", async () => {
    const { port } = await pairedRuntime();

    port.emit({ callId: "call-find", sessionId: SESSION, tool: "find", args: { tabId: HELD, query: "x" } });

    await vi.waitFor(() => expect(answered(port, "call-find")).toBe(true));
    expect(steps(fake)).toHaveLength(1);
  });

  it("answers the navigate as it would have when the page never takes the step, and tries the injected script once", async () => {
    fake.rejectSteps.on = true;
    const { port } = await pairedRuntime();

    port.emit({ callId: "call-nav", sessionId: SESSION, tool: "navigate", args: NAVIGATE });

    await vi.waitFor(() => expect(answered(port, "call-nav")).toBe(true));
    // Before the call (rejected, nothing more), after it (rejected, the agent script injected), and
    // once after the injection - then no more.
    await vi.waitFor(() => expect(steps(fake)).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(steps(fake)).toHaveLength(3);
  });

  it("does not tell a tab the call released the step again", async () => {
    const { port, runtime } = await pairedRuntime();
    fake.navigation.run = async () => {
      await runtime.tabs.release(SESSION, HELD);
      throw new Error("fake: the navigation is not run");
    };

    port.emit({ callId: "call-nav", sessionId: SESSION, tool: "navigate", args: NAVIGATE });

    await vi.waitFor(() => expect(answered(port, "call-nav")).toBe(true));
    expect(steps(fake)).toHaveLength(1);
  });
});
