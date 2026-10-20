import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PANEL_PORT_NAME, agentLinkFrameSchema, agentPanelMessageSchema, agentPanelStateSchema } from "@hallpass/contracts";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { createAgentPanelPort, type AgentPanelPortLike } from "../src/service-worker/agent-panel-port.js";
import { createConversationRelay } from "../src/service-worker/conversation-relay.js";

/**
 * 019/T527 — the worker's side of the broker's link (R-312, contracts/conversation-frames.md).
 *
 * The relay has already checked the broker's secret; what the worker adds is that the broker is
 * not an agent: its greeting creates no session card, no persisted record, no tab group and no
 * pairing. There is one broker session per relay run - a second broker greeting replaces the first
 * only after the first's `session-ended` (or a new relay run) - and `conversation-*` frames are
 * accepted from that session alone.
 */

const BROKER = "broker-aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_BROKER = "broker-bbbbbbbbbbbbbbbbbbbbbbbb";
const brokerHello = (sessionId = BROKER) => ({
  type: "hello",
  sessionId,
  agentId: "hallpass-broker",
  displayName: "Hallpass conversations",
  role: "broker",
});
const overview = (sessionId = BROKER) => ({
  type: "conversation-overview",
  sessionId,
  conversations: [],
  agents: [],
  folders: [],
});

describe("019 conversation relay (pure)", () => {
  function harness() {
    const delivered: unknown[] = [];
    const diagnostics: string[] = [];
    const relay = createConversationRelay({
      deliver: (frame) => delivered.push(frame),
      reportDiagnostic: (code) => diagnostics.push(code),
    });
    return { relay, delivered, diagnostics };
  }

  it("takes the first broker greeting and accepts conversation frames only from it", () => {
    const { relay, delivered, diagnostics } = harness();

    expect(relay.announce(BROKER)).toBe(true);
    expect(relay.receive(overview(BROKER) as never)).toBe(true);
    expect(relay.receive(overview("session-1") as never)).toBe(false);

    expect(delivered).toEqual([overview(BROKER)]);
    expect(diagnostics).toContain("agent.conversation.frame-foreign");
  });

  it("T558: a browser-token frame goes to onBrowserToken only, never to the deliver hook", () => {
    const delivered: unknown[] = [];
    const grants: unknown[] = [];
    const relay = createConversationRelay({
      deliver: (frame) => delivered.push(frame),
      onBrowserToken: (grant) => grants.push(grant),
    });
    relay.announce(BROKER);
    const token = "t".repeat(43);
    const frame = { type: "conversation-browser-token", sessionId: BROKER, conversationId: "conv-1", token, startTabId: 3 };

    expect(relay.receive(frame as never)).toBe(true);
    expect(relay.receive(overview(BROKER) as never)).toBe(true);

    expect(grants).toEqual([{ conversationId: "conv-1", token, startTabId: 3 }]);
    expect(delivered).toEqual([overview(BROKER)]);
    expect(JSON.stringify(delivered)).not.toContain(token);
  });

  it("drops conversation frames while no broker has greeted", () => {
    const { relay, delivered } = harness();

    expect(relay.receive(overview(BROKER) as never)).toBe(false);

    expect(delivered).toEqual([]);
  });

  it("keeps one broker per relay run: a second greeting waits for the first's session-ended", () => {
    const { relay, delivered, diagnostics } = harness();
    relay.announce(BROKER);

    expect(relay.announce(OTHER_BROKER)).toBe(false);
    expect(diagnostics).toContain("agent.conversation.broker-refused");
    expect(relay.receive(overview(OTHER_BROKER) as never)).toBe(false);
    // The same broker greeting again (a link drop on the same relay) is still that broker.
    expect(relay.announce(BROKER)).toBe(true);

    expect(relay.ended(BROKER)).toBe(true);
    expect(relay.announce(OTHER_BROKER)).toBe(true);
    expect(relay.receive(overview(OTHER_BROKER) as never)).toBe(true);
    expect(relay.receive(overview(BROKER) as never)).toBe(false);
    expect(delivered).toEqual([overview(OTHER_BROKER)]);
  });

  it("starts each relay run with no broker", () => {
    const { relay } = harness();
    relay.announce(BROKER);

    relay.relayStarted();

    expect(relay.current()).toBeUndefined();
    expect(relay.announce(OTHER_BROKER)).toBe(true);
  });

  it("says a session-ended was not the broker's when it was not", () => {
    const { relay } = harness();
    relay.announce(BROKER);

    expect(relay.ended("session-1")).toBe(false);
    expect(relay.current()).toBe(BROKER);
  });
});

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

