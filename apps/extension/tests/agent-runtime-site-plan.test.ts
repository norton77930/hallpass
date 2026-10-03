import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SITE_PLAN_FEATURE } from "@hallpass/contracts";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import type { AgentInputAttachments } from "../src/service-worker/agent-tools/input.js";
import { AGENT_RECONCILE_ALARM, composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentRecorder } from "../src/service-worker/recording/recorder.js";
import { AGENT_SESSION_SITE_PLANS_KEY } from "../src/service-worker/site-plan-store.js";

/**
 * 017/T470, T482 — the session site plan as the composed worker carries it (R-245, R-246).
 *
 * `site-mode-gate.test.ts` pins what the gate does with "this session's plan covers this site";
 * this file pins that the worker *asks the question* on the calls that reach the gate, about the
 * right session and the tab's origin as it is now - and that the answer is forgotten on every path
 * a session ends by, on unpair, and not on an interrupt. Each claim drives a composed runtime over
 * its native port, so a runner the coverage never reaches fails here rather than in the browser.
 */

type FakePort = AgentPortLike & { sent: unknown[]; emit(message: unknown): void };

type Fake = {
  session: Record<string, unknown>;
  tabs: Array<{ id: number; url: string; title: string; groupId: number; active: boolean; windowId: number }>;
  /** The browser telling the worker a tab moved (014's only navigation signal). */
  fire(tabId: number, url: string): void;
  /** A page event on a tab's debugger attachment, the way a real dialog arrives. */
  emitDebugger(tabId: number, method: string, params: Record<string, unknown>): void;
  fireAlarm(name: string): void;
  /** The names of the alarms the worker has armed, in order. */
  alarms: string[];
  /** Turns the session storage area off, as a browser without one would. */
  dropSessionArea(): void;
  /** The next `storage.local` write of `key` completes only once the returned function is called. */
  holdNextLocalWrite(key: string): () => void;
};

const { built } = vi.hoisted(() => ({ built: [] as AgentInputAttachments[] }));

vi.mock("../src/service-worker/agent-tools/input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/service-worker/agent-tools/input.js")>();
  return {
    ...actual,
    // Wrapped, never replaced: the runtime gets the real attachments and this file a handle on them.
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

const A = "https://a.test";
const B = "https://b.test";
const TAB = 7;
const OTHER_TAB = 8;
const S1 = "session-p1";
const S2 = "session-p2";
const hello = (sessionId: string) => ({ type: "hello", sessionId, agentId: "agent-1", displayName: "Claude Code" });
const pairRequest = (sessionId: string) => ({
  type: "pair-request",
  agentId: "agent-1",
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId,
});

function installChrome(): Fake {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const tabs = [
    { id: TAB, url: `${A}/one`, title: "A one", groupId: -1, active: true, windowId: 900 },
    { id: OTHER_TAB, url: `${A}/two`, title: "A two", groupId: -1, active: false, windowId: 900 },
  ];
  const updateListeners: Array<(tabId: number, change: { url?: string }, tab: unknown) => void> = [];
  const eventListeners: Array<(source: { tabId?: number }, method: string, params?: unknown) => void> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const alarms: string[] = [];
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
  const held = new Map<string, Promise<void>>();
  const localArea = area(local);
  const storage: { local: unknown; session?: unknown } = {
    local: {
      get: localArea.get,
      async set(values: Record<string, unknown>) {
        for (const key of Object.keys(values)) {
          const hold = held.get(key);
          if (hold) {
            held.delete(key);
            await hold;
          }
        }
        await localArea.set(values);
      },
    },
    session: area(session),
  };
  (globalThis as { chrome?: unknown }).chrome = {
    storage,
    alarms: {
      create: (name: string) => void alarms.push(name),
      clear: async () => true,
      onAlarm: { addListener: (listener: (alarm: { name: string }) => void) => void alarmListeners.push(listener) },
    },
    runtime: { id: "extension-1", onMessage: { addListener() {} } },
    scripting: { async executeScript() {} },
    debugger: {
      async getTargets() {
        return [];
      },
      async attach() {},
      async detach() {},
      async sendCommand() {
        return {};
      },
      onEvent: {
        addListener(callback: (source: { tabId?: number }, method: string, params?: unknown) => void) {
          eventListeners.push(callback);
        },
      },
      onDetach: { addListener() {} },
    },
    tabs: {
      // The content runtime answers for the page the tab is on *now*: a probe of a tab that moved
      // reports the new origin, which is what makes the binding follow the tab.
      async sendMessage(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        return { documentEpoch: "doc-1", canonicalOrigin: new URL(tab?.url ?? A).origin };
      },
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return tabs;
      },
      async ungroup() {},
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        const target = groupId ?? 100;
        for (const tabId of tabIds) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = target;
        }
        return target;
      },
      onUpdated: {
        addListener(listener: (tabId: number, change: { url?: string }, tab: unknown) => void) {
          updateListeners.push(listener);
        },
        removeListener() {},
      },
    },
    tabGroups: { async update(groupId: number) { return { id: groupId }; } },
    downloads: { onCreated: { addListener: () => undefined }, onChanged: { addListener: () => undefined } },
  };
  return {
    session,
    tabs,
    fire(tabId, url) {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (tab) tab.url = url;
      for (const listener of updateListeners) listener(tabId, { url }, tab);
    },
    emitDebugger(tabId, method, params) {
      for (const listener of eventListeners) listener({ tabId }, method, params);
    },
    alarms,
    fireAlarm(name) {
      for (const listener of alarmListeners) listener({ name });
    },
    dropSessionArea() {
      delete storage.session;
    },
    holdNextLocalWrite(key) {
      let release!: () => void;
      held.set(key, new Promise<void>((resolve) => (release = resolve)));
      return () => release();
    },
  };
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
type Runtime = ReturnType<typeof composeAgentRuntime>;

