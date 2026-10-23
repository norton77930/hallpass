import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentLinkFrameSchema } from "@hallpass/contracts";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";

/**
 * 023/T716 (R-365, R-368, FR-364): the worker tells the broker that a conversation's `hallpass`
 * server greeted with that conversation's panel token - the only proof an agent run took the browser
 * tools. Once per agent run (the broker mints one token per run), only for a live token under the
 * agent id of the conversation it was issued for, and only to the broker's session.
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
const CONVERSATION = "c-0123456789abcdef";
const OTHER_CONVERSATION = "c-fedcba9876543210";
const TOKEN = "t".repeat(40);
const NEXT_TOKEN = "n".repeat(40);

const brokerHello = { type: "hello", sessionId: BROKER, agentId: "hallpass-broker", displayName: "Hallpass conversations", role: "broker" };
const tokenFrame = (token: string | null, conversationId = CONVERSATION) => ({
  type: "conversation-browser-token",
  sessionId: BROKER,
  conversationId,
  token,
});
const serverHello = (sessionId: string, conversationId: string, panelToken: string | undefined) => ({
  type: "hello",
  sessionId,
  agentId: `panel:${conversationId}`,
  displayName: "Hermes",
  ...(panelToken === undefined ? {} : { panelToken }),
});

function installChrome(): void {
  const area = () => {
    const store: Record<string, unknown> = {};
    return {
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
    };
  };
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: area(), session: area() },
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
      async group() {
        return 100;
      },
    },
    tabGroups: { async update(groupId: number) { return { id: groupId }; } },
    downloads: { onCreated: { addListener() {} }, onChanged: { addListener() {} } },
  };
}

const attachedFrames = (port: FakePort): unknown[] => port.sent.filter((frame) => (frame as { type?: string }).type === "conversation-browser-attached");

describe("023 conversation-browser-attached (worker)", () => {
  beforeEach(() => installChrome());
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  async function composed(withBroker = true) {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port, setAttention: () => undefined });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (withBroker) port.emit(brokerHello);
    return { port, runtime };
  }

  it("sends the broker one frame when the conversation's server greets with its live token", async () => {
    const { port } = await composed();
    port.emit(tokenFrame(TOKEN));
    port.emit(serverHello("session-1", CONVERSATION, TOKEN));

    expect(attachedFrames(port)).toEqual([{ type: "conversation-browser-attached", sessionId: BROKER, conversationId: CONVERSATION }]);
    expect(agentLinkFrameSchema.safeParse(attachedFrames(port)[0]).success).toBe(true);
  });

  it("says it once per run: a redial with the same token is silent, a new run's token says it again", async () => {
    const { port } = await composed();
    port.emit(tokenFrame(TOKEN));
    port.emit(serverHello("session-1", CONVERSATION, TOKEN));
    port.emit(serverHello("session-1", CONVERSATION, TOKEN));
    port.emit(serverHello("session-2", CONVERSATION, TOKEN));
    expect(attachedFrames(port)).toHaveLength(1);

    port.emit(tokenFrame(NEXT_TOKEN));
    port.emit(serverHello("session-3", CONVERSATION, NEXT_TOKEN));
    expect(attachedFrames(port)).toHaveLength(2);
  });

  it("says nothing for an unknown token, another conversation's agent id, or a greeting without a token", async () => {
    const { port } = await composed();
    port.emit(tokenFrame(TOKEN));
    port.emit(serverHello("session-1", CONVERSATION, "u".repeat(40)));
    port.emit(serverHello("session-2", OTHER_CONVERSATION, TOKEN));
    port.emit(serverHello("session-3", CONVERSATION, undefined));
    expect(attachedFrames(port)).toEqual([]);
  });

  it("says nothing when no broker is attached", async () => {
    const { port } = await composed(false);
    port.emit(serverHello("session-1", CONVERSATION, TOKEN));
    expect(attachedFrames(port)).toEqual([]);
  });
});
