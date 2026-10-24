import { afterEach, describe, expect, it, vi } from "vitest";
import { agentChoicesSchema, agentPanelStateSchema, type ConversationAgentAvailability } from "@hallpass/contracts";
import {
  AGENT_CHOICES_STORAGE_KEY,
  LEGACY_LAST_AGENT_STORAGE_KEY,
  createAgentChoicesStore,
} from "../src/service-worker/agent-choices.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";

/**
 * 024 T770 (R-380, data-model "AgentChoices", D-024-15, FR-382..384, FR-396) - which agents the
 * owner switched on and which is the default: a worker-owned record under `agentChoices`.
 *
 * First run: every agent on; the default is the agent the composer remembered (`conversationLastAgent`)
 * while it is ready, else the first ready one in the order Claude, Codex, Hermes, DeepSeek; the old
 * key goes. A default may only be set to an enabled, ready agent. Switching the default off moves it
 * to the first enabled, ready agent in that order, or to none, and says where.
 */

const ALL_ON = { "claude-code": true, codex: true, hermes: true, deepseek: true };

function entry(agent: ConversationAgentAvailability["agent"], availability: ConversationAgentAvailability["availability"]) {
  return { agent, availability } as ConversationAgentAvailability;
}
const READY_ALL = [entry("claude-code", "ready"), entry("codex", "ready"), entry("hermes", "ready"), entry("deepseek", "ready")];

function memoryStorage(seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  const writes: Array<Record<string, unknown>> = [];
  return {
    store,
    writes,
    area: {
      async get(keys: string[]) {
        const out: Record<string, unknown> = {};
        for (const key of keys) if (key in store) out[key] = store[key];
        return out;
      },
      async set(values: Record<string, unknown>) {
        writes.push(values);
        Object.assign(store, values);
      },
      async remove(keys: string[]) {
        for (const key of keys) delete store[key];
      },
    },
  };
}