async function pairedRuntime(): Promise<{
  runtime: Runtime;
  port: FakePort;
  attachments: AgentInputAttachments;
  send: (tool: string, args: Record<string, unknown>, sessionId?: string) => string;
  answer: (callId: string) => Promise<Answer>;
}> {
  const port = fakePort();
  built.length = 0;
  const runtime = composeAgentRuntime({ connectNative: () => port, recorder: quietRecorder });
  runtime.start();
  port.emit(hello(S1));
  port.emit(pairRequest(S1));
  await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
  await runtime.pairing.decide("agent-1", true);
  await vi.waitFor(() => expect(port.sent).toHaveLength(1));
  // A second session of the same agent, holding the other tab on the same site.
  port.emit(hello(S2));
  port.emit(pairRequest(S2));
  await vi.waitFor(() => expect(port.sent).toHaveLength(2));
  await runtime.tabs.adopt(S1, TAB);
  await runtime.tabs.adopt(S2, OTHER_TAB);

  let next = 0;
  const send = (tool: string, args: Record<string, unknown>, sessionId = S1): string => {
    next += 1;
    const callId = `call-${next}`;
    const tabId = typeof args.tabId === "number" ? args.tabId : TAB;
    port.emit({ callId, sessionId, tool, tabId, args });
    return callId;
  };
  const answer = async (callId: string): Promise<Answer> => {
    await vi.waitFor(() =>
      expect(port.sent.some((sent) => (sent as { callId?: string }).callId === callId)).toBe(true),
    );
    return port.sent.find((sent) => (sent as { callId?: string }).callId === callId) as Answer;
  };
  return { runtime, port, attachments: built[0] as AgentInputAttachments, send, answer };
}

/** The consent card a call raised, about which site; fails loudly rather than hanging. */
async function card(runtime: Runtime): Promise<{ promptId: string; site: string; tool?: string; kind?: string }> {
  await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined(), { timeout: 3_000 });
  return runtime.prompts.current() as never;
}