function installChrome(): { session: Record<string, unknown>; local: Record<string, unknown>; grouped: number[] } {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const grouped: number[] = [];
  const area = (store: Record<string, unknown>) => ({
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in store) out[key] = store[key];
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
    alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
    scripting: { async executeScript() {} },
    tabs: {
      async sendMessage() {
        return undefined;
      },
      async get() {
        throw new Error("No tab with id");
      },
      async query() {
        return [];
      },
      async group({ tabIds }: { tabIds: number[] }) {
        grouped.push(...tabIds);
        return 100;
      },
    },
    tabGroups: { async update(groupId: number) { return { id: groupId }; } },
    downloads: { onCreated: { addListener() {} }, onChanged: { addListener() {} } },
  };
  return { session, local, grouped };
}

describe("019 conversation relay in the composed worker", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  async function composed() {
    const port = fakePort();
    const frames: unknown[] = [];
    const runtime = composeAgentRuntime({ connectNative: () => port, onConversationFrame: (frame) => frames.push(frame) });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack" })));
    return { port, runtime, frames };
  }

  it("a broker greeting is no agent: no session, no record, no group, no pairing", async () => {
    const { port, runtime, frames } = await composed();

    port.emit(brokerHello());
    port.emit(overview());
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    const state = await runtime.projection();
    expect(state.sessions).toEqual([]);
    expect(state.pending).toBeUndefined();
    expect(JSON.stringify(fake.session)).not.toContain(BROKER);
    expect(JSON.stringify(fake.local)).not.toContain(BROKER);
    expect(fake.grouped).toEqual([]);
    expect(port.sent.map((frame) => (frame as { type: string }).type).sort()).toEqual(["relay-ack", "upload-roots-list"]);
  });

  it("accepts conversation frames only from the broker session, and a new broker after session-ended", async () => {
    const { port, frames } = await composed();
    port.emit({ type: "hello", sessionId: "session-1", agentId: "agent-1", displayName: "Claude Code" });
    port.emit(brokerHello());

    port.emit(overview("session-1"));
    port.emit(brokerHello(OTHER_BROKER));
    port.emit(overview(OTHER_BROKER));
    port.emit(overview());
    await vi.waitFor(() => expect(frames).toEqual([overview()]));

    port.emit({ type: "session-ended", sessionId: BROKER });
    port.emit(brokerHello(OTHER_BROKER));
    port.emit(overview(OTHER_BROKER));
    await vi.waitFor(() => expect(frames).toEqual([overview(), overview(OTHER_BROKER)]));
  });

  it("an ordinary greeting naming the broker's session does not become a session", async () => {
    const { port, runtime } = await composed();
    port.emit(brokerHello());

    port.emit({ type: "hello", sessionId: BROKER, agentId: "agent-1", displayName: "Claude Code" });

    await new Promise((settle) => setTimeout(settle, 20));
    expect((await runtime.projection()).sessions).toEqual([]);
  });
});

/**
 * 019/T547 - the worker between the panel documents and the broker (contracts/conversation-frames.md,
 * R-318, R-323): `ui.conversation.*` forwarded as `conversation-command` frames under the panel's
 * commandId; results, events and pages fanned out to every panel document; the projection's
 * `conversation` part always present; a reconnecting panel gets the overview, then pages from the
 * seq it names. The worker keeps no conversation content: nothing of it is ever stored.
 */

