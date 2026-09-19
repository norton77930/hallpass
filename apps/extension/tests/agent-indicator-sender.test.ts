import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { lookup } from "../src/locales/catalog.js";

/**
 * 004/T107b — who sends the indicator (FR-062, SC-032).
 *
 * T107 built the page half and T108 the return half, and nothing in between ever said "show it".
 * The claim here is the sender's, and it is about *which* tabs hear it: a tab joins a session and
 * that tab is told, it leaves and it is told again, and a tab no session holds is never told to
 * put an agent's badge on the owner's page.
 *
 * The navigation case is the reason the page asks rather than the worker tracking: the content
 * script is reloaded at `document_start` and the indicator is gone with the document, so the page
 * announces itself and the worker answers with that tab's state - which also heals a worker that
 * was evicted. An announcement from a tab nobody holds is answered "no indicator" rather than
 * ignored, so the page is never left waiting for an answer that is not coming.
 */

const EXTENSION_ID = "hallpass-test-extension";

type ContentSender = { id?: string; tab?: { id?: number } };
type ContentListener = (message: unknown, sender: ContentSender) => boolean | void;
type SentMessage = { tabId: number; message: unknown; options?: { frameId?: number } };

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

/**
 * The relay's announcement of an attached agent, and the pairing question that follows it: the
 * unpair path is the one indicator case that cannot be reached from the tab manager alone, because
 * the owner unpairs an *agent* and only the greeting says which session belongs to it.
 */
const HELLO = {
  type: "hello",
  sessionId: "session-a",
  agentId: "agent-1",
  displayName: "Claude Code",
};

const PAIR_REQUEST = {
  type: "pair-request",
  agentId: "agent-1",
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId: "session-a",
};

function installChrome(): {
  sent: SentMessage[];
  emit: (message: unknown, sender: ContentSender) => void;
} {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const sent: SentMessage[] = [];
  const listeners: ContentListener[] = [];
  const tabs = [
    { id: 3, url: "https://owner.test/unheld", title: "Owner", groupId: -1, active: true, windowId: 900 },
    { id: 5, url: "https://a.test/main", title: "A main", groupId: -1, active: false, windowId: 900 },
    { id: 7, url: "https://a.test/held", title: "A held", groupId: -1, active: false, windowId: 900 },
  ];
  let nextGroupId = 100;
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
    runtime: {
      id: EXTENSION_ID,
      onMessage: { addListener: (listener: ContentListener) => void listeners.push(listener) },
    },
    i18n: { getUILanguage: () => "zh-TW" },
    storage: { local: area(local), session: area(session) },
    alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
    scripting: { async executeScript() {} },
    tabs: {
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return tabs;
      },
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        const target = groupId ?? nextGroupId++;
        for (const tabId of tabIds) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = target;
        }
        return target;
      },
      async ungroup(tabIds: number[]) {
        for (const tabId of tabIds) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = -1;
        }
      },
      async update(tabId: number) {
        return tabs.find((candidate) => candidate.id === tabId);
      },
      async sendMessage(tabId: number, message: unknown, options?: { frameId?: number }) {
        sent.push({ tabId, message, ...(options === undefined ? {} : { options }) });
        return undefined;
      },
    },
    tabGroups: { async update(groupId: number) { return { id: groupId }; } },
    windows: { async update(windowId: number) { return { id: windowId }; } },
  };
  return {
    sent,
    emit(message, sender) {
      for (const listener of listeners) listener(message, sender);
    },
  };
}

const RAISED = {
  type: "indicator",
  show: true,
  // The owner's locale, chosen by the worker: a content script in a page has no business picking
  // what the owner is told, and the browser under test runs in zh-TW here.
  label: lookup("agent.indicator.active", "zh-TW"),
  action: lookup("agent.indicator.focusMain", "zh-TW"),
};
const LOWERED = { type: "indicator", show: false };

