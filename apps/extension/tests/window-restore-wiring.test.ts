import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentRecorder } from "../src/service-worker/recording/recorder.js";
import { AGENT_WINDOW_RESTORES_KEY, type WindowRestoreRecord } from "../src/service-worker/window-restore.js";

/**
 * 008/T232 — the two moments a window is given back (FR-118, FR-119).
 *
 * The decision itself is `window-restore.test.ts`'s; this file is about *where* the worker asks for
 * it, which is the half no pure function can prove: the record is written by the tool that
 * un-maximised the window, and the restore runs when the session lets its last tab in that window
 * go - whether that is one `tabs_release`, the owner handing every tab back, or the session ending.
 * The gate (T233) does the same three things to a real window.
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

const HELLO = { type: "hello", sessionId: "session-w1", agentId: "agent-1", displayName: "Claude Code" };
const PAIR_REQUEST = {
  type: "pair-request",
  agentId: "agent-1",
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId: "session-w1",
};

type FakeWindow = { id: number; state: string; width: number; height: number };
type UpdateInfo = { state?: string; width?: number; height?: number };

type Harness = {
  session: Record<string, unknown>;
  windows: FakeWindow[];
  updates: Array<{ windowId: number } & UpdateInfo>;
};

function installChrome(): Harness {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const windows: FakeWindow[] = [{ id: 900, state: "maximized", width: 2064, height: 1120 }];
  const updates: Array<{ windowId: number } & UpdateInfo> = [];
  const tabs = [
    { id: 7, url: "https://agent.test/one", title: "Agent one", groupId: -1, active: true, windowId: 900 },
    { id: 8, url: "https://agent.test/two", title: "Agent two", groupId: -1, active: false, windowId: 901 },
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
    scripting: { async executeScript() {} },
    windows: {
      async get(windowId: number) {
        const window = windows.find((candidate) => candidate.id === windowId);
        if (!window) throw new Error(`No window with id: ${windowId}.`);
        return { ...window };
      },
      async update(windowId: number, info: UpdateInfo) {
        const window = windows.find((candidate) => candidate.id === windowId);
        if (!window) throw new Error(`No window with id: ${windowId}.`);
        updates.push({ windowId, ...info });
        if (info.state !== undefined) window.state = info.state;
        // Chrome's rule, reproduced: bounds land only on a window in the "normal" state.
        if (window.state === "normal") {
          if (info.width !== undefined) window.width = info.width;
          if (info.height !== undefined) window.height = info.height;
        }
        return { ...window };
      },
    },
    tabs: {
      async sendMessage() {
        return { documentEpoch: "doc-1", canonicalOrigin: "https://agent.test" };
      },
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return tabs;
      },
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        const target = groupId ?? 100;
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
    },
    tabGroups: {
      async update(groupId: number) {
        return { id: groupId };
      },
    },
    downloads: {
      onCreated: { addListener: () => undefined },
      onChanged: { addListener: () => undefined },
    },
  };
  return { session, windows, updates };
}

/** The recorder is not what this file is about; it answers "nothing recorded" to everything. */
const quietRecorder: AgentRecorder = {
  async start() {
    return { state: "none", frames: 0, skipped: 0, full: false };
  },
  async stop() {
    return { state: "none", frames: 0, skipped: 0, full: false };
  },
  async clear() {
    return { state: "none", frames: 0, skipped: 0, full: false };
  },
  async noteAction() {
    return { state: "none", frames: 0, skipped: 0, full: false };
  },
  async export() {
    return { ok: false, refusal: { reason: "empty-recording" } };
  },
  async exportIfFrames() {
    return undefined;
  },
  async stateOf() {
    return { state: "none", frames: 0, skipped: 0, full: false };
  },
  async listStates() {
    return {};
  },
};

async function pairedRuntime(): Promise<{
  port: FakePort;
  runtime: ReturnType<typeof composeAgentRuntime>;
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}> {
  const port = fakePort();
  const runtime = composeAgentRuntime({ connectNative: () => port, recorder: quietRecorder });
  runtime.start();
  port.emit(HELLO);
  port.emit(PAIR_REQUEST);
  await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
  await runtime.pairing.decide("agent-1", true);
  await vi.waitFor(() => expect(port.sent).toHaveLength(1));
  await runtime.tabs.adopt("session-w1", 7);

  let nextCall = 0;
  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    nextCall += 1;
    const callId = `call-${nextCall}`;
    port.emit({ callId, sessionId: "session-w1", tool, args });
    await vi.waitFor(() =>
      expect(port.sent.some((sent) => (sent as { callId?: string }).callId === callId)).toBe(true),
    );
    return port.sent.find((sent) => (sent as { callId?: string }).callId === callId);
  };
  return { port, runtime, call };
}

