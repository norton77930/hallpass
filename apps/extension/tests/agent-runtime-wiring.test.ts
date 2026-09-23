import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import { ASK_TIMEOUT_MS } from "../src/service-worker/agent-tools/prompts.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";

/**
 * 003/T018 — the agent path wired together: transport → pairing → tab manager.
 *
 * The claims here are the ones neither half can make alone: no tool runs before the owner accepts,
 * an accepted agent's `tabs_context` comes from the real group, and an unpair reaches an open
 * session at once (FR-032, SC-026).
 */

type FakePort = AgentPortLike & { sent: unknown[]; emit(message: unknown): void; drop(): void };

function fakePort(): FakePort {
  const listeners: Array<(message: unknown) => void> = [];
  const closers: Array<() => void> = [];
  return {
    sent: [],
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    disconnect() {},
    onMessage: { addListener: (cb: (message: unknown) => void) => void listeners.push(cb) },
    onDisconnect: { addListener: (cb: () => void) => void closers.push(cb) },
    emit(message: unknown) {
      for (const listener of listeners) listener(message);
    },
    /** Chrome tearing the native port down, which is what the worker sees when the relay exits. */
    drop() {
      for (const closer of closers) closer();
    },
  };
}

/**
 * The relay's first frame, which is what makes the link `connected` (004/T099h): Chrome hands back a
 * Port even for a host it cannot spawn, so the open port claims nothing on its own.
 */
const RELAY_STARTED = { type: "relay-started", relayPid: 4242 };

/**
 * The announcement the relay forwards on every attach, token stripped (004/T099i). It is what
 * registers the session; the pairing request that follows only asks the owner about the agent.
 */
const HELLO = {
  type: "hello",
  sessionId: "session-h1",
  agentId: "agent-1",
  displayName: "Claude Code",
};

const PAIR_REQUEST = {
  type: "pair-request",
  agentId: "agent-1",
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId: "session-h1",
};

function installChrome(): {
  tabs: Array<{ id: number; url: string; groupId: number }>;
  /** Every frame the worker sent a page, so a test can read the binding it used (003/B6). */
  frames: Array<{ type: string; nonce: string; runtimeEpochId: string }>;
  /** The browser's own record of a download beginning / changing (005/T181), raised by a test. */
  downloadCreated: (item: Record<string, unknown>) => void;
  downloadChanged: (delta: Record<string, unknown>) => void;
  session: Record<string, unknown>;
} {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const frames: Array<{ type: string; nonce: string; runtimeEpochId: string }> = [];
  const created: Array<(item: unknown) => void> = [];
  const changed: Array<(delta: unknown) => void> = [];
  const state = {
    tabs: [{ id: 7, url: "https://agent.test/one", title: "Agent one", groupId: -1, active: false, windowId: 900 }],
    frames,
    downloadCreated: (item: Record<string, unknown>) => created.forEach((listener) => listener(item)),
    downloadChanged: (delta: Record<string, unknown>) => changed.forEach((listener) => listener(delta)),
    session,
  };
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
    storage: { local: area(local), session: area(session) },
    alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
    scripting: { async executeScript() {} },
    tabs: {
      async sendMessage(_tabId: number, message: unknown) {
        const frame = message as { type: string; nonce: string; runtimeEpochId: string };
        frames.push({ type: frame.type, nonce: frame.nonce, runtimeEpochId: frame.runtimeEpochId });
        if (frame.type === "content.probe") {
          return { documentEpoch: "doc-1", canonicalOrigin: "https://agent.test" };
        }
        return {
          contextHandle: "snap-1",
          documentEpoch: "doc-1",
          canonicalOrigin: "https://agent.test",
          visibleText: "Agent page",
          formValueItems: [],
        };
      },
      async get(tabId: number) {
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return state.tabs;
      },
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        const target = groupId ?? nextGroupId++;
        for (const tabId of tabIds) {
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = target;
        }
        return target;
      },
    },
    tabGroups: { async update(groupId: number) { return { id: groupId }; } },
    downloads: {
      onCreated: { addListener: (listener: (item: unknown) => void) => void created.push(listener) },
      onChanged: { addListener: (listener: (delta: unknown) => void) => void changed.push(listener) },
    },
  };
  return state;
}

