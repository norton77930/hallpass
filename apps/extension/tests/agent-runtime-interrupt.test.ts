import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERRUPT_HINTS } from "@hallpass/contracts";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import { AGENT_TRANSITIONS_KEY } from "../src/service-worker/transition-store.js";
import type { AgentRecorder } from "../src/service-worker/recording/recorder.js";

/**
 * 014/T354 — 中斷 ends the calls and keeps the session (FR-179..FR-183, R-185 §2).
 *
 * The claim that needs a runtime rather than a unit is the *race*. A runner reads the stop flag at
 * its own checkpoints, which is right for the owner's Stop and cannot meet a one-second bound: a
 * `wait` sits a whole poll between reads, and a runner parked on a page that never answers has no
 * checkpoint at all. So the dispatch point answers the call itself and lets the runner finish into
 * nothing - and every fact this file asserts is about that seam: what the answer says, which of the
 * two honest sentences it carries, what happens to the result that arrives afterwards, and what the
 * session still holds when it is over.
 *
 * The two runners below are chosen for what they prove, not for coverage. A `wait` reaches no page
 * at all, so its interrupt is the "nothing refused it" case. A `type` whose key events never come
 * back has already put its input into the page - the marker for the call is written before the
 * first key goes out - so its interrupt is the "may have taken effect" case, which is the one
 * sentence this feature must not get wrong (Constitution XI).
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

const SESSION = "session-i1";
const TAB = 7;
const SITE = "https://agent.test";
const HELLO = { type: "hello", sessionId: SESSION, agentId: "agent-1", displayName: "Claude Code" };
const PAIR_REQUEST = {
  type: "pair-request",
  agentId: "agent-1",
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId: SESSION,
};

type Harness = {
  /** Every CDP command the worker sent, so "nothing was released" can be asserted rather than hoped. */
  commands: string[];
  detached: number[];
  ungrouped: number[];
  /** Group titles the worker cleared - the marking going away is what a session ending looks like. */
  clearedGroups: number[];
  /** Key and text events hang here, standing for a page that took the input and never answered. */
  releaseInput: () => void;
  /** 014/T369: the transition state read the dispatch point makes, failing as storage can fail. */
  transitionReadsFail: boolean;
  /** The same read, parked, so an interrupt can land while the check is still in flight. */
  holdTransitionReads(): () => void;
};

