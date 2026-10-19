import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { BROKER_GREETING_WINDOW_MS } from "../src/service-worker/conversation-relay.js";
import { PANEL_CONSENT_KEY } from "../src/service-worker/panel-consent.js";

/**
 * 019/T550, T553 - T555: panel sessions (R-321, FR-305 - FR-307, FR-309, D-019-7, D-019-11).
 *
 * The side-panel agent reaches this browser through Hallpass's own mcp-server, started by the broker
 * with a token the worker issued for that conversation. A greeting that carries a token the worker
 * holds is a *panel session*: admitted by the one-time panel consent, never by `agentPairings`, and
 * otherwise under exactly the rules an external session is under. The two admissions never cross:
 * a token never yields an external pairing, an external pairing never admits a panel session, and
 * the status row's unpair and the panel consent's withdrawal each touch only their own kind.
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

const BROKER = "broker-aaaaaaaaaaaaaaaaaaaaaaaa";
const CONVERSATION = "conv-0123456789abcdef";
const OTHER_CONVERSATION = "conv-fedcba9876543210";
const TOKEN = "t".repeat(43);
const OTHER_TOKEN = "u".repeat(43);
const PANEL_AGENT = `panel:${CONVERSATION}`;
const PANEL_SESSION = "panel-session-1";
const EXTERNAL_SESSION = "session-h1";

const brokerHello = { type: "hello", sessionId: BROKER, agentId: "hallpass-broker", displayName: "Hallpass", role: "broker" };
const tokenFrame = (token: string | null, extra: Record<string, unknown> = {}, conversationId = CONVERSATION) => ({
  type: "conversation-browser-token",
  sessionId: BROKER,
  conversationId,
  token,
  ...extra,
});
const panelHello = (token = TOKEN, agentId = PANEL_AGENT, sessionId = PANEL_SESSION) => ({
  type: "hello",
  sessionId,
  agentId,
  displayName: "claude-code",
  panelToken: token,
});
const pairRequest = (sessionId: string, agentId: string) => ({
  type: "pair-request",
  agentId,
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId,
});
const call = (sessionId: string, callId: string, tool = "tabs_context", args: Record<string, unknown> = {}) => ({
  callId,
  sessionId,
  tool,
  args,
});

function installChrome(options: { consent?: unknown } = {}) {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  if (options.consent !== undefined) local[PANEL_CONSENT_KEY] = options.consent;
  const state = {
    local,
    session,
    tabs: [
      { id: 7, url: "https://agent.test/one", title: "Agent one", groupId: -1, active: true, windowId: 900 },
      { id: 8, url: "https://agent.test/two", title: "Agent two", groupId: -1, active: false, windowId: 900 },
    ],
    ungrouped: [] as number[],
  };
  let nextGroupId = 100;
  const area = (store: Record<string, unknown>) => ({
    async get(keys: string[] | string) {
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) if (key in store) out[key] = store[key];
      return out;
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store, values);
    },
    async remove(keys: string[]) {
      for (const key of keys) delete store[key];
    },
  });
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: area(local), session: area(session) },
    alarms: { create() {}, clear: async () => true, getAll: async () => [], onAlarm: { addListener() {} } },
    scripting: { async executeScript() {} },
    tabs: {
      async sendMessage() {
        return { documentEpoch: "doc-1", canonicalOrigin: "https://agent.test" };
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
      async ungroup(tabIds: number[]) {
        for (const tabId of tabIds) {
          state.ungrouped.push(tabId);
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = -1;
        }
      },
    },
    tabGroups: { async update(groupId: number) { return { id: groupId }; } },
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
    downloads: { onCreated: { addListener() {} }, onChanged: { addListener() {} } },
  };
  return state;
}

const GRANTED = { granted: true, at: "2026-10-19T00:00:00.000Z" };

const pairResults = (port: FakePort, sessionId: string) =>
  port.sent.filter(
    (frame) => (frame as { type?: string }).type === "pair-result" && (frame as { sessionId?: string }).sessionId === sessionId,
  ) as Array<{ accepted: boolean; agentId: string }>;
const answerTo = (port: FakePort, callId: string) =>
  port.sent.find((frame) => (frame as { callId?: string }).callId === callId) as
    | { outcome: string; reason?: string; result?: Array<{ tabId: number; holder: unknown }> }
    | undefined;

describe("T550 panel sessions: admitted by a worker-issued token and the panel consent", () => {
  let fake: ReturnType<typeof installChrome>;

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  async function composed(consent: unknown = GRANTED) {
    fake = installChrome({ consent });
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack" })));
    port.emit(brokerHello);
    return { port, runtime };
  }

  async function panelSession(port: FakePort, extra: Record<string, unknown> = {}) {
    port.emit(tokenFrame(TOKEN, extra));
    port.emit(panelHello());
    port.emit(pairRequest(PANEL_SESSION, PANEL_AGENT));
    await vi.waitFor(() => expect(pairResults(port, PANEL_SESSION)).toHaveLength(1));
  }

  async function pairExternal(port: FakePort, runtime: ReturnType<typeof composeAgentRuntime>) {
    port.emit({ type: "hello", sessionId: EXTERNAL_SESSION, agentId: "agent-1", displayName: "Claude Code" });
    port.emit(pairRequest(EXTERNAL_SESSION, "agent-1"));
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    await vi.waitFor(() => expect(pairResults(port, EXTERNAL_SESSION)).toHaveLength(1));
  }

  it("makes a greeting with a live token a panel session, accepted without a card or an agentPairings entry", async () => {
    const { port, runtime } = await composed();

    await panelSession(port);

    expect(pairResults(port, PANEL_SESSION)[0]).toMatchObject({ agentId: PANEL_AGENT, accepted: true });
    const state = await runtime.pairing.state();
    expect(state.pending).toBeUndefined();
    expect(state.paired).toEqual([]);
    expect(fake.local.agentPairings === undefined || JSON.stringify(fake.local.agentPairings).includes("panel:") === false).toBe(true);

    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());
    expect(answerTo(port, "call-1")?.outcome).toBe("ok");
    // On the panel as a session of its own, under the conversation's agent id.
    const projected = await runtime.projection();
    expect(projected.sessions.map((card) => [card.sessionId, card.agentId])).toEqual([[PANEL_SESSION, PANEL_AGENT]]);
  });

  it("refuses an unknown token as not-admitted and never raises a pairing card for it", async () => {
    const { port, runtime } = await composed();
    port.emit(tokenFrame(TOKEN));

    port.emit(panelHello(OTHER_TOKEN));
    port.emit(pairRequest(PANEL_SESSION, PANEL_AGENT));
    await vi.waitFor(() => expect(pairResults(port, PANEL_SESSION)).toHaveLength(1));
    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());

    expect(pairResults(port, PANEL_SESSION)[0]?.accepted).toBe(false);
    expect(answerTo(port, "call-1")).toEqual({ callId: "call-1", outcome: "denied", reason: "not-admitted" });
    expect((await runtime.pairing.state()).pending).toBeUndefined();
    expect((await runtime.projection()).sessions).toEqual([]);
  });

  it("refuses a live token presented under another conversation's agent id", async () => {
    const { port } = await composed();
    port.emit(tokenFrame(TOKEN));

    port.emit(panelHello(TOKEN, `panel:${OTHER_CONVERSATION}`));
    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());

    expect(answerTo(port, "call-1")?.reason).toBe("not-admitted");
  });

  it("does not admit a panel session because the owner's own agent is paired, nor pair a panel id externally", async () => {
    const { port, runtime } = await composed();
    await pairExternal(port, runtime);

    // A forged token under the paired agent's id: still a panel greeting, refused as one.
    port.emit(panelHello(OTHER_TOKEN, "agent-1", "panel-session-2"));
    port.emit(pairRequest("panel-session-2", "agent-1"));
    await vi.waitFor(() => expect(pairResults(port, "panel-session-2")).toHaveLength(1));
    port.emit(call("panel-session-2", "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());
    expect(pairResults(port, "panel-session-2")[0]?.accepted).toBe(false);
    expect(answerTo(port, "call-1")?.reason).toBe("not-admitted");

    // And a greeting with no token that names a panel id is not offered to the owner as an agent.
    port.emit({ type: "hello", sessionId: "session-x", agentId: PANEL_AGENT, displayName: "Claude Code" });
    port.emit(pairRequest("session-x", PANEL_AGENT));
    await vi.waitFor(() => expect(pairResults(port, "session-x")).toHaveLength(1));
    expect(pairResults(port, "session-x")[0]?.accepted).toBe(false);
    expect((await runtime.pairing.state()).pending).toBeUndefined();
    expect((await runtime.pairing.state()).paired.map((agent) => agent.agentId)).toEqual(["agent-1"]);
  });

  it("is not admitted while the panel consent is unknown or withdrawn, whatever the token", async () => {
    const { port } = await composed({ granted: false, at: "2026-10-19T00:00:00.000Z" });

    await panelSession(port);
    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());

    expect(pairResults(port, PANEL_SESSION)[0]?.accepted).toBe(false);
    expect(answerTo(port, "call-1")?.reason).toBe("not-admitted");
  });

  it("leaves panel sessions alone when the status row unpairs the owner's agent", async () => {
    const { port, runtime } = await composed();
    await pairExternal(port, runtime);
    await panelSession(port);

    await runtime.unpair("agent-1");

    expect(pairResults(port, PANEL_SESSION)).toHaveLength(1);
    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());
    expect(answerTo(port, "call-1")?.outcome).toBe("ok");
  });

  it("puts a panel session's effects through the same gate: an ask site raises the owner's card", async () => {
    const { port, runtime } = await composed();
    await panelSession(port);
    await runtime.tabs.adopt(PANEL_SESSION, 7);
    // The page-JavaScript tool, granted for the site but still under its `ask` mode.
    fake.local.agentSiteModes = { "https://agent.test": { mode: "ask", diagnosticsGranted: true } };

    port.emit(call(PANEL_SESSION, "call-1", "evaluate", { tabId: 7, expression: "1" }));

    await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined());
    expect(runtime.prompts.current()).toMatchObject({ site: "https://agent.test", tool: "evaluate" });
    expect(runtime.prompts.currentSession()).toBe(PANEL_SESSION);

    // T556 (R-328): "remember" on this card is recorded as the panel agent's change; the owner's own
    // change from the site list as the owner's.
    runtime.prompts.decide(runtime.prompts.current()!.promptId, true, "skip-checks");
    await vi.waitFor(() =>
      expect((fake.local.agentSiteModes as Record<string, unknown>)["https://agent.test"]).toMatchObject({
        mode: "skip-checks",
        changedBy: "panel-agent",
      }),
    );
    await runtime.setSiteMode("https://agent.test", "follow-a-plan");
    expect((fake.local.agentSiteModes as Record<string, unknown>)["https://agent.test"]).toMatchObject({
      mode: "follow-a-plan",
      changedBy: "owner",
    });
  });

  it("refuses the next call once the broker revokes the token or its session ends", async () => {
    const { port } = await composed();
    await panelSession(port);

    port.emit(tokenFrame(null));
    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());
    expect(answerTo(port, "call-1")?.reason).toBe("not-admitted");

    port.emit(tokenFrame(TOKEN));
    port.emit(call(PANEL_SESSION, "call-2"));
    await vi.waitFor(() => expect(answerTo(port, "call-2")?.outcome).toBe("ok"));
    port.emit({ type: "session-ended", sessionId: BROKER });
    port.emit(call(PANEL_SESSION, "call-3"));
    await vi.waitFor(() => expect(answerTo(port, "call-3")?.reason).toBe("not-admitted"));
  });

  it("T572: keeps the tokens across a relay restart for the broker's greeting window, and revokes them if no broker greets", async () => {
    const { port } = await composed();
    await panelSession(port);
    vi.useFakeTimers();
    try {
      port.emit({ type: "relay-started", relayPid: 4343 });
      // The new run counts from its acknowledgement, which waits on the browser run id.
      await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack", relayPid: 4343 })));

      // The panel's mcp-server redials before the broker re-attaches: still admitted.
      port.emit(panelHello());
      port.emit(call(PANEL_SESSION, "call-1"));
      await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());
      expect(answerTo(port, "call-1")?.outcome).toBe("ok");

      // No broker within the window: the tokens it issued are gone.
      await vi.advanceTimersByTimeAsync(BROKER_GREETING_WINDOW_MS);
      port.emit(call(PANEL_SESSION, "call-2"));
      await vi.waitFor(() => expect(answerTo(port, "call-2")).toBeDefined());
      expect(answerTo(port, "call-2")?.reason).toBe("not-admitted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("T572: keeps the tokens when the same broker greets the new relay inside the window", async () => {
    const { port } = await composed();
    await panelSession(port);
    vi.useFakeTimers();
    try {
      port.emit({ type: "relay-started", relayPid: 4343 });
      await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack", relayPid: 4343 })));
      port.emit(brokerHello);

      await vi.advanceTimersByTimeAsync(BROKER_GREETING_WINDOW_MS);
      port.emit(call(PANEL_SESSION, "call-1"));
      await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());
      expect(answerTo(port, "call-1")?.outcome).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("T572: revokes the kept tokens at once when a different broker greets the new relay", async () => {
    const { port } = await composed();
    await panelSession(port);
    port.emit({ type: "relay-started", relayPid: 4343 });
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack", relayPid: 4343 })));

    port.emit({ ...brokerHello, sessionId: "broker-bbbbbbbbbbbbbbbbbbbbbbbb" });
    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());
    expect(answerTo(port, "call-1")?.reason).toBe("not-admitted");
  });

  it("takes a token only from the broker session", async () => {
    const { port } = await composed();
    port.emit({ ...tokenFrame(TOKEN), sessionId: "session-intruder" });

    port.emit(panelHello());
    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());
    expect(answerTo(port, "call-1")?.reason).toBe("not-admitted");
  });

  it("never stores the token", async () => {
    const { port } = await composed();
    await panelSession(port);
    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());

    expect(JSON.stringify(fake.session)).not.toContain(TOKEN);
    expect(JSON.stringify(fake.local)).not.toContain(TOKEN);
  });
});

describe("T554 the start tab (FR-306)", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome({ consent: GRANTED });
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  async function composed() {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack" })));
    port.emit(brokerHello);
    return { port, runtime };
  }

  it("places the tab the owner was viewing into the panel session's group on its first call, without a card", async () => {
    const { port, runtime } = await composed();
    port.emit(tokenFrame(TOKEN, { startTabId: 7 }));
    port.emit(panelHello());
    port.emit(pairRequest(PANEL_SESSION, PANEL_AGENT));
    await vi.waitFor(() => expect(pairResults(port, PANEL_SESSION)).toHaveLength(1));

    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());

    expect(answerTo(port, "call-1")?.result?.find((tab) => tab.tabId === 7)?.holder).toBe("this");
    expect(answerTo(port, "call-1")?.result?.find((tab) => tab.tabId === 8)?.holder).toBe("none");
    expect(runtime.prompts.current()).toBeUndefined();
    expect(fake.tabs.find((tab) => tab.id === 7)?.groupId).not.toBe(-1);
  });

  it("does it once per turn: a tab the session released stays released until the next message names it", async () => {
    const { port, runtime } = await composed();
    port.emit(tokenFrame(TOKEN, { startTabId: 7 }));
    port.emit(panelHello());
    port.emit(pairRequest(PANEL_SESSION, PANEL_AGENT));
    await vi.waitFor(() => expect(pairResults(port, PANEL_SESSION)).toHaveLength(1));
    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());

    await runtime.releaseSessionTabs(PANEL_SESSION);
    port.emit(call(PANEL_SESSION, "call-2"));
    await vi.waitFor(() => expect(answerTo(port, "call-2")).toBeDefined());
    expect(answerTo(port, "call-2")?.result?.find((tab) => tab.tabId === 7)?.holder).toBe("none");

    port.emit(tokenFrame(TOKEN, { startTabId: 8 }));
    port.emit(call(PANEL_SESSION, "call-3"));
    await vi.waitFor(() => expect(answerTo(port, "call-3")).toBeDefined());
    expect(answerTo(port, "call-3")?.result?.find((tab) => tab.tabId === 8)?.holder).toBe("this");
  });

  it("never takes the start tab from another session", async () => {
    const { port, runtime } = await composed();
    port.emit({ type: "hello", sessionId: EXTERNAL_SESSION, agentId: "agent-1", displayName: "Claude Code" });
    await runtime.tabs.adopt(EXTERNAL_SESSION, 7);
    port.emit(tokenFrame(TOKEN, { startTabId: 7 }));
    port.emit(panelHello());

    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());

    expect(answerTo(port, "call-1")?.result?.find((tab) => tab.tabId === 7)?.holder).toEqual({ sessionId: EXTERNAL_SESSION });
  });
});

describe("T555 withdrawing the panel consent (FR-309)", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome({ consent: GRANTED });
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("tears every panel session down like an unpair, revokes the tokens, and asks again next time", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack" })));
    port.emit(brokerHello);
    port.emit({
      type: "conversation-overview",
      sessionId: BROKER,
      conversations: [],
      agents: [],
      folders: [],
      consent: "granted",
    });
    port.emit({ type: "hello", sessionId: EXTERNAL_SESSION, agentId: "agent-1", displayName: "Claude Code" });
    port.emit(pairRequest(EXTERNAL_SESSION, "agent-1"));
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);
    port.emit(tokenFrame(TOKEN));
    port.emit(panelHello());
    port.emit(pairRequest(PANEL_SESSION, PANEL_AGENT));
    await vi.waitFor(() => expect(pairResults(port, PANEL_SESSION)).toHaveLength(1));
    await runtime.tabs.adopt(PANEL_SESSION, 7);
    await runtime.tabs.adopt(EXTERNAL_SESSION, 8);

    runtime.conversation.command({ type: "ui.conversation.consent", payload: { granted: false }, commandId: "c-1" });

    // The host is told at once, unpair-shaped, and the session lets go of everything it held.
    await vi.waitFor(() => expect(pairResults(port, PANEL_SESSION)).toHaveLength(2));
    expect(pairResults(port, PANEL_SESSION)[1]).toMatchObject({ agentId: PANEL_AGENT, accepted: false });
    await vi.waitFor(async () => expect((await runtime.projection()).sessions.map((card) => card.sessionId)).toEqual([EXTERNAL_SESSION]));
    expect(JSON.stringify(fake.session)).not.toContain(PANEL_SESSION);
    // The owner's answer is kept by the worker, and the broker hears it too.
    expect(fake.local[PANEL_CONSENT_KEY]).toMatchObject({ granted: false });
    expect(port.sent).toContainEqual(
      expect.objectContaining({ type: "conversation-command", command: { type: "ui.conversation.consent", payload: { granted: false } } }),
    );
    // The panel shows the switch off at once, whatever the broker's last overview said.
    expect((await runtime.projection()).conversation?.consent).toBe("withdrawn");

    // The next call is refused; the token is dead even after the consent is given again (the broker
    // revokes it too and never re-sends it - only a new agent run gets a new token, T558).
    port.emit(call(PANEL_SESSION, "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());
    expect(answerTo(port, "call-1")?.outcome).toBe("denied");
    runtime.conversation.command({ type: "ui.conversation.consent", payload: { granted: true }, commandId: "c-2" });
    await vi.waitFor(() => expect(fake.local[PANEL_CONSENT_KEY]).toMatchObject({ granted: true }));
    port.emit(panelHello());
    port.emit(call(PANEL_SESSION, "call-2"));
    await vi.waitFor(() => expect(answerTo(port, "call-2")).toBeDefined());
    expect(answerTo(port, "call-2")?.reason).toBe("not-admitted");

    // The external agent was never touched.
    expect(pairResults(port, EXTERNAL_SESSION).map((frame) => frame.accepted)).toEqual([true]);
    port.emit(call(EXTERNAL_SESSION, "call-3"));
    await vi.waitFor(() => expect(answerTo(port, "call-3")?.outcome).toBe("ok"));
    const held = answerTo(port, "call-3")?.result ?? [];
    expect(held.find((tab) => tab.tabId === 7)?.holder).toBe("none");
    expect(held.find((tab) => tab.tabId === 8)?.holder).toBe("this");
  });

  it.each([
    ["a relay restart (its tokens held for the greeting window)", { type: "relay-started", relayPid: 4343 }],
    ["its link ending (its tokens dropped until it greets again)", { type: "session-ended", sessionId: BROKER }],
  ])("T579: a token the withdrawal revoked is not held again when the same broker greets anew after %s", async (_how, away) => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack" })));
    port.emit(brokerHello);
    port.emit(tokenFrame(TOKEN));
    port.emit(panelHello());
    port.emit(pairRequest(PANEL_SESSION, PANEL_AGENT));
    await vi.waitFor(() => expect(pairResults(port, PANEL_SESSION)).toHaveLength(1));

    // The broker is away. The owner withdraws meanwhile - and gives the consent again - before the
    // broker hears either.
    port.emit(away);
    if (away.type === "relay-started") {
      await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack", relayPid: 4343 })));
    }
    runtime.conversation.command({ type: "ui.conversation.consent", payload: { granted: false }, commandId: "c-1" });
    await vi.waitFor(() => expect(fake.local[PANEL_CONSENT_KEY]).toMatchObject({ granted: false }));
    runtime.conversation.command({ type: "ui.conversation.consent", payload: { granted: true }, commandId: "c-2" });
    await vi.waitFor(() => expect(fake.local[PANEL_CONSENT_KEY]).toMatchObject({ granted: true }));

    // The same broker greets anew and hands its live runs' tokens again (`regrantBrowserTokens`).
    port.emit(brokerHello);
    port.emit(tokenFrame(TOKEN));
    port.emit(panelHello(TOKEN, PANEL_AGENT, "panel-session-2"));
    port.emit(call("panel-session-2", "call-1"));
    await vi.waitFor(() => expect(answerTo(port, "call-1")).toBeDefined());
    expect(answerTo(port, "call-1")?.reason).toBe("not-admitted");

    // A new run's token is taken as ever.
    port.emit(tokenFrame(OTHER_TOKEN));
    port.emit(panelHello(OTHER_TOKEN, PANEL_AGENT, "panel-session-3"));
    port.emit(call("panel-session-3", "call-2"));
    await vi.waitFor(() => expect(answerTo(port, "call-2")?.outcome).toBe("ok"));
  });

  it("T572: tells a broker that greets the owner's answer given while no broker was attached", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack" })));
    port.emit(brokerHello);
    port.emit({ type: "session-ended", sessionId: BROKER });

    // No broker: the worker records the withdrawal, the broker's own record still says granted.
    runtime.conversation.command({ type: "ui.conversation.consent", payload: { granted: false }, commandId: "c-1" });
    await vi.waitFor(() => expect(fake.local[PANEL_CONSENT_KEY]).toMatchObject({ granted: false }));
    const before = port.sent.length;

    port.emit(brokerHello);

    await vi.waitFor(() =>
      expect(port.sent.slice(before)).toContainEqual(
        expect.objectContaining({
          type: "conversation-command",
          sessionId: BROKER,
          command: { type: "ui.conversation.consent", payload: { granted: false } },
        }),
      ),
    );
  });
});