/** A call answered with no card ever raised: admitted, whatever the fake page then made of it. */
async function answeredWithoutCard(
  runtime: Runtime,
  answer: (callId: string) => Promise<Answer>,
  callId: string,
): Promise<Answer> {
  const raised: string[] = [];
  runtime.subscribe(() => {
    const current = runtime.prompts.current();
    if (current) raised.push(current.promptId);
  });
  const answered = await answer(callId);
  expect(raised, "a consent card was raised").toEqual([]);
  expect(runtime.prompts.current()).toBeUndefined();
  expect(answered.reason).not.toBe("owner-denied");
  return answered;
}

function storedPlans(fake: Fake): Record<string, unknown> {
  return (fake.session[AGENT_SESSION_SITE_PLANS_KEY] ?? {}) as Record<string, unknown>;
}

const CLICK = { tabId: TAB, target: { ref: "t_one" } };
const CONFIRM = { url: `${A}/one`, message: "Delete 3 orders?", type: "confirm", hasBrowserHandler: false };

describe("T470 coverage on every gated call", () => {
  let fake: Fake;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("writes an approval to the live session area, and the projection shows it on the card", async () => {
    const { runtime } = await pairedRuntime();

    expect(await runtime.sitePlans.approve(S1, [A])).toEqual({ ok: true });

    expect(storedPlans(fake)[S1]).toMatchObject({ origins: [A] });
    const cards = (await runtime.projection()).sessions;
    expect(cards.find((card) => card.sessionId === S1)?.sitePlan).toEqual({ origins: [A] });
    expect(cards.find((card) => card.sessionId === S2)?.sitePlan).toBeUndefined();
  });

  it("asks about a click with no plan, and admits it without a card once the site is approved", async () => {
    const { runtime, send, answer } = await pairedRuntime();

    send("click", CLICK);
    const asked = await card(runtime);
    expect(asked.site).toBe(A);
    runtime.prompts.decide(asked.promptId, false);

    await runtime.sitePlans.approve(S1, [A]);
    await answeredWithoutCard(runtime, answer, send("click", CLICK));
  });

  it("does not cover a tab that has navigated off the approved origin", async () => {
    const { runtime, send } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A]);
    // The page went elsewhere without the 014 feed hearing of it: only the origin decides here.
    const tab = fake.tabs.find((candidate) => candidate.id === TAB);
    if (tab) tab.url = `${B}/landing`;

    send("click", CLICK);
    expect((await card(runtime)).site).toBe(B);
  });

  it("covers one session only: another session on an approved site is still asked", async () => {
    const { runtime, send } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A]);

    send("click", { tabId: OTHER_TAB, target: { ref: "t_one" } }, S2);
    const asked = await card(runtime);
    expect(asked.site).toBe(A);
    expect(runtime.prompts.currentSession()).toBe(S2);
  });

  it("admits a dialog accept on a covered tab and asks about it on an uncovered one", async () => {
    const { runtime, attachments, send, answer } = await pairedRuntime();
    await attachments.acquire(TAB, "input");
    fake.emitDebugger(TAB, "Page.javascriptDialogOpening", CONFIRM);

    send("dialog", { tabId: TAB, action: "accept" });
    const asked = await card(runtime);
    expect(asked.tool).toBe("dialog");
    runtime.prompts.decide(asked.promptId, false);
    // The owner's no dismissed that one (FR-114); the page asks again.
    await vi.waitFor(() => expect(runtime.prompts.current()).toBeUndefined());
    fake.emitDebugger(TAB, "Page.javascriptDialogOpening", CONFIRM);

    await runtime.sitePlans.approve(S1, [A]);
    const accepted = await answeredWithoutCard(runtime, answer, send("dialog", { tabId: TAB, action: "accept" }));
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ outcome: "ok" });
  });

  it("keeps asking about page JavaScript and a forced leave on a covered site (FR-255)", async () => {
    const { runtime, send } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A]);
    await runtime.setDiagnostics(A, true);

    send("evaluate", { tabId: TAB, expression: "document.title" });
    const script = await card(runtime);
    expect(script.tool).toBe("evaluate");
    runtime.prompts.decide(script.promptId, false);
    await vi.waitFor(() => expect(runtime.prompts.current()).toBeUndefined());

    send("navigate", { tabId: TAB, url: `${A}/next`, force: true });
    expect((await card(runtime)).tool).toBe("navigate");
  });

  it("runs a covered follow-a-plan batch with no plan card, and still asks about its script step", async () => {
    const { runtime, send, answer } = await pairedRuntime();
    await runtime.setSiteMode(A, "follow-a-plan");
    await runtime.setDiagnostics(A, true);
    await runtime.sitePlans.approve(S1, [A]);

    const covered = await answeredWithoutCard(
      runtime,
      answer,
      send("browser_batch", { tabId: TAB, steps: [{ tool: "click", args: { target: { ref: "t_one" } } }] }),
    );
    expect(runtime.prompts.currentPlan()).toBeUndefined();
    expect((covered.result as { results: Array<{ reason?: string }> }).results[0]?.reason).not.toBe("owner-denied");

    send("browser_batch", { tabId: TAB, steps: [{ tool: "evaluate", args: { expression: "1" } }] });
    expect((await card(runtime)).tool).toBe("evaluate");
    expect(runtime.prompts.currentPlan(), "a covered batch raised the plan card").toBeUndefined();
  });

  /** FR-262: the plan is an input to the gate, never a way past the 014 transition hold. */
  it("still raises the transition card when a covered tab moves to an unlisted site", async () => {
    const { runtime, send } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A]);
    // Where the session first saw the tab, then a move nothing of ours made.
    fake.fire(TAB, `${A}/one`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.fire(TAB, `${B}/landing`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    send("click", CLICK);
    const asked = await card(runtime);
    expect(asked.kind).toBe("transition");
  });
});