function installChrome(): Harness {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const tabs = [{ id: TAB, url: `${SITE}/one`, title: "Agent one", groupId: -1, active: true, windowId: 900 }];
  /** Parked while a test wants the dispatch point's transition read still in flight. */
  let held: Promise<void> | undefined;
  const harness: Harness = {
    commands: [],
    detached: [],
    ungrouped: [],
    clearedGroups: [],
    releaseInput: () => undefined,
    transitionReadsFail: false,
    holdTransitionReads() {
      let release = (): void => undefined;
      held = new Promise<void>((resolve) => {
        release = () => {
          held = undefined;
          resolve();
        };
      });
      return release;
    },
  };
  const hanging = new Promise<Record<string, unknown>>((resolve) => {
    harness.releaseInput = () => resolve({});
  });
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
    storage: {
      local: area(local),
      session: {
        ...area(session),
        async get(keys: string[]) {
          // Only the transitions key, and only when a test asks for it: the rest of the worker
          // reads this same area for its leases, and a store that failed everything would prove
          // nothing about the one read this file is about.
          if (keys.includes(AGENT_TRANSITIONS_KEY)) {
            if (harness.transitionReadsFail) throw new Error("storage.session unavailable");
            if (held) await held;
          }
          return area(session).get(keys);
        },
      },
    },
    alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
    runtime: { id: "extension-1", onMessage: { addListener() {} } },
    scripting: { async executeScript() {} },
    tabs: {
      async sendMessage() {
        return { documentEpoch: "doc-1", canonicalOrigin: SITE };
      },
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return tabs;
      },
      async ungroup(tabIds: number[]) {
        harness.ungrouped.push(...tabIds);
      },
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        const target = groupId ?? 100;
        for (const tabId of tabIds) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = target;
        }
        return target;
      },
      async captureVisibleTab() {
        return "data:image/png;base64,cGljdHVyZQ==";
      },
    },
    tabGroups: {
      async update(groupId: number, update: { title?: string }) {
        if (update.title === undefined || update.title === "") harness.clearedGroups.push(groupId);
        return { id: groupId };
      },
    },
    downloads: { onCreated: { addListener: () => undefined }, onChanged: { addListener: () => undefined } },
    debugger: {
      async getTargets() {
        return [];
      },
      async attach() {},
      async detach(target: { tabId: number }) {
        harness.detached.push(target.tabId);
      },
      async sendCommand(_target: unknown, method: string) {
        harness.commands.push(method);
        // The page took the keystrokes and never came back. Everything else answers at once, so
        // the only thing hanging is the one thing this test wants hanging.
        if (method.startsWith("Input.")) return hanging;
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return harness;
}

/** A recorder that says a recording is running, so "the recording is untouched" is assertable. */
function spyRecorder(): AgentRecorder & { exports: number; frames: number } {
  const spy = {
    exports: 0,
    frames: 3,
    async start() {
      return { state: "recording" as const, frames: spy.frames, skipped: 0, full: false };
    },
    async stop() {
      return { state: "stopped" as const, frames: spy.frames, skipped: 0, full: false };
    },
    async clear() {
      return { state: "none" as const, frames: 0, skipped: 0, full: false };
    },
    async noteAction() {
      spy.frames += 1;
      return { state: "recording" as const, frames: spy.frames, skipped: 0, full: false };
    },
    async export() {
      return { ok: false as const, refusal: { reason: "empty-recording" as const } };
    },
    async exportIfFrames() {
      spy.exports += 1;
      return undefined;
    },
    async listStates() {
      return { [SESSION]: { state: "recording" as const, frames: spy.frames, skipped: 0, full: false } };
    },
    async stateOf() {
      return { state: "recording" as const, frames: spy.frames, skipped: 0, full: false };
    },
  };
  return spy as unknown as AgentRecorder & { exports: number; frames: number };
}

async function pairedRuntime(): Promise<{
  port: FakePort;
  runtime: ReturnType<typeof composeAgentRuntime>;
  recorder: ReturnType<typeof spyRecorder>;
}> {
  const port = fakePort();
  const recorder = spyRecorder();
  const runtime = composeAgentRuntime({ connectNative: () => port, recorder });
  runtime.start();
  port.emit(HELLO);
  port.emit(PAIR_REQUEST);
  await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
  await runtime.pairing.decide("agent-1", true);
  await vi.waitFor(() => expect(port.sent).toHaveLength(1));
  await runtime.tabs.adopt(SESSION, TAB);
  return { port, runtime, recorder };
}

function answerFor(port: FakePort, callId: string): Record<string, unknown> | undefined {
  return port.sent.find((sent) => (sent as { callId?: string }).callId === callId) as
    | Record<string, unknown>
    | undefined;
}

function answersFor(port: FakePort, callId: string): unknown[] {
  return port.sent.filter((sent) => (sent as { callId?: string }).callId === callId);
}

describe("T354 the owner interrupts one session's calls", () => {
  let fake: Harness;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("answers a wait that nothing else would have ended, at once and honestly", async () => {
    const { port, runtime } = await pairedRuntime();
    let told = 0;
    runtime.subscribe(() => {
      told += 1;
    });
    port.emit({ callId: "call-w", sessionId: SESSION, tool: "wait", args: { tabId: TAB, forMs: 15_000 } });
    await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.inFlight).toBe(1));
    // FR-178: the panel is told a call started, or its 中斷 would stay unavailable through the
    // whole of the one call the owner wanted to end.
    expect(told, "nothing told the panel a call was in flight").toBeGreaterThan(0);

    const at = Date.now();
    expect(runtime.interruptSession(SESSION)).toEqual({ interrupted: 1 });
    await vi.waitFor(() => expect(answerFor(port, "call-w")).toBeDefined());

    // FR-179's bound is a second; the dispatcher does not wait for the runner's next poll at all.
    expect(Date.now() - at).toBeLessThan(100);
    expect(answerFor(port, "call-w")).toEqual({
      callId: "call-w",
      outcome: "stopped",
      reason: "owner-interrupted",
      // FR-180: nothing refused it, the tabs are still held, run it again if it is still wanted.
      hint: INTERRUPT_HINTS.nothingDelivered,
    });
  });

  it("says an effect may have taken effect when its input had already gone to the page", async () => {
    const { port, runtime } = await pairedRuntime();
    await runtime.siteModes.set(SITE, { mode: "skip-checks" });

    port.emit({
      callId: "call-t",
      sessionId: SESSION,
      tool: "type",
      tabId: TAB,
      args: { tabId: TAB, text: "hello", mode: "insert" },
    });
    // The keystrokes are out and the page has not answered: exactly the state FR-181 is about.
    await vi.waitFor(() => expect(fake.commands.some((method) => method.startsWith("Input."))).toBe(true));

    runtime.interruptSession(SESSION);
    await vi.waitFor(() => expect(answerFor(port, "call-t")).toBeDefined());

    expect(answerFor(port, "call-t")).toEqual({
      callId: "call-t",
      outcome: "stopped",
      reason: "owner-interrupted",
      // Never "nothing happened", and never a verified result: the one honest answer is that it
      // may have landed and nobody checked (Constitution XI).
      hint: INTERRUPT_HINTS.mayHaveTakenEffect,
    });
  });

  it("discards the result that arrives afterwards, says so, and frees the call", async () => {
    (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__ = "test";
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { port, runtime } = await pairedRuntime();
      port.emit({ callId: "call-w", sessionId: SESSION, tool: "wait", args: { tabId: TAB, forMs: 15_000 } });
      await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.inFlight).toBe(1));

      runtime.interruptSession(SESSION);
      await vi.waitFor(() => expect(answerFor(port, "call-w")).toBeDefined());

      // The runner reaches its own next checkpoint a poll later and answers `stopped` into nothing.
      await vi.waitFor(() => expect(warned).toHaveBeenCalledWith("[hallpass] agent.call.late-result call-w"));
      // FR-182: never a second frame for the same call. The host is holding one answer, and a
      // second would settle a call that is already settled - or worse, the next one.
      expect(answersFor(port, "call-w")).toHaveLength(1);
      // And `end()` ran, so the call is no longer something the owner can interrupt.
      await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.inFlight).toBe(0));
    } finally {
      warned.mockRestore();
      delete (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__;
    }
  });

  it("changes nothing at all when the session has nothing in flight", async () => {
    (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__ = "test";
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { port, runtime } = await pairedRuntime();

      expect(runtime.interruptSession(SESSION)).toEqual({ interrupted: 0 });

      expect(port.sent).toHaveLength(1);
      expect(
        warned.mock.calls.flat().filter((line) => String(line).includes("late-result")),
        "a session with nothing running discarded nothing",
      ).toEqual([]);
    } finally {
      warned.mockRestore();
      delete (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__;
    }
  });

  /**
   * FR-179's second half, which is most of the feature: an interrupt ends *calls*.
   *
   * Asserted on the fakes rather than on the runtime's own word, because the failure this guards
   * against is a future edit reaching for `releaseSession` to "clean up": the tab would leave the
   * group, the debugger would detach and the owner would watch their browser change under an
   * action that promised to change nothing.
   */
  it("keeps the session, its tabs, its marking, its attachment, its recording and its decisions", async () => {
    const { port, runtime, recorder } = await pairedRuntime();
    await runtime.siteModes.set(SITE, { mode: "skip-checks" });
    port.emit({
      callId: "call-t",
      sessionId: SESSION,
      tool: "type",
      tabId: TAB,
      args: { tabId: TAB, text: "hello", mode: "insert" },
    });
    await vi.waitFor(() => expect(fake.commands.some((method) => method.startsWith("Input."))).toBe(true));
    const leasesBefore = await runtime.tabs.leases();

    runtime.interruptSession(SESSION);
    await vi.waitFor(() => expect(answerFor(port, "call-t")).toBeDefined());

    const after = await runtime.projection();
    expect(after.sessions.map((entry) => entry.sessionId)).toEqual([SESSION]);
    expect(await runtime.tabs.leases()).toEqual(leasesBefore);
    expect(fake.ungrouped, "a tab left the agent's group").toEqual([]);
    expect(fake.clearedGroups, "the group's marking was withdrawn").toEqual([]);
    expect(fake.detached, "the debugger was let go of").toEqual([]);
    expect(
      fake.commands.filter((method) => method.includes("clearDeviceMetricsOverride")),
      "an emulated viewport was cleared",
    ).toEqual([]);
    expect(recorder.exports, "the recording was exported as if the session had ended").toBe(0);
    expect(after.sessions[0]?.recording).toMatchObject({ state: "recording" });
    expect(await runtime.siteModes.list()).toEqual([
      expect.objectContaining({ site: SITE, mode: "skip-checks" }),
    ]);
    // And the session takes the next call without pairing or claiming again (FR-183).
    fake.releaseInput();
    port.emit({ callId: "call-next", sessionId: SESSION, tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(answerFor(port, "call-next")).toMatchObject({ outcome: "ok" }));
  });

  /** FR-184: the owner's Stop is the control that ends everything, and it still does. */
  it("leaves the stop exactly as it was", async () => {
    const { port, runtime } = await pairedRuntime();
    port.emit({ callId: "call-w", sessionId: SESSION, tool: "wait", args: { tabId: TAB, forMs: 15_000 } });
    await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.inFlight).toBe(1));

    await runtime.stopSessionFromOwner(SESSION);
    await vi.waitFor(() => expect(answerFor(port, "call-w")).toBeDefined());

    expect(answerFor(port, "call-w")).toMatchObject({ outcome: "stopped", reason: "owner-stopped" });
    // The session is gone with its tabs, which is what a stop means and an interrupt does not.
    expect((await runtime.projection()).sessions).toEqual([]);
    expect(await runtime.tabs.leases()).toEqual([]);
  });

  it("puts one line on the card for the interrupt", async () => {
    const { port, runtime } = await pairedRuntime();
    port.emit({ callId: "call-w", sessionId: SESSION, tool: "wait", args: { tabId: TAB, forMs: 15_000 } });
    await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.inFlight).toBe(1));

    runtime.interruptSession(SESSION);
    await vi.waitFor(() => expect(answerFor(port, "call-w")).toBeDefined());

    // FR-182: one line per press, whatever was running - the owner reads afterwards what they did.
    expect((await runtime.projection()).sessions[0]?.activity).toEqual([
      expect.objectContaining({ kind: "interrupt", outcome: "interrupted" }),
    ]);
  });
});

