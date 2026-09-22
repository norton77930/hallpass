import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentRecorder } from "../src/service-worker/recording/recorder.js";

/**
 * 008/T221 — the recording decorator on `dispatchTool`, and the export that beats the session's end.
 *
 * Two claims, and both are about *where* the recorder is called rather than about what it does:
 *
 *  - every tool that changes the page or takes a picture adds a frame, and a read adds none. The
 *    decorator sits on the one runner every call and every batch step passes through (R-132), so
 *    "each step of a batch gets its own frame" is a fact about the wiring - the gate (T223) shoots
 *    a real three-step batch and counts the frames in the file.
 *  - a session that ends with frames exports *before* its tabs go (FR-108, R-137): the download is
 *    attributed by who held a tab when it began, so an export after the release would appear in
 *    nobody's `downloads_context`. The spy below asks the runtime, at the moment of the export,
 *    whether the session still holds its lease.
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

const HELLO = { type: "hello", sessionId: "session-r1", agentId: "agent-1", displayName: "Claude Code" };
const PAIR_REQUEST = {
  type: "pair-request",
  agentId: "agent-1",
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId: "session-r1",
};

function installChrome(): void {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const tabs = [{ id: 7, url: "https://agent.test/one", title: "Agent one", groupId: -1, active: true, windowId: 900 }];
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
    tabs: {
      async sendMessage(_tabId: number, message: unknown) {
        // 013: the page's own answer to a delivered picture, so a recorded `upload_image` reaches
        // the `ok` the recorder's rule is about. Everything else here is a probe.
        if ((message as { type?: string }).type === "content.deliver-image") {
          return { ok: true, delivery: "drop", file: { name: "screenshot.png", size: 8 }, point: { x: 40, y: 50 } };
        }
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
      async captureVisibleTab() {
        return "data:image/png;base64,cGljdHVyZQ==";
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
}

type SpyRecorder = AgentRecorder & {
  notes: Array<{ sessionId: string; tabId: number; label: string; tool: string }>;
  /** What the export saw about the session's leases when it ran; FR-108's whole point. */
  exportSaw: number[];
  recording: boolean;
};

function spyRecorder(leases: () => Promise<Array<unknown>>): SpyRecorder {
  const spy: SpyRecorder = {
    notes: [],
    exportSaw: [],
    recording: true,
    async start() {
      return { state: "recording", frames: 1, skipped: 0, full: false };
    },
    async stop() {
      return { state: "stopped", frames: 1, skipped: 0, full: false };
    },
    async clear() {
      return { state: "none", frames: 0, skipped: 0, full: false };
    },
    async noteAction(sessionId, tabId, action) {
      spy.notes.push({ sessionId, tabId, label: action.label, tool: action.tool });
      return { state: "recording", frames: spy.notes.length + 1, skipped: 0, full: false };
    },
    async export() {
      return { ok: false, refusal: { reason: "empty-recording" } };
    },
    async exportIfFrames() {
      spy.exportSaw.push((await leases()).length);
      return undefined;
    },
    async listStates() {
      return {};
    },
    async stateOf() {
      return spy.recording
        ? { state: "recording", frames: spy.notes.length + 1, skipped: 0, full: false }
        : { state: "none", frames: 0, skipped: 0, full: false };
    },
  };
  return spy;
}

async function pairedRuntime(): Promise<{
  port: FakePort;
  runtime: ReturnType<typeof composeAgentRuntime>;
  recorder: SpyRecorder;
}> {
  const port = fakePort();
  let runtime!: ReturnType<typeof composeAgentRuntime>;
  const recorder = spyRecorder(async () => runtime.tabs.leases());
  runtime = composeAgentRuntime({ connectNative: () => port, recorder });
  runtime.start();
  port.emit(HELLO);
  port.emit(PAIR_REQUEST);
  await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
  await runtime.pairing.decide("agent-1", true);
  await vi.waitFor(() => expect(port.sent).toHaveLength(1));
  await runtime.tabs.adopt("session-r1", 7);
  return { port, runtime, recorder };
}

