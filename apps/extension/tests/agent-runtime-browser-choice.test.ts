import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentLinkFrameSchema } from "@hallpass/contracts";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";

/**
 * 018/T509 — the "Use this browser?" card as the composed worker carries it (FR-274, R-273, R-279).
 *
 * A choose-only link is not a session: its greeting registers nothing the owner would see as an
 * agent at work - no session card, no persisted record, no tab group - and only lets that link's
 * id carry the three choice frames. The card itself follows the pairing card's rules: one slot in
 * the panel, the badge and the "still waiting" tick while nobody can see it, and a withdrawal, an
 * expiry or the link ending take it down without a word to the host.
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

const CHOOSE = "session-h1~choose";
const CHOOSE_HELLO = { type: "hello", sessionId: CHOOSE, agentId: "agent-1", displayName: "Claude Code", intent: "choose" };
const request = (requestId = "req-1", boundMs = 120_000, sessionId = CHOOSE) => ({
  type: "browser-choice-request",
  sessionId,
  requestId,
  agentName: "Claude Code",
  boundMs,
});

function installChrome(): { session: Record<string, unknown>; grouped: number[] } {
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
        return { documentEpoch: "doc-1", canonicalOrigin: "https://agent.test" };
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
  return { session, grouped };
}

function choiceFrames(port: FakePort): unknown[] {
  return port.sent.filter((frame) => (frame as { type?: string }).type === "browser-choice-result");
}

describe("018 browser choice card in the worker", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  async function composed(visible = true) {
    const port = fakePort();
    const marks: boolean[] = [];
    let seen = visible;
    const presenceListeners: Array<(value: boolean) => void> = [];
    const runtime = composeAgentRuntime({ connectNative: () => port, setAttention: (on) => marks.push(on) });
    runtime.bindPanelPresence({ isVisible: () => seen, onPresenceChange: (listener) => presenceListeners.push(listener) });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    // The relay publishes, and so lets any server dial, only on the ack: nothing greets before it.
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack" })));
    return {
      port,
      runtime,
      marks,
      setVisible(next: boolean) {
        seen = next;
        for (const listener of presenceListeners) listener(next);
      },
    };
  }

  it("a choose greeting creates no session, no record and no group", async () => {
    const { port, runtime } = await composed();
    port.emit(CHOOSE_HELLO);
    port.emit(request());
    await vi.waitFor(async () => expect((await runtime.projection()).browserChoice).toBeDefined());

    const state = await runtime.projection();
    expect(state.sessions).toEqual([]);
    expect(state.pending).toBeUndefined();
    expect(JSON.stringify(fake.session)).not.toContain(CHOOSE);
    expect(fake.grouped).toEqual([]);
    // Nothing went back but the ack and the upload-roots ask: no pairing, no tick, no answer.
    expect(port.sent.map((frame) => (frame as { type: string }).type).sort()).toEqual(["relay-ack", "upload-roots-list"]);
  });

  it("raises the card in the projection, and the owner's answer goes back addressed to the choose link", async () => {
    const { port, runtime } = await composed();
    port.emit(CHOOSE_HELLO);
    port.emit(request());
    await vi.waitFor(async () => expect((await runtime.projection()).browserChoice).toBeDefined());
    const card = (await runtime.projection()).browserChoice!;
    expect(card).toMatchObject({ requestId: "req-1", agentName: "Claude Code" });
    expect(Number.isNaN(Date.parse(card.raisedAt))).toBe(false);

    expect(runtime.decideBrowserChoice("req-1", true)).toBe(true);
    expect(choiceFrames(port)).toEqual([{ type: "browser-choice-result", sessionId: CHOOSE, requestId: "req-1", decision: "confirm" }]);
    expect(agentLinkFrameSchema.safeParse(choiceFrames(port)[0]).success).toBe(true);
    expect((await runtime.projection()).browserChoice).toBeUndefined();

    port.emit(request("req-2"));
    await vi.waitFor(async () => expect((await runtime.projection()).browserChoice?.requestId).toBe("req-2"));
    expect(runtime.decideBrowserChoice("req-2", false)).toBe(true);
    expect(choiceFrames(port).at(-1)).toEqual({ type: "browser-choice-result", sessionId: CHOOSE, requestId: "req-2", decision: "decline" });
  });

  it("a withdrawal takes the card down silently, and a later answer to it is ignored", async () => {
    const { port, runtime } = await composed();
    port.emit(CHOOSE_HELLO);
    port.emit(request());
    await vi.waitFor(async () => expect((await runtime.projection()).browserChoice).toBeDefined());

    port.emit({ type: "browser-choice-withdraw", sessionId: CHOOSE, requestId: "req-1" });
    expect((await runtime.projection()).browserChoice).toBeUndefined();
    expect(runtime.decideBrowserChoice("req-1", true)).toBe(false);
    expect(runtime.decideBrowserChoice("never-asked", true)).toBe(false);
    expect(choiceFrames(port)).toEqual([]);
  });

  it("a request on a link that never greeted as a choose link raises nothing", async () => {
    const { port, runtime } = await composed();
    port.emit({ type: "hello", sessionId: "session-h2", agentId: "agent-1", displayName: "Claude Code" });
    port.emit(request("req-1", 120_000, "session-h2"));
    port.emit(request("req-2", 120_000, "session-unknown"));
    expect((await runtime.projection()).browserChoice).toBeUndefined();
  });

  it("goes at its bound without an answer, and when its link ends", async () => {
    vi.useFakeTimers();
    const { port, runtime } = await composed();
    port.emit(CHOOSE_HELLO);
    port.emit(request("req-1", 1_000));
    expect((await runtime.projection()).browserChoice).toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await runtime.projection()).browserChoice).toBeUndefined();
    expect(runtime.decideBrowserChoice("req-1", true)).toBe(false);

    port.emit(request("req-2"));
    expect((await runtime.projection()).browserChoice).toBeDefined();
    port.emit({ type: "session-ended", sessionId: CHOOSE });
    expect((await runtime.projection()).browserChoice).toBeUndefined();
    // The ended link may carry no more cards.
    port.emit(request("req-3"));
    expect((await runtime.projection()).browserChoice).toBeUndefined();
    expect(choiceFrames(port)).toEqual([]);
  });

  it("a new relay on the link takes the old relay's choose links and card with it", async () => {
    // T515 m2: a same-browser handoff keeps the status "connected" and the superseded relay sends
    // no session-ended, so the fresh relay's greeting is the only signal that its links are gone.
    const { port, runtime } = await composed();
    port.emit(CHOOSE_HELLO);
    port.emit(request());
    await vi.waitFor(async () => expect((await runtime.projection()).browserChoice).toBeDefined());

    port.emit({ type: "relay-started", relayPid: 4343 });
    await vi.waitFor(async () => expect((await runtime.projection()).browserChoice).toBeUndefined());
    expect(runtime.decideBrowserChoice("req-1", true)).toBe(false);
    // The old relay's choose link may carry no more cards.
    port.emit(request("req-2"));
    expect((await runtime.projection()).browserChoice).toBeUndefined();
    expect(choiceFrames(port)).toEqual([]);
  });

  it("marks the icon and ticks while nobody can see the card, as the pairing card does", async () => {
    vi.useFakeTimers();
    const { port, runtime, marks, setVisible } = await composed(false);
    port.emit(CHOOSE_HELLO);
    port.emit(request());
    expect(marks.at(-1), "raised into a panel nobody has open").toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(port.sent).toContainEqual({
      type: "prompt-waiting",
      sessionId: CHOOSE,
      kind: "browser-choice",
      panelConnected: false,
      waitedMs: 5_000,
      boundMs: 120_000,
    });

    setVisible(true);
    expect(marks.at(-1)).toBe(false);
    runtime.decideBrowserChoice("req-1", true);
    const heard = port.sent.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(port.sent).toHaveLength(heard);
  });
});