/**
 * 014/T369 — what the dispatch point owes every call, including the ones that go wrong.
 *
 * `begin()` is the first thing a call meets and `end()` must be the last, on every route out. A
 * route that skips it leaves a registration behind, and a registration outliving its call is not a
 * tidiness problem: it is what the panel counts for its 中斷 control and what the next interrupt
 * reports having ended, so the owner is told a phantom call was running and then that they stopped
 * it. The two routes below are the ones the seam did not have: the runner rejecting, and the
 * feature's own storage read failing.
 */
describe("T369 the dispatch point's own failures", () => {
  let fake: Harness;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("frees the call, and answers it once, when the runner itself throws", async () => {
    const { port, runtime, recorder } = await pairedRuntime();
    // A runner that rejects rather than answering: the offscreen document went away under it.
    (recorder as unknown as { stop: () => Promise<never> }).stop = async () => {
      throw new Error("the offscreen document went away");
    };

    port.emit({ callId: "call-boom", sessionId: SESSION, tool: "gif_recorder", args: { action: "stop" } });

    await vi.waitFor(() => expect(answerFor(port, "call-boom")).toBeDefined());
    expect(answerFor(port, "call-boom")).toEqual({
      callId: "call-boom",
      outcome: "failed",
      reason: "handler-error",
    });
    expect(answersFor(port, "call-boom")).toHaveLength(1);
    // The registration went with the answer, so the panel's control goes quiet again...
    await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.inFlight).toBe(0));
    // ...and the next press ends nothing rather than claiming a call nobody is waiting for.
    expect(runtime.interruptSession(SESSION)).toEqual({ interrupted: 0 });
  });

  /**
   * T369 review F2 — FR-179's bound covers the window before the runner as well.
   *
   * The transition check is a storage read, and a storage read on a worker that has just woken is
   * not instant. Left outside the race it is a stretch of a call's life in which 中斷 does nothing
   * at all: the owner presses it, the panel says the call is still in flight, and the answer waits
   * for a store nobody is interested in any more.
   */
  it("answers within the bound when the owner interrupts while the transition check is still reading", async () => {
    const { port, runtime } = await pairedRuntime();
    const release = fake.holdTransitionReads();
    try {
      port.emit({ callId: "call-w", sessionId: SESSION, tool: "wait", args: { tabId: TAB, forMs: 15_000 } });
      await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.inFlight).toBe(1));

      const at = Date.now();
      expect(runtime.interruptSession(SESSION)).toEqual({ interrupted: 1 });
      await vi.waitFor(() => expect(answerFor(port, "call-w")).toBeDefined());

      expect(Date.now() - at).toBeLessThan(100);
      expect(answerFor(port, "call-w")).toMatchObject({ outcome: "stopped", reason: "owner-interrupted" });
      // And the check, answering afterwards, raises no card for a call that is already over.
      release();
      await vi.waitFor(() => expect(runtime.prompts.current()).toBeUndefined());
    } finally {
      release();
    }
  });

  it("lets the call through when the transition check cannot read its own store, and says so", async () => {
    (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__ = "test";
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { port, runtime } = await pairedRuntime();
      fake.transitionReadsFail = true;

      port.emit({ callId: "call-w", sessionId: SESSION, tool: "wait", args: { tabId: TAB, forMs: 10 } });

      await vi.waitFor(() => expect(answerFor(port, "call-w")).toBeDefined());
      // 014 FR-187 asks the owner about a move this worker *knows* about. A store that will not
      // answer knows of no move, so the call proceeds exactly as it would have - refusing it would
      // hold an agent behind a question nobody was ever asked.
      expect(answerFor(port, "call-w")).toMatchObject({ outcome: "ok" });
      expect(warned).toHaveBeenCalledWith("[hallpass] agent.transition.check-failed");
      await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.inFlight).toBe(0));
    } finally {
      warned.mockRestore();
      delete (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__;
    }
  });
});
