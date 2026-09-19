import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_BRIDGE_DISCONNECTS_KEY,
  AGENT_BRIDGE_GREETINGS_KEY,
  AGENT_HEARTBEAT_ALARM,
  AGENT_HEARTBEAT_PERIOD_MINUTES,
  AGENT_RECONCILE_ALARM,
  AGENT_RETRY_ALARM,
  composeAgentRuntime,
} from "../src/service-worker/agent-runtime.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";

/**
 * 004/T095 — several agent sessions on one worker (US2, R-111).
 *
 * 003 had one session per browser, so "the session" was a single variable and the owner's E1 was
 * the consequence: a second agent attaching took the first one's place. The claims here are the
 * ones that only appear once there is more than one - that two sessions hold two groups, that a
 * link event about one leaves the other alone, and that a relay restart releases the sessions whose
 * servers did not come back rather than all of them or none.
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
    drop() {
      for (const closer of closers) closer();
    },
  };
}

function pairRequest(sessionId: string, agentId = "agent-1"): unknown {
  return { type: "pair-request", agentId, displayName: "Claude Code", origin: "stdio:local", sessionId };
}

/**
 * The greeting the relay forwards on every attach, with the token stripped (004/T099i). It is what
 * announces a session to the worker; the pairing request that follows only asks the owner.
 */
function announce(sessionId: string, agentId = "agent-1", displayName = "Claude Code"): unknown {
  return { type: "hello", sessionId, agentId, displayName };
}

type Harness = {
  tabs: Array<{ id: number; url: string; title: string; groupId: number; active: boolean; windowId: number }>;
  session: Record<string, unknown>;
  alarms: Array<{ name: string; info: unknown }>;
  clearedAlarms: string[];
  /** Every group the worker asked Chrome to mark as the agent's, so a test can see a marking go. */
  marked: number[];
  cleared: number[];
  /** The tabs the worker took out of their group, the indicator it lowered, the debugger it let go of. */
  ungrouped: number[];
  lowered: number[];
  debugger: { attached: number[]; detached: number[] };
  fireAlarm(name: string): void;
};

