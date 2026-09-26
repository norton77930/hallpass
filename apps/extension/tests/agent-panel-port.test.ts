import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PANEL_PORT_NAME, agentPanelMessageSchema, PAIRING_DECLINED_MARKER } from "@hallpass/contracts";
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

/**
 * The browser's last-focused normal window, as the worker is told it (fix 2026-09-23, panel in
 * another window). `watch` answers at once with what is known, as the real adapter does once
 * `getLastFocused` resolves, and again on every move.
 */
function fakeFocus(initial?: number) {
  const listeners: Array<(windowId: number) => void> = [];
  let current = initial;
  return {
    watch(listener: (windowId: number) => void) {
      listeners.push(listener);
      if (current !== undefined) listener(current);
    },
    move(windowId: number) {
      current = windowId;
      for (const listener of listeners) listener(windowId);
    },
  };
}

function setup(options: { focus?: ReturnType<typeof fakeFocus>; setAttention?: (on: boolean) => void } = {}) {
  const nativePort = fakeNativePort();
  const runtime = composeAgentRuntime({
    connectNative: () => nativePort,
    ...(options.setAttention ? { setAttention: options.setAttention } : {}),
  });
  const panel = createAgentPanelPort({
    extensionId: EXTENSION_ID,
    sidePanelUrl: PANEL_URL,
    runtime,
    ...(options.focus ? { watchFocusedWindow: options.focus.watch } : {}),
  });
  // What `agent-entry.ts` does: the runtime reads the panel port's presence.
  if (options.focus) runtime.bindPanelPresence(panel);
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
      // 014 FR-191: the remembered moves ride along too, empty until the owner allows one.
      payload: {
        paired: [],
        sessions: [],
        tabs: [],
        sites: [],
        bridge: "connected",
        transitions: [],
        diagnostics: { relayPid: 4242 },
      },
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
        // 014 FR-194: and the worker asks that relay what the owner's upload directories are, on
        // every link, because the panel's rows are a picture of the host's file.
        { type: "upload-roots-list" },
        // 013/R-184: every pairing answer names this browser's run, minted into
        // `chrome.storage.session` on first use. The value is opaque, so only its presence is read.
        // 014/R-187: and what this worker can be asked, which is what lets the host ask at all.
        {
          type: "pair-result",
          agentId: "agent-1",
          sessionId: "session-h1",
          accepted: true,
          browserRunId: expect.any(String),
          features: ["upload-consent", "pair-withdraw"],
        },
      ]));
    await vi.waitFor(() =>
      expect(port.sent.at(-1)).toMatchObject({
        payload: { paired: [expect.objectContaining({ agentId: "agent-1" })] },
      }),
    );
    // The prompt is gone, not merely answered: the panel must stop offering Accept for it.
    expect((port.sent.at(-1) as { payload: { pending?: unknown } }).payload.pending).toBeUndefined();
  });

  /** 006 FR-084 (amended 2026-09-24)/FR-085: the projection dates each question, and Ignore answers the host as a decline of this request. */
  it("dates the pending request and the prompt, and answers the host with a marked decline on ignore", async () => {
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
    // The waiting session is told at once, marked as a decline of this request (FR-032a) so the host
    // asks afresh on the next call rather than treating it as an unpair.
    await vi.waitFor(() => expect(nativePort.sent).toHaveLength(3));
    expect(nativePort.sent[2]).toMatchObject({
      type: "pair-result",
      agentId: "agent-1",
      sessionId: "session-h1",
      accepted: false,
      features: expect.arrayContaining([PAIRING_DECLINED_MARKER]),
    });
    runtime.prompts.cancel();
    await asked;
  });

  /** Item 2 (2026-09-24): a second session joining the card is published, with the count the card shows. */
  it("publishes the number of sessions waiting on the pairing card when another one joins", async () => {
    const { panel, nativePort } = setup();
    const port = fakePanelPort();
    panel.accept(port);

    nativePort.emit({ type: "hello", sessionId: "session-h1", agentId: "agent-1", displayName: "Claude Code" });
    nativePort.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
    await vi.waitFor(() =>
      expect(port.sent.at(-1)).toMatchObject({ payload: { pending: { agentId: "agent-1", waitingSessions: 1 } } }),
    );
    const before = port.sent.length;

    nativePort.emit({ type: "hello", sessionId: "session-h2", agentId: "agent-1", displayName: "Claude Code" });
    nativePort.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h2" });
    await vi.waitFor(() =>
      expect(port.sent.at(-1)).toMatchObject({ payload: { pending: { agentId: "agent-1", waitingSessions: 2 } } }),
    );
    expect(port.sent.length).toBeGreaterThan(before);
  });

  it("unpairs on the owner's command and tells the open session at once", async () => {
    const { panel, nativePort } = setup();
    const port = fakePanelPort();
    panel.accept(port);
    nativePort.emit({ type: "hello", sessionId: "session-h1", agentId: "agent-1", displayName: "Claude Code" });
    nativePort.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
    await vi.waitFor(() => expect(port.sent.at(-1)).toMatchObject({ payload: { pending: expect.anything() } }));
    port.emit({ type: "ui.agent.pair-decide", payload: { agentId: "agent-1", accepted: true } });
    // `relay-ack` (004/T169), the list request (014) and then the accept.
    await vi.waitFor(() => expect(nativePort.sent).toHaveLength(3));

    port.emit({ type: "ui.agent.unpair", payload: { agentId: "agent-1" } });

    await vi.waitFor(() =>
      expect(nativePort.sent[3]).toEqual({
        type: "pair-result",
        agentId: "agent-1",
        sessionId: "session-h1",
        accepted: false,
      }),
    );
    await vi.waitFor(() => expect(port.sent.at(-1)).toMatchObject({ payload: { paired: [] } }));
  });

  it("answers the owner's Decline as a decline of that request, not as an unpair (FR-032a)", async () => {
    const { panel, nativePort } = setup();
    const port = fakePanelPort();
    panel.accept(port);
    nativePort.emit({ type: "hello", sessionId: "session-h1", agentId: "agent-1", displayName: "Claude Code" });
    nativePort.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
    await vi.waitFor(() => expect(port.sent.at(-1)).toMatchObject({ payload: { pending: expect.anything() } }));

    port.emit({ type: "ui.agent.pair-decide", payload: { agentId: "agent-1", accepted: false } });

    await vi.waitFor(() => expect(nativePort.sent).toHaveLength(3));
    expect(nativePort.sent[2]).toMatchObject({
      type: "pair-result",
      agentId: "agent-1",
      sessionId: "session-h1",
      accepted: false,
      features: expect.arrayContaining([PAIRING_DECLINED_MARKER]),
    });
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

  /** 014/T358 (FR-178): 中斷 is its own runtime operation, and it is not a quiet stop. */
  it("routes session-interrupt to the interrupt and never to the stop", async () => {
    const { panel, runtime } = setup();
    const port = fakePanelPort();
    panel.accept(port);
    const interruptSession = vi.spyOn(runtime, "interruptSession").mockReturnValue({ interrupted: 1 });
    const stopSessionFromOwner = vi.spyOn(runtime, "stopSessionFromOwner").mockResolvedValue();
    const releaseSessionTabs = vi.spyOn(runtime, "releaseSessionTabs").mockResolvedValue();

    port.emit({ type: "ui.agent.session-interrupt", payload: { sessionId: "session-h1" } });

    expect(interruptSession).toHaveBeenCalledWith("session-h1");
    expect(stopSessionFromOwner).not.toHaveBeenCalled();
    expect(releaseSessionTabs).not.toHaveBeenCalled();
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

    /**
     * 011/T291 — who, if anybody, can see a card.
     *
     * It is the one fact the prompt controllers cannot work out for themselves, and everything in
     * this feature hangs off it: the bound a question is given, the sentence the person is told,
     * and whether the toolbar badge is on. The set was already here; this only says it out loud,
     * and says so on every connect and every disconnect rather than on the transitions through
     * zero - a listener that wants the transition can compare, and one that wants every event
     * cannot recover what it was never told.
     */
    it("says whether any panel is connected, and says so on every connect and disconnect", async () => {
      const { panel } = setup();
      const seen: boolean[] = [];
      panel.onPresenceChange((connected) => seen.push(connected));
      expect(panel.isConnected()).toBe(false);

      const first = fakePanelPort();
      const second = fakePanelPort();
      panel.accept(first);
      expect(panel.isConnected()).toBe(true);
      panel.accept(second);

      second.drop();
      expect(panel.isConnected(), "one panel is still open").toBe(true);
      first.drop();

      expect(panel.isConnected()).toBe(false);
      expect(seen).toEqual([true, true, true, false]);
    });

    it("says nothing about a connection it refused", async () => {
      const { panel } = setup();
      const seen: boolean[] = [];
      panel.onPresenceChange((connected) => seen.push(connected));

      panel.accept(fakePanelPort({ sender: { id: EXTENSION_ID, url: "https://evil.test/", tab: { id: 3 } } }));

      expect(seen).toEqual([]);
      expect(panel.isConnected()).toBe(false);
    });

    /**
     * 011 FR-149 — a panel opened after the question was raised still shows it.
     *
     * This is what makes the closed-panel bound worth having: the person reads the agent's
     * sentence, clicks the toolbar icon, and the card they are told about is the first thing the
     * panel they just opened is given. Nothing new does this - the first projection has always been
     * the whole picture - so the case is here to keep it that way.
     */
    it("gives a panel that connects mid-question the question in its first projection", async () => {
      const { panel, runtime, nativePort } = setup();
      nativePort.emit({ type: "hello", sessionId: "session-h1", agentId: "agent-1", displayName: "Claude Code" });
      nativePort.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
      await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
      await runtime.pairing.decide("agent-1", true);
      void runtime.prompts.ask({
        callId: "c-1",
        sessionId: "session-h1",
        site: "https://a.test",
        tool: "click",
        argsSummary: "click a page element",
      });
      await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined());

      const port = fakePanelPort();
      panel.accept(port);

      await vi.waitFor(() => expect(port.sent).toHaveLength(1));
      expect((port.sent[0] as { payload: { prompt?: { site: string } } }).payload.prompt).toMatchObject({
        site: "https://a.test",
      });
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

  /**
   * Fix 2026-09-23, panel in another window.
   *
   * Observed live: the owner saw no card and no badge, and the pairing request ran out at 45 s -
   * the open-panel bound - because a Hallpass panel was open in a *different* window. Chrome's side
   * panel is per window, so "some panel is connected" is not "the owner can see a card". What
   * counts is a connected panel in the window the owner last focused; the badge, the pairing bound
   * and the consent bound all read that, while the cards themselves still go to every panel.
   */
  describe("a panel the owner can see is one in the last-focused window", () => {
    const WINDOW_ID_MESSAGE = (windowId: number) => ({ type: "ui.agent.panel-window", payload: { windowId } });
    const HELLO = { type: "hello", sessionId: "session-h1", agentId: "agent-1", displayName: "Claude Code" };
    const PAIR_REQUEST = {
      type: "pair-request",
      agentId: "agent-1",
      displayName: "Claude Code",
      origin: "stdio:local",
      sessionId: "session-h1",
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("counts a panel in another window as not seen: badge on, 120 s bound with ticks", async () => {
      vi.useFakeTimers();
      const marks: boolean[] = [];
      const focus = fakeFocus(1);
      const { panel, runtime, nativePort } = setup({ focus, setAttention: (on) => marks.push(on) });
      const other = fakePanelPort();
      panel.accept(other);
      other.emit(WINDOW_ID_MESSAGE(2));

      expect(panel.isConnected(), "a panel is connected").toBe(true);
      expect(panel.isVisible(), "but not in the window the owner is using").toBe(false);

      nativePort.emit(HELLO);
      nativePort.emit(PAIR_REQUEST);
      await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
      expect(marks.at(-1), "the badge is on").toBe(true);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(nativePort.sent).toContainEqual({
        type: "prompt-waiting",
        sessionId: "session-h1",
        kind: "pairing",
        panelConnected: false,
        waitedMs: 5_000,
        boundMs: 120_000,
      });
      // Past the open-panel bound the card still stands: this is the 120 s one.
      await vi.advanceTimersByTimeAsync(45_000);
      expect((await runtime.pairing.state()).pending).toBeDefined();
      // The card itself still reached the panel in the other window.
      expect(JSON.stringify(other.sent.at(-1))).toContain("agent-1");
    });

    it("turns the badge off when the owner moves to the window that has the panel", async () => {
      const marks: boolean[] = [];
      const focus = fakeFocus(1);
      const { panel, runtime, nativePort } = setup({ focus, setAttention: (on) => marks.push(on) });
      const other = fakePanelPort();
      panel.accept(other);
      other.emit(WINDOW_ID_MESSAGE(2));
      nativePort.emit(HELLO);
      nativePort.emit(PAIR_REQUEST);
      await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
      expect(marks.at(-1)).toBe(true);

      focus.move(2);

      expect(panel.isVisible()).toBe(true);
      expect(marks.at(-1), "the card is now in front of the owner").toBe(false);

      // And back: the owner left the window with the panel, the question is out of sight again.
      focus.move(1);
      expect(marks.at(-1)).toBe(true);
    });

    it("keeps the open-panel 45 s bound, with no ticks, for a panel in the focused window", async () => {
      vi.useFakeTimers();
      const focus = fakeFocus(1);
      const { panel, runtime, nativePort } = setup({ focus });
      const here = fakePanelPort();
      panel.accept(here);
      here.emit(WINDOW_ID_MESSAGE(1));
      expect(panel.isVisible()).toBe(true);

      nativePort.emit(HELLO);
      nativePort.emit(PAIR_REQUEST);
      await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(nativePort.sent.some((frame) => (frame as { type?: string }).type === "prompt-waiting")).toBe(false);
      await vi.advanceTimersByTimeAsync(41_000);
      expect((await runtime.pairing.state()).pending, "the 45 s bound ran out").toBeUndefined();
    });

    /**
     * 011 D-011-7: the bound follows the panel going out of sight, not only the moment of the raise.
     * Observed live 2026-09-24: card raised in the panel's window, owner moved away, badge on - and
     * the card still vanished at 45 s.
     */
    it("extends a card raised in sight to 120 s with ticks once the owner moves away, and never shortens it back", async () => {
      vi.useFakeTimers();
      const focus = fakeFocus(1);
      const { panel, runtime, nativePort } = setup({ focus });
      const here = fakePanelPort();
      panel.accept(here);
      here.emit(WINDOW_ID_MESSAGE(1));
      nativePort.emit(HELLO);
      nativePort.emit(PAIR_REQUEST);
      await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
      const consent = runtime.prompts.ask({
        callId: "call-1",
        sessionId: "session-h1",
        site: "https://agent.test",
        tool: "click",
        argsSummary: "click a page element",
      });

      await vi.advanceTimersByTimeAsync(10_000);
      const waiting = () => nativePort.sent.filter((frame) => (frame as { type?: string }).type === "prompt-waiting");
      expect(waiting(), "nothing said while the card is in front of the owner").toEqual([]);

      focus.move(2);
      expect(waiting()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "pairing", boundMs: 120_000, waitedMs: 10_000, panelConnected: false }),
          expect.objectContaining({ kind: "ask", callId: "call-1", boundMs: 120_000, waitedMs: 10_000, panelConnected: false }),
        ]),
      );

      // Back to the panel's window: nothing is shortened.
      focus.move(1);
      await vi.advanceTimersByTimeAsync(100_000);
      expect((await runtime.pairing.state()).pending, "the card outlived 45 s").toBeDefined();
      expect(runtime.prompts.current(), "the consent question outlived 25 s").toBeDefined();

      await vi.advanceTimersByTimeAsync(10_000);
      expect((await runtime.pairing.state()).pending, "two minutes from the raise").toBeUndefined();
      await expect(consent).resolves.toMatchObject({ decision: "timed-out" });
    });

    it("counts a panel that has not said which window it is in as not seen", () => {
      const focus = fakeFocus(1);
      const { panel } = setup({ focus });
      panel.accept(fakePanelPort());

      expect(panel.isConnected()).toBe(true);
      expect(panel.isVisible()).toBe(false);
    });

    it("counts nothing as seen while the focused window is not yet known", () => {
      const focus = fakeFocus();
      const { panel } = setup({ focus });
      const here = fakePanelPort();
      panel.accept(here);
      here.emit(WINDOW_ID_MESSAGE(1));

      expect(panel.isVisible()).toBe(false);
      focus.move(1);
      expect(panel.isVisible()).toBe(true);
    });

    it("refuses a window report that is not a window id, and it changes nothing", () => {
      const diagnostics: string[] = [];
      const focus = fakeFocus(1);
      const nativePort = fakeNativePort();
      const runtime = composeAgentRuntime({ connectNative: () => nativePort });
      const panel = createAgentPanelPort({
        extensionId: EXTENSION_ID,
        sidePanelUrl: PANEL_URL,
        runtime,
        watchFocusedWindow: focus.watch,
        reportDiagnostic: (code) => diagnostics.push(code),
      });
      const port = fakePanelPort();
      panel.accept(port);

      port.emit({ type: "ui.agent.panel-window", payload: { windowId: "1" } });
      port.emit({ type: "ui.agent.panel-window", payload: { windowId: 1, extra: true } });
      port.emit({ type: "ui.agent.panel-window", payload: { windowId: -1 } });

      expect(panel.isVisible()).toBe(false);
      expect(diagnostics.filter((code) => code === "agent.panel.command-rejected")).toHaveLength(3);
    });
  });
});
