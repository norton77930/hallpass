import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import type { AgentInputAttachments } from "../src/service-worker/agent-tools/input.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentRecorder } from "../src/service-worker/recording/recorder.js";

/**
 * 008/T230 (S4 review) — the dialog module as the *runtime* wires it (FR-111, FR-115, FR-117).
 *
 * `dialogs.test.ts` pins the rules against the module's own seams, and every one of them passes
 * against a worker that never subscribes the module at all. The three claims here are about the
 * wiring itself, so each one drives a composed runtime over its native port with a fake
 * `chrome.debugger` underneath, and the dialog arrives the only way a real one does - as an event
 * on the tab's attachment.
 *
 *  - the fan-out has exactly one subscriber, and every page event but the two dialog ones dies in
 *    its switch (D-008-5: the attachment's stated exception is worth what this is);
 *  - a dialog blocks the tools that would ask the page something and not the ones that walk away
 *    from it or name no tab at all (FR-111 as the review amended it);
 *  - what the module remembers about a tab never outlives the attachment it was heard on: a
 *    session ending and Chrome detaching both clear it, so a later session adopting that tab does
 *    not inherit a dialog that is not there.
 */

type FakePort = AgentPortLike & { sent: unknown[]; emit(message: unknown): void };

type FakeDebugger = {
  attached: number[];
  commands: Array<{ tabId: number; method: string }>;
  emit(tabId: number, method: string, params: Record<string, unknown>): void;
  detach(tabId: number): void;
};

/** The attachments the runtime built for itself, which is the object the fan-out belongs to. */
const { built } = vi.hoisted(() => ({ built: [] as AgentInputAttachments[] }));

vi.mock("../src/service-worker/agent-tools/input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/service-worker/agent-tools/input.js")>();
  return {
    ...actual,
    // Wrapped, never replaced: the runtime gets the real attachments, and this file gets a handle
    // on the one it got - the only way to ask a composed worker how many consumers its fan-out has.
    createInputAttachments: (deps?: Parameters<typeof actual.createInputAttachments>[0]) => {
      const made = actual.createInputAttachments(deps);
      built.push(made);
      return made;
    },
  };
});

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

const AGENT_TAB = 7;
const SESSION = "session-d1";
const NEXT_SESSION = "session-d2";
const hello = (sessionId: string) => ({ type: "hello", sessionId, agentId: "agent-1", displayName: "Claude Code" });
const PAIR_REQUEST = {
  type: "pair-request",
  agentId: "agent-1",
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId: SESSION,
};