function records(harness: Harness): WindowRestoreRecord[] {
  return (harness.session[AGENT_WINDOW_RESTORES_KEY] as WindowRestoreRecord[] | undefined) ?? [];
}

describe("008 window restore wiring", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("remembers the state resize_window took the window out of, and answers only the size", async () => {
    const { call } = await pairedRuntime();

    const answered = (await call("resize_window", { tabId: 7, width: 1024, height: 768 })) as {
      outcome: string;
      result: Record<string, unknown>;
    };

    expect(answered.outcome).toBe("ok");
    expect(answered.result).toEqual({ width: 1024, height: 768 });
    expect(records(harness)).toEqual([
      { windowId: 900, priorState: "maximized", sessionId: "session-w1", setSize: { width: 1024, height: 768 } },
    ]);
  });

  it("remembers nothing for a window that was already normal", async () => {
    harness.windows[0]!.state = "normal";
    const { call } = await pairedRuntime();

    await call("resize_window", { tabId: 7, width: 1024, height: 768 });

    expect(records(harness)).toEqual([]);
  });

  it("puts the window back when the session hands its last tab in that window back", async () => {
    const { runtime, call } = await pairedRuntime();
    await call("resize_window", { tabId: 7, width: 1024, height: 768 });
    expect(harness.windows[0]!.state).toBe("normal");

    await runtime.releaseSessionTabs("session-w1");

    await vi.waitFor(() => expect(harness.windows[0]!.state).toBe("maximized"));
    expect(records(harness)).toEqual([]);
    // And the card says so, in pieces the panel writes the sentence from (FR-119).
    const session = (await runtime.projection()).sessions.find((view) => view.sessionId === "session-w1");
    expect(session?.activity?.[0]).toMatchObject({ kind: "restore", outcome: "restored", message: "maximized" });
  });

  it("leaves the window alone while the session still holds another tab in it", async () => {
    const { runtime, call } = await pairedRuntime();
    await runtime.tabs.adopt("session-w1", 8);
    await call("resize_window", { tabId: 7, width: 1024, height: 768 });
    const before = harness.updates.length;

    // Tab 8 is in another window; letting it go says nothing about window 900.
    await runtime.tabs.release("session-w1", 8);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.updates.slice(before)).toEqual([]);
    expect(harness.windows[0]!.state).toBe("normal");
    expect(records(harness)).toHaveLength(1);
  });

  it("puts the window back when the session ends", async () => {
    const { runtime, call } = await pairedRuntime();
    await call("resize_window", { tabId: 7, width: 1024, height: 768 });

    await runtime.stopSessionFromOwner("session-w1");

    expect(harness.windows[0]!.state).toBe("maximized");
    expect(records(harness)).toEqual([]);
  });

  it("does nothing to a window the owner re-maximised by hand", async () => {
    const { runtime, call } = await pairedRuntime();
    await call("resize_window", { tabId: 7, width: 1024, height: 768 });
    harness.windows[0]!.state = "maximized";
    const before = harness.updates.length;

    await runtime.stopSessionFromOwner("session-w1");

    expect(harness.updates.slice(before)).toEqual([]);
    expect(records(harness)).toEqual([]);
  });

  it("does nothing to a window the owner resized by hand - their choice wins", async () => {
    const { runtime, call } = await pairedRuntime();
    await call("resize_window", { tabId: 7, width: 1024, height: 768 });
    harness.windows[0]!.width = 1300;
    const before = harness.updates.length;

    await runtime.stopSessionFromOwner("session-w1");

    expect(harness.updates.slice(before)).toEqual([]);
    expect(harness.windows[0]!.state).toBe("normal");
    expect(records(harness)).toEqual([]);
  });

  it("leaves a window another session also resized to that session", async () => {
    const { runtime, call } = await pairedRuntime();
    await call("resize_window", { tabId: 7, width: 1024, height: 768 });
    harness.session[AGENT_WINDOW_RESTORES_KEY] = [
      ...records(harness),
      { windowId: 900, priorState: "maximized", sessionId: "session-w2", setSize: { width: 1024, height: 768 } },
    ];
    const before = harness.updates.length;

    await runtime.stopSessionFromOwner("session-w1");

    expect(harness.updates.slice(before)).toEqual([]);
    // Our own record goes; the other session's is what will restore the window when it lets go.
    expect(records(harness)).toEqual([
      { windowId: 900, priorState: "maximized", sessionId: "session-w2", setSize: { width: 1024, height: 768 } },
    ]);
  });
});