describe("024 T770 agentChoices first run", () => {
  it("switches every agent on and takes the remembered agent as default when it is ready; the old key goes", async () => {
    const storage = memoryStorage({ [LEGACY_LAST_AGENT_STORAGE_KEY]: "hermes" });
    const choices = createAgentChoicesStore({ storage: () => storage.area });

    const read = await choices.read(READY_ALL);

    expect(read).toEqual({ enabled: ALL_ON, default: "hermes" });
    expect(storage.store[AGENT_CHOICES_STORAGE_KEY]).toEqual({ enabled: ALL_ON, default: "hermes" });
    expect(LEGACY_LAST_AGENT_STORAGE_KEY in storage.store).toBe(false);
    expect(agentChoicesSchema.safeParse(read).success).toBe(true);
  });

  it("falls back to the first ready agent in the order Claude, Codex, Hermes, DeepSeek when the remembered one is not ready", async () => {
    const storage = memoryStorage({ [LEGACY_LAST_AGENT_STORAGE_KEY]: "hermes" });
    const choices = createAgentChoicesStore({ storage: () => storage.area });

    const read = await choices.read([
      entry("claude-code", "missing"),
      entry("codex", "ready"),
      entry("hermes", "needs-install"),
      entry("deepseek", "ready"),
    ]);

    expect(read).toEqual({ enabled: ALL_ON, default: "codex" });
    expect(LEGACY_LAST_AGENT_STORAGE_KEY in storage.store).toBe(false);
  });

  it("has no default when no agent is ready, and none from an old key naming no agent", async () => {
    const storage = memoryStorage({ [LEGACY_LAST_AGENT_STORAGE_KEY]: "other" });
    const choices = createAgentChoicesStore({ storage: () => storage.area });

    expect(await choices.read([entry("claude-code", "missing"), entry("codex", "version-problem"), entry("hermes", "missing"), entry("deepseek", "needs-install")])).toEqual({
      enabled: ALL_ON,
      default: null,
    });
    expect(LEGACY_LAST_AGENT_STORAGE_KEY in storage.store).toBe(false);
  });

  it("decides nothing while readiness is unknown (no broker yet): all on, no default, nothing written", async () => {
    const storage = memoryStorage({ [LEGACY_LAST_AGENT_STORAGE_KEY]: "codex" });
    const choices = createAgentChoicesStore({ storage: () => storage.area });

    expect(await choices.read([])).toEqual({ enabled: ALL_ON, default: null });
    expect(storage.writes).toEqual([]);
    expect(storage.store[LEGACY_LAST_AGENT_STORAGE_KEY]).toBe("codex");

    // Once the agents are known, the first run happens with the remembered agent.
    expect(await choices.read(READY_ALL)).toEqual({ enabled: ALL_ON, default: "codex" });
  });

  it("keeps a stored record as it is, and a later old key changes nothing", async () => {
    const stored = { enabled: { ...ALL_ON, hermes: false }, default: "deepseek" };
    const storage = memoryStorage({ [AGENT_CHOICES_STORAGE_KEY]: stored, [LEGACY_LAST_AGENT_STORAGE_KEY]: "codex" });
    const choices = createAgentChoicesStore({ storage: () => storage.area });

    expect(await choices.read(READY_ALL)).toEqual(stored);
    expect(storage.writes).toEqual([]);
  });

  it("an unreadable storage reads as undecided, says so, and never seeds or changes over the owner's record", async () => {
    const owners = { enabled: { ...ALL_ON, hermes: false }, default: "deepseek" };
    const storage = memoryStorage({ [AGENT_CHOICES_STORAGE_KEY]: owners, [LEGACY_LAST_AGENT_STORAGE_KEY]: "codex" });
    const reports: string[] = [];
    let readable = false;
    const choices = createAgentChoicesStore({
      storage: () => ({ ...storage.area, get: async (keys: string[]) => (readable ? storage.area.get(keys) : Promise.reject(new Error("io"))) }),
      reportDiagnostic: (code) => reports.push(code),
    });

    expect(await choices.read(READY_ALL)).toEqual({ enabled: ALL_ON, default: null });
    expect(await choices.set({ enabled: { codex: false } }, READY_ALL)).toEqual({ ok: false, code: "not-saved" });
    expect(storage.writes, "nothing written over a record that could not be read").toEqual([]);
    expect(storage.store[LEGACY_LAST_AGENT_STORAGE_KEY]).toBe("codex");
    expect(reports).toContain("agent.choices.unread");

    // Read again once the storage answers: the owner's record, as it was.
    readable = true;
    expect(await choices.read(READY_ALL)).toEqual(owners);
  });

  it("keeps the default when its agent stops being ready (data-model: readiness changes later)", async () => {
    const storage = memoryStorage({ [AGENT_CHOICES_STORAGE_KEY]: { enabled: ALL_ON, default: "codex" } });
    const choices = createAgentChoicesStore({ storage: () => storage.area });
    expect(await choices.read([entry("claude-code", "ready"), entry("codex", "missing")])).toEqual({ enabled: ALL_ON, default: "codex" });
  });
});