describe("T482 the plan ends with the session, the pairing, and not the interrupt", () => {
  let fake: Fake;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  async function approvedBoth(): Promise<Awaited<ReturnType<typeof pairedRuntime>>> {
    const built = await pairedRuntime();
    await built.runtime.sitePlans.approve(S1, [A]);
    await built.runtime.sitePlans.approve(S2, [A, B]);
    expect(Object.keys(storedPlans(fake)).sort()).toEqual([S1, S2]);
    return built;
  }

  it("clears it on a relay-named stop, and leaves the other session's", async () => {
    const { port } = await approvedBoth();
    port.emit({ type: "stop", sessionId: S1 });
    await vi.waitFor(() => expect(storedPlans(fake)[S1]).toBeUndefined());
    expect(storedPlans(fake)[S2]).toBeDefined();
  });

  it("clears every plan on the owner's unnamed stop", async () => {
    const { port } = await approvedBoth();
    port.emit({ type: "stop" });
    await vi.waitFor(() => expect(storedPlans(fake)).toEqual({}));
  });

  it("clears it when the relay says the session's server went away", async () => {
    const { port } = await approvedBoth();
    port.emit({ type: "session-ended", sessionId: S1 });
    await vi.waitFor(() => expect(storedPlans(fake)[S1]).toBeUndefined());
    expect(storedPlans(fake)[S2]).toBeDefined();
  });

  it("clears it when the reconciliation sweeps a session that never came back", async () => {
    const { port } = await approvedBoth();
    port.emit({ type: "relay-started", relayPid: 4321 });
    // The window is open before anybody greets the new relay, as in the sessions suite.
    await vi.waitFor(() => expect(fake.alarms).toContain(AGENT_RECONCILE_ALARM));
    // Only the second session greets the new relay.
    port.emit(hello(S2));
    port.emit(pairRequest(S2));
    await vi.waitFor(() =>
      expect(port.sent.filter((frame) => (frame as { type?: string }).type === "pair-result")).toHaveLength(3),
    );
    fake.fireAlarm(AGENT_RECONCILE_ALARM);
    await vi.waitFor(() => expect(storedPlans(fake)[S1]).toBeUndefined());
    expect(storedPlans(fake)[S2]).toBeDefined();
  });

  it("clears it when the owner stops the session from its card", async () => {
    const { runtime } = await approvedBoth();
    await runtime.stopSessionFromOwner(S1);
    expect(storedPlans(fake)[S1]).toBeUndefined();
    expect(storedPlans(fake)[S2]).toBeDefined();
  });

  it("clears every session's plan of an agent the owner unpairs", async () => {
    const { runtime } = await approvedBoth();
    await runtime.unpair("agent-1");
    expect(storedPlans(fake)).toEqual({});
  });

  it("keeps it through an interrupt", async () => {
    const { runtime, send, answer } = await approvedBoth();
    send("wait", { tabId: TAB, forMs: 300 });
    // Pressed until it reaches the call in flight: an interrupt that ended something.
    await vi.waitFor(() => expect(runtime.interruptSession(S1).interrupted).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storedPlans(fake)[S1]).toMatchObject({ origins: [A] });
    // And it still covers: the next click on the approved site runs without a card.
    await answeredWithoutCard(runtime, answer, send("click", CLICK));
  });

  it("clears it on the panel's withdraw, and covers nothing afterwards", async () => {
    const { runtime, send } = await approvedBoth();
    await runtime.sitePlans.withdraw(S1);
    expect(storedPlans(fake)[S1]).toBeUndefined();
    expect((await runtime.projection()).sessions.find((card) => card.sessionId === S1)?.sitePlan).toBeUndefined();

    send("click", CLICK);
    expect((await card(runtime)).site).toBe(A);
  });

  it("refuses an approval for a session that has ended or an agent that is unpaired", async () => {
    const { runtime } = await pairedRuntime();
    await runtime.stopSessionFromOwner(S1);
    expect(await runtime.sitePlans.approve(S1, [A])).toEqual({ ok: false, reason: "session-ended" });

    await runtime.unpair("agent-1");
    expect(await runtime.sitePlans.approve(S2, [A])).toEqual({ ok: false, reason: "not-paired" });
    expect(storedPlans(fake)).toEqual({});
  });

  /**
   * The approval checks the session and then writes, and an end can arrive between the two: its
   * clear may be queued before the approval's write. The plan must not survive it either way.
   */
  it("leaves no plan behind when the session ends while the approval is being checked", async () => {
    const { runtime } = await pairedRuntime();
    // The approval has seen a live session and is waiting on the pairing queue - behind a write
    // about some other agent - when the owner stops the session, and the whole stop runs first.
    const release = fake.holdNextLocalWrite("agentPairings");
    const unrelated = runtime.pairing.unpair("agent-elsewhere");
    const approving = runtime.sitePlans.approve(S1, [A]);
    await runtime.stopSessionFromOwner(S1);
    release();
    await unrelated;

    expect(await approving).toEqual({ ok: false, reason: "session-ended" });
    expect(storedPlans(fake)[S1]).toBeUndefined();
  });

  it("says when an approval could not be written, rather than reporting it granted", async () => {
    const { runtime } = await pairedRuntime();
    fake.dropSessionArea();
    expect(await runtime.sitePlans.approve(S1, [A])).toEqual({ ok: false, reason: "site-plan-not-recorded" });
  });

  it("lands an approval and another session's end made side by side", async () => {
    const { runtime, port } = await pairedRuntime();
    await runtime.sitePlans.approve(S2, [B]);

    const approving = runtime.sitePlans.approve(S1, [A]);
    port.emit({ type: "session-ended", sessionId: S2 });
    expect(await approving).toEqual({ ok: true });

    await vi.waitFor(() => expect(storedPlans(fake)[S2]).toBeUndefined());
    expect(storedPlans(fake)[S1]).toMatchObject({ origins: [A] });
  });
});