describe("T107b the indicator's sender", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  function startedRuntime(): ReturnType<typeof composeAgentRuntime> {
    const runtime = composeAgentRuntime({ connectNative: () => fakePort() });
    runtime.start();
    return runtime;
  }

  it("raises the indicator on the tab a session claims", async () => {
    const runtime = startedRuntime();

    await runtime.tabs.claim("session-a", 7);

    await expect.poll(() => fake.sent, { timeout: 1000 }).toEqual([
      { tabId: 7, message: RAISED, options: { frameId: 0 } },
    ]);
  });

  it("raises it on a tab the session adopted, and on no other tab", async () => {
    const runtime = startedRuntime();

    await runtime.tabs.adopt("session-a", 5);

    await expect.poll(() => fake.sent, { timeout: 1000 }).toEqual([
      { tabId: 5, message: RAISED, options: { frameId: 0 } },
    ]);
  });

  it("lowers it when the tab is released", async () => {
    const runtime = startedRuntime();
    await runtime.tabs.claim("session-a", 7);
    await expect.poll(() => fake.sent.length, { timeout: 1000 }).toBe(1);

    await runtime.tabs.release("session-a", 7);

    await expect.poll(() => fake.sent.slice(1), { timeout: 1000 }).toEqual([
      { tabId: 7, message: LOWERED, options: { frameId: 0 } },
    ]);
  });

  it("lowers it on every tab of a session that ended", async () => {
    const runtime = startedRuntime();
    await runtime.tabs.claim("session-a", 7);
    await runtime.tabs.adopt("session-a", 5);
    await expect.poll(() => fake.sent.length, { timeout: 1000 }).toBe(2);

    await runtime.tabs.endSession("session-a");

    await expect.poll(() => fake.sent.slice(2), { timeout: 1000 }).toEqual([
      { tabId: 7, message: LOWERED, options: { frameId: 0 } },
      { tabId: 5, message: LOWERED, options: { frameId: 0 } },
    ]);
  });

  it("re-raises it when a reloaded page announces itself from a held tab", async () => {
    const runtime = startedRuntime();
    await runtime.tabs.claim("session-a", 7);
    await expect.poll(() => fake.sent.length, { timeout: 1000 }).toBe(1);

    // What a navigation looks like from the worker: the document is new, the content script is new,
    // and the only thing that happened is that the page said hello.
    fake.emit({ type: "ui.agent.announce" }, { id: EXTENSION_ID, tab: { id: 7 } });

    await expect.poll(() => fake.sent.slice(1), { timeout: 1000 }).toEqual([
      { tabId: 7, message: RAISED, options: { frameId: 0 } },
    ]);
  });

  it("answers an announcement from a tab nobody holds with no indicator", async () => {
    startedRuntime();

    fake.emit({ type: "ui.agent.announce" }, { id: EXTENSION_ID, tab: { id: 3 } });

    await expect.poll(() => fake.sent, { timeout: 1000 }).toEqual([
      { tabId: 3, message: LOWERED, options: { frameId: 0 } },
    ]);
  });

  /**
   * B26 — the fourth way a tab leaves a session, and the only one the tab manager cannot see.
   *
   * Release, close and session-end all pass through a lease write, so the sender hears them. An
   * unpair does not touch a single lease: the session keeps its tabs until it ends, and what
   * changes is that its agent may no longer do anything in them. A page still saying "an agent is
   * working here" would then be telling the owner something that is no longer true (FR-062), so
   * the runtime lowers it itself - which is why this case needs the greeting that names the
   * session and the pairing the owner then revokes.
   */
  it("lowers it on a held tab when the owner unpairs that tab's agent", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await runtime.tabs.claim("session-a", 7);
    await expect.poll(() => fake.sent, { timeout: 1000 }).toEqual([
      { tabId: 7, message: RAISED, options: { frameId: 0 } },
    ]);

    await runtime.unpair("agent-1");

    await expect
      .poll(() => fake.sent.filter((entry) => entry.tabId === 7).slice(1), { timeout: 1000 })
      .toEqual([{ tabId: 7, message: LOWERED, options: { frameId: 0 } }]);
    // Nothing is raised on the way out: whatever else the unpair touches, no page is told an
    // unpaired agent is working in it.
    expect(fake.sent.slice(1).map((entry) => entry.message)).not.toContainEqual(RAISED);
  });

  /**
   * T111b — and only the tabs it holds.
   *
   * The lower is the same message an unheld tab's announcement is answered with, so sending it
   * wider than the session's leases changes nothing on any page. It changes what this file says:
   * the sender's rule is that only a tab the session holds is told anything, and a loop that reads
   * a wider list than the leases is one edit away from telling the owner's own tabs about an agent
   * that never touched them.
   */
  it("lowers it on no tab the unpaired session does not hold", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await runtime.tabs.claim("session-a", 7);
    await expect.poll(() => fake.sent.length, { timeout: 1000 }).toBe(1);
    // Held, then given back: the tab is the owner's again and its lease is gone.
    await runtime.tabs.release("session-a", 7);
    await expect.poll(() => fake.sent.length, { timeout: 1000 }).toBe(2);

    await runtime.unpair("agent-1");

    await new Promise((resolve) => setTimeout(resolve, 50));
    // The release already lowered it; the unpair adds nothing, because the session holds nothing.
    expect(fake.sent).toHaveLength(2);
  });

  it("ignores an announcement that did not come from this extension's content script", async () => {
    startedRuntime();

    fake.emit({ type: "ui.agent.announce" }, { id: "some-other-extension", tab: { id: 7 } });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.sent).toEqual([]);
  });
});