describe("T018 agent runtime wiring", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("raises the owner's prompt on a first connection and runs no tool until it is answered", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();

    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toEqual({
      agentId: "agent-1",
      displayName: "Claude Code",
      origin: "stdio:local",
    }));
    // Nothing has been answered yet: the host is holding the agent's first call on this.
    expect(port.sent).toEqual([]);

    port.emit({ callId: "call-1", sessionId: "session-h1", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));
    expect(port.sent[0]).toEqual({ callId: "call-1", outcome: "denied", reason: "not-paired" });
  });

  it("answers tabs_context from the session's real tab group once the owner accepts", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());

    await runtime.pairing.decide("agent-1", true);
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));
    expect(port.sent[0]).toEqual({
      type: "pair-result",
      agentId: "agent-1",
      sessionId: "session-h1",
      accepted: true,
      // 013/R-184: the runtime puts this browser's run id on the answer, out of
      // `chrome.storage.session`. Opaque by design, so the test reads that it is there and no more.
      browserRunId: expect.any(String),
      // 014/R-187: and what this worker can be asked - the host asks about an upload directory
      // only where a card can actually be raised.
      features: ["upload-consent"],
    });

    await runtime.tabs.adopt("session-h1", 7);
    port.emit({ callId: "call-1", sessionId: "session-h1", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));

    expect(port.sent[1]).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: [{ tabId: 7, url: "https://agent.test/one", title: "Agent one", active: false, windowId: 900, holder: "this" }],
    });
  });

  it("lists the browser's tabs as nobody's for a session that holds none (004/T104)", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    port.emit({ callId: "call-1", sessionId: "session-h1", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));

    // The list is not the session's tabs any more, it is the browser's - and a session that has
    // claimed nothing is told exactly that about every tab, which is what a first claim is made
    // from. The old empty answer would have left an agent with nothing to ask for.
    expect(port.sent[1]).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: [{ tabId: 7, url: "https://agent.test/one", title: "Agent one", active: false, windowId: 900, holder: "none" }],
    });
  });

  it("refuses the open session's next call the moment the owner unpairs (SC-026)", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    await runtime.unpair("agent-1");

    // The open session is told at once, rather than finding out on its next call.
    expect(port.sent[1]).toEqual({
      type: "pair-result",
      agentId: "agent-1",
      sessionId: "session-h1",
      accepted: false,
    });
    port.emit({ callId: "call-2", sessionId: "session-h1", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(3));
    expect(port.sent[2]).toEqual({ callId: "call-2", outcome: "denied", reason: "not-paired" });
  });

  it("drops the unanswered prompt when the link goes away (A3)", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(RELAY_STARTED);
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());

    port.drop();

    // The prompt belonged to a connection that no longer exists. Leaving it up would ask the owner
    // to accept an agent that is not there, and the answer would reach nobody.
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeUndefined());
    expect((await runtime.projection()).pending).toBeUndefined();
  });

  it("tells only the connected agent it was unpaired (A1)", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    await runtime.unpair("agent-2");

    // The open session belongs to agent-1. A decline on this link would end *its* pairing for a
    // decision the owner made about somebody else.
    expect(port.sent).toHaveLength(1);
  });

  /**
   * 003/M4 Part A — the difference between the relay blinking and the agent going home.
   *
   * A `stop` naming a call is the host's backstop (D-M3-1). A `stop` naming only the session is the
   * MCP session itself ending, and that is the one event that releases the session's tabs: the
   * group stops reading "Agent" and the record stops holding the tabs against every later session.
   */
  it("keeps the session's tabs when the relay drops and reconnects", async () => {
    const first = fakePort();
    const second = fakePort();
    let next = first;
    const runtime = composeAgentRuntime({ connectNative: () => next });
    runtime.start();
    first.emit(HELLO);
    first.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    await runtime.tabs.adopt("session-h1", 7);

    first.drop();
    next = second;
    runtime.connect();
    // The same agent session behind a new relay connection: the host repeats the id it minted.
    second.emit(HELLO);
    second.emit(PAIR_REQUEST);
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));

    second.emit({ callId: "call-1", sessionId: "session-h1", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(second.sent).toHaveLength(2));
    expect(second.sent[1]).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: [{ tabId: 7, url: "https://agent.test/one", title: "Agent one", active: false, windowId: 900, holder: "this" }],
    });
  });

  /**
   * 003/B3 — a question whose asker is gone.
   *
   * The pairing prompt was already dropped on a relay drop (A3); the *effect* prompt was not, so an
   * owner could still be looking at "allow this click?" for a call that has no link to answer on -
   * and pressing Allow would run the effect for nobody.
   */
  it("cancels the pending effect prompt when the link goes away (B3)", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(RELAY_STARTED);
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);

    const asked = runtime.prompts.ask({
      callId: "call-1",
      sessionId: "session-h1",
      site: "https://agent.test",
      tool: "click",
      argsSummary: "click a page element",
    });
    await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined());
    const promptId = runtime.prompts.current()?.promptId ?? "";

    port.drop();

    await expect(asked).resolves.toEqual({ decision: "timed-out" });
    expect(runtime.prompts.current()).toBeUndefined();
    // A late Allow runs nothing: the prompt it names is dead, not merely off screen.
    expect(runtime.prompts.decide(promptId, true)).toBe(false);
  });

  /**
   * 003/B5 — the host's per-call backstop is about one call.
   *
   * `stop {callId}` means "I have given up on this call". Cancelling every pending prompt on it
   * would take down a question belonging to a different call that is still perfectly alive.
   */
  /**
   * 011/T293, T294 — the two things a question raised into a closed panel sets off.
   *
   * The badge is the browser's half and the tick is the agent's: Chrome will not let the worker
   * open the panel (R-160), so the person is told once by the icon in front of them and once by the
   * agent they are talking to. Both hang off the same fact - a question is up and no panel is
   * connected - which is why they are wired in one place and checked here together.
   */
  it("marks the icon and says it is still waiting while nobody can see the question", async () => {
    vi.useFakeTimers();
    try {
      const port = fakePort();
      const marks: boolean[] = [];
      const runtime = composeAgentRuntime({ connectNative: () => port, setAttention: (on) => marks.push(on) });
      let connected = false;
      const presenceListeners: Array<(value: boolean) => void> = [];
      runtime.bindPanelPresence({
        isConnected: () => connected,
        onPresenceChange: (listener) => presenceListeners.push(listener),
      });
      runtime.start();
      // On wake, before anything is waiting: a badge left by the worker Chrome evicted is cleared.
      expect(marks).toEqual([false]);

      port.emit(RELAY_STARTED);
      port.emit(HELLO);
      port.emit(PAIR_REQUEST);
      await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
      expect(marks, "the pairing card raised into a panel nobody has open").toEqual([false, true]);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(port.sent).toContainEqual({
        type: "prompt-waiting",
        sessionId: "session-h1",
        kind: "pairing",
        panelConnected: false,
        waitedMs: 5_000,
        boundMs: 120_000,
      });

      // The person clicks the icon: the panel connects, and the card is now in front of them.
      connected = true;
      for (const listener of presenceListeners) listener(true);
      expect(marks).toEqual([false, true, false]);

      await runtime.pairing.decide("agent-1", true);
      await vi.waitFor(() => expect(port.sent.at(-1)).toMatchObject({ type: "pair-result", accepted: true }));
      const heard = port.sent.length;
      await vi.advanceTimersByTimeAsync(15_000);
      // The card is answered: nothing is waiting, so nothing says it is.
      expect(port.sent).toHaveLength(heard);
      expect(marks).toEqual([false, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 011 review — what a runtime with no panel port bound assumes about the panel.
   *
   * `agent-entry.ts` binds the real presence before `start()`, so this is a fact about compositions
   * that say nothing about panels: a suite that composes the runtime to test something else. They
   * mean the bounds they were written under, so the assumption is "somebody is looking" - the same
   * one `prompts.ts` and `pairing-controller.ts` make when they are handed no presence at all.
   */
  it("raises a question on the open-panel bound until a panel presence is bound", async () => {
    vi.useFakeTimers();
    try {
      const port = fakePort();
      const runtime = composeAgentRuntime({ connectNative: () => port });
      runtime.start();
      port.emit(HELLO);
      port.emit(PAIR_REQUEST);
      await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
      await runtime.pairing.decide("agent-1", true);

      const asked = runtime.prompts.ask({
        callId: "call-a",
        sessionId: "session-h1",
        site: "https://agent.test",
        tool: "click",
        argsSummary: "click a page element",
      });
      await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined());

      await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);

      // The pre-011 bound, and no instruction to open a panel nobody said was closed.
      await expect(asked).resolves.toEqual({ decision: "timed-out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels only the prompt belonging to the call a stop names (B5)", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);

    const asked = runtime.prompts.ask({
      callId: "call-a",
      sessionId: "session-h1",
      site: "https://agent.test",
      tool: "click",
      argsSummary: "click a page element",
    });
    await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined());

    port.emit({ type: "stop", callId: "call-b" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.prompts.current(), "another call's backstop took this question down").toBeDefined();

    port.emit({ type: "stop", callId: "call-a" });

    await expect(asked).resolves.toEqual({ decision: "timed-out" });
    expect(runtime.prompts.current()).toBeUndefined();
  });

  /**
   * 003/B6 — a relay reconnect is not a new session.
   *
   * The channel nonce and the runtime epoch are what bind this worker's conversation with a
   * document; minting new ones on a reconnect makes every ref the agent holds unusable, for an
   * event the agent never saw. The host repeats the session id it minted, and that is the identity.
   */
  it("keeps the session's page binding across a relay reconnect (B6)", async () => {
    const first = fakePort();
    const second = fakePort();
    let next = first;
    const runtime = composeAgentRuntime({ connectNative: () => next });
    runtime.start();
    first.emit(HELLO);
    first.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await runtime.tabs.adopt("session-h1", 7);

    first.emit({ callId: "call-1", sessionId: "session-h1", tool: "get_page_text", args: { tabId: 7 } });
    await vi.waitFor(() => expect(first.sent).toHaveLength(2));
    const before = fake.frames.at(-1);

    first.drop();
    next = second;
    runtime.connect();
    second.emit(HELLO);
    second.emit(PAIR_REQUEST);
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));

    second.emit({ callId: "call-2", sessionId: "session-h1", tool: "get_page_text", args: { tabId: 7 } });
    await vi.waitFor(() => expect(second.sent).toHaveLength(2));
    const after = fake.frames.at(-1);

    expect(after?.nonce).toBe(before?.nonce);
    expect(after?.runtimeEpochId).toBe(before?.runtimeEpochId);
  });

  it("releases the session's tabs when the MCP session ends", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));
    await runtime.tabs.adopt("session-h1", 7);

    port.emit({ type: "stop", sessionId: "session-h1" });

    await vi.waitFor(async () =>
      expect(await runtime.tabs.ownership("session-h1", 7)).toEqual({ state: "not-yours" }),
    );
  });

  /**
   * 005/T181 — the browser's downloads reach the session that held a tab when they began, through
   * the runtime's own listeners, and go with the session when it ends (FR-077, FR-079, FR-080).
   */
  it("lists a download that began while the session held a tab, and forgets it with the session", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    // Nobody holds a tab yet: the owner's own download, attributed to nobody.
    fake.downloadCreated({ id: 1, url: "https://owner.test/a.zip", filename: "", state: "in_progress", danger: "safe", startTime: "2026-09-13T10:00:00.000Z", bytesReceived: 0, totalBytes: -1, fileSize: -1 });
    await runtime.tabs.adopt("session-h1", 7);
    // A scan still pending is "not yet known", not a flag (review 2026-09-13).
    fake.downloadCreated({ id: 2, url: "https://agent.test/report.csv", filename: "", state: "in_progress", danger: "asyncScanning", startTime: "2026-09-13T10:00:05.000Z", bytesReceived: 0, totalBytes: -1, fileSize: -1 });
    fake.downloadChanged({ id: 2, filename: { current: "C:\\dl\\report.csv" }, state: { current: "complete" }, endTime: { current: "2026-09-13T10:00:06.000Z" }, fileSize: { current: 512 } });

    port.emit({ callId: "call-1", sessionId: "session-h1", tool: "downloads_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    expect(port.sent[1]).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        downloads: [
          {
            id: 2,
            filename: "C:\\dl\\report.csv",
            url: "https://agent.test/report.csv",
            state: "complete",
            startedAt: "2026-09-13T10:00:05.000Z",
            endedAt: "2026-09-13T10:00:06.000Z",
            bytesReceived: 512,
            totalBytes: -1,
            danger: false,
            attribution: "session",
          },
        ],
      },
    });

    port.emit({ type: "stop", sessionId: "session-h1" });
    await vi.waitFor(async () =>
      expect(await runtime.tabs.ownership("session-h1", 7)).toEqual({ state: "not-yours" }),
    );
    // The ring went with the session (FR-080): nothing of it is left in session storage.
    await vi.waitFor(() => expect(JSON.stringify(fake.session)).not.toContain("report.csv"));
  });

  /**
   * 003/T051 — a batch is dispatched through the same table a single call is.
   *
   * The claim is the wiring one: `browser_batch` reaches a runner at all, and each of its steps
   * comes back through the runtime's own dispatch rather than through a second path of its own. What
   * each step then answers is the runner's business and is asserted where the runners are.
   */
  it("runs a batch's steps through the same dispatch a single call takes", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));
    await runtime.tabs.adopt("session-h1", 7);

    port.emit({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "browser_batch",
      tabId: 7,
      args: { tabId: 7, steps: [{ tool: "tabs_context", args: {} }, { tool: "tabs_context", args: {} }] },
    });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));

    expect(port.sent[1]).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        results: [
          { index: 0, outcome: "ok", result: [{ tabId: 7, url: "https://agent.test/one", title: "Agent one", active: false, windowId: 900, holder: "this" }] },
          { index: 1, outcome: "ok", result: [{ tabId: 7, url: "https://agent.test/one", title: "Agent one", active: false, windowId: 900, holder: "this" }] },
        ],
      },
    });
  });

  /**
   * 003/M6 — every name in the closed tool list now reaches a runner.
   *
   * The dispatch's `tool-not-implemented` answer was the honest reply while stories were still
   * being built; with US6 and US7 shipped nothing produces it any more, and the way to keep that
   * true is to assert that the last two arrivals answer in their own words. A tool the session does
   * not own the tab for is refused by the *runner's* rule, not by the table's fallback.
   */
  it("answers the diagnostics and upload tools from their own runners", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(HELLO);
    port.emit(PAIR_REQUEST);
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    port.emit({ callId: "call-1", sessionId: "session-h1", tool: "read_console", tabId: 7, args: { tabId: 7 } });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    expect(port.sent[1]).toEqual({
      callId: "call-1",
      outcome: "denied",
      // 004/T104: the runner's own rule still refuses it, now in the word that says
      // *which* fact it is - nobody holds tab 7, so a claim would get it.
      reason: "not-yours",
      refusal: { reason: "not-yours" },
    });

    port.emit({
      callId: "call-2",
      sessionId: "session-h1",
      tool: "file_upload",
      tabId: 7,
      args: { tabId: 7, ref: "t_1", files: [{ name: "a.txt", type: "text/plain", bytesBase64: "aGk=" }] },
    });
    await vi.waitFor(() => expect(port.sent).toHaveLength(3));
    expect(port.sent[2]).toEqual({
      callId: "call-2",
      outcome: "denied",
      // 004/T104: the runner's own rule still refuses it, now in the word that says
      // *which* fact it is - nobody holds tab 7, so a claim would get it.
      reason: "not-yours",
      refusal: { reason: "not-yours" },
    });
  });
});