/**
 * 017 code review (S2+S3): M1, m1 and the coordinate-press gap.
 *
 * M1: a plan is the owner's yes to one agent's session. A session id the worker knows can be
 * re-announced by another paired agent (and after a restart any paired agent's greeting with a
 * stored id creates the session under its own agent), so admission must check whose plan it is.
 * m1: an unpair ends the agent's standing proposal too, not only its plans.
 */
describe("017 review: the plan is bound to its agent", () => {
  let fake: Fake;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("asks a press when the approved session id is re-announced by another paired agent (M1)", async () => {
    const { runtime, port, send } = await pairedRuntime();
    expect(await runtime.sitePlans.approve(S1, [A])).toEqual({ ok: true });

    // A second agent, paired by the owner, greets under the session id the plan was approved for.
    port.emit({ type: "hello", sessionId: S1, agentId: "agent-2", displayName: "Other agent" });
    port.emit({ type: "pair-request", agentId: "agent-2", displayName: "Other agent", origin: "stdio:local", sessionId: S1 });
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending?.agentId).toBe("agent-2"));
    await runtime.pairing.decide("agent-2", true);
    await vi.waitFor(async () => expect(await runtime.pairing.isPaired("agent-2")).toBe(true));
    // The plan is still stored, under the agent it was approved for.
    expect(storedPlans(fake)[S1]).toMatchObject({ origins: [A], agentId: "agent-1" });

    send("click", CLICK);
    const asked = await card(runtime);
    expect(asked.tool).toBe("click");
    expect(asked.site).toBe(A);
  });

  it("shows no plan, and marks nothing already approved, for a session re-announced by another agent (M1)", async () => {
    const { runtime, port, send } = await pairedRuntime();
    expect(await runtime.sitePlans.approve(S1, [A])).toEqual({ ok: true });

    port.emit({ type: "hello", sessionId: S1, agentId: "agent-2", displayName: "Other agent" });
    port.emit({ type: "pair-request", agentId: "agent-2", displayName: "Other agent", origin: "stdio:local", sessionId: S1 });
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending?.agentId).toBe("agent-2"));
    await runtime.pairing.decide("agent-2", true);
    await vi.waitFor(async () => expect(await runtime.pairing.isPaired("agent-2")).toBe(true));
    expect(storedPlans(fake)[S1]).toMatchObject({ origins: [A], agentId: "agent-1" });

    const sessionCard = (await runtime.projection()).sessions.find((session) => session.sessionId === S1);
    expect(sessionCard).toBeDefined();
    expect(sessionCard?.sitePlan).toBeUndefined();

    send("propose_sites", { origins: [A, B], purpose: "More" });
    await vi.waitFor(async () => expect((await runtime.projection()).sitePlan).toBeDefined(), { timeout: 3_000 });
    expect((await runtime.projection()).sitePlan?.alreadyApproved ?? []).toEqual([]);
  });

  it("takes down a pending proposal of an agent the owner unpairs, granting nothing (m1)", async () => {
    const { runtime, send, answer } = await pairedRuntime();

    const callId = send("propose_sites", { origins: [A], purpose: "x" });
    await vi.waitFor(() => expect(runtime.prompts.currentSitePlan()).toBeDefined());
    await runtime.unpair("agent-1");

    expect(runtime.prompts.currentSitePlan()).toBeUndefined();
    expect((await runtime.projection()).sitePlan).toBeUndefined();
    expect((await answer(callId)).outcome).not.toBe("ok");
    expect(storedPlans(fake)).toEqual({});
  });

  it("admits a coordinate press on an approved site without a card, and asks one without a plan", async () => {
    const { runtime, send, answer } = await pairedRuntime();
    const PRESS = { tabId: TAB, action: "left_click", x: 40, y: 30 };
    // A coordinate press is aimed inside the viewport, so the page has to say how big it is.
    const debuggerApi = (globalThis as { chrome: { debugger: { sendCommand: unknown } } }).chrome.debugger;
    debuggerApi.sendCommand = async (_target: unknown, method: string) =>
      method === "Page.getLayoutMetrics" ? { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } } : {};

    send("computer", PRESS);
    const asked = await card(runtime);
    expect(asked.tool).toBe("computer");
    expect(asked.site).toBe(A);
    runtime.prompts.decide(asked.promptId, false);
    await vi.waitFor(() => expect(runtime.prompts.current()).toBeUndefined());

    await runtime.sitePlans.approve(S1, [A]);
    await answeredWithoutCard(runtime, answer, send("computer", PRESS));
  });
});