function installChrome(): FakeDebugger {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const tabs = [
    { id: AGENT_TAB, url: "https://agent.test/one", title: "Agent one", groupId: -1, active: true, windowId: 900 },
  ];
  const eventListeners: Array<(source: { tabId?: number }, method: string, params?: unknown) => void> = [];
  const detachListeners: Array<(source: { tabId?: number }) => void> = [];
  const fakeDebugger: FakeDebugger = {
    attached: [],
    commands: [],
    emit(tabId, method, params) {
      for (const listener of eventListeners) listener({ tabId }, method, params);
    },
    detach(tabId) {
      fakeDebugger.attached = fakeDebugger.attached.filter((candidate) => candidate !== tabId);
      for (const listener of detachListeners) listener({ tabId });
    },
  };
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
    debugger: {
      async getTargets() {
        return [];
      },
      async attach(target: { tabId: number }) {
        fakeDebugger.attached.push(target.tabId);
      },
      async detach(target: { tabId: number }) {
        fakeDebugger.attached = fakeDebugger.attached.filter((tabId) => tabId !== target.tabId);
      },
      async sendCommand(target: { tabId: number }, method: string) {
        fakeDebugger.commands.push({ tabId: target.tabId, method });
        return {};
      },
      onEvent: {
        addListener(callback: (source: { tabId?: number }, method: string, params?: unknown) => void) {
          eventListeners.push(callback);
        },
      },
      onDetach: {
        addListener(callback: (source: { tabId?: number }) => void) {
          detachListeners.push(callback);
        },
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
  return fakeDebugger;
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

type Answer = { callId: string; outcome?: string; reason?: string; result?: unknown };

async function pairedRuntime(): Promise<{
  runtime: ReturnType<typeof composeAgentRuntime>;
  port: FakePort;
  attachments: AgentInputAttachments;
  call: (tool: string, args: Record<string, unknown>, sessionId?: string) => Promise<Answer>;
}> {
  const port = fakePort();
  built.length = 0;
  const runtime = composeAgentRuntime({ connectNative: () => port, recorder: quietRecorder });
  runtime.start();
  port.emit(hello(SESSION));
  port.emit(PAIR_REQUEST);
  await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
  await runtime.pairing.decide("agent-1", true);
  await vi.waitFor(() => expect(port.sent).toHaveLength(1));
  await runtime.tabs.adopt(SESSION, AGENT_TAB);

  let nextCall = 0;
  const call = async (tool: string, args: Record<string, unknown>, sessionId = SESSION): Promise<Answer> => {
    nextCall += 1;
    const callId = `call-${nextCall}`;
    port.emit({ callId, sessionId, tool, tabId: AGENT_TAB, args });
    await vi.waitFor(() =>
      expect(port.sent.some((sent) => (sent as { callId?: string }).callId === callId)).toBe(true),
    );
    return port.sent.find((sent) => (sent as { callId?: string }).callId === callId) as Answer;
  };
  const attachments = built[0] as AgentInputAttachments;
  return { runtime, port, attachments, call };
}

/** What the page says when it opens a confirm, as the debugger delivers it. */
const OPENING = {
  url: "https://agent.test/one",
  message: "Delete 3 orders?",
  type: "confirm",
  hasBrowserHandler: false,
};

describe("008/T230 dialog wiring", () => {
  let fakeDebugger: FakeDebugger;

  beforeEach(() => {
    fakeDebugger = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  /**
   * FR-117 / D-008-5, asserted where it is actually decided. The module's own switch is tested in
   * `dialogs.test.ts`; what no test could reach before is the *count* of consumers the composed
   * worker hangs on the fan-out, which is the other half of "the page-events domain has exactly one
   * consumer in this worker".
   */
  it("hangs one page-events consumer on the attachment's fan-out, and drops every other page event", async () => {
    const { attachments, call } = await pairedRuntime();
    await attachments.acquire(AGENT_TAB, "input");

    // Two subscribers in the whole worker and no third: 003's diagnostics, which keeps `Runtime`,
    // `Log` and `Network` traffic under the owner's per-site grant, and 008's dialogs, which is the
    // only consumer of the page-events domain. A number rather than a name, because what must not
    // happen is a *new* one appearing beside them.
    expect(attachments.listenerCount().event).toBe(2);

    fakeDebugger.emit(AGENT_TAB, "Page.frameNavigated", {
      frame: { id: "F1", url: "https://agent.test/secret?token=hunter2", securityOrigin: "https://agent.test" },
    });
    fakeDebugger.emit(AGENT_TAB, "Page.loadEventFired", { timestamp: 12 });
    fakeDebugger.emit(AGENT_TAB, "Page.lifecycleEvent", { name: "load", frameId: "F1" });

    // Nothing was consumed: no dialog to answer, and no tool is held up by one.
    expect(await call("dialog", { tabId: AGENT_TAB, action: "dismiss" })).toMatchObject({ reason: "no-dialog" });
  });

  /**
   * FR-111 as the S4 review amended it: the pass-through set is the set of calls that do not ask
   * the blocked page anything. Handing the tab back is the agent's way out of a dialog it should
   * not answer - the owner gets their tab, with their dialog, exactly as it is.
   */
  it("blocks the click and lets tabs_release, tabs_create and gif_recorder through", async () => {
    const { attachments, call } = await pairedRuntime();
    await attachments.acquire(AGENT_TAB, "input");
    fakeDebugger.emit(AGENT_TAB, "Page.javascriptDialogOpening", OPENING);

    const clicked = await call("click", { tabId: AGENT_TAB, target: { ref: "t_save" } });
    expect(clicked).toMatchObject({ outcome: "busy", reason: "blocked-by-dialog" });

    // Neither of these names the held tab at all; the call carries its session's tab, and that is
    // not a reason to refuse a recorder control or a new tab.
    expect((await call("gif_recorder", { action: "status" })).reason).not.toBe("blocked-by-dialog");
    expect((await call("tabs_create", { url: "https://agent.test/two" })).reason).not.toBe("blocked-by-dialog");

    const released = await call("tabs_release", { tabId: AGENT_TAB });
    expect(released).toMatchObject({ outcome: "ok", result: { released: true } });
  });

  /** The tab is not attached any more, so nothing heard on that attachment is still true. */
  it("forgets the dialog when Chrome detaches the tab", async () => {
    const { attachments, call } = await pairedRuntime();
    await attachments.acquire(AGENT_TAB, "input");
    fakeDebugger.emit(AGENT_TAB, "Page.javascriptDialogOpening", OPENING);
    expect((await call("get_page_text", { tabId: AGENT_TAB })).reason).toBe("blocked-by-dialog");

    // The owner dismissed Chrome's own debugging bar, or the tab crashed: either way this worker
    // will never hear the `javascriptDialogClosed` that would have cleared it.
    fakeDebugger.detach(AGENT_TAB);

    // A read rather than the `dialog` tool: the block is what a stale record would keep doing, and
    // `dialog` answers `no-dialog` for a second reason (the browser refusing a dead handle) that
    // would pass this test against the leak it is about.
    expect((await call("get_page_text", { tabId: AGENT_TAB })).reason).not.toBe("blocked-by-dialog");
  });

  /**
   * And the session's own end. Left behind, the record would meet the *next* session to adopt that
   * tab as a dialog nobody can answer - every tool blocked on a confirm that closed long ago.
   */
  it("forgets the dialog when the session ends, so the next session does not inherit it", async () => {
    const { runtime, port, attachments, call } = await pairedRuntime();
    await attachments.acquire(AGENT_TAB, "input");
    fakeDebugger.emit(AGENT_TAB, "Page.javascriptDialogOpening", OPENING);
    expect((await call("get_page_text", { tabId: AGENT_TAB })).reason).toBe("blocked-by-dialog");

    await runtime.stopSessionFromOwner(SESSION);
    port.emit(hello(NEXT_SESSION));
    await runtime.tabs.adopt(NEXT_SESSION, AGENT_TAB);

    expect((await call("get_page_text", { tabId: AGENT_TAB }, NEXT_SESSION)).reason).not.toBe("blocked-by-dialog");
  });
});