function installChrome(): Harness {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const alarms: Array<{ name: string; info: unknown }> = [];
  const clearedAlarms: string[] = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const marked: number[] = [];
  const cleared: number[] = [];
  const ungrouped: number[] = [];
  const lowered: number[] = [];
  const debuggerState = { attached: [] as number[], detached: [] as number[] };
  const state: Harness = {
    tabs: [
      { id: 7, url: "https://agent.test/one", title: "Agent one", groupId: -1, active: false, windowId: 900 },
      { id: 8, url: "https://agent.test/two", title: "Agent two", groupId: -1, active: false, windowId: 900 },
    ],
    session,
    alarms,
    clearedAlarms,
    marked,
    cleared,
    ungrouped,
    lowered,
    debugger: debuggerState,
    fireAlarm(name: string) {
      for (const listener of alarmListeners) listener({ name });
    },
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
    alarms: {
      create(name: string, info: unknown) {
        alarms.push({ name, info });
      },
      getAll: async () => alarms.map((alarm) => ({ name: alarm.name })),
      clear: async (name: string) => {
        clearedAlarms.push(name);
        return true;
      },
      onAlarm: { addListener: (cb: (alarm: { name: string }) => void) => void alarmListeners.push(cb) },
    },
    scripting: { async executeScript() {} },
    tabs: {
      async sendMessage(tabId: number, message: unknown) {
        const frame = message as { type?: string; show?: boolean };
        if (frame.type === "indicator" && frame.show === false) lowered.push(tabId);
        return { documentEpoch: "doc-1", canonicalOrigin: "https://agent.test" };
      },
      async ungroup(tabIds: number[]) {
        for (const tabId of tabIds) {
          ungrouped.push(tabId);
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = -1;
        }
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
    tabGroups: {
      async update(groupId: number, update: { title?: string }) {
        if (update.title === undefined || update.title === "") cleared.push(groupId);
        else marked.push(groupId);
        return { id: groupId };
      },
    },
    debugger: {
      async getTargets() {
        return [];
      },
      async attach(target: { tabId: number }) {
        debuggerState.attached.push(target.tabId);
      },
      async detach(target: { tabId: number }) {
        debuggerState.detached.push(target.tabId);
      },
      async sendCommand() {
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return state;
}

/** The sessions the worker is holding in `chrome.storage.session`, which is what survives eviction. */
function storedSessions(harness: Harness): Record<string, { groupId?: number; tabIds: number[]; lastHelloAt?: string }> {
  return (harness.session.agentSessions ?? {}) as Record<
    string,
    { groupId?: number; tabIds: number[]; lastHelloAt?: string }
  >;
}

async function pairedRuntime(port: FakePort): Promise<ReturnType<typeof composeAgentRuntime>> {
  const runtime = composeAgentRuntime({ connectNative: () => port });
  runtime.start();
  port.emit(announce("session-a"));
  port.emit(pairRequest("session-a"));
  await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
  await runtime.pairing.decide("agent-1", true);
  await vi.waitFor(() => expect(port.sent).toHaveLength(1));
  return runtime;
}

describe("T095 several agent sessions in one worker", () => {
  let fake: Harness;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  /**
   * 004/T099i - the announcement is the greeting, not the pairing request.
   *
   * A server sends `pair-request` on every attach today, which is the only reason the registry,
   * `lastHelloAt` and the group marking ever happen. S2 revisits pairing, and a pairing request
   * sent once per agent instead of once per attach would leave live sessions unregistered and
   * released by the 15 s reconciliation (FR-058). So the greeting - which every attach sends by
   * definition - is what registers a session.
   */
  it("registers a session on the greeting alone, before any pairing request", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();

    port.emit(announce("session-a"));
    await vi.waitFor(() =>
      expect(storedSessions(fake)["session-a"]?.lastHelloAt).toEqual(expect.any(String)),
    );

    // No pairing question was asked by the greeting, and none was answered.
    expect(port.sent).toEqual([]);
    // And the session is live enough to own tabs.
    await runtime.tabs.adopt("session-a", 7);
    expect(storedSessions(fake)["session-a"]?.tabIds).toEqual([7]);
  });

  it("keeps two sessions in their own groups, and tells each which tabs are the other's", async () => {
    const port = fakePort();
    const runtime = await pairedRuntime(port);

    // A second session of the *same* agent: already paired, so the owner is never asked again
    // (003 SC-020). It is a new session all the same - its own group, its own tabs.
    port.emit(announce("session-b"));
    port.emit(pairRequest("session-b"));
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    expect(port.sent[1]).toEqual({
      type: "pair-result",
      agentId: "agent-1",
      sessionId: "session-b",
      accepted: true,
    });
    expect((await runtime.pairing.state()).pending).toBeUndefined();

    await runtime.tabs.adopt("session-a", 7);
    await runtime.tabs.adopt("session-b", 8);

    port.emit({ callId: "call-a", sessionId: "session-a", tool: "tabs_context", args: {} });
    port.emit({ callId: "call-b", sessionId: "session-b", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(4));

    /**
     * 004/T104: the list is the browser's, so each session now sees that the other's tab exists -
     * and is told, by name, that it is not theirs. That is the same boundary the 003 assertion
     * drew: nothing here says a word about the other tab's *page*, and every tool that would read
     * or touch it still refuses (`held-by-session`, tested in agent-navigation).
     */
    expect(port.sent[2]).toEqual({
      callId: "call-a",
      outcome: "ok",
      result: [
        { tabId: 7, url: "https://agent.test/one", title: "Agent one", active: false, windowId: 900, holder: "this" },
        {
          tabId: 8,
          url: "https://agent.test/two",
          title: "Agent two",
          active: false,
          windowId: 900,
          holder: { sessionId: "session-b" },
        },
      ],
    });
    expect(port.sent[3]).toEqual({
      callId: "call-b",
      outcome: "ok",
      result: [
        {
          tabId: 7,
          url: "https://agent.test/one",
          title: "Agent one",
          active: false,
          windowId: 900,
          holder: { sessionId: "session-a" },
        },
        { tabId: 8, url: "https://agent.test/two", title: "Agent two", active: false, windowId: 900, holder: "this" },
      ],
    });
    const stored = storedSessions(fake);
    expect(stored["session-a"]?.groupId).not.toBe(stored["session-b"]?.groupId);
  });

  it("releases exactly the session the relay named, and leaves its tabs open", async () => {
    const port = fakePort();
    const runtime = await pairedRuntime(port);
    port.emit(announce("session-b"));
    port.emit(pairRequest("session-b"));
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    await runtime.tabs.adopt("session-a", 7);
    await runtime.tabs.adopt("session-b", 8);
    const groupA = storedSessions(fake)["session-a"]?.groupId;

    port.emit({ type: "session-ended", sessionId: "session-a" });
    await vi.waitFor(() => expect(storedSessions(fake)["session-a"]).toBeUndefined());

    // The other session is untouched: its record, its group and its ability to answer all survive.
    expect(storedSessions(fake)["session-b"]?.tabIds).toEqual([8]);
    expect(fake.cleared).toEqual([groupA]);
    // The tabs of the session that ended stay open; only the marking that said an agent was
    // driving them is withdrawn.
    expect(fake.tabs.map((tab) => tab.id)).toEqual([7, 8]);

    port.emit({ callId: "call-b", sessionId: "session-b", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(3));
    expect(port.sent[2]).toEqual({
      callId: "call-b",
      outcome: "ok",
      result: [
        // The ended session's tab is still open and now held by nobody: the owner has it back.
        { tabId: 7, url: "https://agent.test/one", title: "Agent one", active: false, windowId: 900, holder: "none" },
        { tabId: 8, url: "https://agent.test/two", title: "Agent two", active: false, windowId: 900, holder: "this" },
      ],
    });
  });

  it("treats a hello for a session it already knows as a reconnect, keeping the group", async () => {
    const port = fakePort();
    const runtime = await pairedRuntime(port);
    await runtime.tabs.adopt("session-a", 7);
    const groupA = storedSessions(fake)["session-a"]?.groupId;

    // The relay dropped and the same server dialled the next one: same session id, same agent, and
    // the greeting is what announces it (T099i).
    const before = storedSessions(fake)["session-a"]?.lastHelloAt;
    port.emit(announce("session-a"));
    await vi.waitFor(() =>
      expect(storedSessions(fake)["session-a"]?.lastHelloAt).not.toBe(before),
    );

    expect(storedSessions(fake)["session-a"]?.groupId).toBe(groupA);
    expect(storedSessions(fake)["session-a"]?.tabIds).toEqual([7]);
    // No second group was opened beside the one the session already owns.
    expect(fake.marked).toEqual([groupA]);
  });

  it("bounds the reconciliation with an alarm and releases only the sessions that stayed away", async () => {
    const port = fakePort();
    const runtime = await pairedRuntime(port);
    port.emit(announce("session-b"));
    port.emit(pairRequest("session-b"));
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    await runtime.tabs.adopt("session-a", 7);
    await runtime.tabs.adopt("session-b", 8);

    port.emit({ type: "relay-started", relayPid: 4321 });
    await vi.waitFor(() =>
      expect(fake.alarms.some((alarm) => alarm.name === AGENT_RECONCILE_ALARM)).toBe(true),
    );
    // Fifteen seconds, expressed the only way an alarm can express it. A `setTimeout` would be lost
    // with the worker, which is what makes this an alarm rather than a timer.
    expect(fake.alarms.find((alarm) => alarm.name === AGENT_RECONCILE_ALARM)?.info).toEqual({
      delayInMinutes: 15 / 60,
    });

    // One server dialled the new relay and greeted again; the other never came back.
    port.emit(announce("session-b"));
    port.emit(pairRequest("session-b"));
    await vi.waitFor(() => expect(port.sent).toHaveLength(3));

    fake.fireAlarm(AGENT_RECONCILE_ALARM);
    await vi.waitFor(() => expect(storedSessions(fake)["session-a"]).toBeUndefined());
    expect(storedSessions(fake)["session-b"]?.tabIds).toEqual([8]);
  });

  /**
   * 004/T169. A worker with an open native port but nothing to say is idle to MV3, and thirty quiet
   * seconds - an owner reading a pairing prompt, a call held for their answer - evict it: Chrome
   * closes the native port, the host exits, the pending prompt is dropped, the agent's server
   * re-dials a new relay and asks again. Measured in the attach-mode family (`agent-claim` §7,
   * the relay pid changing mid-wait in the server's own log). Both reference extensions keep their
   * worker alive with a repeating alarm at Chrome's 0.5-minute floor; so does this one, for as long
   * as the link is up. The retry alarm already covers the stretch when it is not.
   */
  it("keeps a heartbeat alarm at the half-minute floor while the link is up, and hands off to the retry alarm when it drops (T169)", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4321 });
    await vi.waitFor(() => expect(fake.alarms.some((alarm) => alarm.name === AGENT_HEARTBEAT_ALARM)).toBe(true));
    expect(fake.alarms.find((alarm) => alarm.name === AGENT_HEARTBEAT_ALARM)?.info).toEqual({
      periodInMinutes: AGENT_HEARTBEAT_PERIOD_MINUTES,
    });
    expect(AGENT_HEARTBEAT_PERIOD_MINUTES).toBe(0.5);

    port.drop();
    await vi.waitFor(() => expect(fake.clearedAlarms).toContain(AGENT_HEARTBEAT_ALARM));
  });

  /**
   * 009/T240. The extension owns every alarm in its profile; one with a name it no longer registers
   * is left over from an earlier version (0.2.0 used other names). The runtime clears anything it
   * finds under `chrome.alarms.getAll()` that is not one of its own current names, once, on start -
   * and leaves its own alarms (even ones scheduled from a previous instance) alone.
   */
  it("clears alarms left over from an earlier version once on start, and leaves its own alone", async () => {
    fake.alarms.push(
      { name: "stale-alarm-a", info: {} },
      { name: "stale-alarm-b", info: {} },
      { name: AGENT_RETRY_ALARM, info: {} },
    );
    const port = fakePort();
    composeAgentRuntime({ connectNative: () => port });

    await vi.waitFor(() => expect(fake.clearedAlarms.length).toBeGreaterThan(0));
    expect(fake.clearedAlarms).toContain("stale-alarm-a");
    expect(fake.clearedAlarms).toContain("stale-alarm-b");
    expect(fake.clearedAlarms).not.toContain(AGENT_RETRY_ALARM);
  });

  /**
   * 004/T169. The reason a native port closed lives in `chrome.storage.session`, where the attach
   * gate can read it over the worker's socket and where a fresh worker after an eviction still
   * finds it - the agent build has no console to say it on. Bounded to the last few; a link that
   * flaps for an hour must not fill the session area.
   */
  it("records why the native port closed where a gate can read it, most recent last, bounded (T169)", async () => {
    const port = fakePort();
    let reason: string | undefined = "Native host has exited.";
    const runtime = composeAgentRuntime({ connectNative: () => port, disconnectReason: () => reason });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4321 });

    port.drop();
    await vi.waitFor(() => expect(fake.session[AGENT_BRIDGE_DISCONNECTS_KEY]).toBeDefined());
    const first = fake.session[AGENT_BRIDGE_DISCONNECTS_KEY] as Array<{ at: string; reason?: string }>;
    expect(first).toHaveLength(1);
    expect(first[0]?.reason).toBe("Native host has exited.");
    expect(typeof first[0]?.at).toBe("string");

    reason = undefined;
    for (let i = 0; i < 7; i += 1) {
      runtime.connect();
      port.drop();
    }
    await vi.waitFor(() =>
      expect((fake.session[AGENT_BRIDGE_DISCONNECTS_KEY] as unknown[]).length).toBe(5),
    );
    const ring = fake.session[AGENT_BRIDGE_DISCONNECTS_KEY] as Array<{ reason?: string }>;
    // The last one carried no reason, and says so by carrying no field rather than an invented word.
    expect(ring[ring.length - 1]?.reason).toBeUndefined();
  });

  /** Review B121 #2: one rejected storage write must not disable the rings for the rest of the instance. */
  it("keeps recording drops after one storage write rejected (T169)", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port, disconnectReason: () => "boom" });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4321 });
    await vi.waitFor(() => expect(fake.session[AGENT_BRIDGE_GREETINGS_KEY]).toBeDefined());

    const area = (globalThis as { chrome: { storage: { session: { set: (v: unknown) => Promise<void> } } } }).chrome.storage.session;
    const realSet = area.set;
    let failOnce = true;
    area.set = async (values: unknown) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("quota");
      }
      return realSet(values);
    };
    port.drop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    runtime.connect();
    port.drop();

    await vi.waitFor(() =>
      expect((fake.session[AGENT_BRIDGE_DISCONNECTS_KEY] as unknown[] | undefined)?.length).toBe(1),
    );
  });

  it("still stops everything on a stop that names no session (003's reading of the owner's Stop)", async () => {
    const port = fakePort();
    const runtime = await pairedRuntime(port);
    port.emit(announce("session-b"));
    port.emit(pairRequest("session-b"));
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    await runtime.tabs.adopt("session-a", 7);
    await runtime.tabs.adopt("session-b", 8);

    port.emit({ type: "stop" });

    await vi.waitFor(() => expect(Object.keys(storedSessions(fake))).toEqual([]));
  });

  it("leaves another session's question standing when a stop names one session (T105a)", async () => {
    const port = fakePort();
    const runtime = await pairedRuntime(port);
    port.emit(announce("session-b"));
    port.emit(pairRequest("session-b"));
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    await runtime.tabs.adopt("session-a", 7);
    await runtime.tabs.adopt("session-b", 8);

    // Session B's agent is waiting on the owner. Nothing about this question belongs to session A.
    const asked = runtime.prompts.ask({
      callId: "call-b",
      sessionId: "session-b",
      site: "https://agent.test",
      tool: "click",
      argsSummary: "click a page element",
    });
    await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined());
    const promptId = runtime.prompts.current()?.promptId ?? "";

    port.emit({ type: "stop", sessionId: "session-a" });

    await vi.waitFor(() => expect(storedSessions(fake)["session-a"]).toBeUndefined());
    // The owner is still looking at B's question, and answering it still reaches B's call: a stop
    // about somebody else's work must not make a question vanish from in front of the owner.
    expect(runtime.prompts.current()?.promptId).toBe(promptId);
    expect(runtime.prompts.decide(promptId, true)).toBe(true);
    await expect(asked).resolves.toMatchObject({ decision: "allow" });
    // And B is still a session, with its tab.
    expect(storedSessions(fake)["session-b"]?.tabIds).toEqual([8]);
  });
});