/**
 * 017/T486 — everything outside the plan behaves as before (US4, FR-255, FR-256, FR-262).
 *
 * The plan is one input to the gate for one session's covered page actions on the tab's current
 * origin. Uploads keep their own consent, an unlisted site and another session are asked, and the
 * 014 transition hold runs before any gate - so a move between two sites the owner approved is
 * still a move the owner is asked about.
 */
describe("T486 everything outside the plan behaves as before", () => {
  let fake: Fake;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  const FILE = { name: "a.png", type: "image/png", bytesBase64: "aGk=" };

  it("asks about a file upload on an approved site (FR-255)", async () => {
    const { runtime, send } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A]);

    send("file_upload", { tabId: TAB, ref: "t_one", files: [FILE] });
    const asked = await card(runtime);
    expect(asked.tool).toBe("file_upload");
    expect(asked.site).toBe(A);
  });

  it("asks about putting a picture into a page on an approved site (FR-255)", async () => {
    const { runtime, send } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A]);

    send("upload_image", { tabId: TAB, target: { ref: "t_one" }, file: FILE });
    const asked = await card(runtime);
    expect(asked.tool).toBe("upload_image");
    expect(asked.site).toBe(A);
  });

  it("asks about a press on a site the plan does not list (FR-256)", async () => {
    const { runtime, send } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A]);
    const tab = fake.tabs.find((candidate) => candidate.id === TAB);
    if (tab) tab.url = `${B}/page`;

    send("click", CLICK);
    const asked = await card(runtime);
    expect(asked.tool).toBe("click");
    expect(asked.site).toBe(B);
  });

  it("still raises the transition card for a move between two approved sites (FR-262)", async () => {
    const { runtime, send } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A, B]);
    fake.fire(TAB, `${A}/one`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.fire(TAB, `${B}/landing`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    send("click", CLICK);
    const asked = await card(runtime);
    expect(asked.kind).toBe("transition");
  });
});