const CONVERSATION = "conv-aaaaaaaaaaaaaaaa1";
const SECOND = "conv-bbbbbbbbbbbbbbbb2";
const VIEW = {
  conversationId: CONVERSATION,
  agent: "claude-code",
  title: "Tidy the invoices",
  folder: { kind: "scratch" },
  mode: "strict",
  createdAt: "2026-10-19T08:00:00.000Z",
  lastUsedAt: "2026-10-19T08:00:00.000Z",
  resumable: true,
  state: "idle",
};
const fullOverview = (sessionId = BROKER) => ({
  type: "conversation-overview",
  sessionId,
  conversations: [VIEW],
  agents: [{ agent: "claude-code", availability: "ready" }],
  folders: [],
  consent: "granted",
});
const eventFrame = (seq: number, text = `words-${seq}`, conversationId = CONVERSATION) => ({
  type: "conversation-event",
  sessionId: BROKER,
  conversationId,
  seq,
  event: { type: "text", role: "agent", text },
});

describe("T547 conversation relay: forwarding (pure)", () => {
  function harness(options: { windowMs?: number } = {}) {
    const frames: Array<Record<string, unknown>> = [];
    const panels: Array<Record<string, unknown>> = [];
    const timers: Array<() => void> = [];
    let clock = 1_000;
    let ids = 0;
    let changes = 0;
    const relay = createConversationRelay({
      deliver: () => undefined,
      sendFrame: (frame) => frames.push(frame as Record<string, unknown>),
      toPanels: (message) => panels.push(message as Record<string, unknown>),
      changed: () => void changes++,
      greetingWindowMs: options.windowMs ?? 15_000,
      now: () => clock,
      schedule: (callback) => void timers.push(callback),
      mintId: () => `w-${++ids}`,
    });
    return {
      relay,
      frames,
      panels,
      advance: (ms: number) => {
        clock += ms;
        for (const timer of timers.splice(0)) timer();
      },
      changes: () => changes,
    };
  }

  it("says broker-unavailable before any relay, and host-outdated when a relay never brings a broker", () => {
    const { relay, advance } = harness();
    expect(relay.panelState(false)).toEqual({
      available: false,
      reason: "broker-unavailable",
      consent: "unknown",
      conversations: [],
      agents: [],
      folders: [],
    });

    relay.relayStarted();
    expect(relay.panelState(true)).toMatchObject({ available: false, reason: "broker-unavailable" });
    advance(15_000);
    expect(relay.panelState(true)).toMatchObject({ available: false, reason: "host-outdated" });

    // A broker greeting late still counts; and a broker that greeted and left is unavailable, not old.
    relay.announce(BROKER);
    expect(relay.panelState(true)).toMatchObject({ available: true });
    expect(relay.panelState(true).reason).toBeUndefined();
    relay.ended(BROKER);
    expect(relay.panelState(true)).toMatchObject({ available: false, reason: "broker-unavailable" });
    // The link itself being down is never "host-outdated".
    expect(relay.panelState(false)).toMatchObject({ reason: "broker-unavailable" });
  });

  it("T563 projects the overview's list notice, and nothing when the overview has none", () => {
    const { relay } = harness();
    relay.relayStarted();
    relay.announce(BROKER);

    relay.receive({ ...fullOverview(), notice: "index-unreadable" } as never);
    const noticed = relay.panelState(true);
    expect(noticed.notice).toBe("index-unreadable");
    expect(agentPanelStateSchema.shape.conversation.safeParse(noticed).success).toBe(true);

    // The next overview is the broker's whole picture: a notice it no longer carries is gone.
    relay.receive(fullOverview() as never);
    expect("notice" in relay.panelState(true)).toBe(false);

    // And a broker that left takes the notice with its overview.
    relay.receive({ ...fullOverview(), notice: "index-unreadable" } as never);
    relay.ended(BROKER);
    expect("notice" in relay.panelState(true)).toBe(false);
  });

  it("forwards a panel command under the panel's commandId, without it in the command", () => {
    const { relay, frames } = harness();
    relay.relayStarted();
    relay.announce(BROKER);

    relay.command({ type: "ui.conversation.stop", payload: { conversationId: CONVERSATION }, commandId: "p-1" });
    relay.command({ type: "ui.conversation.add-folder", payload: {} });

    expect(frames).toEqual([
      { type: "conversation-command", sessionId: BROKER, commandId: "p-1", command: { type: "ui.conversation.stop", payload: { conversationId: CONVERSATION } } },
      { type: "conversation-command", sessionId: BROKER, commandId: "w-1", command: { type: "ui.conversation.add-folder", payload: {} } },
    ]);
    for (const frame of frames) expect(agentLinkFrameSchema.safeParse(frame).success).toBe(true);
  });

  it("answers a command at once with broker-unavailable when no broker is attached", () => {
    const { relay, frames, panels } = harness();

    relay.command({ type: "ui.conversation.stop", payload: { conversationId: CONVERSATION }, commandId: "p-1" });

    expect(frames).toEqual([]);
    expect(panels).toEqual([
      { type: "conversation-result", payload: { commandId: "p-1", ok: false, error: { code: "broker-unavailable", detail: expect.any(String) } } },
    ]);
    expect(agentPanelMessageSchema.safeParse(panels[0]).success).toBe(true);
  });

  it("passes results to the panels, sets the open conversation after start and open, and clears it on remove", () => {
    const { relay, panels } = harness();
    relay.relayStarted();
    relay.announce(BROKER);
    relay.receive(fullOverview() as never);
    expect(relay.panelState(true)).toMatchObject({ available: true, consent: "granted", conversations: [VIEW] });
    expect(relay.panelState(true).active).toBeUndefined();

    relay.command({ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } }, commandId: "p-1" });
    relay.receive({ type: "conversation-result", sessionId: BROKER, commandId: "p-1", ok: true, value: { conversationId: CONVERSATION } } as never);
    expect(relay.panelState(true).active).toBe(CONVERSATION);

    relay.command({ type: "ui.conversation.open", payload: { conversationId: SECOND }, commandId: "p-2" });
    relay.receive({ type: "conversation-result", sessionId: BROKER, commandId: "p-2", ok: true } as never);
    expect(relay.panelState(true).active).toBe(SECOND);

    relay.command({ type: "ui.conversation.open", payload: { conversationId: CONVERSATION }, commandId: "p-3" });
    relay.receive({
      type: "conversation-result",
      sessionId: BROKER,
      commandId: "p-3",
      ok: false,
      error: { code: "in-use-elsewhere", detail: "Another browser." },
    } as never);
    expect(relay.panelState(true).active, "a refused open leaves the open conversation").toBe(SECOND);

    relay.command({ type: "ui.conversation.remove", payload: { conversationId: SECOND }, commandId: "p-4" });
    relay.receive({ type: "conversation-result", sessionId: BROKER, commandId: "p-4", ok: true } as never);
    expect(relay.panelState(true).active).toBeUndefined();

    expect(panels.map((message) => (message.payload as { commandId: string }).commandId)).toEqual(["p-1", "p-2", "p-3", "p-4"]);
    expect(panels[2]).toEqual({
      type: "conversation-result",
      payload: { commandId: "p-3", ok: false, error: { code: "in-use-elsewhere", detail: "Another browser." } },
    });
    for (const message of panels) expect(agentPanelMessageSchema.safeParse(message).success).toBe(true);
  });

  it("fails the commands in flight when the broker leaves, so no panel waits for an answer that cannot come", () => {
    const { relay, panels } = harness();
    relay.relayStarted();
    relay.announce(BROKER);
    relay.command({ type: "ui.conversation.stop", payload: { conversationId: CONVERSATION }, commandId: "p-1" });

    relay.ended(BROKER);

    expect(panels).toEqual([
      { type: "conversation-result", payload: { commandId: "p-1", ok: false, error: { code: "broker-unavailable", detail: expect.any(String) } } },
    ]);
  });

  it("fans events and pages out as conversation-event messages, and asks for pages after a gap in the seqs", () => {
    const { relay, panels, frames } = harness();
    relay.relayStarted();
    relay.announce(BROKER);

    relay.receive(eventFrame(0) as never);
    relay.receive(eventFrame(1) as never);
    relay.receive(eventFrame(4) as never);
    relay.receive(eventFrame(5) as never);

    expect(panels.map((message) => (message.payload as { seq: number }).seq)).toEqual([0, 1, 4, 5]);
    for (const message of panels) expect(agentPanelMessageSchema.safeParse(message).success).toBe(true);
    // One request for the gap, not one per later event.
    expect(frames).toEqual([
      {
        type: "conversation-command",
        sessionId: BROKER,
        commandId: "w-1",
        command: { type: "worker.conversation.page", payload: { conversationId: CONVERSATION, fromSeq: 2 } },
      },
    ]);

    panels.length = 0;
    relay.receive({ type: "conversation-result", sessionId: BROKER, commandId: "w-1", ok: true } as never);
    relay.receive({
      type: "conversation-page",
      sessionId: BROKER,
      conversationId: CONVERSATION,
      fromSeq: 2,
      events: [
        { seq: 2, event: { type: "text", role: "agent", text: "two" } },
        { seq: 3, event: { type: "state", state: "running" } },
      ],
      more: false,
    } as never);
    // The worker's own request is not the owner's command: its result is not a panel message.
    expect(panels).toEqual([
      { type: "conversation-event", payload: { conversationId: CONVERSATION, seq: 2, event: { type: "text", role: "agent", text: "two" } } },
      { type: "conversation-event", payload: { conversationId: CONVERSATION, seq: 3, event: { type: "state", state: "running" } } },
    ]);
  });

  it("turns a panel's resync into a page request from the seq it names, and opens that conversation if none is", () => {
    const { relay, frames } = harness();
    relay.relayStarted();
    relay.announce(BROKER);

    relay.command({ type: "ui.conversation.resync", payload: { conversationId: CONVERSATION, fromSeq: 7 } });

    expect(frames).toEqual([
      {
        type: "conversation-command",
        sessionId: BROKER,
        commandId: "w-1",
        command: { type: "worker.conversation.page", payload: { conversationId: CONVERSATION, fromSeq: 7 } },
      },
    ]);
    expect(relay.panelState(true).active).toBe(CONVERSATION);

    // A conversation the broker does not know is not left open.
    relay.receive({
      type: "conversation-result",
      sessionId: BROKER,
      commandId: "w-1",
      ok: false,
      error: { code: "not-found", detail: "Gone." },
    } as never);
    expect(relay.panelState(true).active).toBeUndefined();
  });

  it("asks a broker that greets a new relay for what it may have missed, from the last seq forwarded", () => {
    const { relay, frames } = harness();
    relay.relayStarted();
    relay.announce(BROKER);
    relay.receive(eventFrame(0) as never);
    relay.receive(eventFrame(1) as never);

    relay.relayStarted();
    relay.announce(BROKER);

    expect(frames).toEqual([
      {
        type: "conversation-command",
        sessionId: BROKER,
        commandId: "w-1",
        command: { type: "worker.conversation.page", payload: { conversationId: CONVERSATION, fromSeq: 2 } },
      },
    ]);
  });

  it("T572: names the attached broker as the epoch, and counts a replacement broker's seqs afresh", () => {
    const { relay, frames, panels } = harness();
    relay.relayStarted();
    relay.announce(BROKER);
    expect(relay.panelState(true).epoch).toBe(BROKER);
    for (const seq of [0, 1, 2, 3]) relay.receive(eventFrame(seq) as never);

    // The broker crashed and a new one (a new session, its seqs from 0) greets the same relay.
    relay.ended(BROKER);
    expect(relay.panelState(true).epoch).toBeUndefined();
    relay.announce(OTHER_BROKER);
    expect(relay.panelState(true).epoch).toBe(OTHER_BROKER);
    expect(agentPanelStateSchema.shape.conversation.safeParse(relay.panelState(true)).success).toBe(true);

    panels.length = 0;
    relay.receive({ ...eventFrame(0, "new zero"), sessionId: OTHER_BROKER } as never);
    relay.receive({ ...eventFrame(1, "new one"), sessionId: OTHER_BROKER } as never);
    // Nothing asked of the new broker from the old one's seqs, and no gap seen in its own.
    expect(frames).toEqual([]);
    expect(panels.map((message) => (message.payload as { seq: number }).seq)).toEqual([0, 1]);

    // Its own gap is still followed, from its own last seq.
    relay.receive({ ...eventFrame(3, "new three"), sessionId: OTHER_BROKER } as never);
    expect(frames).toEqual([
      {
        type: "conversation-command",
        sessionId: OTHER_BROKER,
        commandId: "w-1",
        command: { type: "worker.conversation.page", payload: { conversationId: CONVERSATION, fromSeq: 2 } },
      },
    ]);
  });

  it("T572: a different broker greeting a new relay is not asked for the old broker's seqs", () => {
    const { relay, frames } = harness();
    relay.relayStarted();
    relay.announce(BROKER);
    relay.receive(eventFrame(0) as never);
    relay.receive(eventFrame(1) as never);

    relay.relayStarted();
    relay.announce(OTHER_BROKER);

    expect(frames).toEqual([]);
    expect(relay.panelState(true).epoch).toBe(OTHER_BROKER);
  });

  /** T610: the list with an open conversation (`VIEW`) and a stopped one the owner chooses next. */
  const STOPPED = { ...VIEW, conversationId: SECOND, title: "Explain the relay handshake", state: "stopped" };
  const withBoth = (conversations: unknown[] = [VIEW, STOPPED]) => ({ ...fullOverview(), conversations });
  function opened(relay: ReturnType<typeof createConversationRelay>): void {
    relay.relayStarted();
    relay.announce(BROKER);
    relay.receive(withBoth() as never);
    relay.command({ type: "ui.conversation.open", payload: { conversationId: CONVERSATION }, commandId: "p-0" });
    relay.receive({ type: "conversation-result", sessionId: BROKER, commandId: "p-0", ok: true } as never);
  }
  const viewOf = (relay: ReturnType<typeof createConversationRelay>, conversationId: string) =>
    relay.panelState(true).conversations.find((entry) => entry.conversationId === conversationId);

  it("T610: an open switches to the chosen conversation at once, shown starting until the broker answers", () => {
    const { relay } = harness();
    opened(relay);

    relay.command({ type: "ui.conversation.open", payload: { conversationId: SECOND }, commandId: "p-1" });

    expect(relay.panelState(true).active, "before the replay ends").toBe(SECOND);
    expect(viewOf(relay, SECOND)?.state).toBe("starting");
    expect(agentPanelStateSchema.shape.conversation.safeParse(relay.panelState(true)).success).toBe(true);

    relay.receive({ ...withBoth([VIEW, { ...STOPPED, state: "idle" }]) } as never);
    relay.receive({ type: "conversation-result", sessionId: BROKER, commandId: "p-1", ok: true } as never);
    expect(relay.panelState(true).active).toBe(SECOND);
    expect(viewOf(relay, SECOND)?.state).toBe("idle");
  });

  it("T610: an open refused with cannot-resume stays on the chosen conversation, shown ended before the broker's overview says so", () => {
    const { relay, panels } = harness();
    opened(relay);

    relay.command({ type: "ui.conversation.open", payload: { conversationId: SECOND }, commandId: "p-1" });
    relay.receive({
      type: "conversation-result",
      sessionId: BROKER,
      commandId: "p-1",
      ok: false,
      error: { code: "cannot-resume", detail: "Claude Code no longer has this conversation." },
    } as never);

    expect(relay.panelState(true).active).toBe(SECOND);
    expect(viewOf(relay, SECOND)).toMatchObject({ resumable: false, state: "stopped" });
    expect(panels.at(-1)).toMatchObject({ type: "conversation-result", payload: { commandId: "p-1", ok: false } });
    // An overview read before the broker marked the entry still says resumable: the end stays.
    relay.receive(withBoth() as never);
    expect(viewOf(relay, SECOND)?.resumable).toBe(false);
    relay.receive(withBoth([VIEW, { ...STOPPED, resumable: false }]) as never);
    expect(viewOf(relay, SECOND)?.resumable).toBe(false);
    expect(relay.panelState(true).active).toBe(SECOND);
  });

  it("T610: any other refused open goes back to the conversation open before it, or to none", () => {
    const { relay } = harness();
    opened(relay);
    const refuse = (commandId: string, code: string) =>
      relay.receive({ type: "conversation-result", sessionId: BROKER, commandId, ok: false, error: { code, detail: "No." } } as never);

    relay.command({ type: "ui.conversation.open", payload: { conversationId: SECOND }, commandId: "p-1" });
    refuse("p-1", "too-many-running");
    expect(relay.panelState(true).active).toBe(CONVERSATION);
    expect(viewOf(relay, SECOND)).toMatchObject({ state: "stopped", resumable: true });

    // Two opens under way: the later one refused goes back past the earlier one only once that is refused too.
    relay.command({ type: "ui.conversation.open", payload: { conversationId: SECOND }, commandId: "p-2" });
    relay.command({ type: "ui.conversation.open", payload: { conversationId: CONVERSATION }, commandId: "p-3" });
    refuse("p-2", "busy");
    expect(relay.panelState(true).active).toBe(CONVERSATION);
    refuse("p-3", "in-use-elsewhere");
    expect(relay.panelState(true).active).toBe(CONVERSATION);

    // With nothing open before, a refusal leaves nothing open; a broker that leaves refuses the same way.
    relay.command({ type: "ui.conversation.remove", payload: { conversationId: CONVERSATION }, commandId: "p-4" });
    relay.receive({ type: "conversation-result", sessionId: BROKER, commandId: "p-4", ok: true } as never);
    relay.command({ type: "ui.conversation.open", payload: { conversationId: SECOND }, commandId: "p-5" });
    expect(relay.panelState(true).active).toBe(SECOND);
    refuse("p-5", "not-found");
    expect(relay.panelState(true).active).toBeUndefined();
    relay.command({ type: "ui.conversation.open", payload: { conversationId: SECOND }, commandId: "p-6" });
    relay.ended(BROKER);
    relay.announce(BROKER);
    expect(relay.panelState(true).active).toBeUndefined();
  });
});