describe("008 recording wiring", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("adds a frame for each recorded call and carries the state back on the answer", async () => {
    const { port, recorder } = await pairedRuntime();

    for (const callId of ["call-1", "call-2", "call-3"]) {
      port.emit({ callId, sessionId: "session-r1", tool: "screenshot", args: { tabId: 7 } });
      await vi.waitFor(() => expect(port.sent.some((sent) => (sent as { callId?: string }).callId === callId)).toBe(true));
    }

    expect(recorder.notes).toEqual([
      { sessionId: "session-r1", tabId: 7, tool: "screenshot", label: "screenshot" },
      { sessionId: "session-r1", tabId: 7, tool: "screenshot", label: "screenshot" },
      { sessionId: "session-r1", tabId: 7, tool: "screenshot", label: "screenshot" },
    ]);
    const answered = port.sent.find((sent) => (sent as { callId?: string }).callId === "call-3") as {
      result: { recording?: unknown };
    };
    expect(answered.result.recording).toEqual({ state: "recording", frames: 4, skipped: 0, full: false });
  });

  it("adds a frame for a picture put into the page (013/T334)", async () => {
    const { port, runtime, recorder } = await pairedRuntime();
    await runtime.siteModes.set("https://agent.test", { mode: "skip-checks" });

    port.emit({
      callId: "call-u1",
      sessionId: "session-r1",
      tool: "upload_image",
      tabId: 7,
      args: {
        tabId: 7,
        target: { coordinate: { x: 40, y: 50 } },
        file: { name: "screenshot.png", type: "image/png", bytesBase64: "iVBORw0KGgo=" },
      },
    });
    await vi.waitFor(() =>
      expect(port.sent.some((sent) => (sent as { callId?: string }).callId === "call-u1")).toBe(true),
    );

    // FR-101 parity with `file_upload`: a recording of the session should show the picture arriving
    // on the page, because that is something the session *did* to it.
    expect(recorder.notes).toEqual([
      { sessionId: "session-r1", tabId: 7, tool: "upload_image", label: "upload_image" },
    ]);
  });

  /**
   * 013/T337 — and one line on the session's card for it (FR-174).
   *
   * Asserted through this file's harness because a delivered picture needs the whole path - a
   * paired session, a held tab, a site mode that admits the call and a page that answers - and
   * that is exactly what `pairedRuntime` above builds. The claim itself is the runtime's, not the
   * recorder's: an admitted `upload_image` that the page received leaves something the owner can
   * read afterwards, which is the only trace a `skip-checks` upload leaves at all.
   */
  it("notes a delivered picture on the session's card (013/T337, FR-174)", async () => {
    const { port, runtime } = await pairedRuntime();
    await runtime.siteModes.set("https://agent.test", { mode: "skip-checks" });

    port.emit({
      callId: "call-u2",
      sessionId: "session-r1",
      tool: "upload_image",
      tabId: 7,
      args: {
        tabId: 7,
        target: { coordinate: { x: 40, y: 50 } },
        file: { name: "screenshot.png", type: "image/png", bytesBase64: "iVBORw0KGgo=" },
      },
    });
    await vi.waitFor(() =>
      expect(port.sent.some((sent) => (sent as { callId?: string }).callId === "call-u2")).toBe(true),
    );

    const session = (await runtime.projection()).sessions.find((view) => view.sessionId === "session-r1");
    // The pieces, never a sentence: the site the tab is on and the delivery the *page* reported.
    expect(session?.activity).toMatchObject([
      { kind: "upload", outcome: "delivered", site: "https://agent.test", message: "drop" },
    ]);
  });

  it("notes nothing for an upload the page refused", async () => {
    const { port, runtime } = await pairedRuntime();
    await runtime.siteModes.set("https://agent.test", { mode: "skip-checks" });

    port.emit({
      callId: "call-u3",
      sessionId: "session-r1",
      tool: "upload_image",
      // No file: refused by the argument schema before anything reaches the page, so there is
      // nothing that happened to the owner's page to tell them about.
      args: { tabId: 7, target: { coordinate: { x: 40, y: 50 } } },
    });
    await vi.waitFor(() =>
      expect(port.sent.some((sent) => (sent as { callId?: string }).callId === "call-u3")).toBe(true),
    );

    const session = (await runtime.projection()).sessions.find((view) => view.sessionId === "session-r1");
    expect(session?.activity ?? []).toEqual([]);
  });

  it("adds no frame for a read", async () => {
    const { port, recorder } = await pairedRuntime();

    port.emit({ callId: "call-1", sessionId: "session-r1", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));

    expect(recorder.notes).toEqual([]);
  });

  it("adds no frame for a session that is not recording", async () => {
    const { port, recorder } = await pairedRuntime();
    recorder.recording = false;

    port.emit({ callId: "call-1", sessionId: "session-r1", tool: "screenshot", args: { tabId: 7 } });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));

    expect(recorder.notes).toEqual([]);
    expect((port.sent[1] as { result: { recording?: unknown } }).result.recording).toBeUndefined();
  });

  it("exports the recording while the session still holds its tabs", async () => {
    const { runtime, recorder } = await pairedRuntime();

    await runtime.stopSessionFromOwner("session-r1");

    // One lease at the moment of the export, none afterwards: the download is attributed (R-137).
    expect(recorder.exportSaw).toEqual([1]);
    expect(await runtime.tabs.leases()).toEqual([]);
  });

  it("exports when the owner hands every tab back", async () => {
    const { runtime, recorder } = await pairedRuntime();

    await runtime.releaseSessionTabs("session-r1");

    expect(recorder.exportSaw).toEqual([1]);
  });
});
