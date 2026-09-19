import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";

/**
 * 004/T108 — the worker's half of the in-page indicator's control (FR-062, R-117).
 *
 * The indicator's button sends `ui.agent.focus-main` from the page the agent is working on, and
 * this is what answers it: the sending session's main tab comes forward. The claim that matters is
 * not that it works, it is *whose* tab it may bring forward. The lease on the sending tab is the
 * only authority - a message about a tab nobody holds, and a message naming a tab some *other*
 * session holds, both leave the browser exactly as it was.
 */

const EXTENSION_ID = "hallpass-test-extension";

type ContentSender = { id?: string; tab?: { id?: number } };
type ContentListener = (message: unknown, sender: ContentSender) => boolean | void;

function fakePort(): AgentPortLike {
  return {
    postMessage() {},
    disconnect() {},
    onMessage: { addListener: () => undefined },
    onDisconnect: { addListener: () => undefined },
  };
}

function installChrome(): {
  /** Every `chrome.tabs.update` the worker made, so "nothing happened" is a fact and not a guess. */
  activated: Array<{ tabId: number; active?: boolean }>;
  focused: Array<{ windowId: number; focused?: boolean }>;
  emit: (message: unknown, sender: ContentSender) => void;
} {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const activated: Array<{ tabId: number; active?: boolean }> = [];
  const focused: Array<{ windowId: number; focused?: boolean }> = [];
  const listeners: ContentListener[] = [];
  const tabs = [
    { id: 3, url: "https://owner.test/unheld", title: "Owner", groupId: -1, active: true, windowId: 900 },
    { id: 4, url: "https://b.test/main", title: "B main", groupId: -1, active: false, windowId: 901 },
    { id: 5, url: "https://a.test/main", title: "A main", groupId: -1, active: false, windowId: 900 },
    { id: 7, url: "https://a.test/held", title: "A held", groupId: -1, active: false, windowId: 900 },
    { id: 9, url: "https://b.test/held", title: "B held", groupId: -1, active: false, windowId: 901 },
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
      async update(tabId: number, info: { active?: boolean }) {
        activated.push({ tabId, ...info });
        return tabs.find((candidate) => candidate.id === tabId);
      },
    },
    tabGroups: { async update(groupId: number) { return { id: groupId }; } },
    windows: {
      async update(windowId: number, info: { focused?: boolean }) {
        focused.push({ windowId, ...info });
        return { id: windowId };
      },
    },
  };
  return {
    activated,
    focused,
    emit(message, sender) {
      for (const listener of listeners) listener(message, sender);
    },
  };
}

describe("T108 focus-main from a held tab's content script", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  async function startedRuntime(): Promise<ReturnType<typeof composeAgentRuntime>> {
    const runtime = composeAgentRuntime({ connectNative: () => fakePort() });
    runtime.start();
    // Session A holds tab 7 and is working on tab 5; session B holds tab 9 and works on tab 4.
    await runtime.tabs.adopt("session-a", 7);
    await runtime.tabs.adopt("session-a", 5);
    await runtime.tabs.adopt("session-b", 9);
    await runtime.tabs.adopt("session-b", 4);
    return runtime;
  }

  it("brings the sending session's main tab forward and focuses its window (FR-062)", async () => {
    await startedRuntime();

    fake.emit({ type: "ui.agent.focus-main" }, { id: EXTENSION_ID, tab: { id: 7 } });

    await expect
      .poll(() => fake.activated, { timeout: 1000 })
      .toEqual([{ tabId: 5, active: true }]);
    expect(fake.focused).toEqual([{ windowId: 900, focused: true }]);
  });

  it("does nothing for a message from a tab no session holds", async () => {
    await startedRuntime();

    fake.emit({ type: "ui.agent.focus-main" }, { id: EXTENSION_ID, tab: { id: 3 } });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.activated).toEqual([]);
    expect(fake.focused).toEqual([]);
  });

  it("does nothing when the message names a tab a different session holds", async () => {
    await startedRuntime();

    // The page in session A's tab asks about session B's tab. Chrome's own attribution says the
    // message came from tab 7; the body says 9. Neither session's main tab may move: honouring the
    // body would let one session's page steer the owner into another session's work.
    fake.emit({ type: "ui.agent.focus-main", tabId: 9 }, { id: EXTENSION_ID, tab: { id: 7 } });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.activated).toEqual([]);
    expect(fake.focused).toEqual([]);
  });

  it("does nothing for a message that is not from this extension's content script", async () => {
    await startedRuntime();

    fake.emit({ type: "ui.agent.focus-main" }, { id: "some-other-extension", tab: { id: 7 } });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.activated).toEqual([]);
    expect(fake.focused).toEqual([]);
  });
});