const EXTENSION_ID = "adgpccmmbgnchnphfaoabfflfcepbopd";
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/side-panel.html`;

type FakePanel = AgentPanelPortLike & { sent: unknown[]; emit(message: unknown): void };

function fakePanel(): FakePanel {
  const listeners: Array<(message: unknown) => void> = [];
  return {
    name: AGENT_PANEL_PORT_NAME,
    sender: { id: EXTENSION_ID, url: PANEL_URL } as FakePanel["sender"],
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

describe("T547 conversation relay in the composed worker and panel port", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  async function composedWithPanels() {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    const panel = createAgentPanelPort({ extensionId: EXTENSION_ID, sidePanelUrl: PANEL_URL, runtime });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack" })));
    const first = fakePanel();
    const second = fakePanel();
    panel.accept(first);
    panel.accept(second);
    return { port, runtime, panel, first, second };
  }

  const conversationPart = (panel: FakePanel) =>
    (panel.sent.filter((message) => (message as { type: string }).type === "worker.agent.state").at(-1) as
      | { payload: { conversation?: Record<string, unknown> } }
      | undefined)?.payload.conversation;
  const ofType = (panel: FakePanel, type: string) => panel.sent.filter((message) => (message as { type: string }).type === type);

  it("always projects the conversation part: unavailable with no broker, the overview once it has one", async () => {
    const { port, runtime, first } = await composedWithPanels();
    const before = await runtime.projection();
    expect(before.conversation).toMatchObject({ available: false, reason: "broker-unavailable", conversations: [] });
    expect(agentPanelStateSchema.safeParse(before).success).toBe(true);

    port.emit(brokerHello());
    port.emit(fullOverview());

    // 019 T553: the consent shown is the worker's own record; a broker's "granted" this worker never
    // heard admits nothing, so it is not shown as given - the owner is asked, and the answer lands here.
    await vi.waitFor(() => expect(conversationPart(first)).toMatchObject({ available: true, consent: "unknown", conversations: [VIEW] }));
    expect(agentPanelStateSchema.safeParse(await runtime.projection()).success).toBe(true);
    runtime.conversation.command({ type: "ui.conversation.consent", payload: { granted: true }, commandId: "c-1" });
    await vi.waitFor(async () => expect((await runtime.projection()).conversation).toMatchObject({ consent: "granted" }));
  });

  it("forwards ui.conversation.* from any panel document and fans the result and the events out to all of them", async () => {
    const { port, first, second } = await composedWithPanels();
    port.emit(brokerHello());
    port.emit(fullOverview());

    second.emit({ type: "ui.conversation.send", payload: { conversationId: CONVERSATION, text: "summarise this" }, commandId: "p-1" });
    await vi.waitFor(() =>
      expect(port.sent).toContainEqual({
        type: "conversation-command",
        sessionId: BROKER,
        commandId: "p-1",
        command: { type: "ui.conversation.send", payload: { conversationId: CONVERSATION, text: "summarise this" } },
      }),
    );

    port.emit({ type: "conversation-result", sessionId: BROKER, commandId: "p-1", ok: false, error: { code: "busy", detail: "Still answering." } });
    port.emit(eventFrame(0, "secret words of the agent"));
    for (const panel of [first, second]) {
      await vi.waitFor(() =>
        expect(ofType(panel, "conversation-result")).toEqual([
          { type: "conversation-result", payload: { commandId: "p-1", ok: false, error: { code: "busy", detail: "Still answering." } } },
        ]),
      );
      expect(ofType(panel, "conversation-event")).toEqual([
        {
          type: "conversation-event",
          payload: { conversationId: CONVERSATION, seq: 0, event: { type: "text", role: "agent", text: "secret words of the agent" } },
        },
      ]);
    }
  });

  it("gives a reconnecting panel the overview, then the pages from the seq it names", async () => {
    const { port, panel } = await composedWithPanels();
    port.emit(brokerHello());
    port.emit(fullOverview());

    const returning = fakePanel();
    panel.accept(returning);
    await vi.waitFor(() => expect(conversationPart(returning)).toMatchObject({ available: true, conversations: [VIEW] }));

    returning.emit({ type: "ui.conversation.resync", payload: { conversationId: CONVERSATION, fromSeq: 12 } });
    const request = await vi.waitFor(() => {
      const found = port.sent.find((frame) => (frame as { type: string }).type === "conversation-command") as
        | { commandId: string; command: unknown }
        | undefined;
      expect(found?.command).toEqual({ type: "worker.conversation.page", payload: { conversationId: CONVERSATION, fromSeq: 12 } });
      return found!;
    });

    port.emit({ type: "conversation-result", sessionId: BROKER, commandId: request.commandId, ok: true });
    port.emit({
      type: "conversation-page",
      sessionId: BROKER,
      conversationId: CONVERSATION,
      fromSeq: 12,
      events: [{ seq: 12, event: { type: "text", role: "agent", text: "page words" } }],
      more: false,
    });
    await vi.waitFor(() =>
      expect(ofType(returning, "conversation-event")).toEqual([
        { type: "conversation-event", payload: { conversationId: CONVERSATION, seq: 12, event: { type: "text", role: "agent", text: "page words" } } },
      ]),
    );
    await vi.waitFor(() => expect(conversationPart(returning)).toMatchObject({ active: CONVERSATION }));
  });

  it("never accepts the worker's page request from a panel", async () => {
    const { port, first } = await composedWithPanels();
    port.emit(brokerHello());

    first.emit({ type: "worker.conversation.page", payload: { conversationId: CONVERSATION, fromSeq: 0 } });

    await new Promise((settle) => setTimeout(settle, 20));
    expect(port.sent.filter((frame) => (frame as { type: string }).type === "conversation-command")).toEqual([]);
  });

  it("keeps no conversation content: nothing of the words, the pages or the commands is ever stored", async () => {
    const { port, first } = await composedWithPanels();
    port.emit(brokerHello());
    port.emit(fullOverview());
    first.emit({ type: "ui.conversation.send", payload: { conversationId: CONVERSATION, text: "owner secret message" }, commandId: "p-1" });
    port.emit({ type: "conversation-result", sessionId: BROKER, commandId: "p-1", ok: true });
    port.emit(eventFrame(0, "agent secret answer"));
    port.emit({
      type: "conversation-page",
      sessionId: BROKER,
      conversationId: CONVERSATION,
      fromSeq: 0,
      events: [{ seq: 0, event: { type: "text", role: "agent", text: "paged secret answer" } }],
      more: false,
    });
    await vi.waitFor(() => expect(ofType(first, "conversation-event").length).toBeGreaterThanOrEqual(2));
    await new Promise((settle) => setTimeout(settle, 20));

    const stored = JSON.stringify([fake.local, fake.session]);
    for (const secret of ["owner secret message", "agent secret answer", "paged secret answer", "Tidy the invoices", CONVERSATION]) {
      expect(stored).not.toContain(secret);
    }
  });
});
