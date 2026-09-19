import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PANEL_PORT_NAME, agentPanelMessageSchema } from "@hallpass/contracts";
import { createAgentPanelPort, type AgentPanelPortLike } from "../src/service-worker/agent-panel-port.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";

/**
 * 003/T019 — the panel's own port.
 *
 * It is a second port beside the archived control port, accepted under the same sender check: the
 * side panel of this extension, never a page and never another extension. The claims are that the
 * check is really applied, that everything the panel is sent parses as the closed projection, and
 * that each of the three commands reaches the decision it names and nothing else.
 */

const EXTENSION_ID = "adgpccmmbgnchnphfaoabfflfcepbopd";
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/side-panel.html`;

type FakePanelPort = AgentPanelPortLike & {
  sent: unknown[];
  disconnected: boolean;
  emit(message: unknown): void;
  /** Chrome's side of a drop: the panel document went away, and the worker's listener is told. */
  drop(): void;
};

function fakePanelPort(overrides: { name?: string; sender?: unknown } = {}): FakePanelPort {
  const listeners: Array<(message: unknown) => void> = [];
  const dropListeners: Array<() => void> = [];
  return {
    name: overrides.name ?? AGENT_PANEL_PORT_NAME,
    sender: (overrides.sender ?? { id: EXTENSION_ID, url: PANEL_URL }) as FakePanelPort["sender"],
    sent: [],
    disconnected: false,
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    disconnect() {
      this.disconnected = true;
    },
    onMessage: { addListener: (cb: (message: unknown) => void) => void listeners.push(cb) },
    onDisconnect: { addListener: (cb: () => void) => void dropListeners.push(cb) },
    emit(message: unknown) {
      for (const listener of listeners) listener(message);
    },
    drop() {
      for (const listener of dropListeners) listener();
    },
  };
}

function fakeNativePort(): AgentPortLike & { sent: unknown[]; emit(message: unknown): void } {
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

function installChrome(seed: { tabs?: unknown[]; session?: Record<string, unknown> } = {}): void {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = { ...seed.session };
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
    tabs: { async query() { return seed.tabs ?? []; } },
  };
}

function setup() {
  const nativePort = fakeNativePort();
  const runtime = composeAgentRuntime({ connectNative: () => nativePort });
  const panel = createAgentPanelPort({ extensionId: EXTENSION_ID, sidePanelUrl: PANEL_URL, runtime });
  runtime.start();
  // The relay's first frame, which is what makes the link `connected` (004/T099h): an open Port on
  // its own only means Chrome accepted the host's name.
  nativePort.emit({ type: "relay-started", relayPid: 4242 });
  return { runtime, panel, nativePort };
}

describe("T019 agent panel port", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("refuses a port that is not this extension's side panel", () => {
    const { panel } = setup();

    const wrongName = fakePanelPort({ name: "assistant-control-v1" });
    const wrongSender = fakePanelPort({ sender: { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", url: PANEL_URL } });
    const aPage = fakePanelPort({ sender: { id: EXTENSION_ID, url: "https://evil.test/", tab: { id: 3 } } });

    for (const port of [wrongName, wrongSender, aPage]) {
      expect(panel.accept(port).accepted).toBe(false);
      expect(port.disconnected).toBe(true);
      expect(port.sent).toEqual([]);
    }
  });

  it("sends the closed projection as soon as the panel connects", async () => {
    const { panel } = setup();
    const port = fakePanelPort();

    expect(panel.accept(port).accepted).toBe(true);
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));

    const parsed = agentPanelMessageSchema.safeParse(port.sent[0]);
    expect(parsed.success).toBe(true);
    expect(port.sent[0]).toEqual({
      type: "worker.agent.state",
      // 006/T189: the relay that greeted this worker rides along, for the not-connected page.
      payload: { paired: [], sessions: [], tabs: [], sites: [], bridge: "connected", diagnostics: { relayPid: 4242 } },
    });
  });

  /**
   * 004/T109a: the panel is told about the browser's tabs, not only each session's own.
   *
   * The `none` row is the point of the change - while the projection carried one session's list,
   * every row in it was that session's by construction, so the owner could never see the tab they
   * opened themselves sitting there unheld, nor a tab another agent is holding.
   */
  it("projects the browser's tabs with their holder, and no page content", async () => {
    installChrome({
      tabs: [
        { id: 11, url: "https://fixtures.test/one", title: "One", active: true, windowId: 2, groupId: -1 },
        { id: 12, url: "https://fixtures.test/two", title: "Two", active: false, windowId: 2, groupId: -1 },
      ],
      session: {
        agentTabLeases: { "12": { sessionId: "session-h1", kind: "owner", since: "2026-09-09T00:00:00.000Z" } },
      },
    });
    const { runtime } = setup();

    const state = await runtime.projection();

    expect(state.tabs).toEqual([
      { tabId: 11, url: "https://fixtures.test/one", title: "One", active: true, windowId: 2, holder: "none" },
      {
        tabId: 12,
        url: "https://fixtures.test/two",
        title: "Two",
        active: false,
        windowId: 2,
        holder: { sessionId: "session-h1" },
      },
    ]);
    // The closed projection is what the panel is actually sent, so a row carrying anything else -
    // a word of the page, for instance - would never reach it.
    expect(agentPanelMessageSchema.safeParse({ type: "worker.agent.state", payload: state }).success).toBe(true);
  });

  it("shows the owner a pending request and pairs the agent when they accept", async () => {
    const { panel, nativePort } = setup();
    const port = fakePanelPort();
    panel.accept(port);

    nativePort.emit({ type: "hello", sessionId: "session-h1", agentId: "agent-1", displayName: "Claude Code" });
    nativePort.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
    await vi.waitFor(() =>
      expect(port.sent.at(-1)).toMatchObject({
        payload: { pending: { agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local" } },
      }),
    );

    port.emit({ type: "ui.agent.pair-decide", payload: { agentId: "agent-1", accepted: true } });

    // The relay's `relay-started` was acknowledged first (004/T169); the decision follows it.
    await vi.waitFor(() => expect(nativePort.sent).toEqual([
        { type: "relay-ack", relayPid: 4242 },
        { type: "pair-result", agentId: "agent-1", sessionId: "session-h1", accepted: true },
      ]));
    await vi.waitFor(() =>
      expect(port.sent.at(-1)).toMatchObject({
        payload: { paired: [expect.objectContaining({ agentId: "agent-1" })] },
      }),
    );
    // The prompt is gone, not merely answered: the panel must stop offering Accept for it.
    expect((port.sent.at(-1) as { payload: { pending?: unknown } }).payload.pending).toBeUndefined();
  });

  /** 006 FR-084/FR-085 (S1 review): the projection dates each question, and Ignore answers nobody. */
  it("dates the pending request and the prompt, and drops the request on ignore without answering the host", async () => {
    const { panel, nativePort, runtime } = setup();
    const port = fakePanelPort();
    panel.accept(port);

    nativePort.emit({ type: "hello", sessionId: "session-h1", agentId: "agent-1", displayName: "Claude Code" });
    nativePort.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
    await vi.waitFor(() =>
      expect(port.sent.at(-1)).toMatchObject({
        payload: { pending: { agentId: "agent-1", requestedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } },
      }),
    );
    const asked = runtime.prompts.ask({ callId: "c-1", sessionId: "session-h1", site: "https://a.test", tool: "click", argsSummary: "click" });
    await vi.waitFor(() =>
      expect(port.sent.at(-1)).toMatchObject({
        payload: { prompt: { site: "https://a.test", raisedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } },
      }),
    );

    port.emit({ type: "ui.agent.pair-ignore", payload: { agentId: "agent-1" } });

    await vi.waitFor(() =>
      expect((port.sent.at(-1) as { payload: { pending?: unknown } }).payload.pending).toBeUndefined(),
    );
    // Nothing went down the link: no answer at all is what leaves the request to expire (FR-084).
    expect(nativePort.sent).toEqual([{ type: "relay-ack", relayPid: 4242 }]);
    runtime.prompts.cancel();
    await asked;
  });

  it("unpairs on the owner's command and tells the open session at once", async () => {
    const { panel, nativePort } = setup();
    const port = fakePanelPort();
    panel.accept(port);
    nativePort.emit({ type: "hello", sessionId: "session-h1", agentId: "agent-1", displayName: "Claude Code" });
    nativePort.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
    await vi.waitFor(() => expect(port.sent.at(-1)).toMatchObject({ payload: { pending: expect.anything() } }));
    port.emit({ type: "ui.agent.pair-decide", payload: { agentId: "agent-1", accepted: true } });
    // `relay-ack` (004/T169) and then the accept.
    await vi.waitFor(() => expect(nativePort.sent).toHaveLength(2));

    port.emit({ type: "ui.agent.unpair", payload: { agentId: "agent-1" } });

    await vi.waitFor(() =>
      expect(nativePort.sent[2]).toEqual({
        type: "pair-result",
        agentId: "agent-1",
        sessionId: "session-h1",
        accepted: false,
      }),
    );
    await vi.waitFor(() => expect(port.sent.at(-1)).toMatchObject({ payload: { paired: [] } }));
  });

  it("retries the bridge on the owner's Connect", async () => {
    const { panel, runtime } = setup();
    const port = fakePanelPort();
    panel.accept(port);
    const connect = vi.spyOn(runtime, "connect");

    port.emit({ type: "ui.agent.connect", payload: {} });

    expect(connect).toHaveBeenCalledTimes(1);
  });

  /** 003/T051 — the owner's one answer to a whole batch reaches the prompt controller (US5). */
  it("carries the owner's answer to a plan, with the steps they struck out", async () => {
    const { panel, runtime } = setup();
    const port = fakePanelPort();
    panel.accept(port);
    const decidePlan = vi.spyOn(runtime.prompts, "decidePlan");

    port.emit({
      type: "ui.agent.plan-decide",
      payload: { planId: "plan-1", approve: true, excludedIndexes: [1] },
    });

    expect(decidePlan).toHaveBeenCalledWith("plan-1", true, [1]);
  });

  /**
   * 003/T058 — the diagnostics grant is the owner's, made from the panel (US6, FR-049).
   *
   * It is a decision of its own, not a mode: granting it does not change what the agent may do to
   * the site, and setting the mode does not grant it. The revoke is the interesting half - it has
   * to reach the runtime, because letting go of the debugger is what takes Chrome's "is debugging
   * this browser" bar off the owner's screen.
   */
  it("grants and revokes diagnostics for one site on the owner's command", async () => {
    const { panel, runtime } = setup();
    const port = fakePanelPort();
    panel.accept(port);
    const site = "https://fixtures.test:19443";

    port.emit({ type: "ui.agent.set-diagnostics", payload: { site, granted: true } });
    await vi.waitFor(async () => expect((await runtime.siteModes.get(site)).diagnosticsGranted).toBe(true));
    // The grant alone; the mode this site was already under is untouched.
    expect((await runtime.siteModes.get(site)).mode).toBe("ask");

    port.emit({ type: "ui.agent.set-diagnostics", payload: { site, granted: false } });
    await vi.waitFor(async () => expect((await runtime.siteModes.get(site)).diagnosticsGranted).toBe(false));
  });

  /**
   * 006/T190 — the four owner controls of the rebuilt panel, each routed to the one runtime
   * operation it names (R-126). Nothing is decided here: the port carries a command from a control
   * the owner just pressed to the runtime that knows what it means, and a command the schema does
   * not close over is refused before this switch (the last case below).
   */
  it("routes retry-bridge to the bridge and site-clear, session-stop and session-release to the runtime", async () => {
    const { panel, runtime } = setup();
    const port = fakePanelPort();
    panel.accept(port);
    const connect = vi.spyOn(runtime, "connect");
    const clearSiteMode = vi.spyOn(runtime, "clearSiteMode").mockResolvedValue();
    const stopSessionFromOwner = vi.spyOn(runtime, "stopSessionFromOwner").mockResolvedValue();
    const releaseSessionTabs = vi.spyOn(runtime, "releaseSessionTabs").mockResolvedValue();

    port.emit({ type: "ui.agent.retry-bridge", payload: {} });
    expect(connect).toHaveBeenCalledTimes(1);

    port.emit({ type: "ui.agent.site-clear", payload: { site: "https://fixtures.test:19443" } });
    expect(clearSiteMode).toHaveBeenCalledWith("https://fixtures.test:19443");

    port.emit({ type: "ui.agent.session-stop", payload: { sessionId: "session-h1" } });
    expect(stopSessionFromOwner).toHaveBeenCalledWith("session-h1");
    expect(releaseSessionTabs).not.toHaveBeenCalled();

    port.emit({ type: "ui.agent.session-release", payload: { sessionId: "session-h2" } });
    expect(releaseSessionTabs).toHaveBeenCalledWith("session-h2");
    expect(stopSessionFromOwner).toHaveBeenCalledTimes(1);
  });

  it("refuses a stop aimed at one call and a release aimed at one tab", async () => {
    const { panel, runtime } = setup();
    const port = fakePanelPort();
    panel.accept(port);
    const stopSessionFromOwner = vi.spyOn(runtime, "stopSessionFromOwner");
    const releaseSessionTabs = vi.spyOn(runtime, "releaseSessionTabs");

    port.emit({ type: "ui.agent.session-stop", payload: { sessionId: "session-h1", callId: "c-1" } });
    port.emit({ type: "ui.agent.session-release", payload: { sessionId: "session-h1", tabId: 7 } });

    expect(stopSessionFromOwner).not.toHaveBeenCalled();
    expect(releaseSessionTabs).not.toHaveBeenCalled();
  });

  it("ignores a message the command schema does not accept", async () => {
    const { panel, runtime } = setup();
    const port = fakePanelPort();
    panel.accept(port);
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));
    const unpair = vi.spyOn(runtime, "unpair");

    port.emit({ type: "ui.agent.unpair", payload: { agentId: "agent-1", extra: 1 } });
    port.emit({ type: "ui.agent.pair-decide", payload: { agentId: "agent-1" } });
    port.emit("nonsense");

    expect(unpair).not.toHaveBeenCalled();
    expect(port.sent).toHaveLength(1);
  });

  /**
   * 2026-09-16 "blind panel": Chrome shows one side panel per window, and a tab-scoped panel can
   * keep its own document beside the window's, so two panel documents connected at once is the
   * ordinary case, not a fault. A worker that kept only the newest left the older one with a live
   * port that never received another projection or prompt - stale cards, no consent card, 25 s
   * `no-answer` timeouts - until the owner closed and reopened it.
   */
  describe("every connected panel", () => {
    /** The sessions the panel was last told about; `undefined` until it has been told anything. */
    const lastSessions = (port: FakePanelPort): unknown[] | undefined =>
      (port.sent.at(-1) as { payload?: { sessions?: unknown[] } } | undefined)?.payload?.sessions;

    /**
     * Two panels connected, the agent paired through the first one, one session live: the state
     * every case below starts from, with both panels holding the same newest picture.
     */
    async function twoPanelsOneSession() {
      const context = setup();
      const first = fakePanelPort();
      const second = fakePanelPort();
      context.panel.accept(first);
      context.panel.accept(second);
      context.nativePort.emit({ type: "hello", sessionId: "session-h1", agentId: "agent-1", displayName: "Claude Code" });
      context.nativePort.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
      await vi.waitFor(() => expect(first.sent.length).toBeGreaterThan(0));
      first.emit({ type: "ui.agent.pair-decide", payload: { agentId: "agent-1", accepted: true } });
      await vi.waitFor(() => expect(lastSessions(first)).toHaveLength(1));
      await vi.waitFor(() => expect(lastSessions(second)).toHaveLength(1));
      return { ...context, first, second };
    }

    it("receives each projection, and the older one's commands still count", async () => {
      const { first, second, nativePort, runtime } = await twoPanelsOneSession();
      expect(first.sent.at(-1)).toEqual(second.sent.at(-1));

      // Something changes after both are connected: a second session greets the relay.
      nativePort.emit({ type: "hello", sessionId: "session-h2", agentId: "agent-1", displayName: "Claude Code" });
      await vi.waitFor(() => expect(lastSessions(first)).toHaveLength(2));
      await vi.waitFor(() => expect(lastSessions(second)).toHaveLength(2));
      expect(first.sent.at(-1)).toEqual(second.sent.at(-1));

      // The older panel is still the owner's panel: its command reaches the runtime.
      const connect = vi.spyOn(runtime, "connect");
      first.emit({ type: "ui.agent.connect", payload: {} });
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("stops sending to a panel whose document went away, and keeps the rest", async () => {
      const { first, second, nativePort } = await twoPanelsOneSession();
      const secondHeard = second.sent.length;

      second.drop();
      nativePort.emit({ type: "hello", sessionId: "session-h2", agentId: "agent-1", displayName: "Claude Code" });

      await vi.waitFor(() => expect(lastSessions(first)).toHaveLength(2));
      expect(second.sent).toHaveLength(secondHeard);
    });

    it("drops and disconnects a panel it cannot write to, and keeps writing to the rest", async () => {
      const { first, second, nativePort } = await twoPanelsOneSession();
      const secondHeard = second.sent.length;
      second.postMessage = () => {
        throw new Error("Attempting to use a disconnected port object");
      };

      nativePort.emit({ type: "hello", sessionId: "session-h2", agentId: "agent-1", displayName: "Claude Code" });

      await vi.waitFor(() => expect(lastSessions(first)).toHaveLength(2));
      await vi.waitFor(() => expect(second.disconnected).toBe(true));
      // Nothing more is tried on it: a later change reaches the first panel alone.
      nativePort.emit({ type: "hello", sessionId: "session-h3", agentId: "agent-1", displayName: "Claude Code" });
      await vi.waitFor(() => expect(lastSessions(first)).toHaveLength(3));
      expect(second.sent).toHaveLength(secondHeard);
    });

    it("says so when the projection cannot be assembled, instead of leaving the panel on an old picture in silence", async () => {
      const nativePort = fakeNativePort();
      const runtime = composeAgentRuntime({ connectNative: () => nativePort });
      const diagnostics: string[] = [];
      const panel = createAgentPanelPort({
        extensionId: EXTENSION_ID,
        sidePanelUrl: PANEL_URL,
        runtime,
        reportDiagnostic: (code) => diagnostics.push(code),
      });
      runtime.start();
      vi.spyOn(runtime, "projection").mockRejectedValue(new Error("tabs.query blew up"));
      const port = fakePanelPort();

      panel.accept(port);

      await vi.waitFor(() => expect(diagnostics).toContain("agent.panel.projection-failed"));
      expect(port.sent).toEqual([]);
    });
  });
});