describe("024 T770 agentChoices changes", () => {
  async function seeded(record: { enabled: Record<string, boolean>; default: string | null }) {
    const storage = memoryStorage({ [AGENT_CHOICES_STORAGE_KEY]: record });
    return { storage, choices: createAgentChoicesStore({ storage: () => storage.area }) };
  }

  it("sets the default only to an enabled, ready agent", async () => {
    const { choices, storage } = await seeded({ enabled: { ...ALL_ON, hermes: false }, default: "claude-code" });
    const agents = [entry("claude-code", "ready"), entry("codex", "ready"), entry("hermes", "ready"), entry("deepseek", "needs-install")];

    expect(await choices.set({ default: "codex" }, agents)).toEqual({ ok: true, choices: { enabled: { ...ALL_ON, hermes: false }, default: "codex" } });
    expect(await choices.set({ default: "hermes" }, agents)).toEqual({ ok: false, code: "agent-disabled" });
    expect(await choices.set({ default: "deepseek" }, agents)).toEqual({ ok: false, code: "agent-not-ready" });
    expect(storage.store[AGENT_CHOICES_STORAGE_KEY]).toEqual({ enabled: { ...ALL_ON, hermes: false }, default: "codex" });
  });

  it("switching an agent on and making it the default in one change is allowed", async () => {
    const { choices } = await seeded({ enabled: { ...ALL_ON, hermes: false }, default: "claude-code" });
    expect(await choices.set({ enabled: { hermes: true }, default: "hermes" }, READY_ALL)).toEqual({
      ok: true,
      choices: { enabled: ALL_ON, default: "hermes" },
    });
  });

  it("D-024-15: switching off the default moves it to the first enabled, ready agent in the fixed order and says which", async () => {
    const { choices } = await seeded({ enabled: ALL_ON, default: "claude-code" });
    const agents = [entry("claude-code", "ready"), entry("codex", "needs-install"), entry("hermes", "ready"), entry("deepseek", "ready")];

    expect(await choices.set({ enabled: { "claude-code": false } }, agents)).toEqual({
      ok: true,
      choices: { enabled: { ...ALL_ON, "claude-code": false }, default: "hermes" },
      defaultMovedTo: "hermes",
    });
  });

  it("D-024-15: with no enabled, ready agent left the default becomes none, and says so", async () => {
    const { choices } = await seeded({ enabled: { ...ALL_ON, codex: false, deepseek: false }, default: "hermes" });
    const agents = [entry("claude-code", "missing"), entry("codex", "ready"), entry("hermes", "ready"), entry("deepseek", "ready")];

    expect(await choices.set({ enabled: { hermes: false } }, agents)).toEqual({
      ok: true,
      choices: { enabled: { "claude-code": true, codex: false, hermes: false, deepseek: false }, default: null },
      defaultMovedTo: null,
    });
  });

  it("switching off another agent leaves the default and says nothing moved", async () => {
    const { choices } = await seeded({ enabled: ALL_ON, default: "codex" });
    const outcome = await choices.set({ enabled: { deepseek: false } }, READY_ALL);
    expect(outcome).toEqual({ ok: true, choices: { enabled: { ...ALL_ON, deepseek: false }, default: "codex" } });
    expect("defaultMovedTo" in outcome).toBe(false);
  });

  it("a storage that cannot be written refuses the change and keeps the old record", async () => {
    const storage = memoryStorage({ [AGENT_CHOICES_STORAGE_KEY]: { enabled: ALL_ON, default: "codex" } });
    const choices = createAgentChoicesStore({
      storage: () => ({ ...storage.area, set: async () => Promise.reject(new Error("quota")) }),
    });
    expect(await choices.set({ default: "hermes" }, READY_ALL)).toEqual({ ok: false, code: "not-saved" });
    expect(await choices.read(READY_ALL)).toEqual({ enabled: ALL_ON, default: "codex" });
  });
});

/* The record in the panel's projection (frames.md "Panel projection additions"). */

const BROKER = "broker-aaaaaaaaaaaaaaaaaaaaaaaa";

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

describe("024 T770 agentChoices in the panel projection", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("carries the record as conversation.choices, seeded once the broker says which agents are ready", async () => {
    const storage = memoryStorage({ [LEGACY_LAST_AGENT_STORAGE_KEY]: "deepseek" });
    const session = memoryStorage();
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: storage.area, session: session.area },
      alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
      tabs: { async query() { return []; } },
    };
    const port = fakeNativePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack" })));

    expect((await runtime.projection()).conversation?.choices).toEqual({ enabled: ALL_ON, default: null });

    port.emit({ type: "hello", sessionId: BROKER, agentId: "hallpass-broker", displayName: "Hallpass conversations", role: "broker" });
    port.emit({
      type: "conversation-overview",
      sessionId: BROKER,
      conversations: [],
      agents: [
        { agent: "claude-code", availability: "ready" },
        { agent: "codex", availability: "ready" },
        { agent: "hermes", availability: "missing" },
        { agent: "deepseek", availability: "ready" },
      ],
      folders: [],
    });
    await vi.waitFor(async () => expect((await runtime.projection()).conversation?.choices).toEqual({ enabled: ALL_ON, default: "deepseek" }));
    const state = await runtime.projection();
    expect(agentPanelStateSchema.safeParse(state).success).toBe(true);
    expect(storage.store[AGENT_CHOICES_STORAGE_KEY]).toEqual({ enabled: ALL_ON, default: "deepseek" });
    expect(LEGACY_LAST_AGENT_STORAGE_KEY in storage.store).toBe(false);

    // A change through the runtime is the panel's next picture.
    const listener = vi.fn();
    runtime.subscribe(listener);
    expect(await runtime.agentChoices.set({ enabled: { deepseek: false } })).toEqual({
      ok: true,
      choices: { enabled: { ...ALL_ON, deepseek: false }, default: "claude-code" },
      defaultMovedTo: "claude-code",
    });
    expect(listener).toHaveBeenCalled();
    expect((await runtime.projection()).conversation?.choices).toEqual({ enabled: { ...ALL_ON, deepseek: false }, default: "claude-code" });
  });
});