/**
 * 006/T189 — the owner's three controls from the panel, and what the panel is told (R-126, R-127).
 *
 * Stop and release are the two things a session card offers, and they are different in exactly one
 * way: after a stop the session is gone and its in-flight call has been told `owner-stopped`; after
 * a release the session is still live and paired, only its tabs are the owner's again. Clearing a
 * site is the revoke on the site list. The projection half is what the cards and the not-connected
 * page are derived from: sites per session, `waiting` on the one whose question is up, the agent's
 * name, and the bridge facts the 004 rings already hold.
 */
describe("T189 owner controls from the panel and the projection they read", () => {
  let fake: Harness;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  async function twoSessions(port: FakePort): Promise<ReturnType<typeof composeAgentRuntime>> {
    const runtime = await pairedRuntime(port);
    port.emit(announce("session-b"));
    port.emit(pairRequest("session-b"));
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    await runtime.tabs.adopt("session-a", 7);
    await runtime.tabs.adopt("session-b", 8);
    return runtime;
  }

  it("stops one session from the panel: its wait answers owner-stopped, the other session is untouched", async () => {
    const port = fakePort();
    const runtime = await twoSessions(port);
    const groupA = storedSessions(fake)["session-a"]?.groupId;

    port.emit({ callId: "wait-a", sessionId: "session-a", tool: "wait", args: { tabId: 7, forMs: 10_000 } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await runtime.stopSessionFromOwner("session-a");

    await vi.waitFor(() => expect(port.sent).toHaveLength(3));
    expect(port.sent[2]).toEqual({ callId: "wait-a", outcome: "stopped", reason: "owner-stopped" });
    expect(storedSessions(fake)["session-a"]).toBeUndefined();
    // Its marking is withdrawn and its tab stays open as the owner's.
    expect(fake.cleared).toEqual([groupA]);
    expect(fake.tabs.map((tab) => tab.id)).toEqual([7, 8]);
    expect(storedSessions(fake)["session-b"]?.tabIds).toEqual([8]);
    expect((await runtime.projection()).sessions.map((session) => session.sessionId)).toEqual(["session-b"]);
  });

  /**
   * S1 review must-fix 1: the owner presses Release while the session's question is up. The card
   * must stop saying "waiting for you", and the parked call is told the tab is not its own - never
   * `timed-out`, which would read as "nobody answered".
   */
  it("settles a standing consent with released when the owner takes the session's tabs back", async () => {
    const port = fakePort();
    const runtime = await twoSessions(port);
    const asked = runtime.prompts.ask({
      callId: "call-b",
      sessionId: "session-b",
      site: "https://agent.test",
      tool: "click",
      argsSummary: "click a page element",
    });
    await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined());
    expect((await runtime.projection()).sessions.find((session) => session.sessionId === "session-b")?.state).toBe("waiting");

    await runtime.releaseSessionTabs("session-b");

    await expect(asked).resolves.toEqual({ decision: "released" });
    expect(runtime.prompts.current()).toBeUndefined();
    expect((await runtime.projection()).sessions.find((session) => session.sessionId === "session-b")?.state).toBe("working");
  });

  /** S1 review should-fix 3 (FR-087): a call parked on a prompt or a plan answers `owner-stopped`. */
  it("settles a standing consent or plan with stopped when the owner stops the session", async () => {
    const port = fakePort();
    const runtime = await twoSessions(port);
    const asked = runtime.prompts.ask({
      callId: "call-a",
      sessionId: "session-a",
      site: "https://agent.test",
      tool: "click",
      argsSummary: "click a page element",
    });
    await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined());

    await runtime.stopSessionFromOwner("session-a");
    await expect(asked).resolves.toEqual({ decision: "stopped" });

    const plan = runtime.prompts.askPlan({
      callId: "batch-b",
      sessionId: "session-b",
      site: "https://agent.test",
      steps: [{ tool: "click", summary: "click a page element" }],
    });
    await vi.waitFor(() => expect(runtime.prompts.currentPlan()).toBeDefined());

    await runtime.stopSessionFromOwner("session-b");
    await expect(plan).resolves.toEqual({ decision: "stopped" });
    expect(runtime.prompts.currentPlan()).toBeUndefined();
  });

  /**
   * S1 review should-fix 2: after an owner Stop the host is still paired and still attached, so its
   * next call must be told the session is over in a word it can act on - not `not-paired`, which
   * it reads as the owner's refusal. A fresh greeting under the same id is then a new session.
   */
  it("answers session-ended to a call for a stopped session, and takes the session back on a new greeting", async () => {
    const port = fakePort();
    const runtime = await twoSessions(port);

    await runtime.stopSessionFromOwner("session-a");
    port.emit({ callId: "late-a", sessionId: "session-a", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(3));
    expect(port.sent[2]).toEqual({ callId: "late-a", outcome: "denied", reason: "session-ended" });

    port.emit(announce("session-a"));
    port.emit(pairRequest("session-a"));
    await vi.waitFor(() => expect(port.sent).toHaveLength(4));
    expect(port.sent[3]).toEqual({ type: "pair-result", agentId: "agent-1", sessionId: "session-a", accepted: true });
    port.emit({ callId: "again-a", sessionId: "session-a", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(5));
    expect(port.sent[4]).toMatchObject({ callId: "again-a", outcome: "ok" });
    expect(storedSessions(fake)["session-a"]?.tabIds).toEqual([]);
    expect((await runtime.projection()).sessions.map((session) => session.sessionId)).toEqual(["session-b", "session-a"]);
  });

  /** S1 review nit 7: one tab failing to release does not strand the rest, and the failure is said. */
  it("keeps releasing the other tabs when one release throws, and reports it", async () => {
    const port = fakePort();
    const runtime = await twoSessions(port);
    fake.tabs.push({ id: 9, url: "https://agent.test/three", title: "Agent three", groupId: -1, active: false, windowId: 900 });
    await runtime.tabs.adopt("session-a", 9);
    (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__ = "test";
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const release = runtime.tabs.release.bind(runtime.tabs);
    vi.spyOn(runtime.tabs, "release").mockImplementation(async (sessionId, tabId) => {
      if (tabId === 7) throw new Error("storage-gone");
      return release(sessionId, tabId);
    });
    try {
      await expect(runtime.releaseSessionTabs("session-a")).resolves.toBeUndefined();
      expect(storedSessions(fake)["session-a"]?.tabIds).toEqual([7]);
      expect(warned).toHaveBeenCalledWith("[hallpass] agent.release.tab-failed");

      // And the stop path survives a failing release the same way, instead of rejecting the panel's command.
      vi.spyOn(runtime.tabs, "endSession").mockRejectedValueOnce(new Error("storage-gone"));
      await expect(runtime.stopSessionFromOwner("session-b")).resolves.toBeUndefined();
      expect(warned).toHaveBeenCalledWith("[hallpass] agent.session.end-failed");
    } finally {
      warned.mockRestore();
      delete (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__;
    }
  });

  it("releases one session's tabs from the panel and keeps the session live and paired", async () => {
    const port = fakePort();
    const runtime = await twoSessions(port);
    // A debugger on B's tab under the owner's grant, so the release has an attachment to let go of.
    await runtime.setSiteMode("https://agent.test", "ask");
    await runtime.setDiagnostics("https://agent.test", true);
    port.emit({ callId: "console-b", sessionId: "session-b", tool: "read_console", args: { tabId: 8 } });
    await vi.waitFor(() => expect(port.sent).toHaveLength(3));
    expect(port.sent[2]).toMatchObject({ callId: "console-b", outcome: "ok" });
    expect(fake.debugger.attached).toEqual([8]);

    await runtime.releaseSessionTabs("session-b");

    // The lease is gone (the tab left the group the way `tabs_release` takes it out); the session
    // record stays, with nothing in it, and the tab is still open.
    expect(storedSessions(fake)["session-b"]?.tabIds).toEqual([]);
    expect((await runtime.tabs.leases()).map((lease) => lease.tabId)).toEqual([7]);
    expect(fake.tabs.map((tab) => tab.id)).toEqual([7, 8]);
    // Everything `tabs_release` withdraws from one tab: its group, its in-page indicator, its debugger.
    expect(fake.ungrouped).toEqual([8]);
    expect(fake.lowered).toContain(8);
    expect(fake.debugger.detached).toEqual([8]);
    // Its next read of that tab is refused as any tab nobody gave it, and it is still a session.
    port.emit({ callId: "read-b", sessionId: "session-b", tool: "get_page_text", args: { tabId: 8 } });
    await vi.waitFor(() => expect(port.sent).toHaveLength(4));
    expect(port.sent[3]).toMatchObject({ callId: "read-b", outcome: "denied", reason: "not-yours" });
    const projection = await runtime.projection();
    expect(projection.sessions.map((session) => session.sessionId)).toEqual(["session-a", "session-b"]);
    expect(projection.paired.map((agent) => agent.agentId)).toEqual(["agent-1"]);
    // And the other session still holds its own.
    expect(storedSessions(fake)["session-a"]?.tabIds).toEqual([7]);
  });

  it("clears one site's stored decision so the default applies and the row is gone", async () => {
    const port = fakePort();
    const runtime = await pairedRuntime(port);
    await runtime.setSiteMode("https://agent.test", "skip-checks");
    await runtime.setSiteMode("https://other.test", "follow-a-plan");

    await runtime.clearSiteMode("https://agent.test");

    expect((await runtime.siteModes.get("https://agent.test")).mode).toBe("ask");
    expect((await runtime.siteModes.list()).map((record) => record.site)).toEqual(["https://other.test"]);
    expect((await runtime.projection()).sites.map((record) => record.site)).toEqual(["https://other.test"]);
  });

  it("projects each session's sites, which one is waiting on the owner, and the agent's name", async () => {
    const port = fakePort();
    const runtime = await twoSessions(port);
    fake.tabs.push({ id: 9, url: "https://agent.test/three", title: "Agent three", groupId: -1, active: false, windowId: 900 });
    await runtime.tabs.adopt("session-a", 9);
    fake.tabs.push({ id: 10, url: "https://shop.test/cart", title: "Cart", groupId: -1, active: false, windowId: 900 });
    await runtime.tabs.adopt("session-a", 10);

    const asked = runtime.prompts.ask({
      callId: "call-b",
      sessionId: "session-b",
      site: "https://agent.test",
      tool: "click",
      argsSummary: "click a page element",
    });
    await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined());

    const projection = await runtime.projection();
    expect(projection.agentName).toBe("Claude Code");
    const a = projection.sessions.find((session) => session.sessionId === "session-a");
    const b = projection.sessions.find((session) => session.sessionId === "session-b");
    // Hosts, deduped, and never a title: two tabs on agent.test are one site. A tab on a scheme
    // that is not a web page names no site at all (S1 review nit 8).
    fake.tabs.push({ id: 11, url: "chrome://extensions", title: "Extensions", groupId: -1, active: false, windowId: 900 });
    await runtime.tabs.adopt("session-a", 11);
    expect((await runtime.projection()).sessions.find((session) => session.sessionId === "session-a")?.sites).toEqual(["agent.test", "shop.test"]);
    expect(a?.sites).toEqual(["agent.test", "shop.test"]);
    expect(a?.state).toBe("working");
    expect(b?.sites).toEqual(["agent.test"]);
    expect(b?.state).toBe("waiting");
    expect(typeof a?.lastActivityAt).toBe("string");
    // Any call of the session moves its activity, not only an effect (S1 review nit 11).
    await new Promise((resolve) => setTimeout(resolve, 5));
    port.emit({ callId: "ctx-a", sessionId: "session-a", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(port.sent).toHaveLength(3));
    const moved = (await runtime.projection()).sessions.find((session) => session.sessionId === "session-a")?.lastActivityAt ?? "";
    expect(moved > (a?.lastActivityAt ?? "")).toBe(true);

    runtime.prompts.cancel();
    await expect(asked).resolves.toMatchObject({ decision: "timed-out" });
  });

  it("projects each session under the name its own greeting carried, not the paired record's (FR-087 follow-up)", async () => {
    // One agent id serves every MCP client on the machine, so the pairing record's name is the
    // first client's. The greeting is where a session says who it is; the card must read that.
    const port = fakePort();
    const runtime = await pairedRuntime(port);
    port.emit(announce("session-b", "agent-1", "Cursor"));
    await vi.waitFor(async () => expect((await runtime.projection()).sessions).toHaveLength(2));

    const projection = await runtime.projection();
    expect(projection.agentName).toBe("Claude Code");
    expect(projection.sessions.find((session) => session.sessionId === "session-a")?.agentName).toBe("Claude Code");
    expect(projection.sessions.find((session) => session.sessionId === "session-b")?.agentName).toBe("Cursor");
  });

  it("projects the bridge diagnostics from the 004 rings for the not-connected page", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port, disconnectReason: () => "Native host has exited." });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 5150 });
    await vi.waitFor(() => expect(fake.session[AGENT_BRIDGE_GREETINGS_KEY]).toBeDefined());

    expect((await runtime.projection()).diagnostics).toEqual({ relayPid: 5150 });

    port.drop();
    await vi.waitFor(() => expect(fake.session[AGENT_BRIDGE_DISCONNECTS_KEY]).toBeDefined());

    const projection = await runtime.projection();
    expect(projection.bridge).toBe("disconnected");
    expect(projection.diagnostics).toEqual({
      relayPid: 5150,
      lastDisconnect: { at: expect.any(String), reason: "Native host has exited." },
    });
  });

  it("projects the record path the relay named, and survives the worker being replaced (006 FR-082)", async () => {
    const path = "C:\\Users\\owner\\AppData\\Local\\hallpass\\bridge.json";
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 5150, recordPath: path });
    await vi.waitFor(() => expect(fake.session[AGENT_BRIDGE_GREETINGS_KEY]).toBeDefined());

    expect((await runtime.projection()).diagnostics).toEqual({ relayPid: 5150, recordPath: path });

    // A fresh instance has no memory of the greeting, but the ring in the session area still does.
    const successor = composeAgentRuntime({ connectNative: () => fakePort() });
    expect((await successor.projection()).diagnostics).toEqual({ relayPid: 5150, recordPath: path });
  });
});