/**
 * 017/T475, T477, T482, T483 — `propose_sites` through the composed worker.
 *
 * The runner's own rules are pinned in `agent-tools-site-plan.test.ts`; this pins the wiring: the
 * worker says it can ask, the call reaches the runner, the question is what the panel is shown, the
 * owner's answer lands in the one store the gate reads, every change of the plan leaves one line on
 * the session's card, and an unpair clears plans the worker no longer has a session for.
 */
describe("T475/T477 propose_sites in the composed worker", () => {
  let fake: Fake;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  type Line = { kind: string; outcome: string; message?: string; site?: string };
  async function linesOf(runtime: Runtime, sessionId = S1): Promise<Line[]> {
    const card = (await runtime.projection()).sessions.find((session) => session.sessionId === sessionId);
    return ((card as { activity?: Line[] } | undefined)?.activity ?? []).filter((line) => line.kind === "site-plan");
  }

  async function question(runtime: Runtime) {
    await vi.waitFor(async () => expect((await runtime.projection()).sitePlan).toBeDefined(), { timeout: 3_000 });
    return (await runtime.projection()).sitePlan!;
  }

  it("advertises the site-plan feature on every pairing answer", async () => {
    const { port } = await pairedRuntime();
    const results = port.sent.filter((frame) => (frame as { type?: string }).type === "pair-result");
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect((result as { features?: string[] }).features).toContain(SITE_PLAN_FEATURE);
    }
  });

  it("shows the proposal to the panel, and writes exactly what the owner approved", async () => {
    const { runtime, send, answer } = await pairedRuntime();

    const callId = send("propose_sites", { origins: [A, B], purpose: "Compare two sites" });
    const asked = await question(runtime);
    expect(asked).toMatchObject({ sessionId: S1, origins: [A, B], purpose: "Compare two sites" });
    expect(asked.alreadyApproved).toBeUndefined();
    // The session card says whose question it is.
    expect((await runtime.projection()).sessions.find((card) => card.sessionId === S1)?.state).toBe("waiting");

    expect(runtime.prompts.decideSitePlan(asked.proposalId, true, [B])).toBe(true);

    expect(await answer(callId)).toMatchObject({ outcome: "ok", result: { approved: [B], leftOut: [A] } });
    expect(storedPlans(fake)[S1]).toMatchObject({ origins: [B], agentId: "agent-1" });
    const after = await runtime.projection();
    expect(after.sitePlan).toBeUndefined();
    expect(after.sessions.find((card) => card.sessionId === S1)?.sitePlan).toEqual({ origins: [B] });
    expect(await linesOf(runtime)).toEqual([expect.objectContaining({ kind: "site-plan", outcome: "approved", message: "1" })]);
  });

  it("marks the active plan on the next proposal, and notes a replacement and a withdrawal", async () => {
    const { runtime, send, answer } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A]);

    const callId = send("propose_sites", { origins: [A, B], purpose: "More" });
    const asked = await question(runtime);
    expect(asked.alreadyApproved).toEqual([A]);
    runtime.prompts.decideSitePlan(asked.proposalId, true, [A, B]);
    await answer(callId);
    expect(storedPlans(fake)[S1]).toMatchObject({ origins: [A, B] });

    await runtime.sitePlans.withdraw(S1);
    // A withdraw of nothing changes nothing and says nothing.
    await runtime.sitePlans.withdraw(S1);

    expect((await linesOf(runtime)).map((line) => [line.outcome, line.message])).toEqual([
      ["withdrawn", "2"],
      ["replaced", "2"],
      ["approved", "1"],
    ]);
    // The line is the count, never the origins.
    expect((await linesOf(runtime)).every((line) => line.site === undefined)).toBe(true);
  });

  it("writes nothing on a decline, and keeps the plan the session had", async () => {
    const { runtime, send, answer } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A]);

    const callId = send("propose_sites", { origins: [B], purpose: "More" });
    runtime.prompts.decideSitePlan((await question(runtime)).proposalId, false, []);

    expect(await answer(callId)).toMatchObject({ outcome: "declined" });
    expect(storedPlans(fake)[S1]).toMatchObject({ origins: [A] });
    expect((await linesOf(runtime)).map((line) => line.outcome)).toEqual(["approved"]);
  });

  it("withdraws a pending proposal when its session ends, granting nothing (FR-261)", async () => {
    const { runtime, port, send, answer } = await pairedRuntime();

    const callId = send("propose_sites", { origins: [A], purpose: "x" });
    await question(runtime);
    port.emit({ type: "session-ended", sessionId: S1 });

    await vi.waitFor(async () => expect((await runtime.projection()).sitePlan).toBeUndefined());
    expect(runtime.prompts.currentSitePlan()).toBeUndefined();
    expect((await answer(callId)).outcome).not.toBe("ok");
    expect(storedPlans(fake)[S1]).toBeUndefined();
  });

  it("notes the end of an active plan on unpair, on the card the session gets back", async () => {
    const { runtime, port } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A, B]);

    await runtime.unpair("agent-1");
    port.emit(pairRequest(S1));
    await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
    await runtime.pairing.decide("agent-1", true);

    await vi.waitFor(async () =>
      expect((await linesOf(runtime)).map((line) => line.outcome)).toEqual(["ended", "approved"]),
    );
    expect((await linesOf(runtime))[0]?.message).toBe("2");
    // S2 had no plan, so nothing ended there.
    expect(await linesOf(runtime, S2)).toEqual([]);
    expect(storedPlans(fake)).toEqual({});
  });

  /**
   * S2b's unpair gap: after a worker restart the new worker has no session in memory until each
   * greets again, so an unpair that cleared only the sessions it knew left the stored plan in place
   * - and it came back, still approved, when the session re-paired.
   */
  it("clears the plan of a session the worker has not seen since a restart when its agent is unpaired", async () => {
    const { runtime } = await pairedRuntime();
    await runtime.sitePlans.approve(S1, [A]);
    await runtime.sitePlans.approve(S2, [B]);

    // A second worker over the same browser storage: the pairing is remembered, the sessions are not.
    const restarted = composeAgentRuntime({ connectNative: () => fakePort(), recorder: quietRecorder });
    await restarted.unpair("agent-1");

    expect(storedPlans(fake)).toEqual({});
  });
});
